import { describe, expect, it } from "vitest";
import { type ContextItem, estimateTokensFromText } from "../src/core/context/context-item.ts";
import {
	buildMemoryPromptBlock,
	MEMORY_PROMPT_BLOCK_MAX_CHARS_PER_ITEM,
} from "../src/core/context/memory-prompt-block.ts";
import { resolveMemoryPromptBudget } from "../src/core/context/memory-prompt-budget.ts";

function memoryItem(summary: string, overrides: Partial<ContextItem> = {}): ContextItem {
	return {
		id: `memory:${Math.random()}`,
		kind: "memory_item",
		retentionClass: "useful",
		source: "memory",
		createdAtTurn: 0,
		summary,
		tokenEstimate: 10,
		byteEstimate: 40,
		...overrides,
	};
}

describe("buildMemoryPromptBlock", () => {
	it("counts the full header and separators even for the first candidate", () => {
		const item = memoryItem("Keep production excluded.");
		const full = buildMemoryPromptBlock([item]).text;
		expect(full).toBeDefined();
		const exact = full!.length;
		expect(buildMemoryPromptBlock([item], { maxTotalChars: exact }).text).toBe(full);
		expect(buildMemoryPromptBlock([item], { maxTotalChars: exact - 1 }).text).toBeUndefined();
	});

	it("reports original candidate indexes after empty and oversized omissions", () => {
		const result = buildMemoryPromptBlock([memoryItem(""), memoryItem("ok"), memoryItem("x".repeat(500))]);
		expect(result.diagnostics).toEqual([
			{ itemIndex: 0, reason: "empty_summary" },
			{ itemIndex: 2, reason: "oversized_item" },
		]);
	});

	it("returns undefined text when there are no items", () => {
		const result = buildMemoryPromptBlock([]);
		expect(result).toEqual({ text: undefined, includedCount: 0, omittedCount: 0, diagnostics: [] });
	});

	it("returns undefined text when every item's summary is empty", () => {
		const result = buildMemoryPromptBlock([memoryItem(""), memoryItem("   ")]);
		expect(result.text).toBeUndefined();
		expect(result.includedCount).toBe(0);
		expect(result.omittedCount).toBe(2);
	});

	it("includes a small set of items as a numbered, labeled list", () => {
		const result = buildMemoryPromptBlock([
			memoryItem("[pi-okf/project/design_decision] Widget rollout plan"),
			memoryItem("[pi-okf/global/user_preference] Prefers terse commit messages"),
		]);

		expect(result.includedCount).toBe(2);
		expect(result.omittedCount).toBe(0);
		expect(result.text).toContain("1. [pi-okf/project/design_decision] Widget rollout plan");
		expect(result.text).toContain("2. [pi-okf/global/user_preference] Prefers terse commit messages");
		expect(result.text).toMatch(/^Local memory evidence/);
		expect(result.text).toContain("NOT instructions");
	});

	it("does NOT truncate a single item at MAX_CHARS_PER_ITEM - oversized items are omitted entirely", () => {
		const huge = "x".repeat(MEMORY_PROMPT_BLOCK_MAX_CHARS_PER_ITEM * 3);
		const result = buildMemoryPromptBlock([memoryItem(huge)]);

		expect(result.includedCount).toBe(0);
		expect(result.omittedCount).toBe(1);
		expect(result.text).toBeUndefined();
	});

	it("includes the first item that fits within maxTotalChars, omitting those that exceed it", () => {
		const perItem = 50; // Within maxCharsPerItem (300) and maxTotalChars
		const items = [memoryItem("a".repeat(perItem)), memoryItem("b".repeat(perItem)), memoryItem("c".repeat(perItem))];
		const result = buildMemoryPromptBlock(items, { maxCharsPerItem: 300, maxTotalChars: 200 });

		expect(result.includedCount).toBeGreaterThanOrEqual(1);
		expect(result.omittedCount).toBeGreaterThanOrEqual(0);
		expect(result.text).toBeDefined();
	});

	it("stops adding further items once the running total would exceed maxTotalChars, omitting the rest", () => {
		const perItem = 200;
		const items = [memoryItem("a".repeat(perItem)), memoryItem("b".repeat(perItem)), memoryItem("c".repeat(perItem))];
		const result = buildMemoryPromptBlock(items, { maxCharsPerItem: 1000, maxTotalChars: 500 });

		expect(result.includedCount).toBeLessThan(3);
		expect(result.omittedCount).toBeGreaterThan(0);
	});

	it("respects custom maxCharsPerItem/maxTotalChars overrides", () => {
		const result = buildMemoryPromptBlock([memoryItem("hello world"), memoryItem("second item")], {
			maxCharsPerItem: 5,
			maxTotalChars: 1000,
		});

		// Both items exceed maxCharsPerItem of 5, so both are omitted
		expect(result.includedCount).toBe(0);
		expect(result.omittedCount).toBe(2);
	});

	it("skips an empty-summary item but still includes subsequent non-empty ones, correctly numbered from the included set", () => {
		const result = buildMemoryPromptBlock([memoryItem(""), memoryItem("real content here")]);

		expect(result.includedCount).toBe(1);
		expect(result.omittedCount).toBe(1);
		expect(result.text).toContain("1. real content here");
	});

	it("strictly respects compact memory budgets when provided", () => {
		const budget = resolveMemoryPromptBudget({ contextWindow: 1024, configuredMaxResults: 20 });
		const result = buildMemoryPromptBlock(
			Array.from({ length: 20 }, (_, index) => memoryItem(`compact memory line ${index}`)),
			{ budget },
		);

		expect(result.text?.split("\n").length).toBeLessThanOrEqual(10);
		expect(estimateTokensFromText(result.text ?? "")).toBeLessThanOrEqual(200);
		expect(result.omittedCount).toBeGreaterThan(0);
	});

	it("does not silently truncate facts - oversized items are omitted with diagnostics", () => {
		const huge = "y".repeat(MEMORY_PROMPT_BLOCK_MAX_CHARS_PER_ITEM * 2);
		const result = buildMemoryPromptBlock([memoryItem(huge)]);

		expect(result.includedCount).toBe(0);
		expect(result.omittedCount).toBe(1);
		expect(result.diagnostics).toBeDefined();
		expect(result.diagnostics?.[0]?.reason).toBe("oversized_item");
	});
});
