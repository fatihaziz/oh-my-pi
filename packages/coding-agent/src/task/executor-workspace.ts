import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type as schema } from "@oh-my-pi/omptype";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { isEnoent, untilAborted } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { replaceFileAtomically } from "../utils/atomic-file";
import type { ExecutorOptions } from "./executor";
import {
	applyEligibleNestedPatches,
	captureIsolationResult,
	makeIsolationCommitMessage,
	mergeIsolatedChanges,
	prepareIsolationContext,
	runIsolatedSubprocess,
	type IsolatedRunOptions,
	type IsolationContext,
	type RetainedWorkspace,
} from "./isolation-runner";
import { cfgIsolationBackend } from "./settings";
import {
	captureDeltaPatch,
	getRepoRoot,
	getTaskIsolationPath,
	parseIsolationBackend,
	type IsolationHandle,
} from "./worktree";

const planSchema = schema({
	agentId: "string",
	leaseId: "string",
	cwd: "string",
	sessionFile: "string",
	merge: "'patch' | 'branch'",
	apply: "boolean",
	"+": "reject",
});

type WorkspacePlan = typeof planSchema.infer;
type WorkspacePhase =
	| "planned"
	| "preparing"
	| "prepared"
	| "running"
	| "settled"
	| "integrating"
	| "retained"
	| "released"
	| "failed";

export interface WorkspaceIntegration {
	changesApplied: boolean | null;
	mergeSummary: string;
}

/** One native workspace, controlled by its process owner; no queue or scheduling policy. */
export class ExecutorWorkspace {
	readonly plan: WorkspacePlan;
	readonly repoRoot: string;
	readonly cwd: string;
	readonly checkpointPath: string;
	#phase: WorkspacePhase = "planned";
	#turn = 0;
	#abort = new AbortController();
	#ready = Promise.withResolvers<void>();
	#permit = Promise.withResolvers<void>();
	#execution?: Promise<SingleResult>;
	#options?: IsolatedRunOptions;
	#releasePromise?: Promise<boolean>;
	#cleanup?: Promise<void>;
	#context?: IsolationContext;
	#handle?: IsolationHandle;
	#result?: SingleResult;
	#releaseArtifacts?: Pick<SingleResult, "patchPath" | "branchName" | "branchBaseSha" | "nestedPatchPaths">;
	#integration?: WorkspaceIntegration;
	#retained?: RetainedWorkspace;
	#cause?: string;

	constructor(plan: WorkspacePlan, repoRoot: string) {
		this.plan = plan;
		this.repoRoot = repoRoot;
		this.cwd = getTaskIsolationPath(repoRoot, plan.leaseId);
		this.checkpointPath = path.join(plan.sessionFile.slice(0, -6), ".workspaces", plan.leaseId, "workspace.json");
		// Preparation can fail before a caller starts waiting for the ready barrier.
		void this.#ready.promise.catch(() => {});
	}

