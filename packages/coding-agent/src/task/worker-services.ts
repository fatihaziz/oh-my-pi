/**
 * Parent-owned services for natively hosted subagent workers.
 *
 * An in-process child shares its parent's retained Eval kernels and memory
 * state by object identity. A worker process cannot, so each service stays in
 * the process that owns it and the worker reaches it over the executor owner's
 * request channel. Nothing here starts a process or chooses a fallback: a lost
 * parent fails the request.
 */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { toolWireSchema, validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import type { EvalLanguage, EvalStatusEvent } from "@oh-my-pi/pi-tui/tools/eval";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ExecutorBackend, ExecutorBackendResult } from "../eval/backend";
import jsBackend from "../eval/js";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { callSessionTool, type EvalBridgeValue } from "../eval/js/tool-bridge";
import type { EvalPreludeDefinition } from "../eval/preludes";
import pythonBackend from "../eval/py";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { type EvalStateSnapshot, getEvalState } from "../eval/state";
import { contextLocalProtocolOptions } from "../internal-urls/context";
import { MEMORY_BACKEND_TOOL_NAMES } from "../memory-backend/tool-names";
import type { MnemopiScopedMemoryHit } from "../mnemopi/state";
import { BUILTIN_TOOLS, type ToolSession } from "../tools";
import type { ExecutorOptions } from "./executor";

/** Worker session a parent-side service acts for. */
export interface WorkerIdentity {
	cwd: string;
	sessionId: string | null;
	sessionFile: string | null;
}

/** Identity a tool session reports to its parent's services. */
export function workerIdentity(session: ToolSession): WorkerIdentity {
	return { cwd: session.cwd, sessionId: session.getSessionId?.() ?? null, sessionFile: session.getSessionFile() };
}

/** Memory owned by an ancestor process. */
export interface ParentMemory {
	/** Execute one memory tool against the owning state, acting as `session`. */
	executeTool<TDetails = unknown>(
		name: string,
		toolCallId: string,
		params: unknown,
		session: ToolSession,
		signal?: AbortSignal,
	): Promise<AgentToolResult<TDetails>>;
	/** Full row behind a `memory://<id>` URL. */
	getScopedMemory(id: string): Promise<MnemopiScopedMemoryHit | null>;
	/** Recall block the owning state injects into developer instructions. */
	recallSnippet(): Promise<string | undefined>;
}

/** Retained Eval kernels owned by an ancestor process. */
export interface ParentEval {
	/** Backend that runs cells in the ancestor's kernel for `language`. */
	backend(language: EvalLanguage): ExecutorBackend;
	/**
	 * Ancestor registry view for one kernel owner, as of launch or that owner's
	 * latest cell. Model context is built synchronously, so it cannot wait on the parent.
	 */
	state(kernelOwnerId: string | null): EvalStateSnapshot | undefined;
	/** Detach one kernel owner, as an in-process session does on dispose. */
	release(kernelOwnerId: string): Promise<void>;
}

/** Services a hosted worker reaches in its parent; absent members are not shared. */
export interface ParentServices {
	memory?: ParentMemory;
	eval?: ParentEval;
}

