import { describe, expect, it } from "vitest";
import { createGoalState } from "../src/core/goals/goal-state.ts";
import { applyGoalAction, summarizeGoalState } from "../src/core/goals/goal-tool-core.ts";

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

	it("rejects updates after the goal is no longer active", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "A", now: "T0" });
		state = expectOk(applyGoalAction(state, { action: "cancel" }, "T1"));
		expect(state.status).toBe("cancelled");
		const afterCancel = applyGoalAction(state, { action: "progress" }, "T2");
		expect(afterCancel.ok).toBe(false);
	});

	it("completes only when all requirements are satisfied", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "A", now: "T0" });
		state = expectOk(applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Do X" }, "T1"));

		const early = applyGoalAction(state, { action: "complete" }, "T2");
		expect(early.ok).toBe(false);

		state = expectOk(applyGoalAction(state, { action: "satisfy_requirement", requirementId: "r1" }, "T3"));
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
