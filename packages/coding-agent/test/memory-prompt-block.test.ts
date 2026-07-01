import { describe, expect, it } from "vitest";
import type { ContextItem } from "../src/core/context/context-item.ts";
import {
	buildMemoryPromptBlock,
	MEMORY_PROMPT_BLOCK_MAX_CHARS_PER_ITEM,
	MEMORY_PROMPT_BLOCK_MAX_TOTAL_CHARS,
} from "../src/core/context/memory-prompt-block.ts";

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
	it("returns undefined text when there are no items", () => {
		const result = buildMemoryPromptBlock([]);
		expect(result).toEqual({ text: undefined, includedCount: 0, omittedCount: 0 });
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

	it("truncates a single item at MAX_CHARS_PER_ITEM and marks it with an ellipsis", () => {
		const huge = "x".repeat(MEMORY_PROMPT_BLOCK_MAX_CHARS_PER_ITEM * 3);
		const result = buildMemoryPromptBlock([memoryItem(huge)]);

		expect(result.includedCount).toBe(1);
		expect(result.omittedCount).toBe(0);
		const text = result.text ?? "";
		expect(text).toContain("…");
		// "1. " prefix + truncated body must not exceed the per-item cap by more than the prefix.
		const line = text.split("\n")[1] ?? "";
		expect(line.length).toBeLessThanOrEqual(MEMORY_PROMPT_BLOCK_MAX_CHARS_PER_ITEM + "1. ".length);
	});

	it("always includes at least the first item, truncated to the per-item cap, even if it alone would exceed the total budget", () => {
		// A single item whose *untruncated* length would blow the total budget on its own.
		const huge = "y".repeat(MEMORY_PROMPT_BLOCK_MAX_TOTAL_CHARS * 2);
		const result = buildMemoryPromptBlock([memoryItem(huge)]);

		expect(result.includedCount).toBe(1);
		expect(result.omittedCount).toBe(0);
		expect(result.text).toBeDefined();
		expect((result.text ?? "").length).toBeLessThan(MEMORY_PROMPT_BLOCK_MAX_TOTAL_CHARS);
	});

	it("stops adding further items once the running total would exceed maxTotalChars, omitting the rest", () => {
		// Use a per-item cap large enough that truncation itself isn't what limits item
		// size here -- only the total-budget check should be exercised. Each item is sized
		// so 3 of them together would exceed the (custom, smaller) total budget, but the
		// first 2 fit comfortably.
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

		expect(result.text).toContain("1. hell…");
		expect(result.text).toContain("2. seco…");
	});

	it("skips an empty-summary item but still includes subsequent non-empty ones, correctly numbered from the included set", () => {
		const result = buildMemoryPromptBlock([memoryItem(""), memoryItem("real content here")]);

		expect(result.includedCount).toBe(1);
		expect(result.omittedCount).toBe(1);
		expect(result.text).toContain("1. real content here");
	});
});
