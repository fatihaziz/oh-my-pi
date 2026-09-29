import { afterEach, beforeEach, expect, it, spyOn, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { TempDir, setWorktreesDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import * as executor from "../../src/task/executor";
import { ExecutorWorkspace } from "../../src/task/executor-workspace";
import { ensureIsolation, getTaskIsolationPath } from "../../src/task/worktree";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

let temporary: TempDir;
let repo: string;
let sessionFile: string;
let workspace: ExecutorWorkspace | undefined;
let oldWorktrees: string | undefined;

async function git(...args: string[]): Promise<void> {
	const child = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", windowsHide: true });
	const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	if (code !== 0) throw new Error(error);
}

beforeEach(async () => {
	const scratch = path.resolve("tmp");
	await fs.mkdir(scratch, { recursive: true });
	temporary = await TempDir.create(path.join(scratch, "executor-workspace-test-"));
	repo = path.join(temporary.path(), "source");
	await fs.mkdir(repo);
	await git("init", "-q", "-b", "main");
	await git("config", "user.name", "Workspace Test");
	await git("config", "user.email", "workspace@example.test");
	await git("config", "commit.gpgsign", "false");
	await Bun.write(path.join(repo, "work.txt"), "base\n");
	await Bun.write(path.join(repo, "owner.txt"), "owner base\n");
	await vcs.requireGit(repo).stageFiles(["work.txt", "owner.txt"]);
	await vcs.requireGit(repo).commitCreate("fixture baseline", {});
	await Bun.write(path.join(repo, "owner.txt"), "owner staged\n");
	await vcs.requireGit(repo).stageFiles(["owner.txt"]);
	await Bun.write(path.join(repo, "owner.txt"), "owner unstaged\n");
	await Bun.write(path.join(repo, "owner-new.txt"), "owner untracked\n");
	sessionFile = path.join(temporary.path(), "parent.jsonl");
	oldWorktrees = process.env.OMP_WORKTREE_DIR;
	delete process.env.OMP_WORKTREE_DIR;
	setWorktreesDir(path.join(temporary.path(), "workspaces"));
});

afterEach(async () => {
	await workspace?.release().catch(() => {});
	workspace = undefined;
	mock.restore();
	setWorktreesDir(undefined);
	if (oldWorktrees === undefined) delete process.env.OMP_WORKTREE_DIR;
	else process.env.OMP_WORKTREE_DIR = oldWorktrees;
	await temporary.remove();
});

async function prepare(merge: "patch" | "branch" = "patch", keepAlive = false): Promise<executor.ExecutorOptions> {
	workspace = await ExecutorWorkspace.plan({
		agentId: "Worker",
		leaseId: crypto.randomUUID(),
		cwd: repo,
		sessionFile,
		merge,
		apply: true,
	});
	const options: executor.ExecutorOptions = {
		id: "Worker",
		cwd: workspace.cwd,
		worktree: workspace.cwd,
		index: 0,
		task: "fixture task",
		agent: { name: "Fixture", description: "No provider execution", systemPrompt: "", source: "bundled" },
		sessionFile,
		artifactsDir: sessionFile.slice(0, -6),
		keepAlive,
		settings: Settings.isolated({ "isolation.backend": "rcopy", "task.isolation.commits": "generic" }),
	};
	await workspace.prepare(options);
	return options;
}

function result(options: executor.ExecutorOptions, failed = false): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		exitCode: failed ? 1 : 0,
		error: failed ? "fixture interrupted" : undefined,
		aborted: failed,
		output: "fixture result",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

async function expectOwnerWip(): Promise<void> {
	expect(await Bun.file(path.join(repo, "owner.txt")).text()).toBe("owner unstaged\n");
	expect(await Bun.file(path.join(repo, "owner-new.txt")).text()).toBe("owner untracked\n");
	expect(await vcs.requireGit(repo).diffText({ cached: true })).toContain("+owner staged");
}

it("prepares without executing, cancels at the barrier, and refuses a consumed lease", async () => {
	const execute = spyOn(executor, "runSubprocess").mockRejectedValue(new Error("must not execute"));
	await prepare();
	expect(await Bun.file(path.join(workspace!.cwd, "owner.txt")).text()).toBe("owner unstaged\n");
	expect(await Bun.file(path.join(workspace!.cwd, "owner-new.txt")).text()).toBe("owner untracked\n");
	expect(execute).not.toHaveBeenCalled();
	const plan = workspace!.plan;
	await workspace!.release();
	expect(
		await fs.stat(workspace!.cwd).then(
			() => true,
			() => false,
		),
	).toBe(false);
	expect(await Bun.file(workspace!.checkpointPath).json()).toMatchObject({
		phase: "released",
		result: { aborted: true },
	});
	await expect(ExecutorWorkspace.plan(plan)).rejects.toThrow("namespace already exists");
	await expectOwnerWip();
});

it("captures failed work without applying it or losing the parent's WIP", async () => {
	spyOn(executor, "runSubprocess").mockImplementation(async options => {
		await Bun.write(path.join(options.worktree!, "work.txt"), "useful partial work\n");
		return result(options, true);
	});
	await prepare();
	const failed = await workspace!.run();
	expect(failed.aborted).toBe(true);
	expect(await Bun.file(failed.patchPath!).text()).toContain("+useful partial work");
	expect(
		await fs.stat(workspace!.cwd).then(
			() => true,
			() => false,
		),
	).toBe(false);
	expect((await workspace!.integrate()).changesApplied).toBeNull();
	expect(await Bun.file(path.join(repo, "work.txt")).text()).toBe("base\n");
	await expectOwnerWip();
});

it("does not reclaim another owner's occupied namespace", async () => {
	const lease = crypto.randomUUID();
	const occupied = getTaskIsolationPath(repo, lease);
	await fs.mkdir(occupied, { recursive: true });
	const evidence = path.join(occupied, "other-owner.txt");
	await Bun.write(evidence, "must survive\n");
	await expect(ensureIsolation(repo, lease, natives.IsoBackendKind.Rcopy, true)).rejects.toThrow();
	expect(await Bun.file(evidence).text()).toBe("must survive\n");
});

it("retains workspace data when native teardown cannot confirm release", async () => {
	await prepare();
	await Bun.write(path.join(workspace!.cwd, "recover.txt"), "recover this work\n");
	spyOn(natives, "isoStop").mockRejectedValue(new Error("fixture teardown unavailable"));
	await workspace!.release();
	expect(workspace!.snapshot()).toMatchObject({ phase: "retained", retained: { dir: workspace!.cwd } });
	expect(await Bun.file(path.join(workspace!.cwd, "recover.txt")).text()).toBe("recover this work\n");
	await expectOwnerWip();
});

it("reports partial integration when the parent's WIP cannot be restored", async () => {
	spyOn(executor, "runSubprocess").mockImplementation(async options => {
		await Bun.write(path.join(options.worktree!, "owner.txt"), "agent edit\n");
		return result(options);
	});
	await prepare("branch");
	const captured = await workspace!.run();
	expect((await workspace!.integrate()).changesApplied).toBe(false);
	const source = vcs.requireGit(repo);
	expect((await source.showBlob("refs/stash:owner.txt")).data.toString()).toBe("owner unstaged\n");
	expect((await source.showBlob("refs/stash^2:owner.txt")).data.toString()).toBe("owner staged\n");
	expect(await source.refExists(captured.branchName!)).toBe(true);
});

for (const merge of ["patch", "branch"] as const) {
	it(`captures and integrates two ${merge} turns without reapplying prior work or parent WIP`, async () => {
		let live = false;
		let release: (() => Promise<void>) | undefined;
		spyOn(AgentLifecycleManager.global(), "has").mockImplementation(() => live);
		spyOn(AgentLifecycleManager.global(), "release").mockImplementation(async () => {
			await release?.();
			live = false;
			return true;
		});
		spyOn(executor, "runSubprocess").mockImplementation(async options => {
			live = true;
			release = options.onRelease;
			await Bun.write(path.join(options.worktree!, "work.txt"), "first turn\n");
			return result(options);
		});
		const options = await prepare(merge, true);
		const first = await workspace!.run();
		expect(await Bun.file(path.join(repo, "work.txt")).text()).toBe("base\n");
		expect((await workspace!.integrate()).changesApplied).toBe(true);
		expect(await Bun.file(path.join(repo, "work.txt")).text()).toBe("first turn\n");
		const firstPatch = first.patchPath ? await Bun.file(first.patchPath).text() : undefined;
		const failed = await workspace!.followUp(async () => {
			await Bun.write(path.join(workspace!.cwd, "work.txt"), "recoverable failed turn\n");
			throw new Error("provider refused follow-up");
		});
		expect(failed).toMatchObject({ exitCode: 1, error: "provider refused follow-up" });
		expect((await workspace!.integrate()).changesApplied).toBeNull();
		expect(await Bun.file(path.join(repo, "work.txt")).text()).toBe("first turn\n");
		expect(await Bun.file(path.join(workspace!.cwd, "work.txt")).text()).toBe("recoverable failed turn\n");
		const failedCheckpoint = await Bun.file(workspace!.checkpointPath).json();
		expect(failedCheckpoint).toMatchObject({
			phase: "settled",
			result: { exitCode: 1, error: "provider refused follow-up" },
		});
		expect(await Bun.file(failedCheckpoint.result.patchPath).text()).toContain("+recoverable failed turn");
		const second = await workspace!.followUp(async () => {
			await Bun.write(path.join(workspace!.cwd, "work.txt"), "second turn\n");
			return result(options);
		});
		expect(await workspace!.integrate()).toMatchObject({ changesApplied: true });
		expect((await workspace!.integrate()).changesApplied).toBe(true);
		expect(await Bun.file(path.join(repo, "work.txt")).text()).toBe("second turn\n");
		if (first.patchPath) {
			expect(second.patchPath).not.toBe(first.patchPath);
			expect(await Bun.file(first.patchPath).text()).toBe(firstPatch!);
		}
		await Bun.write(path.join(workspace!.cwd, "retirement.txt"), "final recoverable bytes\n");
		await workspace!.release();
		const checkpoint = await Bun.file(workspace!.checkpointPath).json();
		expect(await Bun.file(checkpoint.releaseArtifacts.patchPath).text()).toContain("+final recoverable bytes");
		expect(
			await fs.stat(workspace!.cwd).then(
				() => true,
				() => false,
			),
		).toBe(false);
		await expectOwnerWip();
	});
}
