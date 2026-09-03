import { describe, expect, it } from "vitest";
import { budgetRemainingBucket, formatCompactGoalContext } from "../src/core/goals/compact-goal-context.ts";
import { createGoalState } from "../src/core/goals/goal-state.ts";

describe("formatCompactGoalContext", () => {
	it("is byte-identical across requests while the goal itself is unchanged", () => {
		const state = createGoalState({ goalId: "goal-1", userGoal: "ship it", now: "2026-09-03T00:00:00.000Z" });
		const first = formatCompactGoalContext(state, false);
		for (let turn = 1; turn <= 5; turn++) {
			state.tokensUsed = turn * 1234;
			expect(formatCompactGoalContext(state, false)).toBe(first);
		}
		expect(first).not.toContain("tokensUsed");
		expect(first).not.toContain("timeUsedSeconds");
	});

	it("changes only at 10% budget steps", () => {
		const state = createGoalState({
			goalId: "goal-2",
			userGoal: "ship it",
			now: "2026-09-03T00:00:00.000Z",
			tokenBudget: 1000,
		});
		state.tokensUsed = 10;
		const early = formatCompactGoalContext(state, true);
		state.tokensUsed = 90;
		expect(formatCompactGoalContext(state, true)).toBe(early);
		state.tokensUsed = 150;
		const later = formatCompactGoalContext(state, true);
		expect(later).not.toBe(early);
		expect(later).toContain('"budgetRemainingPct":"80"');
		expect(budgetRemainingBucket(1000, 1000)).toBe(100);
		expect(budgetRemainingBucket(0, 1000)).toBe(0);
		expect(budgetRemainingBucket(5, 0)).toBe(0);
	});
});
