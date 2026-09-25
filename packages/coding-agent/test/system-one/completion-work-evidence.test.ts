import { execFileSync } from "node:child_process";

for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) {
	delete process.env[key];
}

import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";
import { decideFinalCompletion } from "../../src/core/system-one/policy.ts";
import { StateProjector } from "../../src/core/system-one/projector.ts";
import { readWorkDiff } from "../../src/core/system-one/work-diff.ts";

const noul = (value: number) => ({ type: "noul", noul: value });
const passedGates = [{ id: "G-OBJ", kind: "deterministic" as const, required: true, status: "passed" as const }];

/** Answers live System One gave one goal's real diff, and the same goal with the change broken. */
const MEASURED = {
	finished: {
		primary: {
			outcomes_achieved: noul(0.87),
			required_behavior_unverified: noul(0.08),
			material_claim_unsupported: noul(0.09),
			out_of_scope_change_present: noul(0.2),
			duplicate_responsibility_introduced: noul(0.11),
			completion_verdict: { choice: "complete", confidence: 0.99, probabilities: { complete: 1 } },
		},
		challenge: {
			missing_requirement: noul(0.07),
			hidden_assumption: noul(0.25),
			plausible_regression_not_tested: noul(0.28),
			conclusion_overstates_evidence: noul(0.16),
		},
	},
	broken: {
		primary: {
			outcomes_achieved: noul(0.33),
			required_behavior_unverified: noul(0.23),
			material_claim_unsupported: noul(0.09),
			out_of_scope_change_present: noul(0.44),
			duplicate_responsibility_introduced: noul(0.17),
			completion_verdict: { choice: "complete", confidence: 0.64, probabilities: { complete: 0.64, rework: 0.36 } },
		},
		challenge: {
			missing_requirement: noul(0.21),
			hidden_assumption: noul(0.66),
			plausible_regression_not_tested: noul(0.48),
			conclusion_overstates_evidence: noul(0.31),
		},
	},
};

describe("completion judges the work itself", () => {
	it("closes finished work at the answers System One gives it, and keeps broken work open", () => {
		const decide = (answers: (typeof MEASURED)["finished"]) =>
			decideFinalCompletion({
				deterministicGates: passedGates,
				primaryAnswers: answers.primary,
				challengeAnswers: answers.challenge,
				isBugFix: false,
			});
		expect(decide(MEASURED.finished)).toEqual({ verdict: "complete", failed_gates: [] });
		const broken = decide(MEASURED.broken);
		expect(broken.verdict).not.toBe("complete");
		expect(broken.failed_gates.map((gate) => gate.id)).toEqual(
			expect.arrayContaining(["JEV-outcomes_achieved", "JEV-CHALLENGE-hidden_assumption"]),
		);
		// A missing answer never holds.
		const { hidden_assumption: _missing, ...withoutAssumption } = MEASURED.finished.challenge;
		expect(
			decideFinalCompletion({
				deterministicGates: passedGates,
				primaryAnswers: MEASURED.finished.primary,
				challengeAnswers: withoutAssumption,
				isBugFix: false,
			}).verdict,
		).not.toBe("complete");
	});

	it("gives System One the patch and the evidence the acceptance matrix cites", () => {
		const store = new ExecutionStore({
			run_id: "completion",
			objective: { request: "Add a flag", normalized_goal: "Add a flag", acceptance_criteria: [] },
			repo: { root: "/repo", baseline_revision: "HEAD" },
		});
		store.hydrateFromCanonical({
			request: "Add a flag",
			normalized_goal: "Add a flag",
			acceptance_criteria: [],
			constraints: [],
			non_goals: [],
			current_revision: "abc",
			plan_steps: [],
			observations: [
				{
					id: "OBS-ev-1",
					text: "Both paths verified",
					source: {
						kind: "tool_output",
						locator: "call-1",
						content_hash: "ev-1",
						revision: "abc",
						line_start: null,
						line_end: null,
						trust: "authoritative",
					},
					freshness: "fresh",
					status: "observed",
				},
			],
			verification: [],
		});
		const projection = new StateProjector().completion(store.snapshot(), {
			base: "base123",
			patch: "diff --git a/greet.sh b/greet.sh\n+shout=false\n",
			omittedChars: 0,
			untracked: ["notes.txt"],
		});
		expect(projection.final_diff).toMatchObject({
			base_commit: "base123",
			patch: "diff --git a/greet.sh b/greet.sh\n+shout=false\n",
			new_untracked_files: ["notes.txt"],
		});
		expect(projection.evidence).toEqual([
			{ id: "OBS-ev-1", text: "Both paths verified", trust: "authoritative", freshness: "fresh" },
		]);
	});

	it("reads the work since the goal started: commits made during it, edits and new files", () => {
		const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-work-diff-")));
		const git = (...args: string[]) =>
			execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
				cwd: repo,
				encoding: "utf-8",
				env: {
					...process.env,
					GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
					GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
				},
			});
		git("init", "-q");
		writeFileSync(join(repo, "a.txt"), "one\n");
		git("add", "a.txt");
		git("commit", "-qm", "before");
		const base = git("rev-parse", "HEAD").trim();
		expect(readWorkDiff(repo, "2025-12-31T00:00:00Z")).toBeUndefined();

		writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "during"], {
			cwd: repo,
			env: { ...process.env, GIT_COMMITTER_DATE: "2026-02-01T00:00:00Z", GIT_AUTHOR_DATE: "2026-02-01T00:00:00Z" },
		});
		writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
		writeFileSync(join(repo, "new.txt"), "fresh\n");

		const work = readWorkDiff(repo, "2026-01-15T00:00:00Z");
		expect(work?.base).toBe(base);
		expect(work?.patch).toContain("+two");
		expect(work?.patch).toContain("+three");
		expect(work?.untracked).toEqual(["new.txt"]);
		expect(work?.omittedChars).toBe(0);
	});
});
