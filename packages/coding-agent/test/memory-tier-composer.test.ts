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

	it("omits stale/conflicting/secret-like candidates and truncates oversized summaries", () => {
		const budget = resolveMemoryPromptBudget({ contextWindow: 1024 });
		const result = composeTieredMemoryPromptBlock(
			[
				candidate({ id: "ok", tier: "standing", summary: "safe preference" }),
				candidate({ id: "stale", stale: true, summary: "old" }),
				candidate({ id: "conflict", conflict: "current instruction wins", summary: "bad" }),
				candidate({ id: "secret", summary: "api_key=abc123" }),
				candidate({ id: "huge", summary: "x".repeat(2000) }),
			],
			budget,
		);

		expect(result.includedCount).toBe(2);
		expect(result.text).toContain("safe preference");
		expect(result.text).toContain("…");
		expect(result.diagnostics.map((diagnostic) => diagnostic.reason)).toEqual(
			expect.arrayContaining(["stale_or_conflicting", "secret_like"]),
		);
	});
});
