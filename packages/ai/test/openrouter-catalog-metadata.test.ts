import { describe, expect, it } from "vitest";
import { parseOpenRouterCatalogMetadata } from "../scripts/openrouter-catalog-metadata.ts";
import { getSupportedThinkingLevels, resolveModelThinkingLevel } from "../src/model-capabilities.ts";
import type { Model } from "../src/types.ts";

describe("OpenRouter catalog metadata", () => {
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
