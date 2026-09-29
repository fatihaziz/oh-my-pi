import { expect, test } from "bun:test";
import { AuthStorage } from "../../src/session/auth-storage";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { workerModelChoices } from "../../src/task/worker-services";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ExecutorOptions } from "../../src/task/executor";

test("operator model choices enforce native availability and the effort ceiling", async () => {
	const auth = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(auth, undefined, { ignoreLocalModelConfig: true });
	const source = "test://worker-model-choices";
	const base = {
		name: "Catalog fixture",
		input: ["text" as const],
		contextWindow: 8192,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	try {
		registry.registerProvider(
			"worker-choice-fixture",
			{
				baseUrl: "https://models.invalid/v1",
				api: "anthropic-messages",
				apiKey: "fixture-only",
				models: [
					{
						...base,
						id: "allowed",
						reasoning: true,
						thinking: { mode: "anthropic-adaptive", efforts: [Effort.Low, Effort.High] },
					},
					{
						...base,
						id: "too-high",
						reasoning: true,
						thinking: { mode: "anthropic-adaptive", efforts: [Effort.High] },
					},
					{ ...base, id: "plain", reasoning: false },
				],
			},
			source,
		);
		const options: ExecutorOptions = {
			id: "CatalogChild",
			cwd: process.cwd(),
			index: 0,
			task: "catalog only",
			agent: { name: "Fixture", description: "", systemPrompt: "", source: "bundled" },
			modelRegistry: registry,
			settings: Settings.isolated({ "task.maxEffort": "low" }),
		};
		expect(workerModelChoices(options).filter(model => model.provider === "worker-choice-fixture")).toEqual([
			{ provider: "worker-choice-fixture", id: "allowed", name: "Catalog fixture", efforts: [Effort.Low] },
			{ provider: "worker-choice-fixture", id: "plain", name: "Catalog fixture", efforts: [] },
		]);
		registry.clearSourceRegistrations(source);
		expect(workerModelChoices(options).some(model => model.provider === "worker-choice-fixture")).toBe(false);
	} finally {
		registry.clearSourceRegistrations(source);
		auth.close();
	}
});
