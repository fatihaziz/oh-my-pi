import { afterEach, expect, test } from "bun:test";
import * as path from "node:path";
import {
	registerExternalSubagentExecutor,
	externalExecutorForSession,
	type ExternalSubagentExecutor,
} from "../../src/task/external-executor";
import { runSubprocess, runSubagentFollowUpTurn } from "../../src/task/executor";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { IrcBus } from "../../src/irc/bus";
import { createExternalSubagentExecutor } from "../../src/task/external-executor-client";

const root = path.resolve("tmp/external-owner/root.jsonl");
const child = path.resolve("tmp/external-owner/root/Child.jsonl");
const disposed: (() => void)[] = [];
afterEach(() => {
	for (const dispose of disposed.splice(0)) dispose();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
});

function rejectingOwner(): ExternalSubagentExecutor {
	return {
		execute: async () => {
			throw new Error("owner offline");
		},
		start: async () => {
			throw new Error("owner offline");
		},
		followUp: async () => {
			throw new Error("owner offline");
		},
		deliver: async () => {
			throw new Error("owner offline");
		},
		park: async () => {
			throw new Error("owner offline");
		},
		release: async () => {
			throw new Error("owner offline");
		},
	};
}

test("external owner failure never falls back to a local worker or reviver", async () => {
	disposed.push(registerExternalSubagentExecutor(root, rejectingOwner()));
	const agent = { name: "worker", description: "Worker", systemPrompt: "", source: "bundled" as const };
	await expect(
		runSubprocess({
			cwd: process.cwd(),
			agent,
			id: "Child",
			index: 0,
			task: "",
			sessionFile: root,
			signal: AbortSignal.abort(),
		}),
	).rejects.toThrow("owner offline");
	const registry = AgentRegistry.global();
	registry.register({
		id: "Child",
		displayName: "Child",
		kind: "sub",
		parentId: "main",
		session: null,
		sessionFile: child,
		status: "parked",
	});
	await expect(runSubagentFollowUpTurn({ id: "Child", agent, message: "continue" })).rejects.toThrow("owner offline");
	await expect(AgentLifecycleManager.global().release("Child")).rejects.toThrow("owner offline");
	expect(registry.get("Child")?.status).toBe("parked");
});

test("root ownership rejects overlap and does not cross transcript siblings", () => {
	const owner = rejectingOwner();
	disposed.push(registerExternalSubagentExecutor(root, owner));
	expect(() => registerExternalSubagentExecutor(root, owner)).toThrow("already registered");
	expect(externalExecutorForSession(child)).toBe(owner);
	expect(externalExecutorForSession(path.resolve("tmp/external-owner/root-other/Child.jsonl"))).toBeUndefined();
});

test("disconnected owner produces a failed delivery receipt without local revival", async () => {
	const disconnect = registerExternalSubagentExecutor(root, rejectingOwner());
	disposed.push(disconnect);
	const registry = AgentRegistry.global();
	registry.register({
		id: "Child",
		displayName: "Child",
		kind: "sub",
		parentId: "main",
		session: null,
		sessionFile: child,
		status: "parked",
	});
	disconnect();
	await expect(new IrcBus(registry).send({ from: "main", to: "Child", body: "continue" })).resolves.toMatchObject({
		outcome: "failed",
		error: expect.stringContaining("disconnected"),
	});
	expect(registry.get("Child")?.status).toBe("parked");
});

test("a stale disconnect cannot fence a reconnected owner using the same adapter", () => {
	const owner = rejectingOwner();
	const first = registerExternalSubagentExecutor(root, owner);
	first();
	disposed.push(registerExternalSubagentExecutor(root, owner));
	first();
	expect(externalExecutorForSession(child)).toBe(owner);
});

