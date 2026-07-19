import { describe, expect, it } from "vitest";
import { createGoalState } from "../src/core/goals/goal-state.ts";
import { applyGoalAction, completeGoalManually, summarizeGoalState } from "../src/core/goals/goal-tool-core.ts";

describe("applyGoalAction (goal producer core)", () => {
	it("starts a new active goal", () => {
		const result = applyGoalAction(undefined, { action: "start", goalId: "g1", userGoal: "Ship feature" }, "T0");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state.goalId).toBe("g1");
		expect(result.state.status).toBe("active");
		expect(result.state.userGoal).toBe("Ship feature");
	});

	it("rejects start with empty goalId or userGoal", () => {
		expect(applyGoalAction(undefined, { action: "start", goalId: "", userGoal: "x" }, "T0").ok).toBe(false);
		expect(applyGoalAction(undefined, { action: "start", goalId: "g1", userGoal: "  " }, "T0").ok).toBe(false);
	});

	it("rejects updates when no goal exists", () => {
		const result = applyGoalAction(undefined, { action: "progress" }, "T0");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("No active goal");
	});

	it("refuses to start a second active goal with a different id", () => {
		const started = applyGoalAction(undefined, { action: "start", goalId: "g1", userGoal: "A" }, "T0");
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		const second = applyGoalAction(started.state, { action: "start", goalId: "g2", userGoal: "B" }, "T1");
		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect(second.error).toContain("already exists");
	});

	it("allows restarting the same goal id", () => {
		const started = applyGoalAction(undefined, { action: "start", goalId: "g1", userGoal: "A" }, "T0");
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		const restart = applyGoalAction(started.state, { action: "start", goalId: "g1", userGoal: "A2" }, "T1");
		expect(restart.ok).toBe(true);
		if (!restart.ok) return;
		expect(restart.state.userGoal).toBe("A2");
	});

	it("adds requirements and rejects duplicates", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "A", now: "T0" });
		const added = applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Do X" }, "T1");
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		state = added.state;
		expect(state.requirements).toHaveLength(1);
		expect(state.requirements[0].status).toBe("open");

		const dup = applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Do X" }, "T2");
		expect(dup.ok).toBe(false);
	});

	it("satisfies a requirement only with known evidence ids", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "A", now: "T0" });
		state = expectOk(applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Do X" }, "T1"));

		const missingEvidence = applyGoalAction(
			state,
			{ action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["e1"] },
			"T2",
		);
		expect(missingEvidence.ok).toBe(false);

		state = expectOk(
			applyGoalAction(state, { action: "add_evidence", evidenceId: "e1", kind: "file", summary: "edited" }, "T3"),
		);
		state = expectOk(
			applyGoalAction(state, { action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["e1"] }, "T4"),
		);
		expect(state.requirements[0].status).toBe("satisfied");
		expect(state.requirements[0].evidenceIds).toEqual(["e1"]);
	});

	it("rejects satisfying an unknown requirement", () => {
		const state = createGoalState({ goalId: "g1", userGoal: "A", now: "T0" });
		const result = applyGoalAction(state, { action: "satisfy_requirement", requirementId: "nope" }, "T1");
		expect(result.ok).toBe(false);
	});

	it("blocks requirements and goals with a reason", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "A", now: "T0" });
		state = expectOk(applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Do X" }, "T1"));
		const blockedReqNoReason = applyGoalAction(
			state,
			{ action: "block_requirement", requirementId: "r1", reason: "" },
			"T2",
		);
		expect(blockedReqNoReason.ok).toBe(false);

		state = expectOk(
			applyGoalAction(state, { action: "block_requirement", requirementId: "r1", reason: "no access" }, "T2"),
		);
		expect(state.requirements[0].status).toBe("blocked");

		state = expectOk(applyGoalAction(state, { action: "block_goal", reason: "stuck" }, "T3"));
		expect(state.status).toBe("blocked");
		expect(state.blockedReason).toBe("stuck");
	});

	it("resumes blocked goals, reopens requirements, and can cancel from blocked", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "A", now: "T0" });
		state = expectOk(applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Do X" }, "T1"));
		state = expectOk(
			applyGoalAction(state, { action: "block_requirement", requirementId: "r1", reason: "no access" }, "T2"),
		);
		state = expectOk(applyGoalAction(state, { action: "block_goal", reason: "stuck" }, "T3"));
		state = expectOk(applyGoalAction(state, { action: "resume_goal" }, "T4"));
		state = expectOk(applyGoalAction(state, { action: "reopen_requirement", requirementId: "r1" }, "T5"));

		expect(state.status).toBe("active");
		expect(state.blockedReason).toBeUndefined();
		expect(state.requirements[0].status).toBe("open");
		expect(state.requirements[0].blockedReason).toBeUndefined();

		state = expectOk(applyGoalAction(state, { action: "block_goal", reason: "blocked again" }, "T6"));
		state = expectOk(applyGoalAction(state, { action: "cancel" }, "T7"));
		expect(state.status).toBe("cancelled");
	});

	it("rejects updates after the goal is no longer active", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "A", now: "T0" });
		state = expectOk(applyGoalAction(state, { action: "cancel" }, "T1"));
		expect(state.status).toBe("cancelled");
		const afterCancel = applyGoalAction(state, { action: "progress" }, "T2");
		expect(afterCancel.ok).toBe(false);
	});

	it("keeps agent completion evidence-gated but allows explicit manual completion", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "A", now: "T0" });
		state = expectOk(applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Do X" }, "T1"));

		const early = applyGoalAction(state, { action: "complete" }, "T2");
		expect(early.ok).toBe(false);

		const manual = completeGoalManually(state, "T3");
		expect(manual.ok).toBe(true);
		if (!manual.ok) return;
		expect(manual.state.status).toBe("completed");
		expect(manual.state.requirements[0].status).toBe("open");

		state = expectOk(
			applyGoalAction(
				state,
				{ action: "add_evidence", evidenceId: "e1", kind: "user", summary: "user confirmed" },
				"T4",
			),
		);
		state = expectOk(
			applyGoalAction(state, { action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["e1"] }, "T5"),
		);
		state = expectOk(applyGoalAction(state, { action: "complete" }, "T6"));
		expect(state.status).toBe("completed");
	});

	it("blocks agent completion when satisfied requirements have no verified/user evidence backing (default-on gate)", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "A", now: "T0" });
		state = expectOk(applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Do X" }, "T1"));
		// satisfy with no cited evidence at all -- nothing unsatisfied, but nothing verified either
		state = expectOk(applyGoalAction(state, { action: "satisfy_requirement", requirementId: "r1" }, "T2"));

		const blocked = applyGoalAction(state, { action: "complete" }, "T3");
		expect(blocked.ok).toBe(false);
		if (blocked.ok) return;
		expect(blocked.error).toContain("verified evidence");

		// an unverified (kind 'file', verified: false) evidence ref still does not satisfy the gate
		state = expectOk(
			applyGoalAction(
				state,
				{ action: "add_evidence", evidenceId: "e-bogus", kind: "file", summary: "bogus ref", verified: false },
				"T4",
			),
		);
		state = expectOk(
			applyGoalAction(state, { action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["e-bogus"] }, "T5"),
		);
		const stillBlocked = applyGoalAction(state, { action: "complete" }, "T6");
		expect(stillBlocked.ok).toBe(false);

		// but the gate can be opted out of
		const optedOut = applyGoalAction(state, { action: "complete" }, "T7", {
			requireVerifiedEvidenceForCompletion: false,
		});
		expect(optedOut.ok).toBe(true);
	});

	it("allows agent completion when a satisfied requirement is backed by verified-ref evidence", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "A", now: "T0" });
		state = expectOk(applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Do X" }, "T1"));
		state = expectOk(
			applyGoalAction(
				state,
				{ action: "add_evidence", evidenceId: "e1", kind: "tool", summary: "ran the tests", verified: true },
				"T2",
			),
		);
		state = expectOk(
			applyGoalAction(state, { action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["e1"] }, "T3"),
		);
		state = expectOk(applyGoalAction(state, { action: "complete" }, "T4"));
		expect(state.status).toBe("completed");
	});

	it("tracks progress and stall via progress/no_progress", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "A", now: "T0" });
		state = expectOk(applyGoalAction(state, { action: "no_progress" }, "T1"));
		state = expectOk(applyGoalAction(state, { action: "no_progress" }, "T2"));
		expect(state.stallTurns).toBe(2);
		state = expectOk(applyGoalAction(state, { action: "progress" }, "T3"));
		expect(state.stallTurns).toBe(0);
		expect(state.lastProgressAt).toBe("T3");
	});

	it("summarizes ledger state", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
		state = expectOk(applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Do X" }, "T1"));
		const summary = summarizeGoalState(state);
		expect(summary).toContain("Goal 'g1'");
		expect(summary).toContain("1 open");
	});
});

function expectOk(result: ReturnType<typeof applyGoalAction>) {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error);
	return result.state;
}