	static async plan(input: unknown): Promise<ExecutorWorkspace> {
		const plan = planSchema(input);
		if (plan instanceof schema.errors) throw new Error(`Invalid workspace plan: ${plan.summary}`);
		if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(plan.agentId) || plan.agentId === "main")
			throw new Error("Invalid native child identity");
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(plan.leaseId))
			throw new Error("Workspace lease must be a fresh UUID");
		if (!path.isAbsolute(plan.cwd) || !path.isAbsolute(plan.sessionFile) || !plan.sessionFile.endsWith(".jsonl"))
			throw new Error("Workspace source and parent transcript must be absolute");
		const repoRoot = await fs.realpath(await getRepoRoot(plan.cwd));
		const workspace = new ExecutorWorkspace(plan, repoRoot);
		await workspace.#assertUnused();
		return workspace;
	}

	snapshot() {
		return {
			...this.plan,
			repoRoot: this.repoRoot,
			cwd: this.cwd,
			worktree: this.cwd,
			checkpointPath: this.checkpointPath,
			phase: this.#phase,
			turn: this.#turn,
			backend: this.#handle?.backend,
			retained: this.#retained,
			cause: this.#cause,
			integration: this.#integration,
			releaseArtifacts: this.#releaseArtifacts,
		};
	}

	validateLaunch(options: Pick<ExecutorOptions, "id" | "cwd" | "worktree" | "sessionFile">): void {
		if (this.#phase !== "planned") throw new Error(`Workspace is ${this.#phase}, not planned`);
		if (
			options.id !== this.plan.agentId ||
			options.sessionFile !== this.plan.sessionFile ||
			path.resolve(options.cwd) !== this.cwd ||
			options.worktree !== this.cwd
		)
			throw new Error("Native launch does not match its reserved workspace");
	}

	async #assertUnused(): Promise<void> {
		for (const target of [path.dirname(this.cwd), path.dirname(this.checkpointPath)]) {
			try {
				await fs.lstat(target);
			} catch (error) {
				if (isEnoent(error)) continue;
				throw error;
			}
			throw new Error(`Workspace namespace already exists; use a new lease: ${target}`);
		}
	}

	async #persist(): Promise<void> {
		const result = this.#result;
		const checkpoint = {
			version: 1,
			...this.snapshot(),
			baseline: this.#context?.baseline,
			result: result && {
				id: result.id,
				exitCode: result.exitCode,
				error: result.error,
				aborted: result.aborted,
				outputPath: result.outputPath,
				patchPath: result.patchPath,
				hasRootChanges: result.hasRootChanges,
				branchName: result.branchName,
				branchBaseSha: result.branchBaseSha,
				nestedPatchPaths: result.nestedPatchPaths,
			},
		};
		const staged = `${this.checkpointPath}.${crypto.randomUUID()}.tmp`;
		try {
			await Bun.write(staged, JSON.stringify(checkpoint));
			await replaceFileAtomically(staged, this.checkpointPath);
		} finally {
			await fs.rm(staged, { force: true });
		}
	}

	async prepare(baseOptions: ExecutorOptions): Promise<void> {
		this.validateLaunch(baseOptions);
		this.#phase = "preparing";
		try {
			await this.#assertUnused();
			await fs.mkdir(path.dirname(path.dirname(this.checkpointPath)), { recursive: true });
			await fs.mkdir(path.dirname(this.checkpointPath));
			await this.#persist();
			const context = await prepareIsolationContext(this.repoRoot);
			const signal = baseOptions.signal
				? AbortSignal.any([baseOptions.signal, this.#abort.signal])
				: this.#abort.signal;
			signal.throwIfAborted();
			this.#turn = 1;
			const startedAt = Date.now();
			const settings = baseOptions.settings ?? Settings.isolated();
			const options: IsolatedRunOptions = {
				baseOptions: {
					...baseOptions,
					settings,
					signal,
					onCleanupDeferred: completion => {
						this.#cleanup = completion;
						baseOptions.onCleanupDeferred?.(completion);
					},
				},
				context,
				preferredBackend: parseIsolationBackend(cfgIsolationBackend.get(settings)),
				agentId: this.plan.agentId,
				isolationId: this.plan.leaseId,
				exclusive: true,
				mergeMode: this.plan.merge,
				artifactsDir: path.join(path.dirname(this.checkpointPath), "1"),
				description: baseOptions.description,
				buildCommitMessage: makeIsolationCommitMessage({ settings, modelRegistry: baseOptions.modelRegistry }),
				onPrepared: async (handle, preparedContext) => {
					if (handle.mergedDir !== this.cwd)
						throw new Error("Native workspace path differs from the owner reservation");
					this.#handle = handle;
					this.#context = preparedContext;
					this.#phase = "prepared";
					await this.#persist();
					this.#ready.resolve();
					await untilAborted(signal, () => this.#permit.promise);
					signal.throwIfAborted();
				},
				onRetained: retained => {
					this.#retained = retained;
				},
				onReleaseCaptured: ({ patchPath, branchName, branchBaseSha, nestedPatchPaths }) => {
					this.#releaseArtifacts = { patchPath, branchName, branchBaseSha, nestedPatchPaths };
				},
				buildFailureResult: error => {
					const message = error instanceof Error ? error.message : String(error);
					return {
						index: baseOptions.index,
						id: baseOptions.id,
						agent: baseOptions.agent.name,
						agentSource: baseOptions.agent.source,
						task: baseOptions.task,
						assignment: baseOptions.assignment,
						description: baseOptions.description,
						modelOverride: baseOptions.modelOverride,
						modelRole: baseOptions.modelRole,
						exitCode: 1,
						output: "",
						stderr: message,
						truncated: false,
						durationMs: Date.now() - startedAt,
						tokens: 0,
						requests: 0,
						error: message,
						aborted: signal.aborted,
					};
				},
			};
			this.#options = options;
			this.#execution = runIsolatedSubprocess(options)
				.then(async result => {
					this.#ready.reject(new Error(result.error ?? "Workspace preparation ended before ready"));
					this.#result = result;
					this.#phase = this.#retained ? "retained" : "settled";
					await this.#persist();
					return result;
				})
				.catch(error => {
					this.#phase = this.#retained ? "retained" : "failed";
					this.#cause = error instanceof Error ? error.message : String(error);
					this.#ready.reject(error);
					throw error;
				});
			void this.#execution.catch(() => {});
			await this.#ready.promise;
		} catch (error) {
			this.#phase = this.#retained ? "retained" : "failed";
			this.#cause = error instanceof Error ? error.message : String(error);
			throw error;
		}
	}

	async run(): Promise<SingleResult> {
		if (this.#phase !== "prepared" || !this.#execution) throw new Error("Workspace is not ready to run");
		this.#phase = "running";
		await this.#persist();
		this.#permit.resolve();
		return this.#execution;
	}

	/** A captured turn becomes the next delta baseline; branch mode starts from its preserved commit. */
	async #advanceBaseline(): Promise<void> {
		if (!this.#context || !this.#handle) throw new Error("Workspace baseline is unavailable");
		const baseline = this.#context.baseline;
		const anchor = structuredClone(baseline);
		if (this.plan.merge === "branch") {
			const source = vcs.requireGit(this.repoRoot);
			const base =
				!this.plan.apply && this.#result?.branchName
					? await source.resolveRef(this.#result.branchName)
					: await source.headSha();
			if (!base) throw new Error("Captured branch baseline is no longer available");
			// Only the detached native workspace changes HEAD. Soft reset preserves its index and files.
			await vcs.requireGit(this.cwd).reset("soft", base);
			anchor.root.headCommit = base;
		}
		for (const repo of [anchor.root, ...anchor.nested.map(entry => entry.baseline)]) {
			repo.staged = "";
			repo.unstaged = "";
			repo.untracked = [];
			repo.untrackedPatch = "";
		}
		const current = await captureDeltaPatch(this.cwd, anchor);
		anchor.root.unstaged = current.rootPatch;
		for (const entry of anchor.nested)
			entry.baseline.unstaged =
				current.nestedPatches.find(patch => patch.relativePath === entry.relativePath)?.patch ?? "";
		baseline.root = anchor.root;
		baseline.nested = anchor.nested;
	}

	async integrate(): Promise<WorkspaceIntegration> {
		if (this.#integration) {
			if (this.#phase !== "settled") throw new Error(this.#cause ?? "Integration checkpoint is not settled");
			return this.#integration;
		}
		if (this.#phase !== "settled" || !this.#result || !this.#options)
			throw new Error("No captured turn is ready for integration");
		this.#phase = "integrating";
		// An interrupted integration is uncertain, never an automatic replay after restart.
		await this.#persist();
		const result = this.#result;
		let integration: WorkspaceIntegration = { changesApplied: null, mergeSummary: "" };
		if (this.plan.apply && result.exitCode === 0 && !result.aborted && !result.error) {
			const root = await mergeIsolatedChanges({ result, repoRoot: this.repoRoot, mergeMode: this.plan.merge });
			const nested = await applyEligibleNestedPatches({
				result,
				repoRoot: this.repoRoot,
				mergeMode: this.plan.merge,
				...root,
				commitMessage: this.#options.buildCommitMessage?.(),
			});
			integration = {
				changesApplied: nested.failed ? false : root.changesApplied,
				mergeSummary: root.summary + nested.summary,
			};
		}
		this.#integration = integration;
		this.#phase = "settled";
		try {
			await this.#persist();
		} catch (error) {
			this.#phase = "failed";
			this.#cause = error instanceof Error ? error.message : String(error);
			throw error;
		}
		return integration;
	}

	async followUp(operation: () => Promise<SingleResult>): Promise<SingleResult> {
		if (this.#phase !== "settled" || !this.#integration || !this.#context || !this.#handle || !this.#options)
			throw new Error("Settle and integrate the previous turn before a follow-up");
		if (this.#integration.changesApplied === false)
			throw new Error(
				"Resolve the failed integration before reusing this workspace; captured artifacts remain available",
			);
		if (!AgentLifecycleManager.global().has(this.plan.agentId))
			throw new Error("Native child no longer owns a live workspace");
		this.#phase = "running";
		if (this.#result?.exitCode === 0 && !this.#result.error && !this.#result.aborted) await this.#advanceBaseline();
		this.#turn++;
		this.#options.artifactsDir = path.join(path.dirname(this.checkpointPath), String(this.#turn));
		this.#options.isolationId = `${this.plan.leaseId}-${this.#turn}`;
		this.#result = undefined;
		this.#integration = undefined;
		await this.#persist();
		this.#execution = (async () => {
			const startedAt = Date.now();
			let result: SingleResult;
			try {
				result = await operation();
			} catch (error) {
				result = this.#options!.buildFailureResult(error);
				result.durationMs = Date.now() - startedAt;
			}
			try {
				await this.#cleanup;
			} catch (error) {
				this.#retained = { dir: this.cwd, sidecarOk: false };
				throw error;
			}
			const captured = await captureIsolationResult(this.#options!, this.#handle!, this.#context!.baseline, result);
			this.#result = captured.result;
			this.#retained = captured.retained;
			this.#phase = captured.retained ? "retained" : "settled";
			await this.#persist();
			return captured.result;
		})();
		try {
			return await this.#execution;
		} catch (error) {
			this.#phase = this.#retained ? "retained" : "failed";
			this.#cause = error instanceof Error ? error.message : String(error);
			throw error;
		}
	}

	release(tombstone = false): Promise<boolean> {
		this.#releasePromise ??= (async () => {
			this.#abort.abort(new Error("Workspace released by its owner"));
			await this.#execution?.catch(() => {});
			if (this.#options) {
				this.#options.artifactsDir = path.join(path.dirname(this.checkpointPath), "release");
				this.#options.isolationId = `${this.plan.leaseId}-release`;
			}
			try {
				const released = await AgentLifecycleManager.global().release(this.plan.agentId, undefined, { tombstone });
				this.#phase = this.#retained ? "retained" : "released";
				return released;
			} catch (error) {
				this.#phase = this.#retained ? "retained" : "failed";
				this.#cause = error instanceof Error ? error.message : String(error);
				throw error;
			} finally {
				if (this.#turn > 0) await this.#persist();
			}
		})();
		return this.#releasePromise;
	}
}