/** Request channel between one process and the executor owner. */
export interface WorkerServiceTransport {
	request<T>(command: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
}

interface EvalCellRequest {
	cellId: string;
	language: EvalLanguage;
	code: string;
	identity: WorkerIdentity & {
		kernelOwnerId: string | null;
		artifactsDir: string | null;
		/** Resolved `local://` mapping of the calling session; null when it has none. */
		localProtocol: { artifactsDir: string | null; sessionId: string | null } | null;
	};
	preludes: Array<Pick<EvalPreludeDefinition, "name" | "javascript" | "python" | "exports">>;
	sessionFile?: string;
	reset: boolean;
	filename?: string;
	packages?: string[];
	environment?: "managed" | "project";
	idleTimeoutMs?: number;
}

interface EvalCellResponse {
	result: ExecutorBackendResult;
	state: EvalStateSnapshot | null;
}

const EVAL_LANGUAGES: Record<EvalLanguage, true> = { python: true, js: true };

// ─── Worker side ────────────────────────────────────────────────────────────

interface PendingCell {
	session: ToolSession;
	signal?: AbortSignal;
	onChunk(chunk: string): void;
	onStatus?(event: EvalStatusEvent): void;
	events: Promise<void>;
}

/**
 * Worker-side clients for the services the parent declared shared. Frames the
 * parent sends while a cell runs (`executor_eval_event`, `executor_eval_bridge`)
 * go to {@link WorkerServiceClients.handle}.
 */
export interface WorkerServiceClients {
	services: ParentServices;
	/** Handles a parent-to-worker service frame; undefined when `type` is not one. */
	handle(type: string, frame: Record<string, unknown>, signal: AbortSignal): Promise<unknown> | undefined;
}

export function createWorkerServiceClients(
	transport: WorkerServiceTransport,
	agentId: string,
	shared: { memory: boolean; eval?: { state: EvalStateSnapshot | null } },
): WorkerServiceClients {
	const services: ParentServices = {};
	if (shared.memory) {
		services.memory = {
			executeTool: (name, toolCallId, params, session, signal) =>
				transport.request(
					"memory",
					{ agentId, op: "tool", name, toolCallId, params, identity: workerIdentity(session) },
					signal,
				),
			getScopedMemory: id => transport.request("memory", { agentId, op: "get", id }),
			recallSnippet: async () =>
				(await transport.request<string | null>("memory", { agentId, op: "snippet" })) ?? undefined,
		};
	}
	const cells = new Map<string, PendingCell>();
	let nextCell = 0;
	const initialState = shared.eval?.state ?? undefined;
	const states = new Map<string | null, EvalStateSnapshot | undefined>();
	if (shared.eval) {
		const remote = (local: ExecutorBackend): ExecutorBackend => ({
			id: local.id,
			label: local.label,
			highlightLang: local.highlightLang,
			// The kernel runs in the parent, which reports unavailability on the first cell.
			isAvailable: async () => true,
			async execute(code, opts) {
				const cellId = `cell-${++nextCell}`;
				const pending: PendingCell = {
					session: opts.session,
					signal: opts.signal,
					onChunk: opts.onChunk,
					onStatus: opts.onStatus,
					events: Promise.resolve(),
				};
				cells.set(cellId, pending);
				const localProtocol = contextLocalProtocolOptions(opts.session);
				const request: EvalCellRequest = {
					cellId,
					language: local.id,
					code,
					identity: {
						...workerIdentity(opts.session),
						cwd: opts.cwd,
						kernelOwnerId: opts.kernelOwnerId ?? null,
						artifactsDir: opts.session.getArtifactsDir?.() ?? null,
						localProtocol: localProtocol
							? {
									artifactsDir: localProtocol.getArtifactsDir?.() ?? null,
									sessionId: localProtocol.getSessionId?.() ?? null,
								}
							: null,
					},
					preludes: (opts.session.getEvalPreludes?.() ?? [])
						.filter(definition => definition.enabled?.() !== false)
						.map(({ name, javascript, python, exports }) => ({ name, javascript, python, exports })),
					sessionFile: opts.sessionFile,
					reset: opts.reset,
					filename: opts.filename,
					packages: opts.packages,
					environment: opts.environment,
					idleTimeoutMs: opts.idleTimeoutMs,
				};
				try {
					const response = await transport.request<EvalCellResponse>("eval", { agentId, ...request }, opts.signal);
					await pending.events;
					states.set(request.identity.kernelOwnerId, response.state ?? undefined);
					return response.result;
				} finally {
					cells.delete(cellId);
				}
			},
		});
		const backends: Record<EvalLanguage, ExecutorBackend> = {
			python: remote(pythonBackend),
			js: remote(jsBackend),
		};
		services.eval = {
			backend: language => backends[language],
			state: kernelOwnerId => (states.has(kernelOwnerId) ? states.get(kernelOwnerId) : initialState),
			release: async kernelOwnerId => {
				states.delete(kernelOwnerId);
				await transport.request("eval_release", { agentId, kernelOwnerId });
			},
		};
	}
	return {
		services,
		handle(type, frame, signal) {
			if (type !== "executor_eval_event" && type !== "executor_eval_bridge") return undefined;
			const cell = typeof frame.cellId === "string" ? cells.get(frame.cellId) : undefined;
			if (!cell) return Promise.reject(new Error("Eval cell is no longer running in this worker"));
			if (type === "executor_eval_event") {
				const { chunk, status } = frame;
				// Chunks and status must reach the cell in the order the kernel produced them.
				cell.events = cell.events.then(() => {
					if (typeof chunk === "string") cell.onChunk(chunk);
					if (isEvalStatusEvent(status)) cell.onStatus?.(status);
				});
				return cell.events.then(() => null);
			}
			if (typeof frame.name !== "string") return Promise.reject(new Error("Invalid eval bridge call"));
			const identity = frame.identity;
			return callSessionTool(frame.name, frame.args, {
				session: cell.session,
				signal: cell.signal ? AbortSignal.any([signal, cell.signal]) : signal,
				emitStatus: cell.onStatus,
				identity:
					isRecord(identity) && typeof identity.siteId === "string" && typeof identity.occurrence === "number"
						? { siteId: identity.siteId, occurrence: identity.occurrence }
						: undefined,
			});
		},
	};
}

function isEvalStatusEvent(value: unknown): value is EvalStatusEvent {
	return isRecord(value) && typeof value.op === "string";
}

// ─── Parent side ────────────────────────────────────────────────────────────

/** Sends a request to the worker that hosts the addressed agent, through the executor owner. */
export type WorkerRequest = WorkerServiceTransport["request"];

function parseIdentity(value: unknown): WorkerIdentity {
	if (
		!isRecord(value) ||
		typeof value.cwd !== "string" ||
		(value.sessionId !== null && typeof value.sessionId !== "string") ||
		(value.sessionFile !== null && typeof value.sessionFile !== "string")
	)
		throw new Error("Invalid worker service identity");
	return { cwd: value.cwd, sessionId: value.sessionId, sessionFile: value.sessionFile };
}

/** Serve a worker's memory request from the state this process owns, or forward it to this process's parent. */
export async function serveWorkerMemory(
	owner: ExecutorOptions,
	frame: Record<string, unknown>,
	signal: AbortSignal,
): Promise<unknown> {
	const state = owner.parentMnemopiSessionState;
	const primary = state ? (state.aliasOf ?? state) : undefined;
	const upstream = owner.parentServices?.memory;
	if (!primary && !upstream) throw new Error("Parent memory is no longer available to this worker");
	switch (frame.op) {
		case "tool": {
			const { name, toolCallId, params } = frame;
			if (
				typeof name !== "string" ||
				typeof toolCallId !== "string" ||
				!(MEMORY_BACKEND_TOOL_NAMES as readonly string[]).includes(name)
			)
				throw new Error("Invalid memory tool request");
			const identity = parseIdentity(frame.identity);
			if (!owner.settings) throw new Error("Parent memory settings are unavailable");
			// Same state an in-process child's alias delegates to; identity stays the worker's.
			const view: ToolSession = {
				cwd: identity.cwd,
				hasUI: false,
				settings: owner.settings,
				getSessionFile: () => identity.sessionFile,
				getSessionSpawns: () => null,
				getSessionId: () => identity.sessionId,
				getMnemopiSessionState: () => primary,
			};
			if (!primary) return upstream!.executeTool(name, toolCallId, params, view, signal);
			const tool = await BUILTIN_TOOLS[name as (typeof MEMORY_BACKEND_TOOL_NAMES)[number]](view);
			if (!tool) throw new Error(`Memory tool ${name} is unavailable in the parent`);
			if (!validateJsonSchemaValue(toolWireSchema(tool), params).success)
				throw new Error("Invalid memory tool arguments");
			return tool.execute(toolCallId, params as never, signal);
		}
		case "get":
			if (typeof frame.id !== "string") throw new Error("Invalid memory id");
			return primary ? primary.getScopedMemory(frame.id) : upstream!.getScopedMemory(frame.id);
		case "snippet":
			return primary ? (primary.lastRecallSnippet ?? null) : ((await upstream!.recallSnippet()) ?? null);
		default:
			throw new Error("Unsupported memory request");
	}
}

/** Kernel owners each worker registered in this process, disposed with the worker. */
const workerEvalOwners = new Map<string, Set<string>>();

function parseCell(frame: Record<string, unknown>): EvalCellRequest {
	const identity = frame.identity;
	const local = isRecord(identity) ? identity.localProtocol : undefined;
	if (
		typeof frame.cellId !== "string" ||
		typeof frame.language !== "string" ||
		!(frame.language in EVAL_LANGUAGES) ||
		typeof frame.code !== "string" ||
		typeof frame.reset !== "boolean" ||
		!isRecord(identity) ||
		(identity.kernelOwnerId !== null && typeof identity.kernelOwnerId !== "string") ||
		(identity.artifactsDir !== null && typeof identity.artifactsDir !== "string") ||
		(local !== null &&
			(!isRecord(local) ||
				(local.artifactsDir !== null && typeof local.artifactsDir !== "string") ||
				(local.sessionId !== null && typeof local.sessionId !== "string"))) ||
		!Array.isArray(frame.preludes) ||
		!frame.preludes.every(
			prelude =>
				isRecord(prelude) &&
				typeof prelude.name === "string" &&
				typeof prelude.javascript === "string" &&
				typeof prelude.python === "string" &&
				Array.isArray(prelude.exports) &&
				prelude.exports.every(name => typeof name === "string"),
		)
	)
		throw new Error("Invalid eval cell request");
	parseIdentity(identity);
	// Every field was checked above; the remaining optional members are backend options the backend validates.
	return frame as unknown as EvalCellRequest;
}

/**
 * Run a worker's cell in the kernel this process owns (or forward it to this
 * process's parent). The cell sees the worker's cwd, settings, preludes and
 * `local://` root; every tool, agent or prelude call it makes runs back in the
 * worker session.
 */
export async function serveWorkerEval(
	owner: ExecutorOptions,
	frame: Record<string, unknown>,
	requestWorker: WorkerRequest,
	signal: AbortSignal,
): Promise<EvalCellResponse> {
	const agentId = owner.id;
	const cell = parseCell(frame);
	const sharedSessionId = owner.parentEvalSessionId;
	if (sharedSessionId === undefined) throw new Error("Parent Eval state is not shared with this worker");
	if (!owner.settings) throw new Error("Parent Eval settings are unavailable");
	const { identity } = cell;
	const local = identity.localProtocol;
	const preludes: EvalPreludeDefinition[] = cell.preludes.map(prelude => ({
		...prelude,
		documentation: "",
		invoke: () => Promise.reject(new Error("Eval prelude calls run in the worker session")),
	}));
	const view: ToolSession = {
		cwd: identity.cwd,
		hasUI: false,
		settings: owner.settings,
		getSessionFile: () => identity.sessionFile,
		getSessionSpawns: () => null,
		getSessionId: () => identity.sessionId,
		getEvalSessionId: () => sharedSessionId,
		getEvalKernelOwnerId: () => identity.kernelOwnerId,
		getArtifactsDir: () => identity.artifactsDir,
		localProtocolOptions: local
			? { getArtifactsDir: () => local.artifactsDir, getSessionId: () => local.sessionId }
			: undefined,
		getEvalPreludes: () => preludes,
		getParentServices: () => owner.parentServices,
		forwardEvalBridgeCall: (name, args, options) =>
			requestWorker<EvalBridgeValue>(
				"eval_bridge",
				{ agentId, cellId: cell.cellId, name, args, identity: options.identity },
				options.signal,
			),
	};
	if (identity.kernelOwnerId) {
		const owners = workerEvalOwners.get(agentId) ?? new Set<string>();
		owners.add(identity.kernelOwnerId);
		workerEvalOwners.set(agentId, owners);
	}
	const backend =
		owner.parentServices?.eval?.backend(cell.language) ?? (cell.language === "python" ? pythonBackend : jsBackend);
	if (!(await backend.isAvailable(view, { signal }))) {
		throw new Error(`${backend.label} Eval is unavailable in the parent`);
	}
	let events = Promise.resolve();
	const send = (event: { chunk: string } | { status: EvalStatusEvent }) => {
		events = events.then(async () => {
			await requestWorker("eval_event", { agentId, cellId: cell.cellId, ...event }, signal);
		});
	};
	const result = await backend.execute(cell.code, {
		cwd: identity.cwd,
		sessionId: sharedSessionId,
		sessionFile: cell.sessionFile,
		kernelOwnerId: identity.kernelOwnerId ?? undefined,
		signal,
		session: view,
		idleTimeoutMs: cell.idleTimeoutMs,
		reset: cell.reset,
		filename: cell.filename,
		packages: cell.packages,
		environment: cell.environment,
		onChunk: chunk => send({ chunk }),
		onStatus: status => send({ status }),
	});
	await events;
	return { result, state: getEvalState(view) ?? null };
}

async function detachEvalOwner(owner: ExecutorOptions, kernelOwnerId: string): Promise<void> {
	const upstream = owner.parentServices?.eval;
	if (upstream) {
		await upstream.release(kernelOwnerId);
		return;
	}
	const results = await Promise.allSettled([
		disposeKernelSessionsByOwner(kernelOwnerId),
		disposeVmContextsByOwner(kernelOwnerId),
	]);
	const errors = results.flatMap(result => (result.status === "rejected" ? [result.reason] : []));
	if (errors.length > 0) throw new AggregateError(errors, "Failed to dispose one or more eval kernels");
}

/** Detach one kernel owner a worker registered here; other owners' kernels are never touched. */
export async function serveWorkerEvalRelease(owner: ExecutorOptions, frame: Record<string, unknown>): Promise<null> {
	const kernelOwnerId = frame.kernelOwnerId;
	const owners = workerEvalOwners.get(owner.id);
	if (typeof kernelOwnerId !== "string") throw new Error("Invalid eval owner release");
	// An owner that never ran a cell here holds nothing in this process.
	if (!owners?.delete(kernelOwnerId)) return null;
	await detachEvalOwner(owner, kernelOwnerId);
	return null;
}

/** Detach every kernel owner a released worker still holds in this process. */
export async function releaseWorkerEval(owner: ExecutorOptions): Promise<void> {
	const owners = workerEvalOwners.get(owner.id);
	workerEvalOwners.delete(owner.id);
	await Promise.allSettled([...(owners ?? [])].map(kernelOwnerId => detachEvalOwner(owner, kernelOwnerId)));
}

/** Parent registry view a newly launched worker starts from: shared runtimes only, as for a fresh owner. */
export function initialWorkerEvalState(owner: ExecutorOptions): EvalStateSnapshot | null {
	const sessionId = owner.parentEvalSessionId;
	if (sessionId === undefined || !owner.settings) return null;
	return (
		getEvalState({
			cwd: owner.cwd,
			hasUI: false,
			settings: owner.settings,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getEvalSessionId: () => sessionId,
			getParentServices: () => owner.parentServices,
		}) ?? null
	);
}
