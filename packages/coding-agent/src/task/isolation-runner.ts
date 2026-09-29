/**
 * Reusable isolation lifecycle for subagent execution.
 *
 * Both `TaskTool` and the eval `agent()` bridge spawn subagents that can run
 * inside a copy-on-write worktree, capture their changes, and (optionally)
 * apply those changes back to the parent repo. The orchestration is identical
 * for both callers; this module hosts the shared lifecycle so eval `agent()`
 * does not need to round-trip through `TaskTool.#runSpawn`.
 *
 * Shape:
 *   1. {@link prepareIsolationContext} — resolve git root + capture baseline.
 *   2. {@link runIsolatedSubprocess}    — start worktree, run, capture
 *                                        changes, and transfer cleanup ownership.
 *   3. {@link mergeIsolatedChanges}     — apply captured changes back to the
 *                                        parent repo (skip when the caller
 *                                        opted out).
 *
 * Step 1 happens once per top-level call (the baseline is cloned per spawn
 * before mutation); steps 2 and 3 are per-spawn.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as natives from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { prompt } from "@oh-my-pi/pi-utils";
import isolationErrorTemplate from "../prompts/tools/isolation-error.md" with { type: "text" };
import isolationSummaryTemplate from "../prompts/tools/isolation-summary.md" with { type: "text" };
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import type { ToolSession } from "../tools";
import { generateCommitMessage } from "../utils/commit-message-generator";
import type { ExecutorOptions } from "./executor";
import { runSubprocess } from "./executor";
import { needsNativeTeardown, writeRetainedBackend } from "./isolation-ownership";
import type { NestedRepoPatch, SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import {
	applyNestedPatches,
	captureBaseline,
	captureDeltaPatch,
	cleanupIsolation,
	cleanupTaskBranches,
	type CommitToBranchResult,
	commitToBranch,
	ensureIsolation,
	getRepoRoot,
	type IsolationHandle,
	mergeTaskBranches,
	type WorktreeBaseline,
} from "./worktree";

import { cfgTaskIsolationCommits } from "./settings";

type IsoBackendKind = natives.IsoBackendKind;

/** Which isolation outcome `isolation-summary.md` should describe. */
export type IsolationSummaryKind =
	| "captured"
	| "capture-error"
	| "nested-apply-failed"
	| "not-applied"
	| "branch-merge-failed"
	| "branch-capture-failed"
	| "merge-error";

/** Context for `isolation-summary.md`; unused fields are simply absent. */
export interface IsolationSummaryContext {
	kind: IsolationSummaryKind;
	branchName?: string;
	/** Root patch path, only when it holds changes. */
	rootPatchPath?: string;
	nestedCount?: number;
	nestedPatchPaths?: string[];
	error?: string;
	conflict?: string;
}

/**
 * Render one isolation outcome as the model-facing suffix appended to a task
 * result. Always starts with a blank line so it separates from the output it
 * follows.
 */
export function renderIsolationSummary(context: IsolationSummaryContext): string {
	return `\n\n${prompt.render(isolationSummaryTemplate, { ...context })}`;
}

/** Record artifact locations for `agent://` and mark the result as an isolated run. */
function rememberAgentArtifacts(result: SingleResult): SingleResult {
	AgentRegistry.global().setHistory(result.id, {
		outputPath: result.outputPath,
		patchPath: result.patchPath,
		branchName: result.branchName,
		nestedPatchPaths: result.nestedPatchPaths,
	});
	return { ...result, isolated: true };
}

/**
 * Decide the fate of a half-built task branch after apply-back threw.
 *
 * Returns the branch name when it carries at least one commit past `baseSha`
 * — the caller must keep it, because the isolation worktree that also held
 * those objects is about to be torn down. Returns `undefined` after deleting
 * a branch that is absent, empty, or still pinned at the baseline, preserving
 * the original stale-branch cleanup for the cases where nothing is at stake.
 *
 * `revList.range` throws when the branch does not exist, which is the common
 * "commitToBranch failed before it created anything" path; that is treated as
 * "nothing to rescue" only after confirming the ref is absent. Other probe
 * failures preserve the branch because deleting it could lose the only reachable
 * copy of the agent's commits.
 */
