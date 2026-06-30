import { describe, expect, it } from "vitest";
import { evaluateGoalContinuation } from "../src/core/goals/goal-continuation-controller.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";

describe("Phase 10A: Goal Continuation Controller", () => {
	it("missing state asks user", () => {
		const decision = evaluateGoalContinuation({
			settings: { maxStallTurns: 3 },
		});
		expect(decision.action).toBe("ask-user");
		expect(decision.reasonCode).toBe("missing_goal_state");
	});

	it("completed goal finalizes", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Test", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1", now: "T0" });
		state = applyGoalEvent(state, { type: "satisfy_requirement", id: "req-1", evidenceIds: [], now: "T1" });
		state = applyGoalEvent(state, { type: "complete_goal", now: "T2" });

		const decision = evaluateGoalContinuation({
			state,
			settings: { maxStallTurns: 3 },
		});

		expect(decision.action).toBe("finalize");
		expect(decision.reasonCode).toBe("goal_completed");
		expect(decision.satisfiedRequirementIds).toEqual(["req-1"]);
	});

	it("blocked goal asks user", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Test", now: "T0" });
		state = applyGoalEvent(state, { type: "block_goal", reason: "stuck", now: "T1" });

		const decision = evaluateGoalContinuation({
			state,
			settings: { maxStallTurns: 3 },
		});

		expect(decision.action).toBe("ask-user");
		expect(decision.reasonCode).toBe("goal_blocked");
	});

	it("cancelled goal stops", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Test", now: "T0" });
		state = applyGoalEvent(state, { type: "cancel_goal", now: "T1" });

		const decision = evaluateGoalContinuation({
			state,
			settings: { maxStallTurns: 3 },
		});

		expect(decision.action).toBe("stop");
		expect(decision.reasonCode).toBe("goal_cancelled");
	});

	it("active goal with blocked requirement asks user and reports blockedRequirementIds", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Test", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-2", text: "Req 2", now: "T0" });
		state = applyGoalEvent(state, { type: "block_requirement", id: "req-1", blockedReason: "hard", now: "T1" });

		const decision = evaluateGoalContinuation({
			state,
			settings: { maxStallTurns: 3 },
		});

		expect(decision.action).toBe("ask-user");
		expect(decision.reasonCode).toBe("blocked_requirements_present");
		expect(decision.blockedRequirementIds).toEqual(["req-1"]);
		expect(decision.openRequirementIds).toEqual(["req-2"]);
	});

	it("active goal with no open requirements finalizes", () => {
		const state = createGoalState({ goalId: "g1", userGoal: "Test", now: "T0" });

		const decision = evaluateGoalContinuation({
			state,
			settings: { maxStallTurns: 3 },
		});

		expect(decision.action).toBe("finalize");
		expect(decision.reasonCode).toBe("no_open_requirements");
		expect(decision.openRequirementIds).toEqual([]);
	});

	it("active goal at stall limit asks user", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Test", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1", now: "T0" });
		state = applyGoalEvent(state, { type: "no_progress", now: "T1" });
		state = applyGoalEvent(state, { type: "no_progress", now: "T2" });
		state = applyGoalEvent(state, { type: "no_progress", now: "T3" });

		const decision = evaluateGoalContinuation({
			state,
			settings: { maxStallTurns: 3 },
		});

		expect(decision.action).toBe("ask-user");
		expect(decision.reasonCode).toBe("stall_limit_reached");
	});

	it("maxStallTurns 0 is unlimited", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Test", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1", now: "T0" });
		state = applyGoalEvent(state, { type: "no_progress", now: "T1" });
		state = applyGoalEvent(state, { type: "no_progress", now: "T2" });
		state = applyGoalEvent(state, { type: "no_progress", now: "T3" });
		state = applyGoalEvent(state, { type: "no_progress", now: "T4" });
		state = applyGoalEvent(state, { type: "no_progress", now: "T5" });

		const decision = evaluateGoalContinuation({
			state,
			settings: { maxStallTurns: 0 },
		});

		expect(decision.action).toBe("continue");
		expect(decision.reasonCode).toBe("goal_active");
	});

	it("active goal with open requirement continues", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Test", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1", now: "T0" });

		const decision = evaluateGoalContinuation({
			state,
			settings: { maxStallTurns: 3 },
		});

		expect(decision.action).toBe("continue");
		expect(decision.reasonCode).toBe("goal_active");
		expect(decision.openRequirementIds).toEqual(["req-1"]);
	});

	it("helper does not mutate state or requirements", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Test", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1", now: "T0" });

		const originalRequirements = [...state.requirements];
		const originalReq1 = { ...state.requirements[0] };

		evaluateGoalContinuation({
			state,
			settings: { maxStallTurns: 3 },
		});

		expect(state.requirements).toEqual(originalRequirements);
		expect(state.requirements[0]).toEqual(originalReq1);
	});
});
