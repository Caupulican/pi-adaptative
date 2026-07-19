import { describe, expect, it } from "vitest";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { applyGoalAction } from "../src/core/goals/goal-tool-core.ts";

/**
 * dispatch_worker is a STRUCTURAL binding recorder: it sets `Requirement.boundLaneId` and nothing
 * else. It must NEVER satisfy the requirement -- worker completion later populates "worker"-kind
 * evidence and prompts an explicit `satisfy_requirement` pass, so the existing verified/complete
 * gate (goal-tool-core's `isVerifiedOrUserEvidence`/`complete`) is never bypassed by a silent flip.
 */
describe("dispatch_worker (pure reducer)", () => {
	it("records boundLaneId on the requirement without satisfying it", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "A", now: "T0" });
		state = expectOk(applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Do X" }, "T1"));

		state = expectOk(
			applyGoalAction(
				state,
				{ action: "dispatch_worker", requirementId: "r1", instructions: "go do X", laneId: "lane-1" },
				"T2",
			),
		);

		expect(state.requirements[0].boundLaneId).toBe("lane-1");
		expect(state.requirements[0].status).toBe("open");
	});

	it("records the binding with no laneId when the dispatch side effect is unwired/stubbed", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "A", now: "T0" });
		state = expectOk(applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Do X" }, "T1"));

		state = expectOk(
			applyGoalAction(state, { action: "dispatch_worker", requirementId: "r1", instructions: "go do X" }, "T2"),
		);

		expect(state.requirements[0].boundLaneId).toBeUndefined();
		expect(state.requirements[0].status).toBe("open");
	});

	it("rejects an unknown requirement", () => {
		const state = createGoalState({ goalId: "g1", userGoal: "A", now: "T0" });
		const result = applyGoalAction(
			state,
			{ action: "dispatch_worker", requirementId: "nope", instructions: "go" },
			"T1",
		);
		expect(result.ok).toBe(false);
	});

	it("rejects an empty requirementId or empty instructions", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "A", now: "T0" });
		state = expectOk(applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Do X" }, "T1"));

		const emptyRequirementId = applyGoalAction(
			state,
			{ action: "dispatch_worker", requirementId: "  ", instructions: "go" },
			"T2",
		);
		expect(emptyRequirementId.ok).toBe(false);

		const emptyInstructions = applyGoalAction(
			state,
			{ action: "dispatch_worker", requirementId: "r1", instructions: "  " },
			"T2",
		);
		expect(emptyInstructions.ok).toBe(false);
	});

	it("does not touch lastProgressAt/stallTurns (dispatching is not itself progress)", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "A", now: "T0" });
		state = expectOk(applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Do X" }, "T1"));
		state = expectOk(applyGoalAction(state, { action: "no_progress" }, "T2"));
		const stallBefore = state.stallTurns;
		const progressBefore = state.lastProgressAt;

		state = expectOk(
			applyGoalAction(
				state,
				{ action: "dispatch_worker", requirementId: "r1", instructions: "go do X", laneId: "lane-1" },
				"T3",
			),
		);

		expect(state.stallTurns).toBe(stallBefore);
		expect(state.lastProgressAt).toBe(progressBefore);
	});

	it("re-dispatch overwrites a prior binding with the new laneId", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "A", now: "T0" });
		state = expectOk(applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Do X" }, "T1"));
		state = expectOk(
			applyGoalAction(
				state,
				{ action: "dispatch_worker", requirementId: "r1", instructions: "first attempt", laneId: "lane-1" },
				"T2",
			),
		);
		expect(state.requirements[0].boundLaneId).toBe("lane-1");

		state = expectOk(
			applyGoalAction(
				state,
				{ action: "dispatch_worker", requirementId: "r1", instructions: "retry", laneId: "lane-2" },
				"T3",
			),
		);
		expect(state.requirements[0].boundLaneId).toBe("lane-2");
	});

	it("rejects dispatch_worker when no goal is active or the goal is not active", () => {
		const noGoal = applyGoalAction(
			undefined,
			{ action: "dispatch_worker", requirementId: "r1", instructions: "go" },
			"T0",
		);
		expect(noGoal.ok).toBe(false);

		let state = createGoalState({ goalId: "g1", userGoal: "A", now: "T0" });
		state = expectOk(applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Do X" }, "T1"));
		state = expectOk(applyGoalAction(state, { action: "block_goal", reason: "stuck" }, "T2"));

		const whileBlocked = applyGoalAction(
			state,
			{ action: "dispatch_worker", requirementId: "r1", instructions: "go" },
			"T3",
		);
		expect(whileBlocked.ok).toBe(false);
	});
});

describe("dispatch_worker GoalEvent (goal-state reducer level)", () => {
	it("applyGoalEvent sets boundLaneId directly from a dispatch_worker event", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Fix typo", now: "T1" });
		state = applyGoalEvent(state, {
			type: "dispatch_worker",
			id: "req-1",
			instructions: "fix it",
			laneId: "lane-9",
			now: "T2",
		});

		expect(state.requirements[0].boundLaneId).toBe("lane-9");
		expect(state.requirements[0].status).toBe("open");
		expect(state.requirements[0].updatedAt).toBe("T2");
	});

	it("is a no-op on requirements when the event targets an unknown requirement id (defensive, mirrors other events)", () => {
		const state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		const next = applyGoalEvent(state, {
			type: "dispatch_worker",
			id: "unknown",
			instructions: "fix it",
			now: "T1",
		});
		expect(next.requirements).toHaveLength(0);
		expect(next.events).toHaveLength(1);
	});

	it("round-trips through serializeGoalState/parseGoalState", async () => {
		const { serializeGoalState, parseGoalState, isGoalState } = await import("../src/core/goals/goal-state.ts");
		let state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Fix typo", now: "T1" });
		state = applyGoalEvent(state, {
			type: "dispatch_worker",
			id: "req-1",
			instructions: "fix it",
			laneId: "lane-9",
			now: "T2",
		});

		const serialized = serializeGoalState(state);
		expect(isGoalState(JSON.parse(serialized))).toBe(true);
		const parsed = parseGoalState(serialized);
		expect(parsed?.requirements[0].boundLaneId).toBe("lane-9");
	});
});

function expectOk(result: ReturnType<typeof applyGoalAction>) {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error);
	return result.state;
}