async function rescueTaskBranch(repoRoot: string, branchName: string, baseSha: string): Promise<string | undefined> {
	const repo = vcs.git(repoRoot);
	try {
		const carriedCommits = (await vcs.requireGit(repoRoot).revListRange(baseSha, branchName)).length;
		if (carriedCommits > 0) return branchName;
	} catch {
		try {
			if (await repo?.refExists(`refs/heads/${branchName}`)) return branchName;
		} catch {
			// An inconclusive recovery probe must never risk deleting the only ref.
			return branchName;
		}
	}
	try {
		await repo?.deleteBranch(branchName, true);
	} catch {
		// Best-effort cleanup matches the old façade's tryDelete semantics.
	}
	return undefined;
}

/** Resolved repo + baseline used by every isolated spawn in a single call. */
export interface IsolationContext {
	repoRoot: string;
	baseline: WorktreeBaseline;
}

/**
 * Resolve the git repo root and capture the worktree baseline used to diff
 * each isolated spawn against. Throws when the cwd is not inside a git
 * repository; callers surface the error as a task-tool failure.
 */
export async function prepareIsolationContext(cwd: string): Promise<IsolationContext> {
	const repoRoot = await getRepoRoot(cwd);
	const baseline = await captureBaseline(repoRoot);
	return { repoRoot, baseline };
}

/** Build a commit-message callback for branch/nested commits; `undefined` ⇒ fall back to generic message. */
export type BuildCommitMessage = () => undefined | ((diff: string) => Promise<string | null>);

/**
 * Construct the commit-message factory used by isolation branch commits and
 * nested-repo patch commits. Returns a closure that, each time it's called,
 * either yields an AI-backed `(diff) => Promise<string|null>` callback (when
 * `task.isolation.commits === "ai"` and a model registry is available) or
 * `undefined` so the caller falls back to a generic commit message.
 *
 * Centralized so `TaskTool` and the eval `agent()` bridge share one wiring;
 * a drift here previously meant the two callers built subtly different
 * generators for the same setting.
 */
export function makeIsolationCommitMessage(
	session: Pick<ToolSession, "settings" | "modelRegistry" | "getSessionId">,
): BuildCommitMessage {
	return () => {
		const style = cfgTaskIsolationCommits.get(session.settings);
		if (style !== "ai" || !session.modelRegistry) return undefined;
		const registry = session.modelRegistry;
		const settings = session.settings;
		const sessionId = session.getSessionId?.() ?? undefined;
		return async (diff: string) => generateCommitMessage(diff, registry, settings, sessionId);
	};
}

export interface IsolatedRunOptions {
	/**
	 * Base run options handed to the subagent subprocess. This helper sets
	 * `worktree`, clears prepared/path extension preloads and custom-tool paths
	 * (isolated runs re-discover inside the worktree), and forwards everything
	 * else unchanged.
	 */
	baseOptions: ExecutorOptions;
	/** Context returned by {@link prepareIsolationContext}. Baseline is cloned per spawn. */
	context: IsolationContext;
	/** PAL backend hint from `parseIsolationBackend(...)` (undefined ⇒ resolver picks). */
	preferredBackend: IsoBackendKind | undefined;
	/** Native logical identity used by the registry and artifact paths. */
	agentId: string;
	/** External owners use a unique lease identity for workspace and branch names. */
	isolationId?: string;
	/** Refuse an existing namespace instead of reclaiming it. External leases require this. */
	exclusive?: boolean;
	/** Runs before agent execution; an external owner can wait for its start command. */
	onPrepared?: (handle: IsolationHandle, context: IsolationContext) => Promise<void>;
	/** Reports an actual retained path when capture cannot safely complete. */
	onRetained?: (workspace: RetainedWorkspace) => void;
	/** Final release artifacts remain recoverable even after the native registry removes the child. */
	onReleaseCaptured?: (
		artifacts: Pick<SingleResult, "patchPath" | "branchName" | "branchBaseSha" | "nestedPatchPaths">,
	) => void;
	/** Merge mode driving how changes are captured ("branch" commits, "patch" diffs). */
	mergeMode: "patch" | "branch";
	/** Output dir for `${agentId}.patch` artifacts (patch mode and branch-mode commit failures). */
	artifactsDir: string;
	/** Human description carried onto the branch commit (branch mode). */
	description?: string;
	/** Build a commit-message callback (`task.isolation.commits === "ai"`). */
	buildCommitMessage?: BuildCommitMessage;
	/**
	 * Construct a `SingleResult` when isolation setup throws — the caller has
	 * the full metadata (index, agent, assignment, modelOverride) needed to
	 * build a result shape consistent with their non-isolated path.
	 */
	buildFailureResult: (err: unknown) => SingleResult;
	/** Observe the real child result before post-run isolation work. */
	onSubprocessResult?: (result: SingleResult) => void;
}

