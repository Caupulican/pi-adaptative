import { describe, expect, it } from "vitest";
import type { JevAdapter } from "../../src/core/system-one/adapter.ts";
import {
	COMPLETION_EVAL_CASES,
	evaluateCompletionOnce,
	runCompletionEval,
	summarizeCompletionEval,
} from "../../src/core/system-one/evals/completion-eval.ts";

const POSITIVE = {
	outcomes_achieved: { noul: 0.97 },
	root_cause_addressed: { noul: 0.97 },
	required_behavior_unverified: { noul: 0.02 },
	material_claim_unsupported: { noul: 0.02 },
	out_of_scope_change_present: { noul: 0.02 },
	duplicate_responsibility_introduced: { noul: 0.02 },
	completion_verdict: { choice: "complete", confidence: 0.97, probabilities: { complete: 0.97 } },
	missing_requirement: { noul: 0.02 },
	hidden_assumption: { noul: 0.02 },
	plausible_regression_not_tested: { noul: 0.02 },
	conclusion_overstates_evidence: { noul: 0.02 },
};

/** A stand-in judge: rejects when the evidence it is shown admits a gap. */
function judgingAdapter(seen: Array<Record<string, unknown>>): JevAdapter {
	return {
		evaluate: async (input) => {
			seen.push(input.state as Record<string, unknown>);
			const text = JSON.stringify(input.state);
			const gap = /still reports|still shows|still returns|case fails|probably|Likely/u.test(text);
			return {
				model: "fixture",
				answers: gap
					? {
							...POSITIVE,
							outcomes_achieved: { noul: 0.1 },
							completion_verdict: { choice: "rework", confidence: 0.9, probabilities: { rework: 0.9 } },
						}
					: POSITIVE,
				latency_ms: 1,
			} as never;
		},
	};
}

describe("completion reliability evaluation harness", () => {
	it("sends System One the production projection: the repository patch for code work, none for machine work", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const repository = COMPLETION_EVAL_CASES.find((testCase) => testCase.id === "repository-fix-done")!;
		const machine = COMPLETION_EVAL_CASES.find((testCase) => testCase.id === "machine-uninstall-done")!;
		await evaluateCompletionOnce(repository, judgingAdapter(seen));
		const repositoryDiff = seen[0]?.final_diff as { patch?: string };
		expect(repositoryDiff.patch).toContain("parseDuration");
		seen.length = 0;
		await evaluateCompletionOnce(machine, judgingAdapter(seen));
		// A machine outcome has no diff to judge; its outcome evidence carries the harness's own checks.
		expect(seen[0]).not.toHaveProperty("final_diff");
		const outcomes = seen[0]?.outcome_evidence as Array<{ text: string; checks: Array<{ status: string }> }>;
		expect(outcomes.map((outcome) => outcome.checks.map((check) => check.status))).toEqual([["passed"], ["passed"]]);
		expect(JSON.stringify(seen[0])).toContain("Downloaded Ollama models under ~/.ollama are deleted");
	});

	it("measures rejection of planted gaps independently from diagnostic notices", async () => {
		const summary = await runCompletionEval(judgingAdapter([]), { repeats: 2 });
		expect(summary.runs).toHaveLength(COMPLETION_EVAL_CASES.length);
		expect(summary.doneAccepted).toBe(1);
		expect(summary.incompleteRejected).toBe(1);
		expect(summary.incompleteFlagged).toBe(1);
		expect(summary.runs.filter((run) => !run.done).flatMap((run) => run.verdicts)).not.toContain("complete");
		expect(Object.keys(summary.byKind).sort()).toEqual(["information", "machine", "mixed", "remote", "repository"]);
	});

	it("does not count an error or unavailable assessment as detection of a planted gap", () => {
		const summary = summarizeCompletionEval([
			{
				caseId: "advice",
				kind: "machine",
				done: false,
				verdicts: ["complete"],
				reasons: [[]],
				advisories: [["Evidence admits a gap"]],
				assessmentComplete: [true],
			},
			{
				caseId: "outage",
				kind: "machine",
				done: false,
				verdicts: ["complete"],
				reasons: [[]],
				advisories: [["Advice unavailable"]],
				assessmentComplete: [false],
			},
			{ caseId: "error", kind: "machine", done: false, verdicts: ["error: timeout"], reasons: [[]] },
			{
				caseId: "check",
				kind: "machine",
				done: false,
				verdicts: ["refused_by_check"],
				reasons: [["Required file exists"]],
			},
		]);
		expect(summary.incompleteRejected).toBe(0.25);
		expect(summary.incompleteFlagged).toBe(0.5);
	});

	it.each(["outage", "missing"] as const)("distinguishes %s from a complete semantic assessment", async (mode) => {
		const testCase = COMPLETION_EVAL_CASES.find((entry) => entry.id === "repository-fix-done")!;
		const result = await evaluateCompletionOnce(testCase, {
			evaluate: async () => {
				if (mode === "outage") throw new Error("offline");
				return { model: "fixture", answers: {}, latency_ms: 1 };
			},
		});
		expect(result.verdict).toBe(mode === "outage" ? "complete" : "verify_more");
		expect(result.assessmentComplete).toBe(false);
		if (mode === "outage") expect(result.advisories?.length).toBeGreaterThan(0);
		else expect(result.reasons.length).toBeGreaterThan(0);
	});

	it("counts an evaluation error as a non-acceptance, never as a pass", () => {
		const summary = summarizeCompletionEval([
			{ caseId: "a", kind: "machine", done: true, verdicts: ["complete", "error: timeout"], reasons: [[], []] },
			{ caseId: "b", kind: "machine", done: false, verdicts: ["rework"], reasons: [["gap"]] },
		]);
		expect(summary.doneAccepted).toBe(0.5);
		expect(summary.incompleteRejected).toBe(1);
	});
});
