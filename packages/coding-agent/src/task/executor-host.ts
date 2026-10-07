import * as path from "node:path";
import { isRecord, untilAborted } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { ModelRegistry } from "../config/model-registry";
import { discoverAuthStorage } from "../sdk";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "../modes/rpc/host-tools";
import type { RpcHostToolDefinition } from "../modes/rpc/rpc-types";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { EffectiveExtensionRoots } from "../capability/types";
import { IrcBus } from "../irc/bus";
import { claimRpcInput, readRpcInputFrames } from "../modes/rpc/rpc-input";
import { MAX_RPC_REASSEMBLED_BYTES, RpcFrameEncoder } from "../modes/rpc/rpc-frame";
import { RpcOutputWriter } from "../modes/rpc/rpc-output";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { EventBus } from "../utils/event-bus";
import { runSubprocess, runSubagentFollowUpTurn, type ExecutorOptions, type FollowUpTurnOptions } from "./executor";
import { TASK_SUBAGENT_EVENT_CHANNEL, TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "./types";
import { createExternalSubagentExecutor } from "./external-executor-client";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import { mirrorHostedRegistryChange, registerExternalSubagentExecutor } from "./external-executor";
import { HostedPeerRegistry } from "./hosted-peers";
import { ArtifactManager } from "../session/artifacts";
import { toolWireSchema, validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import { type as schema } from "@oh-my-pi/omptype";
import { context, propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import { flushTelemetryExport } from "../telemetry-export";
import { cfgTelemetryOtlpExportEnabled } from "../telemetry-settings";
import { type ImportedWorkerTelemetry, importWorkerTelemetry, type WorkerTelemetry } from "./external-telemetry";
import {
	createWorkerServiceClients,
	releaseWorkerEval,
	serveWorkerEval,
	serveWorkerEvalRelease,
	serveWorkerMemory,
	type WorkerServiceClients,
	workerModelChoices,
} from "./worker-services";
import type { EvalStateSnapshot } from "../eval/state";

import { ExecutorTerminal } from "./executor-terminal";
import { ExecutorWorkspace } from "./executor-workspace";
import { openCoordinatorRuntime } from "./coordinator-runtime";
/** Resolved data only. Live parent services must be supplied by the host adapter. */
export type HostedExecutorOptions = Pick<
	ExecutorOptions,
	| "cwd"
	| "additionalDirectories"
	| "worktree"
	| "agent"
	| "task"
	| "assignment"
	| "context"
	| "planReference"
	| "description"
	| "index"
	| "id"
	| "parentToolCallId"
	| "detached"
	| "modelOverride"
	| "modelRole"
	| "thinkingLevel"
	| "effort"
	| "solutionSpace"
	| "outputSchema"
	| "outputSchemaMode"
	| "outputSchemaSource"
	| "outputSchemaOverridesAgent"
	| "taskDepth"
	| "maxRuntimeMs"
	| "enableIrc"
	| "enableLsp"
	| "enableMCP"
	| "workPoolYieldItems"
	| "restrictToolNames"
	| "sessionFile"
	| "artifactsDir"
	| "contextFiles"
	| "skills"
	| "promptTemplates"
	| "rules"
	| "preloadedExtensionPaths"
	| "preloadedCustomToolPaths"
	| "parentServiceTier"
	| "serviceTierOverride"
	| "inheritedSessionAgents"
	| "autoloadSkills"
	| "parentAgentId"
	| "parentEvalSessionId"
	| "keepAlive"
>;

const servicesSchema = schema({
	memory: "boolean",
	eval: schema({ state: "object | null", "+": "reject" }).or("null"),
	"+": "reject",
});

const telemetrySchema = schema({
	environment: "string",
	"tracerName?": "string",
	"captureMessageContent?": "boolean | 'none' | 'summary' | 'full'",
	"attributes?": "object",
	"agent?": { "id?": "string", "name?": "string", "description?": "string", "+": "reject" },
	"conversationId?": "string",
	trace: "Record<string, string>",
	"+": "reject",
});

const agentDefinitionSchema = schema({
	name: "string",
	description: "string",
	systemPrompt: "string",
	source: "'bundled' | 'user' | 'project'",
	"tools?": "string[]",
	"spawns?": "string[] | '*'",
	"model?": "string[]",
	"thinkingLevel?": "string",
	"output?": "unknown",
	"blocking?": "boolean",
	"autoloadSkills?": "string[]",
	"readSummarize?": "boolean",
	"prewalk?": "boolean | string",
	"advisor?": "boolean | string",
	"filePath?": "string",
	"+": "reject",
});

const launchSchema = schema({
	cwd: "string",
	id: "string",
	index: "number.integer >= 0",
	task: "string",
	agent: agentDefinitionSchema,
	"additionalDirectories?": "string[]",
	"worktree?": "string",
	"assignment?": "string",
	"context?": "string",
	"description?": "string",
	"parentToolCallId?": "string",
	"solutionSpace?": "string",
	"parentAgentId?": "string",
	"modelOverride?": "string | string[]",
	"modelRole?": "string",
	"parentActiveModelPattern?": "string",
	"thinkingLevel?": "string",
	"effort?": "'lo' | 'med' | 'hi'",
	"outputSchema?": "unknown",
	"outputSchemaMode?": "'permissive' | 'strict'",
	"outputSchemaSource?": "string",
	"outputSchemaOverridesAgent?": "boolean",
	"taskDepth?": "number.integer >= 0",
	"maxRuntimeMs?": "number >= 0",
	"invokedAt?": "number >= 0",
	"acquiredAt?": "number >= 0",
	"detached?": "boolean",
	"enableIrc?": "boolean",
	"enableLsp?": "boolean",
	"enableMCP?": "boolean",
	"restrictToolNames?": "boolean",
	"keepAlive?": "boolean",
	"persistArtifacts?": "boolean",
	sessionFile: "string",
	artifactsDir: "string",
	"credentialSourceSessionId?": "string",
	"preloadedExtensionPaths?": "string[]",
	"preloadedCustomToolPaths?": "object[]",
	"contextFiles?": "object[]",
	"skills?": "object[]",
	"rules?": "object[]",
	"promptTemplates?": "object[]",
	"workspaceTree?": "object",
	"autoloadSkills?": "object[]",
	"inheritedSessionAgents?": agentDefinitionSchema.array(),
	"planReference?": { path: "string", content: "string" },
	"workPoolYieldItems?": schema({ id: "string", index: "number.integer >= 0" }).array(),
	"parentServiceTier?": schema({ "openai?": "string", "anthropic?": "string", "google?": "string" }).or("null"),
	"serviceTierOverride?": "'inherit' | 'none' | 'auto' | 'default' | 'flex' | 'scale' | 'priority'",
	"parentEvalSessionId?": "string",
	"+": "reject",
});
/** Reject unknown launch fields before the host initializes the child. */
export function parseHostedExecutorLaunch(input: unknown): HostedExecutorOptions {
	const validated = launchSchema(input);
	if (validated instanceof schema.errors) throw new Error(`Invalid native launch: ${validated.summary}`);
	return validated as HostedExecutorOptions;
}

/** One process hosts one native child identity for its whole lifetime. */
export async function runExecutorHost(): Promise<void> {
	let frameBytes = 0;
	const input = claimRpcInput().pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				for (const byte of chunk) {
					if (byte === 10) frameBytes = 0;
					else if (++frameBytes > MAX_RPC_REASSEMBLED_BYTES)
						throw new Error("Native worker input frame exceeds the RPC limit");
				}
				controller.enqueue(chunk);
			},
		}),
	);
	const encoder = new RpcFrameEncoder();
	encoder.setProtocolVersion(2);
	const lifetime = new AbortController();
	const writer = new RpcOutputWriter(process.stdout, error => lifetime.abort(error));
	const emit = (frame: object) => writer.write(encoder.encodeFrames(frame));
	const hostTools = new RpcHostToolBridge(emit);
	const registry = AgentRegistry.global();
	const events = new EventBus();
	let relayingRegistry = false;
	for (const channel of [
		TASK_SUBAGENT_EVENT_CHANNEL,
		TASK_SUBAGENT_LIFECYCLE_CHANNEL,
		TASK_SUBAGENT_PROGRESS_CHANNEL,
	]) {
		events.on(channel, payload => emit({ type: "subagent_frame", channel, payload }));
	}
	const unsubscribe = registry.onChange(({ type, ref }) => {
		if (relayingRegistry || ref.id !== launch?.id) return;
		const { session: _session, ...snapshot } = ref;
		emit({ type: "subagent_registry", change: type, ref: snapshot });
	});
	let launch: HostedExecutorOptions | undefined;
	let modelOwner: ExecutorOptions | undefined;
	let authorizedModel: { provider: string; id: string } | undefined;
	let modelSelection: FollowUpTurnOptions["modelSelection"];
	let turn: AbortController | undefined;
	let running: Promise<unknown> | undefined;
	let closing = false;
	let admitting = false;
	let workspace: ExecutorWorkspace | undefined;
	let terminal: ExecutorTerminal | undefined;
	let terminalView = "";
	let terminalReady = false;
	let coordinator: Awaited<ReturnType<typeof openCoordinatorRuntime>> | undefined;
	let coordinatorOpening = false;
	// A child's requests to its owner belong to the turn that made them; cancelling the turn cancels them.
	const turnSignal = (): AbortSignal => (turn ? AbortSignal.any([turn.signal, lifetime.signal]) : lifetime.signal);
	const respond = (id: string, command: string, data: unknown) =>
		emit({ type: "response", id, command, success: true, data });
	const fail = (id: unknown, command: unknown, error: unknown) =>
		emit({
			type: "response",
			id,
			command,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		});
	const controls = new Set<Promise<void>>();
	let nextRequest = 0;
	const ownerRequests = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
	const callbackOwners = new Map<string, ExecutorOptions>();
	const callbackRuns = new Map<string, AbortController>();
	let disconnectOwner: (() => void) | undefined;
	let serviceClients: WorkerServiceClients | undefined;
	let peers: HostedPeerRegistry | undefined;
	const ownerTransport = {
		bind(options: ExecutorOptions) {
			callbackOwners.set(options.id, options);
		},
		request<T>(command: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
			// Teardown still has to hand back parent-held resources and release this worker's own hosted descendants.
			const teardown = command === "release_resources" || command === "eval_release" || command === "release";
			if (lifetime.signal.aborted || (closing && !teardown))
				return Promise.reject(new Error("Native executor owner disconnected"));
			if (ownerRequests.size >= 128) return Promise.reject(new Error("Native owner request capacity reached"));
			if (signal?.aborted) return Promise.reject(signal.reason);
			const id = `owner-${++nextRequest}`;
			const pending = Promise.withResolvers<T>();
			const abort = () => {
				emit({ type: "executor_cancel", targetId: id });
				pending.reject(signal?.reason ?? new Error("External execution aborted"));
			};
			ownerRequests.set(id, { resolve: value => pending.resolve(value as T), reject: pending.reject });
			signal?.addEventListener("abort", abort, { once: true });
			emit({ type: "executor_request", id, command, data });
			return pending.promise.finally(() => {
				signal?.removeEventListener("abort", abort);
			});
		},
	};
	const ownerExecutor = createExternalSubagentExecutor(ownerTransport);
	const run = async (frame: unknown): Promise<void> => {
		if (!isRecord(frame) || typeof frame.id !== "string" || typeof frame.type !== "string") {
			throw new Error("Expected a command with string id and type");
		}
		if (isRpcHostToolResult(frame)) {
			hostTools.handleResult(frame);
			return;
		}
		if (isRpcHostToolUpdate(frame)) {
			hostTools.handleUpdate(frame);
			return;
		}
		const { id, type } = frame;
		if (type === "coordinator_init") {
			if (closing || launch || workspace || coordinatorOpening) throw new Error("Native coordinator ownership is unavailable");
			if (coordinator) {
				const previous = coordinator.identity;
				if (previous.paneId !== frame.paneId || previous.sessionId !== frame.sessionId ||
					previous.model !== frame.model || previous.thinking !== frame.thinking) throw new Error("Coordinator identity or settings changed; close the old runtime first");
				respond(id, type, coordinator.selection);
				return;
			}
			coordinatorOpening = true;
			try {
				coordinator = await openCoordinatorRuntime(process.cwd(), frame, lifetime.signal);
				respond(id, type, coordinator.selection);
			} finally {
				coordinatorOpening = false;
			}
			return;
		}
		if (type === "coordinator_judge" || type === "coordinator_think") {
			if (closing || !coordinator) throw new Error("Initialize the pane coordinator first");
			if (callbackRuns.has(id) || callbackRuns.size >= 128) throw new Error("Duplicate or excess coordinator request");
			const abort = new AbortController();
			callbackRuns.set(id, abort);
			try {
				const signal = AbortSignal.any([abort.signal, lifetime.signal]);
				const result = await (type === "coordinator_judge" ? coordinator.judge(frame, signal) : coordinator.think(frame, signal));
				respond(id, type, { ...result, providerCalls: coordinator.providerCalls });
			} finally {
				callbackRuns.delete(id);
			}
			return;
		}
		if (type === "coordinator_close") {
			if (!coordinator) throw new Error("No pane coordinator is initialized");
			closing = true;
			for (const controller of callbackRuns.values()) controller.abort();
			respond(id, type, { closed: true, providerCalls: coordinator.providerCalls });
			return;
		}
		if (type === "executor_peers") {
			if (
				closing ||
				launch ||
				peers ||
				typeof frame.agentId !== "string" ||
				typeof frame.sessionFile !== "string" ||
				typeof frame.peerRoot !== "string" ||
				!Array.isArray(frame.peers) ||
				frame.peers.length > 1024
			)
				throw new Error("Invalid initial native peer snapshot");
			const localId = frame.agentId;
			peers = new HostedPeerRegistry(
				registry,
				localId,
				frame.sessionFile,
				frame.peerRoot,
				(peer, message, deliveryOptions) =>
					ownerTransport.request(
						"peer_send",
						{
							agentId: localId,
							target: peer.ref.id,
							targetGeneration: peer.generation,
							sessionFile: peer.ref.sessionFile,
							message,
							options: deliveryOptions,
						},
						turnSignal(),
					),
			);
			relayingRegistry = true;
			try {
				for (const peer of frame.peers) peers.apply("registered", peer);
			} catch (error) {
				peers.close();
				peers = undefined;
				throw error;
			} finally {
				relayingRegistry = false;
			}
			respond(id, type, null);
			return;
		}
		if (type === "executor_peer") {
			relayingRegistry = true;
			try {
				// Before initialization, executor_peers supplies a fresh snapshot.
				if (peers) peers.apply(String(frame.change), frame.peer);
			} finally {
				relayingRegistry = false;
			}
			respond(id, type, null);
			return;
		}
		if (type === "executor_registry") {
			// Owner relays a hosted child's registry change to the process that owns its session; allowed while closing.
			relayingRegistry = true;
			try {
				if (typeof frame.change !== "string" || !mirrorHostedRegistryChange(frame.change, frame.ref))
					throw new Error("Registry change does not belong to a child of this worker");
			} finally {
				relayingRegistry = false;
			}
			respond(id, type, null);
			return;
		}
		if (type === "executor_response") {
			const pending = ownerRequests.get(id);
			if (!pending || typeof frame.success !== "boolean") throw new Error("Unknown external executor response");
			ownerRequests.delete(id);
			if (frame.success) pending.resolve(frame.data);
			else pending.reject(new Error(typeof frame.error === "string" ? frame.error : "External executor failed"));
			return;
		}
		if (type === "executor_models" || type === "executor_event" || type === "executor_progress") {
			const owner = typeof frame.agentId === "string" ? callbackOwners.get(frame.agentId) : undefined;
			if (!owner) throw new Error("Native parent callback ownership changed");
			if (type === "executor_models") {
				respond(id, type, workerModelChoices(owner));
			} else if (type === "executor_progress") {
				if (!isRecord(frame.progress) || frame.progress.id !== owner.id)
					throw new Error("Invalid child progress identity");
				owner.onProgress?.(frame.progress as unknown as Parameters<NonNullable<ExecutorOptions["onProgress"]>>[0]);
				respond(id, type, null);
			} else {
				if (
					![TASK_SUBAGENT_EVENT_CHANNEL, TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL].includes(
						frame.channel as string,
					)
				)
					throw new Error("Invalid child event channel");
				owner.eventBus?.emit(frame.channel as string, frame.payload);
				if (owner.subagentEventBus !== owner.eventBus)
					owner.subagentEventBus?.emit(frame.channel as string, frame.payload);
				respond(id, type, null);
			}
			return;
		}
		if (closing) throw new Error("Native worker is closing");
		if (type === "workspace_plan") {
			if (launch || admitting || workspace) throw new Error("This native worker already owns a child or workspace");
			admitting = true;
			try {
				workspace = await ExecutorWorkspace.plan(frame.plan);
				lifetime.signal.throwIfAborted();
				respond(id, type, workspace.snapshot());
			} finally {
				admitting = false;
			}
			return;
		}
		if (type === "workspace_release" && workspace) {
			if (frame.agentId !== workspace.plan.agentId) throw new Error("Workspace target does not match this worker");
			closing = true;
			turn?.abort();
			await running?.catch(() => {});
			await workspace.release();
			await AgentLifecycleManager.global().dispose();
			respond(id, type, workspace.snapshot());
			return;
		}
		// Worker role: the parent streams output and bridge calls back into a running Eval cell.
		const serviced = serviceClients?.handle(type, frame, lifetime.signal);
		if (serviced) {
			respond(id, type, await serviced);
			return;
		}
		// Parent role: a nested child reaches the memory and Eval kernels this process owns.
		if (type === "executor_memory" || type === "executor_eval" || type === "executor_eval_release") {
			const owner = typeof frame.agentId === "string" ? callbackOwners.get(frame.agentId) : undefined;
			if (!owner) throw new Error("Native parent service is no longer available");
			const abort = new AbortController();
			callbackRuns.set(id, abort);
			const signal = AbortSignal.any([abort.signal, lifetime.signal]);
			try {
				if (type === "executor_memory") respond(id, type, await serveWorkerMemory(owner, frame, signal));
				else if (type === "executor_eval_release") respond(id, type, await serveWorkerEvalRelease(owner, frame));
				else {
					const requestWorker = <T>(command: string, data: Record<string, unknown>, requestSignal?: AbortSignal) =>
						ownerTransport.request<T>(command, data, requestSignal);
					respond(id, type, await serveWorkerEval(owner, frame, requestWorker, signal));
				}
			} finally {
				callbackRuns.delete(id);
			}
			return;
		}
		if (type === "executor_tool_cancel") {
			if (typeof frame.targetId !== "string") throw new Error("Missing callback cancellation target");
			callbackRuns.get(frame.targetId)?.abort();
			respond(id, type, null);
			return;
		}
		if (type === "executor_tool_call") {
			if (
				typeof frame.agentId !== "string" ||
				typeof frame.toolName !== "string" ||
				typeof frame.toolCallId !== "string" ||
				!isRecord(frame.arguments)
			)
				throw new Error("Invalid child callback request");
			const owner = callbackOwners.get(frame.agentId);
			const tool = owner?.customTools?.find(tool => tool.name === frame.toolName);
			const parent = registry.get(owner?.parentAgentId ?? "")?.session;
			if (!owner || !tool || !parent || !owner.modelRegistry)
				throw new Error("Native parent callback is no longer available");
			if (!validateJsonSchemaValue(toolWireSchema(tool), frame.arguments).success)
				throw new Error("Invalid child callback arguments");
			const abort = new AbortController();
			callbackRuns.set(id, abort);
			try {
				const result = await tool.execute(
					frame.toolCallId,
					frame.arguments,
					partialResult => emit({ type: "executor_tool_update", id, partialResult }),
					{
						sessionManager: parent.sessionManager,
						modelRegistry: owner.modelRegistry,
						model: parent.model,
						isIdle: () => !parent.isStreaming,
						hasQueuedMessages: () => parent.queuedMessageCount > 0,
						abort: () => abort.abort(),
						settings: owner.settings,
						localProtocolOptions: owner.localProtocolOptions,
					},
					AbortSignal.any([abort.signal, lifetime.signal]),
				);
				respond(id, type, result);
			} finally {
				callbackRuns.delete(id);
			}
			return;
		}
		if (type === "executor_credential") {
			if (
				typeof frame.agentId !== "string" ||
				typeof frame.provider !== "string" ||
				typeof frame.modelId !== "string"
			)
				throw new Error("Invalid credential callback identity");
			const owner = callbackOwners.get(frame.agentId);
			const model = owner?.modelRegistry?.find(frame.provider, frame.modelId);
			if (!owner?.getApiKey || !model) throw new Error("Parent credential callback is unavailable");
			respond(id, type, await resolveApiKeyOnce(await owner.getApiKey(model), lifetime.signal));
			return;
		}
		if (type === "executor_artifact") {
			if (typeof frame.agentId !== "string" || typeof frame.toolType !== "string")
				throw new Error("Invalid artifact callback identity");
			const manager = callbackOwners.get(frame.agentId)?.parentArtifactManager;
			if (!manager) throw new Error("Parent artifact allocator is unavailable");
			respond(id, type, await manager.allocatePath(frame.toolType));
			return;
		}
		if (type === "executor_release_resources") {
			if (typeof frame.agentId !== "string") throw new Error("Missing resource owner identity");
			const owner = callbackOwners.get(frame.agentId);
			if (!owner) throw new Error("Native resource owner is unavailable");
			await releaseWorkerEval(owner);
			await owner.onRelease?.();
			callbackOwners.delete(frame.agentId);
			respond(id, type, null);
			return;
		}
		if (type === "start" || type === "workspace_prepare") {
			if (coordinator || coordinatorOpening) throw new Error("A coordinator cannot also own a worker workspace");
			if (launch || admitting) throw new Error("This native worker already owns a child");
			if (!isRecord(frame.options) || !isRecord(frame.options.agent))
				throw new Error("Missing resolved launch options");
			const options = parseHostedExecutorLaunch(frame.options);
			// Nested ids are dot-joined segments ("Parent.Child"); an empty segment would allow `..` in the transcript path.
			if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(options.id) || options.id === "main")
				throw new Error("Invalid native child id");
			if (!path.isAbsolute(options.cwd) || (options.worktree !== undefined && !path.isAbsolute(options.worktree)))
				throw new Error("Child cwd must be absolute");
			if (
				typeof options.sessionFile !== "string" ||
				!path.isAbsolute(options.sessionFile) ||
				!options.sessionFile.endsWith(".jsonl")
			)
				throw new Error("A native parent transcript is required");
			if (options.artifactsDir !== options.sessionFile.slice(0, -6))
				throw new Error("Child artifacts must belong to the parent transcript");
			if (type === "workspace_prepare") {
				if (!workspace) throw new Error("Reserve a native workspace before preparing it");
				workspace.validateLaunch(options);
			} else if (workspace) {
				throw new Error("Use workspace_prepare and workspace_run for the reserved workspace");
			}
			if (!isRecord(frame.settings)) throw new Error("Parent settings snapshot is required");
			if (
				!isRecord(frame.authorizedModel) ||
				typeof frame.authorizedModel.provider !== "string" ||
				typeof frame.authorizedModel.id !== "string"
			) {
				throw new Error("An authorized provider and model are required");
			}
			authorizedModel = { provider: frame.authorizedModel.provider, id: frame.authorizedModel.id };
			const definitions = frame.tools ?? [];
			if (
				!Array.isArray(definitions) ||
				!definitions.every(
					tool =>
						isRecord(tool) &&
						typeof tool.name === "string" &&
						typeof tool.description === "string" &&
						isRecord(tool.parameters),
				)
			) {
				throw new Error("Invalid host tool definitions");
			}
			const local = frame.localProtocol;
			if (
				local !== undefined &&
				(!isRecord(local) ||
					(local.artifactsDir !== null &&
						(typeof local.artifactsDir !== "string" || !path.isAbsolute(local.artifactsDir))) ||
					(local.sessionId !== null && typeof local.sessionId !== "string"))
			)
				throw new Error("Invalid parent local resource identity");
			const localProtocolOptions = isRecord(local)
				? {
						getArtifactsDir: () => (typeof local.artifactsDir === "string" ? local.artifactsDir : null),
						getSessionId: () => (typeof local.sessionId === "string" ? local.sessionId : null),
					}
				: undefined;
			let extensionRoots: EffectiveExtensionRoots | undefined;
			if (frame.extensionRoots !== undefined) {
				const roots = frame.extensionRoots;
				if (
					!isRecord(roots) ||
					!Array.isArray(roots.explicit) ||
					!roots.explicit.every(value => typeof value === "string") ||
					!Array.isArray(roots.configured) ||
					!roots.configured.every(value => typeof value === "string") ||
					(roots.mode !== "merge" && roots.mode !== "explicit-only") ||
					(roots.configuredLevel !== "user" && roots.configuredLevel !== "project")
				)
					throw new Error("Invalid extension discovery roots");
				extensionRoots = {
					explicit: roots.explicit,
					configured: roots.configured,
					mode: roots.mode,
					configuredLevel: roots.configuredLevel,
				};
			}
			const customTools: CustomTool[] = (definitions as RpcHostToolDefinition[]).map(definition => ({
				...definition,
				label: definition.label ?? definition.name,
				execute: (toolCallId, params, update, _context, signal) => {
					if (!isRecord(params)) throw new Error("Host tool arguments must be an object");
					return hostTools.requestExecution(definition, toolCallId, params, signal, update);
				},
			}));
			const shared = frame.services === undefined ? undefined : servicesSchema(frame.services);
			if (shared instanceof schema.errors) throw new Error(`Invalid parent services: ${shared.summary}`);
			if (shared?.eval && options.parentEvalSessionId === undefined)
				throw new Error("Shared Eval requires the parent's Eval session identity");
			if (
				peers &&
				(peers.localId !== options.id ||
					peers.localSessionFile !== path.join(options.artifactsDir!, `${options.id}.jsonl`))
			)
				throw new Error("Launch does not match the native peer identity");
			const childSettings = Settings.initFromSnapshot(frame.settings);
			let telemetry: ImportedWorkerTelemetry | undefined;
			if (frame.telemetry !== undefined) {
				const transferred = telemetrySchema(frame.telemetry);
				if (transferred instanceof schema.errors)
					throw new Error(`Invalid parent telemetry: ${transferred.summary}`);
				// Exporter registration is asynchronous; hold the claim so a concurrent start cannot slip in.
				admitting = true;
				try {
					telemetry = await importWorkerTelemetry(
						transferred as WorkerTelemetry,
						cfgTelemetryOtlpExportEnabled.get(childSettings),
					);
				} finally {
					admitting = false;
				}
				lifetime.signal.throwIfAborted();
			}
			launch = options;
			if (shared && (shared.memory || shared.eval)) {
				serviceClients = createWorkerServiceClients(ownerTransport, options.id, {
					memory: shared.memory,
					// Model-visible runtime summary; the parent computed it from its own registry.
					eval: shared.eval ? { state: shared.eval.state as EvalStateSnapshot | null } : undefined,
				});
			}
			disconnectOwner = registerExternalSubagentExecutor(
				path.join(options.artifactsDir!, `${options.id}.jsonl`),
				ownerExecutor,
			);
			turn = new AbortController();
			const signal = AbortSignal.any([turn.signal, lifetime.signal]);
			running = context.with(telemetry?.context ?? context.active(), async () => {
				const modelRegistry = new ModelRegistry(await discoverAuthStorage());
				signal.throwIfAborted();
				let artifacts: ArtifactManager | undefined;
				if (isRecord(frame.callbacks) && frame.callbacks.artifacts === true) {
					artifacts = new ArtifactManager(options.artifactsDir!);
					artifacts.allocatePath = async toolType => {
						const allocated = await ownerTransport.request<{ id: string; path: string }>(
							"artifact",
							{ agentId: options.id, toolType },
							turnSignal(),
						);
						if (
							!isRecord(allocated) ||
							typeof allocated.id !== "string" ||
							typeof allocated.path !== "string" ||
							!path.isAbsolute(allocated.path)
						)
							throw new Error("Invalid parent artifact allocation");
						return allocated;
					};
				}
				let cleanup: Promise<void> | undefined;
				const nativeOptions: ExecutorOptions = {
					...options,
					parentTelemetry: telemetry?.config,
					parentServices: serviceClients?.services,
					settings: childSettings,
					modelRegistry,
					getApiKey: model => {
						if (
							!authorizedModel ||
							model.provider !== authorizedModel.provider ||
							model.id !== authorizedModel.id
						)
							throw new Error("Resolved model differs from the authorized native worker model");
						if (isRecord(frame.callbacks) && frame.callbacks.credentials === true) {
							return ownerTransport.request<string | undefined>(
								"credential",
								{ agentId: options.id, provider: model.provider, modelId: model.id },
								turnSignal(),
							);
						}
						return modelRegistry.getApiKey(model);
					},
					customTools,
					parentArtifactManager: artifacts,
					localProtocolOptions,
					extensionRoots: extensionRoots ? () => extensionRoots : undefined,
					onRelease:
						isRecord(frame.callbacks) && frame.callbacks.release === true
							? async () => {
									await ownerTransport.request(
										"release_resources",
										{ agentId: options.id },
										AbortSignal.timeout(5000),
									);
								}
							: undefined,
					onCleanupDeferred: completion => {
						cleanup = completion;
					},
					signal,
					eventBus: events,
					subagentEventBus: events,
					onProgress: progress => emit({ type: "progress", progress }),
				};
				modelOwner = nativeOptions;
				if (type === "workspace_prepare") {
					await workspace!.prepare(nativeOptions);
					return workspace!.snapshot();
				}
				const result = await runSubprocess(nativeOptions);
				await cleanup;
				await flushTelemetryExport();
				return result;
			});
			try {
				respond(id, type, await running);
			} finally {
				running = undefined;
				if (type === "start") turn = undefined;
			}
			return;
		}
		if (type === "inspect") {
			respond(id, type, {
				pid: process.pid,
				agentId: launch?.id,
				busy: running !== undefined,
				workspace: workspace?.snapshot(),
				coordinator: coordinator ? { ...coordinator.identity, providerCalls: coordinator.providerCalls, active: callbackRuns.size } : undefined,
			});
			return;
		}
		if (!launch) throw new Error("Start a native child before sending controls");
		if (frame.agentId !== launch.id) throw new Error("Control target does not match this worker");
		if (type.startsWith("terminal_")) {
			if (typeof frame.viewId !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(frame.viewId))
				throw new Error("Invalid worker terminal identity");
			if (type === "terminal_attach") {
				if (terminal && terminalView !== frame.viewId) throw new Error("Worker terminal already has an owner");
				if (terminal && !terminalReady) throw new Error("Worker terminal is still attaching");
				if (
					!Number.isInteger(frame.cols) ||
					!Number.isInteger(frame.rows) ||
					Number(frame.cols) < 2 ||
					Number(frame.cols) > 500 ||
					Number(frame.rows) < 2 ||
					Number(frame.rows) > 300
				)
					throw new Error("Invalid worker terminal dimensions");
				if (!terminal) {
					const session = await AgentLifecycleManager.global().ensureLive(launch.id);
					if (closing || terminal) throw new Error("Worker terminal attachment is no longer available");
					terminalView = frame.viewId;
					const viewId = terminalView;
					terminal = new ExecutorTerminal(Number(frame.cols), Number(frame.rows), data =>
						emit({ type: "terminal_output", viewId, agentId: launch!.id, data }),
					);
					try {
						await terminal.attach(session, {
							agentId: launch.id,
							submit: async (text, options) => {
								if (options.images?.length) throw new Error("Image input is not supported by the worker owner");
								await ownerTransport.request(
									"terminal_submit",
									{ agentId: launch!.id, viewId, text, streamingBehavior: options.streamingBehavior },
									lifetime.signal,
								);
								return true;
							},
						});
						terminalReady = true;
					} catch (error) {
						terminal.dispose();
						terminal = undefined;
						terminalView = "";
						throw error;
					}
				} else {
					terminal.resize(Number(frame.cols), Number(frame.rows));
					terminal.setVisible(true);
				}
				respond(id, type, {
					agentId: launch.id,
					sessionId: terminal.mode!.session.sessionId,
					sessionFile: terminal.mode!.session.sessionFile,
					pid: process.pid,
				});
				return;
			}
			if (!terminal || !terminalReady || frame.viewId !== terminalView)
				throw new Error("Worker terminal attachment changed");
			switch (type) {
				case "terminal_message": {
					if (
						typeof frame.text !== "string" ||
						Buffer.byteLength(frame.text) > 8192 ||
						(frame.streamingBehavior !== "steer" && frame.streamingBehavior !== "followUp")
					)
						throw new Error("Invalid worker terminal submission");
					const session = terminal.mode!.session;
					if (!running || !session.isStreaming)
						throw new Error("Worker has no active turn; approve a follow-up to continue");
					if (frame.streamingBehavior === "followUp") await session.followUp(frame.text);
					else await session.steer(frame.text);
					respond(id, type, { to: launch.id, outcome: "injected" });
					return;
				}
				case "terminal_input":
					if (typeof frame.data !== "string" || Buffer.byteLength(frame.data) > 65536)
						throw new Error("Invalid worker terminal input");
					terminal.input(frame.data);
					break;
				case "terminal_resize":
					if (
						!Number.isInteger(frame.cols) ||
						!Number.isInteger(frame.rows) ||
						Number(frame.cols) < 2 ||
						Number(frame.cols) > 500 ||
						Number(frame.rows) < 2 ||
						Number(frame.rows) > 300
					)
						throw new Error("Invalid worker terminal dimensions");
					terminal.resize(Number(frame.cols), Number(frame.rows));
					break;
				case "terminal_visible":
					if (typeof frame.visible !== "boolean") throw new Error("Invalid terminal visibility");
					terminal.setVisible(frame.visible);
					break;
				case "terminal_detach":
					terminal.dispose();
					terminal = undefined;
					terminalReady = false;
					terminalView = "";
					break;
				default:
					throw new Error("Unsupported worker terminal command");
			}
			respond(id, type, null);
			return;
		}
		switch (type) {
			case "workspace_run":
			case "workspace_integrate": {
				if (!workspace) throw new Error("This worker has no reserved workspace");
				if (running) throw new Error("The native child already has an active operation");
				running = type === "workspace_run" ? workspace.run() : workspace.integrate();
				try {
					const data = await running;
					if (type === "workspace_run") await flushTelemetryExport();
					respond(id, type, data);
				} finally {
					running = undefined;
					if (type === "workspace_run") turn = undefined;
				}
				return;
			}
			case "follow_up": {
				if (running) throw new Error("The native child already has an active turn");
				if (
					frame.trace !== undefined &&
					(!isRecord(frame.trace) || !Object.values(frame.trace).every(value => typeof value === "string"))
				)
					throw new Error("Invalid parent trace context");
				if (typeof frame.message !== "string") throw new Error("Follow-up message must be a string");
				if (
					frame.workPoolYieldItems !== undefined &&
					(!Array.isArray(frame.workPoolYieldItems) ||
						!frame.workPoolYieldItems.every(
							item => isRecord(item) && typeof item.id === "string" && Number.isInteger(item.index),
						))
				)
					throw new Error("Invalid workpool item identities");
				if (
					frame.maxRuntimeMs !== undefined &&
					(typeof frame.maxRuntimeMs !== "number" ||
						!Number.isFinite(frame.maxRuntimeMs) ||
						frame.maxRuntimeMs < 0)
				)
					throw new Error("Invalid follow-up runtime limit");
				if (frame.modelSelection !== undefined) {
					const selection = frame.modelSelection;
					if (!isRecord(selection) || !modelOwner || !registry.get(launch.id))
						throw new Error("Native follow-up model selection is unavailable");
					const choice = workerModelChoices(modelOwner).find(
						candidate => candidate.provider === selection.provider && candidate.id === selection.id,
					);
					const thinkingLevel = choice?.efforts.find(effort => effort === selection.thinkingLevel);
					if (
						!choice ||
						(choice.efforts.length > 0 ? thinkingLevel === undefined : selection.thinkingLevel !== undefined)
					)
						throw new Error("Select an available native model and an allowed thinking level");
					modelSelection = { provider: choice.provider, id: choice.id, thinkingLevel };
					authorizedModel = { provider: choice.provider, id: choice.id };
				}
				turn = new AbortController();
				const followUpSignal = AbortSignal.any([turn.signal, lifetime.signal]);
				const workPoolYieldItems = Array.isArray(frame.workPoolYieldItems)
					? frame.workPoolYieldItems.map(item => ({ id: String(item.id), index: Number(item.index) }))
					: undefined;
				const maxRuntimeMs = typeof frame.maxRuntimeMs === "number" ? frame.maxRuntimeMs : launch.maxRuntimeMs;
				const followUpLaunch = launch;
				running = context.with(
					isRecord(frame.trace) ? propagation.extract(ROOT_CONTEXT, frame.trace) : context.active(),
					async () => {
						const execute = () =>
							runSubagentFollowUpTurn({
								...followUpLaunch,
								message: String(frame.message),
								modelSelection,
								workPoolYieldItems,
								maxRuntimeMs,
								signal: followUpSignal,
								eventBus: events,
								subagentEventBus: events,
								onProgress: progress => emit({ type: "progress", progress }),
							});
						const result = workspace ? await workspace.followUp(execute) : await execute();
						await flushTelemetryExport();
						return result;
					},
				);
				try {
					respond(id, type, await running);
				} finally {
					running = undefined;
					turn = undefined;
				}
				return;
			}
			case "send":
				if (
					!isRecord(frame.message) ||
					typeof frame.message.id !== "string" ||
					typeof frame.message.ts !== "number" ||
					typeof frame.message.from !== "string" ||
					typeof frame.message.body !== "string" ||
					frame.message.to !== launch.id
				)
					throw new Error("Invalid routed message identity");
				respond(
					id,
					type,
					await IrcBus.global().deliver(
						frame.message as unknown as IrcMessage,
						isRecord(frame.options)
							? {
									expectsReply: frame.options.expectsReply === true,
									suppressRelay: frame.options.suppressRelay === true,
									activeOnly: frame.options.activeOnly === true,
								}
							: undefined,
					),
				);
				return;
			case "cancel":
			case "release": {
				closing = true;
				terminal?.dispose();
				terminal = undefined;
				terminalReady = false;
				terminalView = "";
				turn?.abort();
				await running?.catch(() => {});
				const released = workspace
					? await workspace.release(type === "cancel" || frame.tombstone === true)
					: await AgentLifecycleManager.global().release(launch.id, undefined, {
							tombstone: type === "cancel" || frame.tombstone === true,
						});
				// This process exists for one child; its descendants go with it, through their owner.
				await AgentLifecycleManager.global().dispose();
				respond(id, type, released);
				return;
			}
			case "park":
				if (running) throw new Error("Cannot park an active native turn");
				terminal?.dispose();
				terminal = undefined;
				terminalReady = false;
				terminalView = "";
				await AgentLifecycleManager.global().park(launch.id);
				respond(id, type, { status: registry.get(launch.id)?.status });
				return;
			default:
				throw new Error(`Unsupported native worker command: ${type}`);
		}
	};
	emit({
		type: "ready",
		protocol: "omp-native-executor",
		version: 1,
		capabilities: ["workspace_v1", "parent_relay_v1", "peer_registry_v1", "operator_controls_v1", "terminal_v1", "coordinator_v1"],
		pid: process.pid,
	});
	try {
		await readRpcInputFrames(
			input,
			frame => {
				const control = run(frame).catch(error =>
					fail(isRecord(frame) ? frame.id : undefined, isRecord(frame) ? frame.type : undefined, error),
				);
				controls.add(control);
				void control.finally(() => controls.delete(control));
			},
			error => fail(undefined, undefined, error),
		);
	} finally {
		terminal?.dispose();
		closing = true;
		lifetime.abort(new Error("Native executor owner disconnected"));
		relayingRegistry = true;
		peers?.close();
		relayingRegistry = false;
		hostTools.close("Native executor owner disconnected");
		for (const request of ownerRequests.values()) request.reject(new Error("Native executor owner disconnected"));
		try {
			await untilAborted(AbortSignal.timeout(5000), () => Promise.allSettled(controls));
			coordinator?.close();
		} finally {
			try {
				await workspace?.release();
				await AgentLifecycleManager.global().dispose();
			} finally {
				disconnectOwner?.();
				unsubscribe();
				callbackOwners.clear();
				await flushTelemetryExport().catch(() => {});
				await writer.close();
			}
		}
	}
}