/**
 * Write each nested-repo patch to `${artifactsDir}/${agentId}.nested-<n>-<path>.patch`
 * and return the paths. Throws on the first write failure: the caller must
 * then keep the isolation workspace alive, because it is the only other copy.
 * Every attempted destination is removed best-effort on failure — including
 * the in-progress file, which `Bun.write` may have created or truncated
 * before rejecting — so a half-written set cannot be mistaken for the
 * complete capture by the persisted-agent scanner.
 */
export async function persistNestedPatches(
	artifactsDir: string,
	agentId: string,
	nestedPatches: readonly NestedRepoPatch[],
): Promise<string[]> {
	const saved: string[] = [];
	try {
		for (const [index, nestedPatch] of nestedPatches.entries()) {
			const destination = path.join(
				artifactsDir,
				`${agentId}.nested-${index}-${nestedPatch.relativePath.replace(/[^a-zA-Z0-9._-]/g, "_") || "root"}.patch`,
			);
			// Track before writing: a mid-write failure (ENOSPC, quota) can
			// leave a truncated file behind, and `force: true` makes removing
			// a never-created path a no-op.
			saved.push(destination);
			await Bun.write(destination, nestedPatch.patch);
		}
	} catch (error) {
		await Promise.all(saved.map(file => fs.rm(file, { force: true }).catch(() => undefined)));
		throw error;
	}
	return saved;
}

interface IsolationPatchArtifacts {
	patchPath: string;
	hasRootChanges: boolean;
	nestedPatches: NestedRepoPatch[];
	nestedPatchPaths: string[];
}

/**
 * Capture the isolation delta and write every part of it to disk — the root
 * patch and one file per nested repo — before the caller tears the workspace
 * down. Throws when any write fails so nothing captured is ever the only copy.
 */
async function writeIsolationPatch(
	isolationDir: string,
	baseline: WorktreeBaseline,
	artifactsDir: string,
	agentId: string,
): Promise<IsolationPatchArtifacts> {
	const delta = await captureDeltaPatch(isolationDir, baseline);
	const patchPath = path.join(artifactsDir, `${agentId}.patch`);
	await Bun.write(patchPath, delta.rootPatch);
	const nestedPatchPaths = await persistNestedPatches(artifactsDir, agentId, delta.nestedPatches);
	return {
		patchPath,
		hasRootChanges: delta.rootPatch.trim().length > 0,
		nestedPatches: delta.nestedPatches,
		nestedPatchPaths,
	};
}

/**
 * Move a retained isolation workspace out of its deterministic
 * (`repoRoot` + agent id) slot into a globally unique sibling, so a later
 * isolated run with the same id cannot wipe it: `ensureIsolation`
 * unconditionally removes the deterministic base dir before writing its
 * owner marker. The owner marker, `m` mount, and backend sidecar move along,
 * so `omp worktree clear` still classifies and reclaims the workspace with
 * native teardown. Backends needing it (mounts, Btrfs subvolumes) record the
 * sidecar BEFORE the move so it travels atomically — a crash between rename
 * and a later write would leave a mounted workspace with a dead owner and
 * no metadata, and cleanup would traverse the live mount.
 */
export interface RetainedWorkspace {
	/** Workspace path to report (unique sibling on success, original dir when the move fails). */
	dir: string;
	/**
	 * False when cleanup metadata is missing that `clear` would need: the
	 * sidecar could not be written (plausible under the same disk pressure
	 * that forced retention). The error must then say the mount needs a
	 * manual unmount instead of advertising plain `worktree clear`.
	 */
	sidecarOk: boolean;
}

