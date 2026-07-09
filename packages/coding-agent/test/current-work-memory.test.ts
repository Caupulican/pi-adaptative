import { describe, expect, it } from "vitest";
import { collectCurrentWorkMemory } from "../src/core/context/current-work-memory.ts";
import type { GoalState } from "../src/core/goals/goal-state.ts";

function goalState(overrides: Partial<GoalState> = {}): GoalState {
	return {
		goalId: "goal-mrdqec8i",
		userGoal: "design this",
		status: "active",
		requirements: [
			{
				id: "goal-mrdqec8i-r1",
				text: "design tiered memory for compact models",
				status: "open",
				evidenceIds: [],
				createdAt: "2026-07-09T00:00:00Z",
				updatedAt: "2026-07-09T00:00:00Z",
			},
		],
		evidence: [],
		events: [],
		createdAt: "2026-07-09T00:00:00Z",
		updatedAt: "2026-07-09T00:00:00Z",
		lastProgressAt: "2026-07-09T00:00:00Z",
		stallTurns: 0,
		...overrides,
	};
}

describe("collectCurrentWorkMemory", () => {
	it("summarizes an active goal and open requirements as current-work memory", () => {
		const candidates = collectCurrentWorkMemory({ goalState: goalState() });

		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			id: "goal:goal-mrdqec8i",
			tier: "current_work",
			sourceLabel: "work:goal",
		});
		expect(candidates[0]?.summary).toContain("goal-mrdqec8i");
		expect(candidates[0]?.summary).toContain("open: design tiered memory");
	});

	it("does not emit completed goals", () => {
		expect(collectCurrentWorkMemory({ goalState: goalState({ status: "completed" }) })).toEqual([]);
	});
});
