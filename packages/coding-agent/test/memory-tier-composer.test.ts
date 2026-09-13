import { describe, expect, it } from "vitest";
import { resolveMemoryPromptBudget } from "../src/core/context/memory-prompt-budget.ts";
import { composeTieredMemoryPromptBlock, type MemoryTierCandidate } from "../src/core/context/memory-tier-composer.ts";

function candidate(overrides: Partial<MemoryTierCandidate>): MemoryTierCandidate {
	return {
		id: overrides.id ?? "candidate",
		tier: overrides.tier ?? "long_term",
		sourceLabel: overrides.sourceLabel ?? "memory:test",
		summary: overrides.summary ?? "remembered context",
		score: overrides.score,
		stale: overrides.stale,
		conflict: overrides.conflict,
	};
}

describe("composeTieredMemoryPromptBlock", () => {
	it("keeps compact output within 10 lines and 200 estimated tokens", () => {
		const budget = resolveMemoryPromptBudget({ contextWindow: 1024, configuredMaxResults: 10 });
		const result = composeTieredMemoryPromptBlock(
			Array.from({ length: 20 }, (_, index) =>
				candidate({ id: `m${index}`, tier: "long_term", summary: `short memory ${index}` }),
			),
			budget,
		);

		expect(result.text?.split("\n").length).toBeLessThanOrEqual(10);
		expect(result.includedCount).toBeLessThan(20);
		expect(result.omittedCount).toBeGreaterThan(0);
	});

	it("prioritizes standing and current work before long-term memory", () => {
		const budget = resolveMemoryPromptBudget({ contextWindow: 1024, configuredMaxResults: 10 });
		const result = composeTieredMemoryPromptBlock(
			[
				candidate({ id: "long", tier: "long_term", sourceLabel: "memory:automata", summary: "long term" }),
				candidate({ id: "work", tier: "current_work", sourceLabel: "work:goal", summary: "active goal" }),
				candidate({ id: "rule", tier: "standing", sourceLabel: "rule:user", summary: "user rule" }),
			],
			budget,
		);

		const lines = result.text?.split("\n") ?? [];
		expect(lines[1]).toContain("rule:user");
		expect(lines[2]).toContain("work:goal");
		expect(lines[3]).toContain("memory:automata");
	});

	it("omits stale/conflicting/secret-like candidates and does NOT truncate oversized summaries", () => {
		const budget = resolveMemoryPromptBudget({ contextWindow: 1024 });
		const result = composeTieredMemoryPromptBlock(
			[
				candidate({ id: "ok", tier: "standing", summary: "safe preference" }),
				candidate({ id: "stale", stale: true, summary: "old" }),
				candidate({ id: "conflict", conflict: "current instruction wins", summary: "bad" }),
				candidate({ id: "secret", summary: "api_key=sk-12345678" }),
				candidate({ id: "huge", summary: "x".repeat(2000) }),
			],
			budget,
		);

		expect(result.includedCount).toBe(1);
		expect(result.text).toContain("safe preference");
		expect(result.text).not.toContain("…"); // No truncation: facts are never cut midway
		const reasons = result.diagnostics.map((diagnostic) => diagnostic.reason);
		expect(reasons).toContain("stale_or_conflicting");
		expect(reasons).toContain("secret_like");
		expect(reasons).toContain("oversized_item");
	});

	it("allows entire facts that fit the shared budget, never truncates them", () => {
		const budget = resolveMemoryPromptBudget({ contextWindow: 32_000 });
		const longSummary = "x".repeat(500); // Previously capped at 300 chars, now allowed if it fits the budget
		const result = composeTieredMemoryPromptBlock(
			[candidate({ id: "long", tier: "standing", summary: longSummary })],
			budget,
		);

		expect(result.includedCount).toBe(1);
		expect(result.text).toContain(longSummary);
		expect(result.text).not.toContain("…"); // No truncation
	});

	it("uses memoryTextFitsBudget with JS character count, not UTF-8 bytes", () => {
		const budget = resolveMemoryPromptBudget({ contextWindow: 32_000 });
		// Multi-byte UTF-8: "é" is 1 JS char but 2 UTF-8 bytes
		const text = "é".repeat(100); // 100 JS chars
		const result = composeTieredMemoryPromptBlock(
			[candidate({ id: "unicode", tier: "standing", summary: text })],
			budget,
		);

		// Should include because 100 JS chars fits within the budget
		expect(result.includedCount).toBe(1);
	});
});