export async function retainIsolationWorkspace(
	isolationDir: string,
	backend?: natives.IsoBackendKind,
): Promise<RetainedWorkspace> {
	const baseDir = path.dirname(isolationDir);
	const retainedBase = `${baseDir}.retained-${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 32).toString(16)}`;
	const needsSidecar = backend !== undefined && needsNativeTeardown(backend);
	let sidecarOk = !needsSidecar;
	if (needsSidecar && backend !== undefined) {
		try {
			await writeRetainedBackend(baseDir, backend);
			sidecarOk = true;
		} catch {
			sidecarOk = false;
		}
	}
	// A valid move can still fail transiently (Windows AV/indexer locks);
	// retry briefly before conceding the deterministic slot.
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await fs.rename(baseDir, retainedBase);
			return { dir: path.join(retainedBase, path.basename(isolationDir)), sidecarOk };
		} catch {
			if (attempt === 2) return { dir: isolationDir, sidecarOk };
			await Bun.sleep(25);
		}
	}
	return { dir: isolationDir, sidecarOk };
}
/** Context for `isolation-error.md`: the `result.error` text for a run whose changes could not be captured or landed. */
interface IsolationErrorContext {
	kind: "merge-failed" | "patch-capture-failed" | "nested-capture-failed";
	message: string;
	captureError?: string;
	rescueBranch?: string;
	/** Set when the workspace was kept because its changes could not be written out. */
	retainedDir?: string;
	/**
	 * Set when the retained mount's unmount metadata is missing: cleanup
	 * cannot unmount before removal, so the message must direct a manual
	 * unmount instead of advertising plain `worktree clear`.
	 */
	sidecarMissing?: boolean;
}

function renderIsolationError(context: IsolationErrorContext): string {
	return prompt.render(isolationErrorTemplate, { ...context });
}

/**
 * Run a subagent inside an isolation worktree and capture its changes.
 *
 * Branch mode: on success, commits the diff onto `omp/task/${agentId}` and
 * returns `branchName` + `nestedPatches` (+ `nestedPatchPaths`). On commit
 * failure the still-live isolation diff is written to
 * `${artifactsDir}/${agentId}.patch`, the task branch is kept when it already
 * carries commits (deleted otherwise), and `result.error` carries the
 * merge-failure message plus recovery hint.
 *
 * Patch mode: on success, writes `${artifactsDir}/${agentId}.patch` plus one
 * `${agentId}.nested-<n>-<path>.patch` per nested repo and returns
 * `patchPath` + `nestedPatches` + `nestedPatchPaths`.
 *
 * Failure paths preserve the underlying `SingleResult` whenever possible so
 * the caller can still surface the subagent's output; only isolation setup
 * itself routes through {@link IsolatedRunOptions.buildFailureResult}.
 *
 * Kept-alive runs retain the isolation handle through idle/parked lifecycle
 * transitions, then capture final changes and clean up on release. One-shot
 * and failed startup paths clean up in `finally`. If captured changes cannot
 * be written to disk, the workspace is retained under a unique `.retained-*`
 * sibling and its path is named in the resulting error.
 */
