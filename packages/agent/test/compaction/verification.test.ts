import { describe, expect, it } from "vitest";
import type { CompactionFacts } from "../../src/compaction/extraction.ts";
import { containment, jaccard, tokenSet, verifySummary } from "../../src/compaction/index.ts";

const baseFacts: CompactionFacts = {
	files: [
		{ path: "src/fetcher.ts", kind: "modified", note: "EDIT" },
		{ path: "test/fetcher.test.ts", kind: "read", note: "READ" },
	],
	actions: ["EDIT src/fetcher.ts — added retry loop", "RUN npm test — 2 failed: fetcher.test.ts"],
	prohibitions: ["do not touch the legacy client"],
	cancelledText: "wrapped legacy client adapter",
	activeTaskSource: "Fix the two failing tests now",
};

const goodSummary = `## Active Task
User: Fix the two failing tests now

### Mandatory Rules
- DO NOT touch the legacy client; the cancelled wrapped legacy client adapter is forbidden.

## Files
- src/fetcher.ts — edited retry loop (modified)
- test/fetcher.test.ts — read; 2 failing tests

## Done
1. EDIT src/fetcher.ts — added retry loop
2. RUN npm test — 2 failed: fetcher.test.ts

## Constraints & Preferences
(none)

## Key Decisions
(none)

## Blocked / Open
- 2 fetcher tests failing

## Critical Context
(none)`;

describe("verifySummary", () => {
	it("accepts a summary that preserves required deterministic facts", () => {
		expect(verifySummary(goodSummary, baseFacts)).toEqual({ ok: true, failures: [] });
	});

	it("requires every modified or created path verbatim in ## Files", () => {
		const report = verifySummary(goodSummary.replace("src/fetcher.ts", "src/other.ts"), baseFacts);
		expect(report.ok).toBe(false);
		expect(report.failures.some((failure) => failure.check === "files-modified-recall")).toBe(true);
	});

	it("uses containment for read paths so small needles survive large file sections", () => {
		const facts: CompactionFacts = {
			...baseFacts,
			files: [{ path: "docs/design.md", kind: "read", note: "READ" }],
			actions: [],
			prohibitions: [],
			cancelledText: "",
			activeTaskSource: "",
		};
		const summary = `## Active Task
(none)

### Mandatory Rules
(none)

## Files
- docs/design.md — read among many unrelated details alpha beta gamma delta epsilon zeta eta theta iota kappa

## Done
(none)`;
		expect(verifySummary(summary, facts).ok).toBe(true);
		expect(containment(tokenSet("docs/design.md"), tokenSet(summary))).toBe(1);
		expect(jaccard(tokenSet("docs/design.md"), tokenSet(summary))).toBeLessThan(0.5);
	});

	it("checks active task containment", () => {
		const report = verifySummary(goodSummary.replace("Fix the two failing tests", "Continue"), baseFacts);
		expect(report.ok).toBe(false);
		expect(report.failures.some((failure) => failure.check === "active-task-containment")).toBe(true);
	});

	it("checks mandatory-rule recall", () => {
		const report = verifySummary(
			goodSummary.replace("DO NOT touch the legacy client", "Avoid unrelated edits"),
			baseFacts,
		);
		expect(report.ok).toBe(false);
		expect(report.failures.some((failure) => failure.check === "mandatory-rules-recall")).toBe(true);
	});

	it("rejects cancelled work outside mandatory rules but allows it in a DO-NOT bullet", () => {
		const leaked = `${goodSummary}\n\n## Critical Context\nwrapped legacy client adapter`;
		const report = verifySummary(leaked, baseFacts);
		expect(report.ok).toBe(false);
		expect(report.failures.some((failure) => failure.check === "cancelled-work-dropped")).toBe(true);
	});

	it("checks action overlap with the ## Done section", () => {
		const report = verifySummary(
			goodSummary.replace("EDIT src/fetcher.ts — added retry loop", "looked around"),
			baseFacts,
		);
		expect(report.ok).toBe(false);
		expect(report.failures.some((failure) => failure.check === "actions-overlap")).toBe(true);
	});

	it("short-circuits empty facts to ok", () => {
		expect(
			verifySummary("", { files: [], actions: [], prohibitions: [], cancelledText: "", activeTaskSource: "" }),
		).toEqual({ ok: true, failures: [] });
	});
});
