import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { runSubagentFollowUpTurn, runSubprocess } from "../../src/task/executor";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

test("operator model approval survives native parking and subsequent turns", async () => {
	await mkdir("tmp", { recursive: true });
	const dir = await mkdtemp(join(process.cwd(), "tmp", "operator-model-"));
	const auth = createInMemoryAuthStorage();
	const provider = "office-operator-proof";
	auth.keys.setRuntime(provider, "fixture-key");
	const registry = new ModelRegistry(auth, join(dir, "models.yml"));
	const dispatched: string[] = [];
	const models = ["original", "approved"].map(id => ({
		id,
		name: id,
		reasoning: false,
		input: ["text"] as "text"[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 64000,
		maxTokens: 4096,
	}));
	const streams = new Map(
		models.map(model => [
			model.id,
			createMockModel({
				provider,
				id: model.id,
				handler: {
					content: [{ type: "toolCall", name: "yield", arguments: { data: { completedWith: model.id } } }],
				},
			}),
		]),
	);
	try {
		registry.registerProvider(provider, {
			api: "mock",
			apiKey: "fixture-key",
			baseUrl: "mock://",
			models,
			streamSimple: (model, context, options) => {
				dispatched.push(model.id);
				return streams.get(model.id)!.stream(model, context, options);
			},
		});
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		const agent = {
			name: "task",
			description: "Provider-free operator control regression",
			systemPrompt: "Yield the result.",
			source: "project" as const,
			tools: ["yield"],
			spawns: [],
			advisor: false,
			prewalk: false,
		};
		const id = "OperatorRecovery";
		const first = await runSubprocess({
			cwd: dir,
			id,
			agent,
			index: 0,
			task: "initial turn",
			modelRegistry: registry,
			authStorage: auth,
			modelOverride: `${provider}/original`,
			keepAlive: true,
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
			sessionFile: join(dir, "root.jsonl"),
			artifactsDir: join(dir, "root"),
			contextFiles: [],
			skills: [],
			rules: [],
			preloadedExtensionPaths: [],
			preloadedCustomToolPaths: [],
			settings: Settings.isolated({
				"advisor.enabled": false,
				"task.prewalk": false,
				"memory.backend": "off",
				"task.agentIdleTtlMs": 0,
				"retry.enabled": false,
				"compaction.enabled": false,
			}),
		});
		expect(first.exitCode).toBe(0);
		const recovered = await runSubagentFollowUpTurn({
			id,
			agent,
			message: "operator-approved repair",
			modelSelection: { provider, id: "approved" },
		});
		expect(recovered.exitCode).toBe(0);
		await AgentLifecycleManager.global().park(id);
		expect(AgentRegistry.global().get(id)?.status).toBe("parked");
		const revived = await AgentLifecycleManager.global().ensureLive(id);
		expect(revived.model?.id).toBe("approved");
		const continued = await runSubagentFollowUpTurn({ id, agent, message: "continue with the approved session" });
		expect(continued.exitCode).toBe(0);
		expect(dispatched).toEqual(["original", "approved", "approved"]);
		const prompts = revived.messages
			.filter(message => message.role === "user")
			.map(message =>
				typeof message.content === "string"
					? message.content
					: message.content
							.filter(block => block.type === "text")
							.map(block => block.text)
							.join("\n"),
			);
		expect(prompts).toEqual(["initial turn", "operator-approved repair", "continue with the approved session"]);
	} finally {
		await AgentLifecycleManager.global().dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		registry.unregisterProvider(provider);
		auth.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 30000);
