import { describe, expect, it } from "vitest";
import type { MemoryPromptBudget } from "../src/core/context/memory-prompt-budget.ts";
import { memoryTextFitsBudget, resolveMemoryPromptBudget } from "../src/core/context/memory-prompt-budget.ts";

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
		// maxChars is now a generous bounded safety ceiling (64_000), NOT derived from tokens.
		expect(budget.maxChars).toBe(64_000);
	});

	it("fails closed when the context window is missing", () => {
		expect(resolveMemoryPromptBudget({ contextWindow: undefined })).toMatchObject({
			enabled: false,
			reason: "missing_context_window",
		});
	});

	it("fails closed when there is no headroom", () => {
		expect(
			resolveMemoryPromptBudget({ contextWindow: 1024, currentPromptTokens: 900, reservedTokens: 200 }),
		).toMatchObject({
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
		expect(budget.maxChars).toBe(64_000);
	});
});

describe("memoryTextFitsBudget", () => {
	it.each(["maxLines", "maxEstimatedTokens", "maxChars"] as const)("rejects invalid %s bounds", (dimension) => {
		const budget = resolveMemoryPromptBudget({ contextWindow: 32_000 });
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
			expect(memoryTextFitsBudget("hello", { ...budget, [dimension]: value })).toBe(false);
		}
	});

	it("returns false when budget is disabled", () => {
		const budget = resolveMemoryPromptBudget({ contextWindow: 1024 });
		expect(memoryTextFitsBudget("hello", { ...budget, enabled: false })).toBe(false);
	});

	it("returns true when text fits all constraints", () => {
		const budget = resolveMemoryPromptBudget({ contextWindow: 32_000 });
		expect(memoryTextFitsBudget("hello world", budget)).toBe(true);
	});

	it("returns false when text exceeds maxLines", () => {
		const budget = resolveMemoryPromptBudget({ contextWindow: 32_000 });
		const multiLine = Array.from({ length: 25 }, (_, i) => `line${i}`).join("\n");
		expect(memoryTextFitsBudget(multiLine, budget)).toBe(false);
	});

	it("returns false when text exceeds maxEstimatedTokens", () => {
		const budget = resolveMemoryPromptBudget({ contextWindow: 32_000 });
		// 800 tokens * 4 chars/token = 3200 chars max; a 4000-char string exceeds this
		const longText = "x".repeat(4000);
		expect(memoryTextFitsBudget(longText, budget)).toBe(false);
	});

	it("returns false when text exceeds maxChars as JS character count, NOT UTF-8 bytes", () => {
		const budget: MemoryPromptBudget = {
			enabled: true,
			compact: false,
			maxLines: 100,
			maxEstimatedTokens: 100,
			maxChars: 5,
			maxResults: 1,
		};
		// "hello" is 5 JS chars and fits, "hello!" is 6 JS chars
		expect(memoryTextFitsBudget("hello", budget)).toBe(true);
		expect(memoryTextFitsBudget("hello!", budget)).toBe(false);
		// Multi-byte UTF-8: "é" is 1 JS char but 2 UTF-8 bytes
		expect(memoryTextFitsBudget("é".repeat(5), budget)).toBe(true); // 5 JS chars <= 5
		expect(memoryTextFitsBudget("é".repeat(6), budget)).toBe(false); // 6 JS chars > 5
	});

	it("documents that estimateTokensFromText is approximate", () => {
		const budget = resolveMemoryPromptBudget({ contextWindow: 32_000 });
		// estimateTokensFromText uses chars/4, so 100 chars = 25 tokens
		const text = "a".repeat(100);
		expect(memoryTextFitsBudget(text, budget)).toBe(true);
	});
});
