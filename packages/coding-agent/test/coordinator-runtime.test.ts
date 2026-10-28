import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setModelRequestPolicy } from "@oh-my-pi/pi-ai/model-request-policy";
import { openCoordinatorRuntime } from "../src/task/coordinator-runtime";
import { refreshDirsFromEnv } from "@oh-my-pi/pi-utils";

for (const scenario of ["fallback", "primary", "schema", "denied", "cancelled", "exhausted"] as const) {
	test(`coordinator thinker ${scenario}`, async () => {
		const calls: string[] = [];
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
			const route = new URL(request.url).pathname;
			calls.push(route);
			if (scenario !== "primary" && scenario !== "schema" && (route === "/v1/chat/completions" || scenario === "exhausted")) {
				return Response.json({ error: { message: "429 rate limit; retry after 589 seconds", type: "rate_limit_exceeded" } },
					{ status: 429, headers: { "Retry-After": "589" } });
			}
			const content = scenario === "schema" ? '{"wrong":true}' : '{"decision":"allocate"}';
			const chunks = [{ index: 0, delta: { role: "assistant", content }, finish_reason: null },
				{ index: 0, delta: {}, finish_reason: "stop" }];
			return new Response(chunks.map(choice => `data: ${JSON.stringify({ id: "proof", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [choice] })}\n\n`).join("") + "data: [DONE]\n\n",
				{ headers: { "Content-Type": "text/event-stream" } });
		} });
		const scratchRoot = resolve(import.meta.dir, "../../../tmp");
		mkdirSync(scratchRoot, { recursive: true });
		const scratch = mkdtempSync(resolve(scratchRoot, "coordinator-runtime-"));
		const agentDir = resolve(scratch, "agent");
		mkdirSync(agentDir);
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		refreshDirsFromEnv();
		writeFileSync(resolve(agentDir, "config.yml"), JSON.stringify({ enabledProviders: ["primary", "secondary"], extensions: [], retry: { fallbackChains: { judge: [] } } }));
		writeFileSync(resolve(agentDir, "models.yml"), JSON.stringify({ providers: Object.fromEntries(["primary", "secondary"].map(provider => [provider, {
			baseUrl: `http://127.0.0.1:${server.port}${provider === "secondary" ? "/fallback" : ""}/v1`, api: "openai-completions", apiKey: "local-proof-only",
			models: [{ id: "gpt-5", name: "Local proof", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 16000 }],
		}])) }));
		const controller = new AbortController();
		let closeRuntime: (() => void) | undefined;
		try {
			const runtime = await openCoordinatorRuntime(scratch, { paneId: "proof", sessionId: "proof", model: "primary/gpt-5", thinking: "high" }, controller.signal);
			closeRuntime = () => runtime.close();
			setModelRequestPolicy(async selector => {
				if (scenario === "denied" && selector === "secondary/gpt-5") throw new Error("Profile excludes secondary");
			});
			if (scenario === "cancelled") controller.abort();
			const result = runtime.think({ instructions: "Choose whether to allocate.", state: { request: "Repair one file" },
				schema: { type: "object", required: ["decision"], properties: { decision: { const: "allocate" } }, additionalProperties: false },
				candidates: [{ selector: "secondary/gpt-5", thinking: "high" }, { selector: "primary/gpt-5", thinking: "high" }],
			}, controller.signal);
			if (scenario === "fallback" || scenario === "primary") {
				const response = await result;
				expect(response.data).toEqual({ decision: "allocate" });
				expect(response.provider).toBe(scenario === "fallback" ? "secondary" : "primary");
				expect(response.model).toBe("gpt-5");
			} else await expect(result).rejects.toThrow();
			if (scenario === "cancelled") expect(calls).toEqual([]);
			else if (scenario === "fallback" || scenario === "exhausted") expect(calls).toEqual(["/v1/chat/completions", "/fallback/v1/chat/completions"]);
			else expect(calls).toEqual(["/v1/chat/completions"]);
		} finally {
			closeRuntime?.();
			setModelRequestPolicy(undefined);
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			refreshDirsFromEnv();
			server.stop(true);
			// Native registry databases can remain open until process exit on Windows.
		}
	}, 30000);
}

test("coordinator falls back from a rate-limited configured judge to an available native judge", async () => {
	const calls: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const path = new URL(request.url).pathname;
		calls.push(path);
		if (path === "/v1/chat/completions") return Response.json({ error: { message: "429 rate limit; retry after 589 seconds", type: "rate_limit_exceeded" } }, { status: 429, headers: { "Retry-After": "589" } });
		const body = await request.json() as { questions: Record<string, unknown> };
		return Response.json({ model: "jev-1.14.0", answers: Object.fromEntries(Object.keys(body.questions).map(key =>
			[key, { type: "choice", choice: "yes", confidence: 1, probabilities: { yes: 1, no: 0 } }])),
			usage: { input_tokens: 1, output_tokens: 1 } });
	} });
	const scratchRoot = resolve(import.meta.dir, "../../../tmp");
	mkdirSync(scratchRoot, { recursive: true });
	const scratch = mkdtempSync(resolve(scratchRoot, "coordinator-judge-"));
	const agentDir = resolve(scratch, "agent");
	mkdirSync(agentDir);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	refreshDirsFromEnv();
	writeFileSync(resolve(agentDir, "config.yml"), JSON.stringify({ enabledProviders: ["primary", "typesafe"], extensions: [],
		modelRoles: { judge: "primary/gpt-5" }, retry: { fallbackChains: { judge: ["primary/gpt-5"] } } }));
	writeFileSync(resolve(agentDir, "models.yml"), JSON.stringify({ providers: {
		primary: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "local-proof-only",
			models: [{ id: "gpt-5", name: "Rate limited", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 16000 }] },
		typesafe: { baseUrl: `http://127.0.0.1:${server.port}`, api: "typesafe", apiKey: "local-proof-only",
			models: [{ id: "jev-1.14.0", name: "Native fallback", input: ["text"], contextWindow: 32000, maxTokens: 16000 }] },
	} }));
	const controller = new AbortController();
	let closeRuntime: (() => void) | undefined;
	try {
		const runtime = await openCoordinatorRuntime(scratch, { paneId: "proof", sessionId: "proof", model: "primary/gpt-5", thinking: "high" }, controller.signal);
		closeRuntime = () => runtime.close();
		const result = await runtime.judge({ state: { task: "repair" }, questions: { ready: { type: "choice", instructions: "Choose yes", criteria: { yes: "Ready", no: "Not ready" } } } }, controller.signal);
		expect(result.provider).toBe("typesafe");
		expect(result.answers.ready.choice).toBe("yes");
		expect(calls[0]).toBe("/v1/chat/completions");
		expect(calls.at(-1)).toBe("/v1/systemone");
	} finally {
		closeRuntime?.();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		refreshDirsFromEnv();
		server.stop(true);
	}
}, 30000);
