import { describe, expect, it } from "vitest";
import type { GoalEvent } from "../src/core/goals/goal-state.ts";
import {
	applyGoalEvent,
	createGoalState,
	parseGoalState,
	serializeGoalState,
	shouldContinueGoalLoop,
} from "../src/core/goals/goal-state.ts";

describe("Goal State (Phase 4)", () => {
	it("create empty active goal", () => {
		const state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		expect(state.goalId).toBe("g1");
		expect(state.userGoal).toBe("Fix bugs");
		expect(state.status).toBe("active");
		expect(state.requirements.length).toBe(0);
		expect(state.evidence.length).toBe(0);
		expect(state.events.length).toBe(0);
		expect(state.createdAt).toBe("T0");
		expect(state.stallTurns).toBe(0);
	});

	it("add requirement", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Fix typo", now: "T1" });

		expect(state.requirements.length).toBe(1);
		expect(state.requirements[0].id).toBe("req-1");
		expect(state.requirements[0].text).toBe("Fix typo");
		expect(state.requirements[0].status).toBe("open");
		expect(state.requirements[0].createdAt).toBe("T1");
		expect(state.updatedAt).toBe("T1");
	});

	it("satisfy requirement with evidence id", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Fix typo", now: "T1" });
		state = applyGoalEvent(state, { type: "satisfy_requirement", id: "req-1", evidenceIds: ["ev-1"], now: "T2" });

		expect(state.requirements[0].status).toBe("satisfied");
		expect(state.requirements[0].evidenceIds).toEqual(["ev-1"]);
		expect(state.requirements[0].updatedAt).toBe("T2");
		expect(state.lastProgressAt).toBe("T2");
		expect(state.stallTurns).toBe(0);
	});

	it("block requirement", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Fix typo", now: "T1" });
		state = applyGoalEvent(state, { type: "block_requirement", id: "req-1", blockedReason: "no access", now: "T2" });

		expect(state.requirements[0].status).toBe("blocked");
		expect(state.requirements[0].blockedReason).toBe("no access");
		expect(state.requirements[0].updatedAt).toBe("T2");
	});

	it("add evidence preserves provenance fields", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		state = applyGoalEvent(state, {
			type: "add_evidence",
			id: "ev-1",
			kind: "file",
			summary: "Modified foo.ts",
			uri: "file:///foo.ts",
			now: "T1",
		});

		expect(state.evidence.length).toBe(1);
		expect(state.evidence[0]).toEqual({
			id: "ev-1",
			kind: "file",
			summary: "Modified foo.ts",
			uri: "file:///foo.ts",
			createdAt: "T1",
		});

		// Replace evidence
		state = applyGoalEvent(state, {
			type: "add_evidence",
			id: "ev-1",
			kind: "file",
			summary: "Modified foo.ts again",
			uri: "file:///foo.ts",
			now: "T2",
		});

		expect(state.evidence.length).toBe(1);
		expect(state.evidence[0].summary).toBe("Modified foo.ts again");
		expect(state.evidence[0].createdAt).toBe("T1"); // preserved
	});

	it("progress updates lastProgressAt and resets stallTurns", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		state = applyGoalEvent(state, { type: "no_progress", now: "T1" });
		expect(state.stallTurns).toBe(1);

		state = applyGoalEvent(state, { type: "progress", now: "T2" });
		expect(state.stallTurns).toBe(0);
		expect(state.lastProgressAt).toBe("T2");
	});

	it("no-progress loop stops at max stall turns", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		expect(shouldContinueGoalLoop({ state, maxStallTurns: 2, now: "T0" })).toBe(true);

		state = applyGoalEvent(state, { type: "no_progress", now: "T1" });
		expect(shouldContinueGoalLoop({ state, maxStallTurns: 2, now: "T1" })).toBe(true);

		state = applyGoalEvent(state, { type: "no_progress", now: "T2" });
		expect(shouldContinueGoalLoop({ state, maxStallTurns: 2, now: "T2" })).toBe(false); // stallTurns = 2
	});

	it("completed/blocked/cancelled goals do not continue", () => {
		const state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });

		const sCompleted = applyGoalEvent(state, { type: "complete_goal", now: "T1" });
		expect(shouldContinueGoalLoop({ state: sCompleted, maxStallTurns: 5, now: "T1" })).toBe(false);

		const sBlocked = applyGoalEvent(state, { type: "block_goal", reason: "error", now: "T1" });
		expect(shouldContinueGoalLoop({ state: sBlocked, maxStallTurns: 5, now: "T1" })).toBe(false);

		const sCancelled = applyGoalEvent(state, { type: "cancel_goal", now: "T1" });
		expect(shouldContinueGoalLoop({ state: sCancelled, maxStallTurns: 5, now: "T1" })).toBe(false);
	});

	it("complete_goal leaves active if open requirements exist", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Fix typo", now: "T1" });
		state = applyGoalEvent(state, { type: "complete_goal", now: "T2" });
		expect(state.status).toBe("active");

		state = applyGoalEvent(state, { type: "satisfy_requirement", id: "req-1", evidenceIds: [], now: "T3" });
		state = applyGoalEvent(state, { type: "complete_goal", now: "T4" });
		expect(state.status).toBe("completed");
	});

	it("serialization round-trips", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Fix typo", now: "T1" });

		const json = serializeGoalState(state);
		const parsed = parseGoalState(json);
		expect(parsed).toEqual(state);
	});

	it("malformed parse returns undefined", () => {
		expect(parseGoalState("invalid json")).toBeUndefined();
		expect(parseGoalState('{"goalId":"g1"}')).toBeUndefined(); // missing fields

		const state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		expect(parseGoalState(JSON.stringify({ ...state, status: "unknown" }))).toBeUndefined();
		expect(
			parseGoalState(
				JSON.stringify({
					...state,
					requirements: [
						{
							id: "req-1",
							text: "Fix typo",
							status: "unknown",
							evidenceIds: [],
							createdAt: "T1",
							updatedAt: "T1",
						},
					],
				}),
			),
		).toBeUndefined();
	});

	it("reducer does not retain caller-owned event references", () => {
		const state1 = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		const addEvent: { type: "add_requirement"; id: string; text: string; now: string } = {
			type: "add_requirement",
			id: "req-1",
			text: "Fix typo",
			now: "T1",
		};
		const state2 = applyGoalEvent(state1, addEvent);
		addEvent.text = "mutated by caller";
		const storedAddEvent = state2.events[0];
		if (storedAddEvent?.type !== "add_requirement") throw new Error("Expected add_requirement event");
		expect(storedAddEvent.text).toBe("Fix typo");

		const evidenceIds = ["ev-1"];
		const satisfyEvent: GoalEvent = { type: "satisfy_requirement", id: "req-1", evidenceIds, now: "T2" };
		const state3 = applyGoalEvent(state2, satisfyEvent);
		evidenceIds.push("ev-2");
		expect(state3.requirements[0].evidenceIds).toEqual(["ev-1"]);
		const storedSatisfyEvent = state3.events[1];
		if (storedSatisfyEvent?.type !== "satisfy_requirement") throw new Error("Expected satisfy_requirement event");
		expect(storedSatisfyEvent.evidenceIds).toEqual(["ev-1"]);
	});

	it("reducer does not mutate prior state arrays", () => {
		const state1 = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		const state2 = applyGoalEvent(state1, { type: "add_requirement", id: "req-1", text: "Fix typo", now: "T1" });
		const state3 = applyGoalEvent(state2, {
			type: "add_evidence",
			id: "ev-1",
			kind: "file",
			summary: "ok",
			now: "T2",
		});

		expect(state1.requirements).toHaveLength(0);
		expect(state1.events).toHaveLength(0);

		expect(state2.requirements).toHaveLength(1);
		expect(state2.evidence).toHaveLength(0);
		expect(state2.events).toHaveLength(1);

		expect(state3.evidence).toHaveLength(1);
		expect(state3.events).toHaveLength(2);

		// mutating requirement status does not affect old state
		const state4 = applyGoalEvent(state3, {
			type: "satisfy_requirement",
			id: "req-1",
			evidenceIds: ["ev-1"],
			now: "T3",
		});
		expect(state3.requirements[0].status).toBe("open");
		expect(state4.requirements[0].status).toBe("satisfied");
	});
});
