import { describe, expect, test } from "bun:test";
import { fromJsonSchema, OmpErrors } from "@oh-my-pi/omptype";
import {
	cleanupRpcOutputDisconnect,
	cleanupRpcTransportDisconnect,
	createRpcReady,
	reportRpcPromptTerminal,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcPromptEndFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

const fixturePath = new URL("./fixtures/rpc-host-events.jsonl", import.meta.url);

const schemaPath = new URL("../../../docs/rpc-host-events.schema.json", import.meta.url);

describe("RPC host contract", () => {
	test("ready keeps v1 negotiation fields and advertises named capabilities", async () => {
		const [ready] = (await Bun.file(fixturePath).text())
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));

		expect(createRpcReady("1.2.3")).toEqual(ready);
	});

	test("machine-readable schema accepts the golden frames", async () => {
		const schema = fromJsonSchema(await Bun.file(schemaPath).json());
		const frames = (await Bun.file(fixturePath).text())
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));

		for (const frame of frames) expect(schema(frame)).not.toBeInstanceOf(OmpErrors);
	});

	test.each([
		["completed", []],
		["aborted", [{ role: "assistant", stopReason: "aborted" }]],
		["failed", [{ role: "assistant", stopReason: "error" }]],
	] as const)("emits one prompt_end with %s outcome", async (outcome, messages) => {
		const terminal = Promise.withResolvers<void>();
		const scheduledWork = Promise.withResolvers<void>();
		const events: RpcPromptEndFrame[] = [];
		reportRpcPromptTerminal({
			promptId: "prompt-7",
			sessionId: "session-3",
			sessionFile: "/sessions/session-3.jsonl",
			prompt: terminal.promise,
			getMessages: () => messages,
			waitForScheduledWork: () => scheduledWork.promise,
			output: event => events.push(event),
		});

		terminal.resolve();
		await terminal.promise;
		await Promise.resolve();
		expect(events).toEqual([]);

		scheduledWork.resolve();
		await scheduledWork.promise;
		await Promise.resolve();

		const [, promptEnd] = (await Bun.file(fixturePath).text())
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(events).toEqual([{ ...promptEnd, outcome }]);
	});

	test("waits for extension-scheduled agent work before classifying the terminal outcome", async () => {
		const prompt = Promise.withResolvers<void>();
		const events: RpcPromptEndFrame[] = [];
		let outcome: "completed" | "failed" = "completed";
		reportRpcPromptTerminal({
			promptId: "prompt-extension",
			sessionId: "session-3",
			prompt: prompt.promise,
			getMessages: () => [{ role: "assistant", stopReason: outcome === "failed" ? "error" : "stop" }],
			waitForScheduledWork: async () => {
				await Promise.resolve();
				outcome = "failed";
			},
			output: event => events.push(event),
		});

		prompt.resolve();
		await prompt.promise;
		await Promise.resolve();
		await Promise.resolve();

		expect(events).toEqual([
			{ type: "prompt_end", promptId: "prompt-extension", sessionId: "session-3", outcome: "failed" },
		]);
	});

	test("reports a rejected prompt as failed exactly once", async () => {
		const terminal = Promise.withResolvers<void>();
		const events: RpcPromptEndFrame[] = [];
		reportRpcPromptTerminal({
			promptId: "prompt-8",
			sessionId: "session-3",
			prompt: terminal.promise,
			getMessages: () => [],
			output: event => events.push(event),
		});

		terminal.reject(new Error("provider failed"));
		await terminal.promise.catch(() => {});
		await Promise.resolve();

		expect(events).toEqual([{ type: "prompt_end", promptId: "prompt-8", sessionId: "session-3", outcome: "failed" }]);
	});

	test("starts shared session disposal when stdout disconnects", async () => {
		const calls: string[] = [];
		const disposed = Promise.withResolvers<void>();
		const cleanup = cleanupRpcOutputDisconnect({
			beginDispose: () => calls.push("begin-session-dispose"),
			dispose: () => {
				calls.push("dispose-session");
				return disposed.promise;
			},
		});

		expect(calls).toEqual(["begin-session-dispose", "dispose-session"]);
		disposed.resolve();
		await cleanup;
	});

	test("starts shared session disposal before waiting for transport drains", async () => {
		const calls: string[] = [];
		const inputDrain = Promise.withResolvers<void>();
		const shutdownDrain = Promise.withResolvers<void>();
		const sessionDispose = Promise.withResolvers<void>();
		const cleanup = cleanupRpcTransportDisconnect({
			pendingExtensionRequests: { rejectAll: () => calls.push("reject-extension") },
			hostToolBridge: { close: () => calls.push("close-tools") },
			hostUriBridge: { clear: () => calls.push("clear-uris") },
			inputDispatcher: {
				drain: () => {
					calls.push("drain-input");
					return inputDrain.promise;
				},
			},
			shutdownCoordinator: {
				drain: () => {
					calls.push("drain-background");
					return shutdownDrain.promise;
				},
			},
			subagentRegistry: { dispose: () => calls.push("dispose-subagents") },
			session: {
				beginDispose: () => calls.push("begin-session-dispose"),
				dispose: () => {
					calls.push("dispose-session");
					return sessionDispose.promise;
				},
			},
		});

		expect(calls).toEqual([
			"reject-extension",
			"close-tools",
			"clear-uris",
			"begin-session-dispose",
			"dispose-subagents",
			"drain-input",
			"drain-background",
			"dispose-session",
		]);
		inputDrain.resolve();
		shutdownDrain.resolve();
		sessionDispose.resolve();
		await cleanup;
	});
});
