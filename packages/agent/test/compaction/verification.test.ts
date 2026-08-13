import { describe, expect, it } from "vitest";
import type { CompactionFacts } from "../../src/compaction/extraction.ts";
import {
	ACTIONS_RECALL_THRESHOLD,
	ACTIVE_TASK_CONTAINMENT_THRESHOLD,
	CANCELLED_WORK_DROPPED_THRESHOLD,
	COMPACTION_WORKED_EXAMPLE_SENTINEL,
	containment,
	deterministicallyFillSummaryGaps,
	FILES_READ_RECALL_THRESHOLD,
	isCompactionSummaryStructurallyUsable,
	jaccard,
	MANDATORY_RULES_RECALL_THRESHOLD,
	OPEN_ERRORS_RECALL_THRESHOLD,
	SUMMARIZATION_SYSTEM_PROMPT,
	tokenSet,
	verifySummary,
} from "../../src/compaction/index.ts";

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

## Working Set
- src/fetcher.ts — edited retry loop
- test/fetcher.test.ts — read; 2 failing tests

## Files
- src/fetcher.ts
- test/fetcher.test.ts

## Open Problems
(none)

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
		const report = verifySummary(
			goodSummary.replace("## Files\n- src/fetcher.ts", "## Files\n- src/other.ts"),
			baseFacts,
		);
		expect(report.ok).toBe(false);
		expect(report.failures.some((failure) => failure.check === "files-modified-recall")).toBe(true);
	});

	it("requires working-set paths in ## Working Set", () => {
		const report = verifySummary(
			goodSummary.replace("src/fetcher.ts — edited retry loop", "src/other.ts"),
			baseFacts,
		);
		expect(report.ok).toBe(false);
		expect(report.failures.some((failure) => failure.check === "working-set-recall")).toBe(true);
	});

	it("requires open errors in ## Open Problems", () => {
		const facts: CompactionFacts = {
			...baseFacts,
			errorFacts: [{ operation: "TEST npm test", error: "2 failed: fetcher.test.ts" }],
		};
		const summary = goodSummary.replace(
			"## Open Problems\n(none)",
			"## Open Problems\n- TEST npm test: 2 failed: fetcher.test.ts",
		);
		expect(verifySummary(summary, facts)).toEqual({ ok: true, failures: [] });

		const report = verifySummary(summary.replace("TEST npm test: 2 failed: fetcher.test.ts", "tests failed"), facts);
		expect(report.ok).toBe(false);
		expect(report.failures.some((failure) => failure.check === "open-errors-recall")).toBe(true);
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

## Working Set
- docs/design.md — current design notes

## Files
- docs/design.md

## Open Problems
(none)

## Done
(none)`;
		expect(verifySummary(summary, facts).ok).toBe(true);
		expect(containment(tokenSet("docs/design.md"), tokenSet(summary))).toBe(1);
		expect(jaccard(tokenSet("docs/design.md"), tokenSet(summary))).toBeLessThan(0.5);
	});

	it("scores read-file recall by exact path identities", () => {
		const facts: CompactionFacts = {
			...baseFacts,
			files: [
				{ path: "docs/shared alpha.md", kind: "read", note: "READ" },
				{ path: "docs/shared beta.md", kind: "read", note: "READ" },
			],
			workingSet: [],
			actions: [],
			errorFacts: [],
			prohibitions: [],
			cancelledText: "",
			activeTaskSource: "",
		};
		const report = verifySummary("## Files\n- docs/shared alpha.md.backup\n- docs/shared", facts);
		const failure = report.failures.find((candidate) => candidate.check === "files-read-recall");

		expect(failure).toMatchObject({
			score: 0,
			threshold: FILES_READ_RECALL_THRESHOLD,
			comparator: "minimum",
			matched: 0,
			demanded: 2,
		});
		expect(failure?.detail).toContain("0/2 exact paths");
	});

	it("passes when a checkpoint transcribes the facts block", () => {
		const factsText = [
			"## Active Task",
			baseFacts.activeTaskSource,
			"",
			"### Mandatory Rules",
			baseFacts.prohibitions.join("\n"),
			"",
			"## Working Set",
			baseFacts.workingSet.map((file) => `${file.path} ${file.note}`).join("\n"),
			"",
			"## Files",
			baseFacts.files.map((file) => file.path).join("\n"),
			"",
			"## Open Problems",
			baseFacts.errorFacts.map((error) => `${error.operation}: ${error.error}`).join("\n") || "(none)",
			"",
			"## Done",
			baseFacts.actions.join("\n"),
		].join("\n");
		expect(verifySummary(factsText, baseFacts)).toEqual({ ok: true, failures: [] });
	});

	it("checks active task containment", () => {
		const report = verifySummary(goodSummary.replace("Fix the two failing tests", "Continue"), baseFacts);
		expect(report.ok).toBe(false);
		expect(report.failures.some((failure) => failure.check === "active-task-containment")).toBe(true);
	});

	it("replaces a reworded conditional task instead of preserving invented intent", () => {
		const activeTaskSource =
			"Work for up to one hour, but stop and report immediately if the harness loops, stalls, loses worker state, or misses completion.";
		const facts: CompactionFacts = {
			files: [],
			workingSet: [],
			actions: [],
			errorFacts: [],
			prohibitions: [],
			cancelledText: "",
			activeTaskSource,
		};
		const reworded = `## Active Task
Stop and report immediately because the harness failed.

### Mandatory Rules
(none)

## Working Set
(none)

## Files
(none)

## Open Problems
(none)

## Done
(none)`;

		const filled = deterministicallyFillSummaryGaps(reworded, facts);

		expect(filled.verification).toEqual({ ok: true, failures: [] });
		expect(filled.summary).toContain(`## Active Task\nUser: ${activeTaskSource}\n\n### Mandatory Rules`);
		expect(filled.summary).not.toContain("because the harness failed");
	});

	it("weights open-error operation and failure identity independently", () => {
		const facts: CompactionFacts = {
			...baseFacts,
			files: [],
			workingSet: [],
			actions: [],
			errorFacts: [
				{
					operation:
						"RUN npm run check -- --workspace packages/agent --reporter verbose --coverage --changed origin/main",
					error: "FAIL TypeScript contract regression",
				},
			],
			prohibitions: [],
			cancelledText: "",
			activeTaskSource: "",
		};
		const partialOperation = `## Open Problems
- RUN npm run check -- workspace packages/agent coverage
- FAIL TypeScript contract regression`;
		expect(verifySummary(partialOperation, facts)).toEqual({ ok: true, failures: [] });

		const missingOperation = verifySummary("## Open Problems\n- FAIL TypeScript contract regression", facts);
		const failure = missingOperation.failures.find((candidate) => candidate.check === "open-errors-recall");
		expect(failure).toMatchObject({
			score: 0.5,
			threshold: OPEN_ERRORS_RECALL_THRESHOLD,
			comparator: "minimum",
		});
		expect(failure?.detail).toContain("operation 0.00, error 1.00");
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

## Working Set
- src/fetcher.ts — retry loop
- test/fetcher.test.ts — read; 2 failing tests

## Files
- src/fetcher.ts
- test/fetcher.test.ts

## Open Problems
(none)

## Done
1. EDIT src/fetcher.ts — added retry loop
2. RUN npm test — 2 failed: fetcher.test.ts`;
		expect(verifySummary(summary, facts)).toEqual({ ok: true, failures: [] });
	});

	it("deterministically gap-fills missing gate demands and removes cancelled leakage", () => {
		const facts: CompactionFacts = {
			...baseFacts,
			errorFacts: [{ operation: "TEST npm test", error: "2 failed: fetcher.test.ts" }],
		};
		const incomplete = `## Active Task
Continue

### Mandatory Rules
(none)

## Working Set
(none)

## Files
(none)

## Open Problems
(none)

## Done
1. wrapped legacy client adapter`;

		const initial = verifySummary(incomplete, facts);
		expect(initial.ok).toBe(false);

		const filled = deterministicallyFillSummaryGaps(incomplete, facts);

		expect(filled.changed).toBe(true);
		expect(filled.verification).toEqual({ ok: true, failures: [] });
		expect(filled.summary).toContain("User: Fix the two failing tests now");
		expect(filled.summary).toContain("- do not touch the legacy client");
		expect(filled.summary).toContain("- src/fetcher.ts — EDIT");
		expect(filled.summary).toContain("- test/fetcher.test.ts");
		expect(filled.summary).toContain("- TEST npm test: 2 failed: fetcher.test.ts");
		expect(filled.summary).toContain("1. EDIT src/fetcher.ts — added retry loop");
		expect(filled.summary).not.toContain("1. wrapped legacy client adapter");
	});

	it("preserves a model-carried Mandatory Rules line the extractor does not own", () => {
		// "Always run tests from packages/coding-agent" does not match PROHIBITION_PATTERN
		// (do not|don't|never|stop doing/using/changing|no more), so the extractor never harvests it as
		// a prohibition. The model faithfully carried it forward; gap-fill must not delete it.
		const facts: CompactionFacts = {
			files: [],
			workingSet: [],
			actions: [],
			errorFacts: [],
			prohibitions: [],
			cancelledText: "",
			activeTaskSource: "",
		};
		const summary = `## Active Task
(none)

### Mandatory Rules
- Always run tests from packages/coding-agent.

## Working Set
(none)

## Files
(none)

## Open Problems
(none)

## Done
(none)`;

		const filled = deterministicallyFillSummaryGaps(summary, facts);

		expect(filled.summary).toContain("### Mandatory Rules\n- Always run tests from packages/coding-agent.");
	});

	it("never overwrites non-empty Mandatory Rules content with the (none) placeholder", () => {
		const facts: CompactionFacts = {
			files: [],
			workingSet: [],
			actions: [],
			errorFacts: [],
			prohibitions: [],
			cancelledText: "",
			activeTaskSource: "",
		};
		const summary = `## Active Task
(none)

### Mandatory Rules
- Keep secrets out of logs.

## Working Set
(none)

## Files
(none)

## Open Problems
(none)

## Done
(none)`;

		const filled = deterministicallyFillSummaryGaps(summary, facts);
		const mandatoryRulesSection = filled.summary.split("### Mandatory Rules")[1].split("## Working Set")[0];

		expect(mandatoryRulesSection).not.toContain("(none)");
		expect(mandatoryRulesSection).toContain("- Keep secrets out of logs.");
	});

	it("force-replaces a paraphrased Mandatory Rules line with the extractor-owned rule verbatim", () => {
		const facts: CompactionFacts = {
			files: [],
			workingSet: [],
			actions: [],
			errorFacts: [],
			prohibitions: ["do not touch the legacy client"],
			cancelledText: "",
			activeTaskSource: "",
		};
		const summary = `## Active Task
(none)

### Mandatory Rules
- Never touch the legacy client system.

## Working Set
(none)

## Files
(none)

## Open Problems
(none)

## Done
(none)`;

		const filled = deterministicallyFillSummaryGaps(summary, facts);
		const mandatoryRulesSection = filled.summary.split("### Mandatory Rules")[1].split("## Working Set")[0];

		expect(mandatoryRulesSection).toContain("- do not touch the legacy client");
		expect(mandatoryRulesSection).not.toContain("Never touch the legacy client system");
		expect(filled.verification).toEqual({ ok: true, failures: [] });
	});

	it("drops a Mandatory Rules line that echoes the harness's own injected instruction text", () => {
		// "Update OLD CHECKPOINT with CHAT turns." and "Set ## Active Task to newest unfulfilled user
		// input; apply cancellation rule." are lifted verbatim from UPDATE_SUMMARIZATION_PROMPT — a
		// model regurgitating its own instructions into the checkpoint instead of following
		// SUMMARIZATION_SYSTEM_PROMPT's "never copy checkpointer control instructions" rule. This must
		// still be scrubbed even though gap-fill no longer unconditionally overwrites the section.
		const facts: CompactionFacts = {
			files: [],
			workingSet: [],
			actions: [],
			errorFacts: [],
			prohibitions: ["do not touch the legacy client"],
			cancelledText: "",
			activeTaskSource: "",
		};
		const summary = `## Active Task
(none)

### Mandatory Rules
- do not touch the legacy client
- Update OLD CHECKPOINT with CHAT turns.
- Set ## Active Task to newest unfulfilled user input; apply cancellation rule.

## Working Set
(none)

## Files
(none)

## Open Problems
(none)

## Done
(none)`;

		const filled = deterministicallyFillSummaryGaps(summary, facts);
		const mandatoryRulesSection = filled.summary.split("### Mandatory Rules")[1].split("## Working Set")[0];

		expect(mandatoryRulesSection).toContain("- do not touch the legacy client");
		expect(mandatoryRulesSection).not.toContain("Update OLD CHECKPOINT with CHAT turns");
		expect(mandatoryRulesSection).not.toContain("Set ## Active Task to newest unfulfilled user input");
	});

	it("preserves a user rule that only shares a few words with harness instruction text", () => {
		// Must not become a heuristic that punishes coincidental vocabulary overlap: this rule shares
		// "active"/"task" with UPDATE_SUMMARIZATION_PROMPT's "Set ## Active Task to newest unfulfilled
		// user input; apply cancellation rule." sentence but is otherwise unrelated, longer, and
		// clearly a real user-domain instruction.
		const facts: CompactionFacts = {
			files: [],
			workingSet: [],
			actions: [],
			errorFacts: [],
			prohibitions: [],
			cancelledText: "",
			activeTaskSource: "",
		};
		const summary = `## Active Task
(none)

### Mandatory Rules
- Keep the active task focused on the fetcher regression, not exploratory refactors.

## Working Set
(none)

## Files
(none)

## Open Problems
(none)

## Done
(none)`;

		const filled = deterministicallyFillSummaryGaps(summary, facts);
		const mandatoryRulesSection = filled.summary.split("### Mandatory Rules")[1].split("## Working Set")[0];

		expect(mandatoryRulesSection).toContain(
			"- Keep the active task focused on the fetcher regression, not exploratory refactors.",
		);
	});

	it("fill -> render -> verify round-trip never lets the worked-example sentinel survive", () => {
		// A model that violates SUMMARIZATION_SYSTEM_PROMPT's "never copy checkpointer control
		// instructions" rule by echoing its own worked example verbatim into Mandatory Rules.
		const facts: CompactionFacts = {
			files: [],
			workingSet: [],
			actions: [],
			errorFacts: [],
			prohibitions: ["do not touch the legacy client"],
			cancelledText: "",
			activeTaskSource: "",
		};
		const summary = `## Active Task
(none)

### Mandatory Rules
- do not touch the legacy client
- DO NOT touch ${COMPACTION_WORKED_EXAMPLE_SENTINEL}

## Working Set
(none)

## Files
(none)

## Open Problems
(none)

## Done
(none)`;

		const filled = deterministicallyFillSummaryGaps(summary, facts);

		expect(filled.summary).not.toContain(COMPACTION_WORKED_EXAMPLE_SENTINEL);
		expect(filled.verification).toEqual({ ok: true, failures: [] });

		// Re-running the fill on its own output is a fixed point: still sentinel-free, still verifies.
		const filledAgain = deterministicallyFillSummaryGaps(filled.summary, facts);
		expect(filledAgain.summary).not.toContain(COMPACTION_WORKED_EXAMPLE_SENTINEL);
		expect(filledAgain.verification).toEqual({ ok: true, failures: [] });
	});

	it("deterministically drops a Mandatory Rules line that echoes the worked example verbatim", () => {
		// Simulate the model copying SUMMARIZATION_SYSTEM_PROMPT's own worked-example sentence into
		// Mandatory Rules as if it were a real rule — the exact bleed the "never copy checkpointer
		// control instructions" system-prompt rule exists to prevent. Sourced from the real prompt
		// text (not hand-typed) so this tracks whatever the worked example actually says.
		const workedExampleSentence = SUMMARIZATION_SYSTEM_PROMPT.trim().split("\n").at(-1) ?? "";
		expect(workedExampleSentence).toContain(COMPACTION_WORKED_EXAMPLE_SENTINEL);

		const facts: CompactionFacts = {
			files: [],
			workingSet: [],
			actions: [],
			errorFacts: [],
			prohibitions: ["do not touch the legacy client"],
			cancelledText: "",
			activeTaskSource: "",
		};
		const summary = `## Active Task
(none)

### Mandatory Rules
- do not touch the legacy client
- ${workedExampleSentence}
- Always run tests from packages/coding-agent.

## Working Set
(none)

## Files
(none)

## Open Problems
(none)

## Done
(none)`;

		const filled = deterministicallyFillSummaryGaps(summary, facts);
		const mandatoryRulesSection = filled.summary.split("### Mandatory Rules")[1].split("## Working Set")[0];

		expect(mandatoryRulesSection).toContain("- do not touch the legacy client");
		expect(mandatoryRulesSection).toContain("Always run tests from packages/coding-agent.");
		expect(mandatoryRulesSection).not.toContain(COMPACTION_WORKED_EXAMPLE_SENTINEL);

		// Deterministic: the drop never depends on model/random behavior — same input, same output.
		const filledAgain = deterministicallyFillSummaryGaps(summary, facts);
		expect(filledAgain.summary).toBe(filled.summary);
	});

	it("does not flag the sentinel when it only appears inside Mandatory Rules", () => {
		// Mandatory Rules is self-healing (reconcileMandatoryRules always scrubs it) — presence there
		// alone must not trip the hard-failure gate meant for sections the fill cannot repair.
		const summary = `## Active Task
(none)

### Mandatory Rules
- DO NOT touch ${COMPACTION_WORKED_EXAMPLE_SENTINEL}

## Working Set
(none)

## Files
(none)

## Open Problems
(none)

## Done
(none)`;
		const report = verifySummary(summary, {
			files: [],
			workingSet: [],
			actions: [],
			errorFacts: [],
			prohibitions: [],
			cancelledText: "",
			activeTaskSource: "",
		});

		expect(report.failures.some((failure) => failure.check === "compaction-control-sentinel")).toBe(false);
	});

	it("fails verification when the sentinel appears outside Mandatory Rules", () => {
		// This is contamination the deterministic fill never touches (it only reconciles Mandatory
		// Rules) and so cannot safely repair — it must fail loudly rather than silently persist.
		const summary = `## Active Task
(none)

### Mandatory Rules
(none)

## Working Set
(none)

## Files
(none)

## Open Problems
(none)

## Done
(none)

## Critical Context
- Saw a reference to ${COMPACTION_WORKED_EXAMPLE_SENTINEL} while summarizing.`;

		const report = verifySummary(summary, {
			files: [],
			workingSet: [],
			actions: [],
			errorFacts: [],
			prohibitions: [],
			cancelledText: "",
			activeTaskSource: "",
		});

		expect(report.ok).toBe(false);
		expect(report.failures.some((failure) => failure.check === "compaction-control-sentinel")).toBe(true);
	});

	it("round-trips an active task containing a markdown heading without truncating the section", () => {
		// Before the fix, a raw "## Steps" line embedded in the user's request made extractSections
		// re-split the Active Task section, so verbatim verification could never pass and compaction was
		// permanently broken for that conversation (facts are identical on every retry attempt).
		const activeTaskSource = "Fix the parser.\n## Steps\n1. Parse tokens\n2. Build AST\n### Notes\nWatch edge cases.";
		const facts: CompactionFacts = {
			files: [],
			workingSet: [],
			actions: [],
			errorFacts: [],
			prohibitions: [],
			cancelledText: "",
			activeTaskSource,
		};
		const summary = `## Active Task
Continue

### Mandatory Rules
(none)

## Working Set
(none)

## Files
(none)

## Open Problems
(none)

## Done
(none)`;

		const filled = deterministicallyFillSummaryGaps(summary, facts);

		expect(filled.verification).toEqual({ ok: true, failures: [] });
		// The heading text itself must still be present (escaped, not stripped).
		expect(filled.summary).toContain("## Steps");
		expect(filled.summary).toContain("### Notes");
	});

	it("round-trips an active task containing nested/longer fences and leading whitespace", () => {
		const activeTaskSource = [
			"Fix the parser.",
			"    indented step retained verbatim",
			"```",
			"outer fence containing:",
			"````",
			"inner longer fence",
			"````",
			"```",
			"## Not a real heading, just quoted text",
			"Done.",
		].join("\n");
		const facts: CompactionFacts = {
			files: [],
			workingSet: [],
			actions: [],
			errorFacts: [],
			prohibitions: [],
			cancelledText: "",
			activeTaskSource,
		};
		const summary = `## Active Task
Continue

### Mandatory Rules
(none)

## Working Set
(none)

## Files
(none)

## Open Problems
(none)

## Done
(none)`;

		const filled = deterministicallyFillSummaryGaps(summary, facts);

		expect(filled.verification).toEqual({ ok: true, failures: [] });

		// Re-running the fill on its own output must be a fixed point (idempotent).
		const filledAgain = deterministicallyFillSummaryGaps(filled.summary, facts);
		expect(filledAgain.summary).toBe(filled.summary);
		expect(filledAgain.verification).toEqual({ ok: true, failures: [] });
	});

	it("does not gap-fill empty or unparseable summaries", () => {
		expect(isCompactionSummaryStructurallyUsable("")).toBe(false);
		expect(isCompactionSummaryStructurallyUsable("not a checkpoint")).toBe(false);
		const filled = deterministicallyFillSummaryGaps("not a checkpoint", baseFacts);
		expect(filled.summary).toBe("not a checkpoint");
		expect(filled.changed).toBe(false);
		expect(filled.verification.ok).toBe(false);
	});

	it("diff-guards verification thresholds against weakening", () => {
		expect(FILES_READ_RECALL_THRESHOLD).toBe(0.8);
		expect(ACTIVE_TASK_CONTAINMENT_THRESHOLD).toBe(1);
		expect(MANDATORY_RULES_RECALL_THRESHOLD).toBe(0.7);
		expect(CANCELLED_WORK_DROPPED_THRESHOLD).toBe(0.1);
		expect(ACTIONS_RECALL_THRESHOLD).toBe(0.6);
		expect(OPEN_ERRORS_RECALL_THRESHOLD).toBe(0.7);
	});

	it("still rejects an unparseable checkpoint when deterministic facts are empty", () => {
		const report = verifySummary("", {
			files: [],
			workingSet: [],
			actions: [],
			errorFacts: [],
			prohibitions: [],
			cancelledText: "",
			activeTaskSource: "",
		});

		expect(report.ok).toBe(false);
		expect(report.failures).toEqual([
			expect.objectContaining({ check: "summary-structure", comparator: "minimum", score: 0, threshold: 1 }),
		]);
	});
});
