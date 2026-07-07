import { describe, expect, it } from "vitest";
import { resolveDisabledGoogleThinkingConfig, resolveGoogleThinkingConfig } from "../src/providers/google-shared.ts";

describe("google-shared thinking config mapper", () => {
	it("maps Gemma 4 reasoning to thinkingLevel for both Google providers", () => {
		const directGoogleConfig = resolveGoogleThinkingConfig("gemma-4-it", "low");
		const vertexConfig = resolveGoogleThinkingConfig("gemma-4-it", "low");

		expect(directGoogleConfig).toEqual(vertexConfig);
		expect(directGoogleConfig).toEqual({ thinkingLevel: "MINIMAL" });
		expect(resolveGoogleThinkingConfig("gemma-4-it", "medium")).toEqual({ thinkingLevel: "HIGH" });
	});

	it("keeps Gemini 2.5 thinking budgets unchanged", () => {
		expect(resolveGoogleThinkingConfig("gemini-2.5-pro", "minimal")).toEqual({ thinkingBudget: 128 });
		expect(resolveGoogleThinkingConfig("gemini-2.5-pro", "high")).toEqual({ thinkingBudget: 32768 });
		expect(resolveGoogleThinkingConfig("gemini-2.5-flash-lite", "minimal")).toEqual({ thinkingBudget: 512 });
		expect(resolveGoogleThinkingConfig("gemini-2.5-flash-lite", "high")).toEqual({ thinkingBudget: 24576 });
		expect(resolveGoogleThinkingConfig("gemini-2.5-flash", "minimal")).toEqual({ thinkingBudget: 128 });
		expect(resolveGoogleThinkingConfig("gemini-2.5-flash", "high")).toEqual({ thinkingBudget: 24576 });
		expect(resolveGoogleThinkingConfig("gemini-2.0-flash", "medium")).toEqual({ thinkingBudget: -1 });
		expect(resolveGoogleThinkingConfig("gemini-2.5-flash", "low", { low: 4096 })).toEqual({ thinkingBudget: 4096 });
	});

	it("maps disabled thinking consistently across Google providers", () => {
		const directGoogleConfig = resolveDisabledGoogleThinkingConfig("gemma-4-it");
		const vertexConfig = resolveDisabledGoogleThinkingConfig("gemma-4-it");

		expect(directGoogleConfig).toEqual(vertexConfig);
		expect(directGoogleConfig).toEqual({ thinkingLevel: "MINIMAL" });
		expect(resolveDisabledGoogleThinkingConfig("gemini-3-pro-preview")).toEqual({ thinkingLevel: "LOW" });
		expect(resolveDisabledGoogleThinkingConfig("gemini-3-flash-preview")).toEqual({ thinkingLevel: "MINIMAL" });
		expect(resolveDisabledGoogleThinkingConfig("gemini-2.5-flash")).toEqual({ thinkingBudget: 0 });
	});
});
