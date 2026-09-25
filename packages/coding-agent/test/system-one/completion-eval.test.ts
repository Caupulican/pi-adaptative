import { describe, expect, it } from "vitest";
import type { JevAdapter } from "../../src/core/system-one/adapter.ts";
import {
	COMPLETION_EVAL_CASES,
	evaluateCompletionOnce,
	runCompletionEval,
	summarizeCompletionEval,
} from "../../src/core/system-one/evals/completion-eval.ts";

const POSITIVE = {
	implementation_matches_goal: { noul: 0.97 },
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
							implementation_matches_goal: { noul: 0.1 },
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
		const machineDiff = seen[0]?.final_diff as { patch?: string };
		expect(machineDiff.patch ?? "").toBe("");
		// The goal's requirements and the agent's evidence reach the judge.
		expect(JSON.stringify(seen[0])).toContain("Downloaded Ollama models under ~/.ollama are deleted");
	});

	it("measures first-try acceptance of done cases and rejection of planted gaps, per outcome kind", async () => {
		const summary = await runCompletionEval(judgingAdapter([]), { repeats: 2 });
		expect(summary.runs).toHaveLength(COMPLETION_EVAL_CASES.length);
		expect(summary.doneAccepted).toBe(1);
		expect(summary.incompleteRejected).toBe(1);
		expect(Object.keys(summary.byKind).sort()).toEqual(["information", "machine", "mixed", "remote", "repository"]);
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
