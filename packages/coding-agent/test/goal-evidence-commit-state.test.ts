import { describe, expect, it } from "vitest";
import { resolveGoalEvidenceCommitState } from "../src/core/goals/goal-lifecycle.ts";
import {
	applyGoalEvent,
	createGoalState,
	type GoalEvent,
	MAX_GOAL_EVENT_HISTORY,
} from "../src/core/goals/goal-state.ts";

const observed = createGoalState({ goalId: "evidence-owner", userGoal: "Review sources", now: "T0" });
const addition: GoalEvent = {
	type: "add_evidence",
	id: "ev-1",
	kind: "file",
	summary: "Source",
	uri: "/source.ts",
	verified: true,
	now: "T1",
};

describe("pending goal evidence ownership", () => {
	it("accepts an unchanged snapshot and an exact copy", () => {
		expect(resolveGoalEvidenceCommitState(observed, observed)).toBe(observed);
		const copy = structuredClone(observed);
		expect(resolveGoalEvidenceCommitState(observed, copy)).toBe(copy);
	});

	it("accepts evidence additions across the retained event-history boundary", () => {
		let base = observed;
		for (let index = 0; index < MAX_GOAL_EVENT_HISTORY; index++) {
			base = applyGoalEvent(base, { type: "progress", now: `T${index}` });
		}
		const current = applyGoalEvent(applyGoalEvent(base, addition), { ...addition, id: "ev-2" });
		expect(resolveGoalEvidenceCommitState(base, current)).toBe(current);
	});

	it.each([
		{ type: "progress", now: "T2" },
		{ type: "pause_goal", now: "T2" },
		{ type: "cancel_goal", now: "T2" },
		{ type: "edit_goal", userGoal: "Different work", now: "T2" },
	] satisfies GoalEvent[])("rejects $type interleaved with evidence", (event) => {
		const current = applyGoalEvent(applyGoalEvent(applyGoalEvent(observed, addition), event), {
			...addition,
			id: "ev-2",
		});
		expect(() => resolveGoalEvidenceCommitState(observed, current)).toThrow("changed concurrently");
	});

	it("rejects lifecycle changes even if the status returns to active", () => {
		const paused = applyGoalEvent(observed, { type: "pause_goal", now: "T1" });
		const resumed = applyGoalEvent(paused, { type: "resume_goal", now: "T2" });
		expect(() => resolveGoalEvidenceCommitState(observed, resumed)).toThrow("changed concurrently");
	});

	it("rejects missing, replaced, divergent, and truncated histories", () => {
		const current = applyGoalEvent(observed, addition);
		for (const other of [
			undefined,
			{ ...current, goalId: "replacement" },
			{ ...current, userGoal: "Replaced with same id" },
			{ ...current, events: [] },
		]) {
			expect(() => resolveGoalEvidenceCommitState(observed, other)).toThrow("changed concurrently");
		}
		expect(() => resolveGoalEvidenceCommitState(current, observed)).toThrow("changed concurrently");
		expect(() => resolveGoalEvidenceCommitState(undefined, observed)).toThrow("changed concurrently");
	});
});
