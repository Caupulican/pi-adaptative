import { describe, expect, it } from "vitest";
import { AnthropicUsageAccumulator } from "../src/providers/anthropic-usage.ts";
import type { Model } from "../src/types.ts";
import { createEmptyUsage, parseProviderReportedCost } from "../src/usage.ts";

const model: Model<"anthropic-messages"> = {
	id: "local-accounting",
	name: "Local accounting",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://unused.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
};

describe("response-scoped Anthropic accounting", () => {
	it.each([
		[{ output_tokens: 5 }, "reasoning"],
		[{ cache_creation_input_tokens: 3 }, "cache"],
	] as const)("rejects retained subtotals transactionally: %j", (invalid, label) => {
		const usage = createEmptyUsage();
		const accumulator = new AnthropicUsageAccumulator(model, usage);
		accumulator.update({
			input_tokens: 10,
			output_tokens: 10,
			cache_creation_input_tokens: 6,
			output_tokens_details: { thinking_tokens: 8 },
			cache_creation: { ephemeral_5m_input_tokens: 4 },
		});
		const previous = structuredClone(usage);
		expect(() => accumulator.update({ input_tokens: 99, service_tier: "priority", cost: 9, ...invalid })).toThrow(
			label,
		);
		expect(usage).toEqual(previous);
		accumulator.update({ output_tokens: 11, cache_creation_input_tokens: 7 });
		expect(usage.output).toBe(11);
		expect(usage.details?.reasoningTokens).toBe(8);
		expect(usage.details?.cacheWriteWindows).toEqual([{ ttlSeconds: 300, tokens: 4 }]);
		expect(usage.cost.total).not.toBe(9);
	});

	it("distinguishes absent aggregates from authoritative zero", () => {
		const usage = createEmptyUsage();
		const accumulator = new AnthropicUsageAccumulator(model, usage);
		accumulator.update({
			output_tokens_details: { thinking_tokens: 8 },
			cache_creation: { ephemeral_1h_input_tokens: 4 },
		});
		const previous = structuredClone(usage);
		expect(() => accumulator.update({ output_tokens: 0 })).toThrow("reasoning");
		expect(() => accumulator.update({ cache_creation_input_tokens: 0 })).toThrow("cache");
		expect(usage).toEqual(previous);
		accumulator.update({ output_tokens: 10, cache_creation_input_tokens: 6 });
		expect(usage.totalTokens).toBe(16);
	});

	it("retains provider-reported zero cost and replaces cumulative counts", () => {
		const usage = createEmptyUsage();
		const accumulator = new AnthropicUsageAccumulator(model, usage);
		accumulator.update({ input_tokens: 10, output_tokens: 2, service_tier: "priority" });
		expect(usage.cost.estimate).toBe("base-rates");
		accumulator.update({ output_tokens: 4, cost: 0 });
		accumulator.update({ output_tokens: 5 });
		expect(usage.totalTokens).toBe(15);
		expect(usage.cost.total).toBe(0);
		expect(usage.cost.estimate).toBeUndefined();
		expect(parseProviderReportedCost(undefined, 0)).toBe(0);
	});

	it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("rejects malformed counts %s", (count) => {
		const usage = createEmptyUsage();
		const accumulator = new AnthropicUsageAccumulator(model, usage);
		const previous = structuredClone(usage);
		expect(() => accumulator.update({ input_tokens: count })).toThrow();
		expect(usage).toEqual(previous);
	});
});