test("a parked externally owned agent is not reclaimed as a dead local agent", async () => {
	disposed.push(registerExternalSubagentExecutor(root, rejectingOwner()));
	const registry = AgentRegistry.global();
	registry.register({
		id: "Child",
		displayName: "Child",
		kind: "sub",
		parentId: "main",
		session: null,
		sessionFile: child,
		status: "parked",
	});
	const ref = registry.get("Child")!;
	expect(await AgentLifecycleManager.global().reclaimDeadCorpse("Child", ref)).toBe(false);
	expect(registry.get("Child")).toBe(ref);
});

test("registering child ownership does not redirect the live parent mailbox", async () => {
	disposed.push(registerExternalSubagentExecutor(root, rejectingOwner()));
	const registry = AgentRegistry.global();
	registry.register({
		id: "main",
		displayName: "Main",
		kind: "main",
		session: null,
		sessionFile: root,
		status: "running",
	});
	const bus = new IrcBus(registry);
	const waiting = bus.wait("main", {}, 1000);
	const receipt = await bus.send({ from: "Child", to: "main", body: "finished" });
	expect(receipt.outcome).toBe("injected");
	expect((await waiting)?.body).toBe("finished");
});

test("lifecycle teardown releases externally hosted children without local adoption", async () => {
	const registry = AgentRegistry.global();
	const owner = rejectingOwner();
	owner.release = async ref => {
		registry.unregister(ref.id, ref);
	};
	disposed.push(registerExternalSubagentExecutor(root, owner));
	registry.register({
		id: "Child",
		displayName: "Child",
		kind: "sub",
		parentId: "main",
		session: null,
		sessionFile: child,
		status: "idle",
	});
	await AgentLifecycleManager.global().dispose();
	expect(registry.get("Child")).toBeUndefined();
});

test("running hosted peers remain visible to hub waits until their owner disconnects", () => {
	const disconnect = registerExternalSubagentExecutor(root, rejectingOwner());
	disposed.push(disconnect);
	const registry = AgentRegistry.global();
	const ref = registry.register({
		id: "Child",
		displayName: "Child",
		kind: "sub",
		session: null,
		sessionFile: child,
		status: "running",
	});
	expect(registry.isRunning(ref)).toBe(true);
	disconnect();
	expect(registry.isRunning(ref)).toBe(false);
});

const childLaunch = {
	cwd: process.cwd(),
	id: "Child",
	index: 0,
	task: "read parent state",
	agent: { name: "worker", description: "Worker", systemPrompt: "", source: "bundled" as const },
};

test("parent state that cannot cross a process boundary refuses the launch before dispatch", () => {
	let requested = false;
	const owner = createExternalSubagentExecutor({
		bind() {
			requested = true;
		},
		async request<T>(): Promise<T> {
			requested = true;
			throw new Error("must not dispatch");
		},
	});
	expect(() => owner.start({ ...childLaunch, parentHindsightSessionState: {} as never })).toThrow("Hindsight");
	expect(() => owner.start({ ...childLaunch, parentTelemetry: { onSpanStart: () => {} } })).toThrow(
		"Only OMP's OTLP telemetry",
	);
	expect(requested).toBe(false);
});

test("shared Eval and memory are declared to the worker instead of dropped", async () => {
	const starts: Record<string, unknown>[] = [];
	const owner = createExternalSubagentExecutor({
		bind() {},
		async request<T>(command: string, data: Record<string, unknown>): Promise<T> {
			if (command === "start") starts.push(data);
			return { exitCode: 0 } as T;
		},
	});
	const memory = {
		executeTool: () => Promise.reject(new Error("unused")),
		getScopedMemory: async () => null,
		recallSnippet: async () => undefined,
	};
	await owner.start({ ...childLaunch, parentEvalSessionId: "shared-parent-kernel", parentServices: { memory } });
	expect(starts).toHaveLength(1);
	expect(starts[0].services).toEqual({ memory: true, eval: { state: null } });
	expect(starts[0].options).toMatchObject({ parentEvalSessionId: "shared-parent-kernel" });
	expect(starts[0].options).not.toHaveProperty("parentServices");
});