export async function runIsolatedSubprocess(opts: IsolatedRunOptions): Promise<SingleResult> {
	const taskBaseline = structuredClone(opts.context.baseline);
	const isolationId = opts.isolationId ?? opts.agentId;
	let handle: IsolationHandle | undefined;
	let deferredCleanup: Promise<void> | undefined;
	let retainWorkspace = false;
	let baseReleasePromise: Promise<void> | undefined;
	let cleanupPromise: Promise<void> | undefined;
	let releasePromise: Promise<void> | undefined;
	let releasedArtifacts: (IsolationPatchArtifacts & { branchName?: string; branchBaseSha?: string }) | undefined;
	const preserveUnsettled = (error: unknown): never => {
		retainWorkspace = true;
		if (handle) opts.onRetained?.({ dir: handle.mergedDir, sidecarOk: false });
		throw new Error(
			`Worker cleanup did not complete; workspace retained at ${handle?.mergedDir}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	};
	const settleOwnedJobs = async (): Promise<void> => {
		if (!deferredCleanup) return;
		try {
			await deferredCleanup;
		} catch (error) {
			preserveUnsettled(error);
		}
	};
	const releaseBase = (): Promise<void> => {
		baseReleasePromise ??= opts.baseOptions.onRelease?.() ?? Promise.resolve();
		return baseReleasePromise;
	};
	const cleanupHandle = (): Promise<void> => {
		cleanupPromise ??= (async () => {
			try {
				await releaseBase();
			} catch (error) {
				preserveUnsettled(error);
			}
			if (handle && !retainWorkspace) {
				try {
					await cleanupIsolation(handle);
				} catch (error) {
					preserveUnsettled(error);
				}
			}
		})();
		return cleanupPromise;
	};
	const releaseIsolation = (): Promise<void> => {
		releasePromise ??= (async () => {
			if (!handle || retainWorkspace) {
				await releaseBase();
				return;
			}
			try {
				await settleOwnedJobs();
				let patchResult: IsolationPatchArtifacts;
				try {
					patchResult = await writeIsolationPatch(handle.mergedDir, taskBaseline, opts.artifactsDir, opts.agentId);
				} catch (captureErr) {
					retainWorkspace = true;
					const retained = await retainIsolationWorkspace(handle.mergedDir, handle.backend);
					opts.onRetained?.(retained);
					throw new Error(
						renderIsolationError({
							kind: "patch-capture-failed",
							message: captureErr instanceof Error ? captureErr.message : String(captureErr),
							retainedDir: retained.dir,
							sidecarMissing: !retained.sidecarOk,
						}),
					);
				}
				releasedArtifacts = patchResult;
				opts.onReleaseCaptured?.(releasedArtifacts);
				AgentRegistry.global().setHistory(opts.agentId, {
					patchPath: patchResult.patchPath,
					nestedPatchPaths: patchResult.nestedPatchPaths,
				});
				const commitResult = await commitToBranch(
					handle.mergedDir,
					taskBaseline,
					opts.isolationId ?? opts.agentId,
					opts.description,
					undefined,
				);
				releasedArtifacts.branchName = commitResult?.branchName;
				releasedArtifacts.branchBaseSha = commitResult?.baseSha;
				opts.onReleaseCaptured?.(releasedArtifacts);
				AgentRegistry.global().setHistory(opts.agentId, {
					patchPath: patchResult.patchPath,
					branchName: commitResult?.branchName,
					nestedPatchPaths: patchResult.nestedPatchPaths,
				});
			} finally {
				await cleanupHandle();
			}
		})();
		return releasePromise;
	};
	try {
		handle = await ensureIsolation(opts.context.repoRoot, isolationId, opts.preferredBackend, opts.exclusive);
		await opts.onPrepared?.(handle, { repoRoot: opts.context.repoRoot, baseline: taskBaseline });
		const isolationDir = handle.mergedDir;
		const result = await runSubprocess({
			...opts.baseOptions,
			worktree: isolationDir,
			preloadedExtensionPaths: undefined,
			preloadedPreparedExtensions: undefined,
			preloadedCustomToolPaths: undefined,
			onCleanupDeferred: completion => {
				deferredCleanup = completion;
				opts.baseOptions.onCleanupDeferred?.(completion);
			},
			// One-shot runs get `releaseBase` (never touches the worktree): their
			// `finalizeSubagentLifecycle` calls `onRelease` before this function's
			// post-run capture, so the handle must survive until the `finally`
			// below cleans it up. Only kept-alive runs hand full capture+cleanup
			// (`releaseIsolation`) to the agent lifecycle.
			onRelease: opts.baseOptions.keepAlive === false ? releaseBase : releaseIsolation,
		});
		opts.onSubprocessResult?.(result);
		if (releasePromise) {
			await releasePromise;
			return rememberAgentArtifacts({ ...result, ...releasedArtifacts });
		}
		// Capture only after owned jobs and shutdown hooks have stopped writing.
		await settleOwnedJobs();
		const captured = await captureIsolationResult(opts, handle, taskBaseline, result);
		if (captured.retained) {
			retainWorkspace = true;
			opts.onRetained?.(captured.retained);
		}
		return captured.result;
	} catch (err) {
		const result = opts.buildFailureResult(err);
		if (releasePromise) return rememberAgentArtifacts({ ...result, ...releasedArtifacts });
		if (!handle || retainWorkspace) return rememberAgentArtifacts(result);
		try {
			await settleOwnedJobs();
		} catch (cleanupError) {
			return rememberAgentArtifacts(opts.buildFailureResult(cleanupError));
		}
		const captured = await captureIsolationResult(opts, handle, taskBaseline, result);
		if (captured.retained) {
			retainWorkspace = true;
			opts.onRetained?.(captured.retained);
		}
		return captured.result;
	} finally {
		if (
			handle &&
			!retainWorkspace &&
			!releasePromise &&
			!(opts.baseOptions.keepAlive !== false && AgentLifecycleManager.global().has(opts.agentId))
		) {
			await cleanupHandle();
		}
	}
}

export interface IsolationCaptureResult {
	result: SingleResult;
	retained?: RetainedWorkspace;
}

/** Capture a settled turn through the same path for in-process and hosted workers. */
export async function captureIsolationResult(
	opts: Pick<
		IsolatedRunOptions,
		"context" | "agentId" | "isolationId" | "mergeMode" | "artifactsDir" | "description" | "buildCommitMessage"
	>,
	handle: IsolationHandle,
	taskBaseline: WorktreeBaseline,
	result: SingleResult,
): Promise<IsolationCaptureResult> {
	const isolationDir = handle.mergedDir;
	const isolationBackend = handle.backend;
	const isolationId = opts.isolationId ?? opts.agentId;
	if (opts.mergeMode === "branch" && result.exitCode === 0 && !result.error && !result.aborted) {
		let commitResult: CommitToBranchResult | null;
		try {
			commitResult = await commitToBranch(
				isolationDir,
				taskBaseline,
				isolationId,
				opts.description,
				opts.buildCommitMessage?.(),
			);
		} catch (mergeErr) {
			// A partial branch commit can be the only copy of committed work (#8868).
			const baseSha = taskBaseline.root.headCommit;
			const branchName = `omp/task/${isolationId}`;
			const rescueBranch = await rescueTaskBranch(opts.context.repoRoot, branchName, baseSha);
			const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
			try {
				const patchResult = await writeIsolationPatch(isolationDir, taskBaseline, opts.artifactsDir, opts.agentId);
				return {
					result: rememberAgentArtifacts({
						...result,
						...patchResult,
						error: renderIsolationError({ kind: "merge-failed", message: msg, rescueBranch }),
					}),
				};
			} catch (patchErr) {
				const retained = await retainIsolationWorkspace(isolationDir, isolationBackend);
				return {
					retained,
					result: rememberAgentArtifacts({
						...result,
						error: renderIsolationError({
							kind: "merge-failed",
							message: msg,
							captureError: patchErr instanceof Error ? patchErr.message : String(patchErr),
							rescueBranch,
							retainedDir: retained.dir,
							sidecarMissing: !retained.sidecarOk,
						}),
					}),
				};
			}
		}
		try {
			const nestedPatchPaths = await persistNestedPatches(
				opts.artifactsDir,
				opts.agentId,
				commitResult?.nestedPatches ?? [],
			);
			return {
				result: rememberAgentArtifacts({
					...result,
					branchName: commitResult?.branchName,
					branchBaseSha: commitResult?.baseSha,
					nestedPatches: commitResult?.nestedPatches,
					nestedPatchPaths,
				}),
			};
		} catch (persistErr) {
			const retained = await retainIsolationWorkspace(isolationDir, isolationBackend);
			return {
				retained,
				result: rememberAgentArtifacts({
					...result,
					branchName: commitResult?.branchName,
					branchBaseSha: commitResult?.baseSha,
					nestedPatches: commitResult?.nestedPatches,
					error: renderIsolationError({
						kind: "nested-capture-failed",
						message: persistErr instanceof Error ? persistErr.message : String(persistErr),
						retainedDir: retained.dir,
						sidecarMissing: !retained.sidecarOk,
					}),
				}),
			};
		}
	}
	// Failed and cancelled turns can contain useful changes too.
	try {
		const patchResult = await writeIsolationPatch(isolationDir, taskBaseline, opts.artifactsDir, opts.agentId);
		return { result: rememberAgentArtifacts({ ...result, ...patchResult }) };
	} catch (patchErr) {
		const retained = await retainIsolationWorkspace(isolationDir, isolationBackend);
		return {
			retained,
			result: rememberAgentArtifacts({
				...result,
				error: renderIsolationError({
					kind: "patch-capture-failed",
					message: patchErr instanceof Error ? patchErr.message : String(patchErr),
					retainedDir: retained.dir,
					sidecarMissing: !retained.sidecarOk,
				}),
			}),
		};
	}
}

export interface IsolationMergeOptions {
	result: SingleResult;
	repoRoot: string;
	mergeMode: "patch" | "branch";
}

export interface IsolationMergeOutcome {
	/** Trailing summary appended to the subagent's result text. May be empty. */
	summary: string;
	/**
	 * Tri-state apply outcome:
	 * - `true`  — merge ran (or had nothing to apply) and left the repo clean.
	 * - `false` — merge attempted and failed; artifacts are preserved.
	 * - `null`  — caller skipped the merge phase entirely (e.g. `apply=false`).
	 */
	changesApplied: boolean | null;
	hadAnyChanges: boolean;
	/** True iff the root branch actually merged — gates nested-repo patch application. */
	mergedBranchForNestedPatches: boolean;
}

/**
 * Apply changes captured by {@link runIsolatedSubprocess} back to the parent
 * repo: patch apply (patch mode) or cherry-pick + cleanup (branch mode).
 *
 * The caller decides whether to run this at all — eval `agent()` with
 * `apply=False` skips this step and surfaces the patch artifact / branch name
 * instead.
 */
export async function mergeIsolatedChanges(opts: IsolationMergeOptions): Promise<IsolationMergeOutcome> {
	const { result, repoRoot, mergeMode } = opts;
	const repo = vcs.requireGit(repoRoot);
	try {
		if (mergeMode === "branch") {
			if (!result.branchName && result.exitCode === 0 && !result.aborted && result.error) {
				return {
					summary: renderIsolationSummary({
						kind: "branch-capture-failed",
						error: result.error,
						rootPatchPath: result.patchPath,
						nestedPatchPaths: result.nestedPatchPaths,
					}),
					changesApplied: false,
					hadAnyChanges: false,
					mergedBranchForNestedPatches: false,
				};
			}
			const canApplyNestedOnly =
				!result.branchName && result.exitCode === 0 && !result.aborted && (result.nestedPatches?.length ?? 0) > 0;
			if (!result.branchName || result.exitCode !== 0 || result.aborted) {
				return {
					summary: canApplyNestedOnly
						? "\n\nNo root changes to apply; nested repository patches captured."
						: "\n\nNo changes to apply.",
					changesApplied: true,
					hadAnyChanges: canApplyNestedOnly,
					mergedBranchForNestedPatches: canApplyNestedOnly,
				};
			}
			const mergeResult = await mergeTaskBranches(repoRoot, [
				{
					branchName: result.branchName,
					taskId: result.id,
					description: result.description,
					baseSha: result.branchBaseSha,
				},
			]);
			const mergedBranchForNestedPatches =
				mergeResult.merged.includes(result.branchName) && !mergeResult.stashConflict;
			const changesApplied = mergeResult.failed.length === 0 && !mergeResult.stashConflict;
			const hadAnyChanges = mergeResult.merged.length > 0;

			let summary: string;
			if (mergeResult.failed.length === 0) {
				summary = hadAnyChanges ? `\n\nMerged branch: ${result.branchName}` : "\n\nNo changes to apply.";
			} else {
				// The nested patches are skipped when the branch did not merge; name
				// their files so the parent can recover them alongside the branch.
				summary = renderIsolationSummary({
					kind: "branch-merge-failed",
					branchName: result.branchName,
					conflict: mergeResult.conflict,
					nestedPatchPaths: result.nestedPatchPaths,
				});
			}
			if (mergeResult.stashConflict) {
				summary += `\n\n<system-notification>${mergeResult.stashConflict}</system-notification>`;
			}

			// Clean up the merged branch (keep failed ones for manual resolution)
			if (changesApplied) {
				await cleanupTaskBranches(repoRoot, [result.branchName]);
			}
			return { summary, changesApplied, hadAnyChanges, mergedBranchForNestedPatches };
		}

		// Patch mode: apply the patch from a successful run. A failed or
		// aborted run has nothing to apply and must not block the result.
		let changesApplied: boolean;
		let hadAnyChanges: boolean;
		const succeeded = result.exitCode === 0 && !result.error && !result.aborted;
		if (!succeeded) {
			changesApplied = true;
			hadAnyChanges = false;
		} else if (!result.patchPath) {
			changesApplied = false;
			hadAnyChanges = false;
		} else {
			const patchText = await Bun.file(result.patchPath).text();
			if (!patchText.trim()) {
				changesApplied = true;
				hadAnyChanges = false;
			} else {
				const normalized = patchText.endsWith("\n") ? patchText : `${patchText}\n`;
				// Idempotence: declare a no-op only when the reverse patch applies AND
				// the forward patch does not. `--reverse --check` alone can theoretically
				// succeed if the file happens to carry the postimage at another location
				// via git-apply's fuzz factor; requiring the forward check to fail
				// removes that ambiguity while still catching true already-applied
				// runs. Reads only — neither call touches the worktree, unlike
				// `--3way --check`, which exits 0 even when the real apply would
				// leave conflict markers and unmerged index entries.
				const [alreadyApplied, forwardApplies] = await Promise.all([
					repo.canApplyPatch(normalized, { reverse: true }).catch(() => false),
					repo.canApplyPatch(normalized, {}).catch(() => false),
				]);
				hadAnyChanges = false;
				if (alreadyApplied && !forwardApplies) {
					changesApplied = true;
				} else if (forwardApplies) {
					changesApplied = true;
					try {
						await repo.applyPatch(normalized, {});
						hadAnyChanges = true;
					} catch {
						changesApplied = false;
					}
				} else {
					changesApplied = false;
				}
			}
		}

		let summary: string;
		if (changesApplied) {
			summary = hadAnyChanges ? "\n\nApplied patches: yes" : "\n\nNo changes to apply.";
		} else {
			// Nested apply is skipped when the root patch did not apply; the
			// persisted nested patches are the parent's only pointer to that work.
			summary = renderIsolationSummary({
				kind: "not-applied",
				rootPatchPath: result.patchPath,
				nestedPatchPaths: result.nestedPatchPaths,
			});
		}
		return { summary, changesApplied, hadAnyChanges, mergedBranchForNestedPatches: false };
	} catch (mergeErr) {
		return {
			summary: renderIsolationSummary({
				kind: "merge-error",
				error: mergeErr instanceof Error ? mergeErr.message : String(mergeErr),
				branchName: result.branchName,
				rootPatchPath: result.patchPath,
				nestedPatchPaths: result.nestedPatchPaths,
			}),
			changesApplied: false,
			hadAnyChanges: false,
			mergedBranchForNestedPatches: false,
		};
	}
}

export interface NestedPatchApplyOptions {
	/** Subagent result carrying `nestedPatches`/`exitCode`/`aborted`. */
	result: SingleResult;
	repoRoot: string;
	mergeMode: "patch" | "branch";
	/** Parent merge outcome — patch mode skips nested apply when this is `false`. */
	changesApplied: boolean | null;
	/** Branch mode gates nested apply on whether the root branch merged. */
	mergedBranchForNestedPatches: boolean;
	/** Optional AI commit-message callback for nested commits; falls back to a generic message. */
	commitMessage?: (diff: string) => Promise<string | null>;
}

export interface NestedPatchApplyOutcome {
	summary: string;
	failed: boolean;
}

/** Apply nested patches only after a successful root result; preserve partial failure explicitly. */
export async function applyEligibleNestedPatches(opts: NestedPatchApplyOptions): Promise<NestedPatchApplyOutcome> {
	const { result, repoRoot, mergeMode, changesApplied, mergedBranchForNestedPatches, commitMessage } = opts;
	if (mergeMode === "patch" && changesApplied === false) return { summary: "", failed: false };
	const nestedPatches = result.nestedPatches ?? [];
	const eligible =
		nestedPatches.length > 0 &&
		result.exitCode === 0 &&
		!result.aborted &&
		!result.error &&
		(mergeMode !== "branch" || mergedBranchForNestedPatches);
	if (!eligible) return { summary: "", failed: false };
	try {
		const warnings = await applyNestedPatches(repoRoot, nestedPatches, commitMessage);
		return {
			summary: warnings.length ? `\n\n<system-notification>${warnings.join("\n")}</system-notification>` : "",
			failed: warnings.length > 0,
		};
	} catch (applyErr) {
		// Nested patch failures are non-fatal to the parent merge, but the patch
		// files are the only surviving copy of that work — name them.
		return {
			failed: true,
			summary: renderIsolationSummary({
				kind: "nested-apply-failed",
				error: applyErr instanceof Error ? applyErr.message : String(applyErr),
				nestedPatchPaths: result.nestedPatchPaths,
			}),
		};
	}
}
