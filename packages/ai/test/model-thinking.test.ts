import { describe, expect, test } from "vitest";
import { resolveModelThinkingLevel } from "../src/models.ts";
import type { Model } from "../src/types.ts";

function createModel(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
	return {
		id: "reasoning-model",
		name: "Reasoning model",
		api: "openai-responses",
		provider: "test-provider",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...overrides,
	};
}

describe("resolveModelThinkingLevel", () => {
	test("uses explicit caller intent before model metadata", () => {
		const model = createModel({ defaultThinkingLevel: "low" });
		expect(resolveModelThinkingLevel(model, "high")).toBe("high");
	});

	test("uses model metadata before the harness fallback", () => {
		const model = createModel({ defaultThinkingLevel: "low" });
		expect(resolveModelThinkingLevel(model, undefined, "high")).toBe("low");
	});

	test("uses the provider-neutral medium fallback when no preference is declared", () => {
		expect(resolveModelThinkingLevel(createModel(), undefined)).toBe("medium");
	});

	test("clamps non-reasoning models to off", () => {
		const model = createModel({ reasoning: false, defaultThinkingLevel: undefined });
		expect(resolveModelThinkingLevel(model, "ultra")).toBe("off");
	});

	test("clamps unsupported mapped levels before returning", () => {
		const model = createModel({
			defaultThinkingLevel: "ultra",
			thinkingLevelMap: { ultra: null, max: null, xhigh: null },
		});
		expect(resolveModelThinkingLevel(model, undefined)).toBe("high");
	});
});
