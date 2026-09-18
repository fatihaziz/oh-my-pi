import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { CompanionSnapshot, ExtensionAskDialogResult } from "../src/extensibility/extensions/types";
import { getCompanionBridge } from "../src/session/companion";

const message: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "Finished result" }],
	api: "openai-responses",
	provider: "openai",
	model: "test",
	timestamp: 1,
	stopReason: "stop",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};
const questions = [
	{
		id: "choice",
		question: "Which action?",
		options: [{ label: "Continue" }, { label: "Stop" }],
	},
];

describe("Companion's supported session boundary", () => {
	test("only a public terminal settle produces completion", () => {
		const bridge = getCompanionBridge({ getSessionId: () => "session-a" });
		const observed: CompanionSnapshot[] = [];
		bridge.bind({
			submit: async () => {},
			commands: () => [],
			interrupt: async () => {},
		});
		bridge.context().subscribe(snapshot => observed.push(snapshot));
		bridge.observe({ type: "agent_start" });
		bridge.observe({ type: "agent_end", messages: [message] });
		bridge.observe({
			type: "agent_end",
			isTerminal: false,
			messages: [message],
		});
		expect(bridge.snapshot().state).toBe("working");
		bridge.observe({
			type: "agent_end",
			isTerminal: true,
			messages: [message],
		});
		expect(bridge.snapshot()).toMatchObject({
			state: "completed",
			text: "Finished result",
			sessionId: "session-a",
		});
		expect(observed.map(snapshot => snapshot.state)).toEqual(["working", "completed"]);
		bridge.observe({ type: "agent_start" });
		bridge.observe({
			type: "agent_end",
			isTerminal: true,
			messages: [{ ...message, stopReason: "error" }],
		});
		expect(bridge.snapshot().state).toBe("failed");
		bridge.observe({ type: "agent_start" });
		bridge.observe({ type: "agent_end", isTerminal: true, messages: [] });
		expect(bridge.snapshot().state).toBe("unknown");
	});

	test("validated remote answers settle the actual pending dialog once and close its local UI", async () => {
		const bridge = getCompanionBridge({ getSessionId: () => "session-answer" });
		bridge.bind({
			submit: async () => {},
			commands: () => [],
			interrupt: async () => {},
		});
		let closed = false;
		const result = bridge.ask(
			questions,
			signal =>
				new Promise<ExtensionAskDialogResult | undefined>(resolve => {
					signal.addEventListener(
						"abort",
						() => {
							closed = true;
							resolve(undefined);
						},
						{ once: true },
					);
				}),
		);
		const api = bridge.context();
		const requestId = api.snapshot().question!.requestId;
		await expect(api.answer(requestId, [{ id: "choice", selectedOptions: ["Not an option"] }])).rejects.toThrow(
			"choices",
		);
		expect(api.snapshot().state).toBe("waiting");
		await api.answer(requestId, [{ id: "choice", selectedOptions: ["Continue"] }]);
		expect(await result).toMatchObject({
			kind: "submit",
			results: [{ id: "choice", selectedOptions: ["Continue"] }],
		});
		expect(closed).toBe(true);
		expect(api.snapshot().question).toBeUndefined();
		await expect(api.answer(requestId, [{ id: "choice", selectedOptions: ["Stop"] }])).rejects.toThrow("stale");
	});

	test("abort and a session switch revoke old question authority", async () => {
		let sessionId = "before";
		const bridge = getCompanionBridge({ getSessionId: () => sessionId });
		bridge.bind({
			submit: async () => {},
			commands: () => [],
			interrupt: async () => {},
		});
		const controller = new AbortController();
		const result = bridge.ask(
			questions,
			signal =>
				new Promise<ExtensionAskDialogResult | undefined>(resolve => {
					signal.addEventListener("abort", () => resolve(undefined), {
						once: true,
					});
				}),
			controller.signal,
		);
		const api = bridge.context();
		const requestId = api.snapshot().question!.requestId;
		controller.abort();
		expect(await result).toBeUndefined();
		sessionId = "after";
		bridge.reset();
		await expect(api.answer(requestId, [{ id: "choice", selectedOptions: ["Continue"] }])).rejects.toThrow(
			"no longer active",
		);
		expect(bridge.snapshot()).toMatchObject({
			sessionId: "after",
			state: "unknown",
		});
	});
});
