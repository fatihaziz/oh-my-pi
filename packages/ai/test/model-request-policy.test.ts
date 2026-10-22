import { expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { setModelRequestPolicy } from "../src/model-request-policy";
import { streamSimple } from "../src/stream";
import { streamAnthropic } from "../src/providers/anthropic";
import type { Model } from "../src/types";

it("enforces live policy on calls, retries and fallback while allowing an accepted response to finish", async () => {
	let allowed = new Set(["fixture/primary"]);
	let requests = 0;
	let rateLimit = false;
	const server = Bun.serve({
		port: 0,
		fetch: () => {
			requests++;
			allowed.clear(); // A Profile edit while this request is already running.
			if (rateLimit) return new Response(JSON.stringify({ error: { message: "retry later" } }), { status: 429, headers: { "retry-after": "0" } });
			const chunk = { id: "policy-response", object: "chat.completion.chunk", created: 1, model: "primary", choices: [{ index: 0, delta: { content: "accepted response finished" }, finish_reason: null }] };
			const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		},
	});
	const model: Model<"openai-completions"> = buildModel({
		id: "primary", name: "Policy transport fixture", provider: "fixture", api: "openai-completions",
		baseUrl: `http://127.0.0.1:${server.port}/v1`, reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256,
	});
	const request = (id = "primary") => streamSimple({ ...model, id }, { messages: [{ role: "user", content: "Respond", timestamp: 1 }] }, { apiKey: "local-fixture", maxRetryDelayMs: 1 }).result();
	setModelRequestPolicy(async selector => { if (!allowed.has(selector)) throw new Error(`Profile excludes ${selector}`); });
	try {
		const first = await request();
		expect(first.content).toContainEqual({ type: "text", text: "accepted response finished" });
		expect(requests).toBe(1);
		await expect(request()).rejects.toThrow("Profile excludes fixture/primary");
		await expect(request("fallback")).rejects.toThrow("Profile excludes fixture/fallback");
		expect(requests).toBe(1);
		allowed.add("fixture/fallback");
		expect((await request("fallback")).stopReason).toBe("stop");
		expect(requests).toBe(2);
		allowed.add("fixture/primary");
		const fallbackCall = streamAnthropic(buildModel({
			id: "primary", name: "Server fallback fixture", api: "anthropic-messages",
			provider: "fixture", baseUrl: model.baseUrl, reasoning: false, input: ["text"],
			cost: model.cost, contextWindow: 4096, maxTokens: 256,
		}),
			{ messages: [{ role: "user", content: "Respond", timestamp: 1 }] },
			{ apiKey: "local-fixture", fallbacks: [{ model: "excluded-server-fallback" }] });
		await expect(fallbackCall.result()).rejects.toThrow("Profile excludes fixture/excluded-server-fallback");
		expect(requests).toBe(2);
		rateLimit = true;
		const failure = await request().then(value => value.errorMessage ?? "", error => String(error));
		expect(failure).toContain("Profile excludes fixture/primary");
		expect(requests).toBe(3); // The HTTP retry is denied before a second network request.
	} finally {
		setModelRequestPolicy(undefined);
		await server.stop(true);
	}
});
