import { describe, expect, it } from "vitest";
import type { CompactionFacts } from "../../src/compaction/extraction.ts";
import { containment, jaccard, tokenSet, verifySummary } from "../../src/compaction/index.ts";

const baseFacts: CompactionFacts = {
	files: [
		{ path: "src/fetcher.ts", kind: "modified", note: "EDIT" },
		{ path: "test/fetcher.test.ts", kind: "read", note: "READ" },
	],
	workingSet: [
		{ path: "src/fetcher.ts", kind: "modified", note: "EDIT" },
		{ path: "test/fetcher.test.ts", kind: "read", note: "READ" },
	],
	actions: ["EDIT src/fetcher.ts — added retry loop", "RUN npm test — 2 failed: fetcher.test.ts"],
	errorFacts: [],
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
			workingSet: [{ path: "docs/design.md", kind: "read", note: "READ" }],
			actions: [],
			errorFacts: [],
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

	it("fails when the ## Done section omits the new span's actions", () => {
		const report = verifySummary(
			goodSummary.replace("EDIT src/fetcher.ts — added retry loop", "looked around"),
			baseFacts,
		);
		expect(report.ok).toBe(false);
		expect(report.failures.some((failure) => failure.check === "actions-recall")).toBe(true);
	});

	it("accepts faithful Done carry-over on the update path (resumed-session regression)", () => {
		// 2026-07-06 incident: symmetric Jaccard punished carrying prior Done items forward, so every
		// 2nd+ compaction of a long session (any resumed session that compacts again) trended toward
		// deterministic gate failure. Recall of the NEW actions must be the only demand.
		const carriedDone = Array.from(
			{ length: 30 },
			(_, i) => `${i + 1}. EDIT src/legacy-area/file-${i}.ts — earlier session work item ${i}`,
		).join("\n");
		const updated = goodSummary.replace(
			"## Done\n1. EDIT src/fetcher.ts — added retry loop\n2. RUN npm test — 2 failed: fetcher.test.ts",
			`## Done\n${carriedDone}\n31. EDIT src/fetcher.ts — added retry loop\n32. RUN npm test — 2 failed: fetcher.test.ts`,
		);
		expect(updated).toContain("31. EDIT src/fetcher.ts");
		expect(verifySummary(updated, baseFacts)).toEqual({ ok: true, failures: [] });
	});

	it("does not count required file paths as cancelled-work leakage", () => {
		// A reversal message that names a modified file must not make cancelled-work-dropped and
		// files-modified-recall mutually unsatisfiable: the path is demanded in ## Files.
		const facts: CompactionFacts = {
			...baseFacts,
			cancelledText: "reworked src/fetcher.ts wrapped adapter attempt",
		};
		const summary = `## Active Task
User: Fix the two failing tests now

### Mandatory Rules
- DO NOT touch the legacy client; the wrapped adapter attempt was cancelled.

## Files
- src/fetcher.ts — retry loop (modified)
- test/fetcher.test.ts — read; 2 failing tests

## Done
1. EDIT src/fetcher.ts — added retry loop
2. RUN npm test — 2 failed: fetcher.test.ts`;
		expect(verifySummary(summary, facts)).toEqual({ ok: true, failures: [] });
	});

	it("short-circuits empty facts to ok", () => {
		expect(
			verifySummary("", {
				files: [],
				workingSet: [],
				actions: [],
				errorFacts: [],
				prohibitions: [],
				cancelledText: "",
				activeTaskSource: "",
			}),
		).toEqual({ ok: true, failures: [] });
	});
});
