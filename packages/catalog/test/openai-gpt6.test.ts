import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { fetchCodexModels } from "@oh-my-pi/pi-catalog/discovery/codex";
import { calculateUsageCost } from "@oh-my-pi/pi-catalog/models";
import type { Usage } from "@oh-my-pi/pi-catalog/types";

function usage(input: number): Usage {
	return {
		input,
		output: 1_000,
		cacheRead: 1_000,
		cacheWrite: 1_000,
		totalTokens: input + 3_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("GPT-6 Sol and Luna billing", () => {
	test.each([
		["gpt-6-sol", 2, 10, 0.2, 2.5],
		["gpt-6-luna", 0.1, 0.5, 0.01, 0.125],
	] as const)("charges the API long-context tier only above 272K input for %s", (id, input, output, cached, write) => {
		const spec = seedModels("openai").find(model => model.id === id);
		if (!spec) throw new Error(`Missing seed for ${id}`);
		const model = buildModel(spec);
		const standard = calculateUsageCost(model.cost, usage(270_000));
		expect(standard.input).toBeCloseTo(0.27 * input);
		expect(standard.output).toBeCloseTo(0.001 * output);
		expect(standard.cacheRead).toBeCloseTo(0.001 * cached);
		expect(standard.cacheWrite).toBeCloseTo(0.001 * write);
		const long = calculateUsageCost(model.cost, usage(270_001));
		expect(long.input).toBeCloseTo(0.270001 * input * 2);
		expect(long.output).toBeCloseTo(0.001 * output * 1.5);
		expect(long.cacheRead).toBeCloseTo(0.001 * cached * 2);
		expect(long.cacheWrite).toBeCloseTo(0.001 * write * 2);
	});

	test.each([
		["gpt-6-sol", 2, 10, 0.2],
		["gpt-6-luna", 0.1, 0.5, 0.01],
	] as const)(
		"recovers subscription pricing for discovered plain and worker %s without API surcharges",
		async (id, input, output, cached) => {
			const result = await fetchCodexModels({
				accessToken: "test-token",
				fetchFn: async () =>
					Response.json({
						models: [
							{
								slug: `${id}-wm`,
								context_window: 372_000,
								max_context_window: 950_000,
								supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
							},
						],
					}),
			});
			for (const route of [id, `${id}-wm`]) {
				const spec = result?.models.find(model => model.id === route);
				if (!spec) throw new Error(`Missing discovered route ${route}`);
				const model = buildModel(spec);
				// A rollout's live context metadata must not be replaced by an offline default.
				expect(model.contextWindow).toBe(372_000);
				expect(model.maxContextWindow).toBe(950_000);
				const cost = calculateUsageCost(model.cost, usage(300_000));
				expect(cost.input).toBeCloseTo(0.3 * input);
				expect(cost.output).toBeCloseTo(0.001 * output);
				expect(cost.cacheRead).toBeCloseTo(0.001 * cached);
				expect(cost.cacheWrite).toBe(0);
			}
		},
	);
});
