import { describe, expect, it } from "vitest";
import { parseOpenRouterCatalogCost, parseOpenRouterCatalogMetadata } from "../scripts/openrouter-catalog-metadata.ts";
import { getSupportedThinkingLevels, resolveModelThinkingLevel } from "../src/model-capabilities.ts";
import { getModel } from "../src/models.ts";
import { streamOpenAICompletions } from "../src/providers/openai-completions.ts";
import type { Model } from "../src/types.ts";

describe("OpenRouter catalog metadata", () => {
	it.each([undefined, 0.0123])(
		"keeps router cost nonnegative and preserves reported cost %s",
		async (reportedCost) => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = async () =>
				new Response(
					`data: ${JSON.stringify({
						id: "fixture",
						choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
						usage: { prompt_tokens: 10, completion_tokens: 2, cost: reportedCost },
					})}\n\ndata: [DONE]\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			try {
				const result = await streamOpenAICompletions(
					getModel("openrouter", "typesafe/jev-router"),
					{
						messages: [{ role: "user", content: "fixture", timestamp: 1 }],
					},
					{ apiKey: "fixture-key" },
				).result();
				expect(result.stopReason, result.errorMessage).toBe("stop");
				expect(result.usage.cost.total).toBe(reportedCost ?? 0);
				expect(result.usage.cost.input).toBe(0);
				expect(result.usage.cost.output).toBe(0);
			} finally {
				globalThis.fetch = originalFetch;
			}
		},
	);
	it("retains router pricing as unavailable without negative estimates", () => {
		expect(parseOpenRouterCatalogCost({ prompt: "-1", completion: "-1" })).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});
	it("converts advertised prices and genuine zero rates to per-million units", () => {
		expect(
			parseOpenRouterCatalogCost({
				prompt: "0.000002",
				completion: "0",
				input_cache_read: "0.0000005",
				input_cache_write: "0.000003",
			}),
		).toEqual({ input: 2, output: 0, cacheRead: 0.5, cacheWrite: 3 });
		expect(parseOpenRouterCatalogCost(undefined)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});
	it.each(["NaN", "Infinity", "0.000001oops", "", "1e308", {}, true])("rejects unusable prices: %s", (prompt) => {
		expect(() => parseOpenRouterCatalogCost({ prompt })).toThrow(/OpenRouter.*price/);
	});
	it("keeps an alias target separate from the requested model identity", () => {
		const metadata = parseOpenRouterCatalogMetadata({
			id: "~deepseek/deepseek-flash-latest",
			alias_target: { slug: "deepseek/deepseek-v4.1-flash" },
		});
		expect(metadata).toEqual({ targetId: "deepseek/deepseek-v4.1-flash" });
	});

	it("exposes only advertised efforts and respects mandatory reasoning through the capability consumer", () => {
		const metadata = parseOpenRouterCatalogMetadata({
			reasoning: {
				mandatory: true,
				supported_efforts: ["low", "medium", "high", "xhigh", "max"],
				default_effort: "medium",
			},
		});
		const model: Model<"openai-completions"> = {
			id: "~openai/gpt-astra-latest",
			name: "GPT Astra Latest",
			provider: "openrouter",
			api: "openai-completions",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
			...metadata,
		};
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(resolveModelThinkingLevel(model, undefined)).toBe("medium");
		expect(resolveModelThinkingLevel(model, "off")).toBe("low");
	});

	it("allows optional reasoning while excluding unadvertised effort levels", () => {
		const metadata = parseOpenRouterCatalogMetadata({
			reasoning: { mandatory: false, supported_efforts: ["low", "high", "max"], default_effort: "high" },
		});
		expect(metadata.thinkingLevelMap).toEqual({
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
		expect(metadata.defaultThinkingLevel).toBe("high");
	});

	it.each([undefined, null, {}, [], { reasoning: null }, { alias_target: { slug: 12 } }].map((value) => ({ value })))(
		"ignores absent or malformed optional metadata: $value",
		({ value }) => expect(parseOpenRouterCatalogMetadata(value)).toEqual({}),
	);

	it.each([[], ["future-effort"], ["high", 12], "high"].map((supported_efforts) => ({ supported_efforts })))(
		"does not erase legacy effort metadata for an unusable advertisement: $supported_efforts",
		({ supported_efforts }) => {
			const metadata = parseOpenRouterCatalogMetadata({ reasoning: { supported_efforts } });
			expect(metadata.thinkingLevelMap).toBeUndefined();
		},
	);

	it("does not accept an unadvertised default", () => {
		const metadata = parseOpenRouterCatalogMetadata({
			reasoning: { supported_efforts: ["high", "max"], default_effort: "low" },
		});
		expect(metadata.defaultThinkingLevel).toBeUndefined();
	});

	it("preserves mandatory reasoning even when effort metadata is unusable", () => {
		const metadata = parseOpenRouterCatalogMetadata({
			reasoning: { mandatory: true, supported_efforts: ["future-effort"] },
		});
		expect(metadata.thinkingLevelMap).toEqual({ off: null });
	});
});
