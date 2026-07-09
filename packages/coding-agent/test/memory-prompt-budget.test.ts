import { describe, expect, it } from "vitest";
import { resolveMemoryPromptBudget } from "../src/core/context/memory-prompt-budget.ts";

describe("resolveMemoryPromptBudget", () => {
	it("uses the compact micro-budget for context windows up to 2048", () => {
		const budget = resolveMemoryPromptBudget({ contextWindow: 2048, configuredMaxResults: 8 });

		expect(budget).toMatchObject({
			enabled: true,
			compact: true,
			maxLines: 10,
			maxEstimatedTokens: 200,
			maxResults: 3,
		});
		expect(budget.maxChars).toBeLessThanOrEqual(800);
	});

	it("fails closed when the context window is missing", () => {
		expect(resolveMemoryPromptBudget({ contextWindow: undefined })).toMatchObject({
			enabled: false,
			reason: "missing_context_window",
		});
	});

	it("fails closed when there is no headroom", () => {
		expect(resolveMemoryPromptBudget({ contextWindow: 1024, currentPromptTokens: 900, reservedTokens: 200 })).toMatchObject({
			enabled: false,
			compact: true,
			reason: "no_context_headroom",
		});
	});

	it("uses a bounded normal budget for larger windows", () => {
		const budget = resolveMemoryPromptBudget({ contextWindow: 32_000, configuredMaxResults: 20 });

		expect(budget.enabled).toBe(true);
		expect(budget.compact).toBe(false);
		expect(budget.maxLines).toBe(20);
		expect(budget.maxEstimatedTokens).toBeLessThanOrEqual(800);
		expect(budget.maxResults).toBe(10);
	});
});
