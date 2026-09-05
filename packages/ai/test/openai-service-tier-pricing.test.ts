import { describe, expect, expectTypeOf, it } from "vitest";
import type { OpenAICodexResponsesOptions } from "../src/providers/openai-codex-responses.ts";
import type { OpenAIResponsesOptions } from "../src/providers/openai-responses.ts";
import { applyOpenAIServiceTierPricing } from "../src/providers/openai-responses-shared.ts";
import type { StreamOptions, Usage } from "../src/types.ts";

function usage(): Usage {
	return {
		input: 1,
		output: 1,
		cacheRead: 1,
		cacheWrite: 1,
		totalTokens: 4,
		cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
	};
}

describe("OpenAI service-tier pricing", () => {
	it("keeps both request APIs on the provider-neutral tier contract", () => {
		expectTypeOf<OpenAIResponsesOptions["serviceTier"]>().toEqualTypeOf<StreamOptions["serviceTier"]>();
		expectTypeOf<OpenAICodexResponsesOptions["serviceTier"]>().toEqualTypeOf<StreamOptions["serviceTier"]>();
		expectTypeOf<"ultrafast">().not.toExtend<StreamOptions["serviceTier"]>();
	});

	it.each([
		["gpt-5.4", "flex", 0.5],
		["gpt-5.4", "priority", 2],
		["gpt-5.5", "priority", 2.5],
		["gpt-5.5", "default", 1],
	] as const)("applies the shared %s/%s multiplier", (modelId, serviceTier, multiplier) => {
		const result = usage();
		applyOpenAIServiceTierPricing(result, serviceTier, { id: modelId });
		expect(result.cost).toEqual({
			input: 1 * multiplier,
			output: 2 * multiplier,
			cacheRead: 3 * multiplier,
			cacheWrite: 4 * multiplier,
			total: 10 * multiplier,
		});
	});
});
