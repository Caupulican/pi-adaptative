import { describe, expect, it } from "vitest";
import { createGoalState, type GoalState } from "../src/core/goals/goal-state.ts";
import { createGoalLifecycleToolDefinitions, createGoalToolDefinition } from "../src/core/tools/goal.ts";

describe("update_goal pause", () => {
	it("pauses an active goal after an explicit owner stop instead of applying the blocker gate", async () => {
		let state: GoalState | undefined = createGoalState({
			goalId: "goal-stop",
			userGoal: "Finish the active work",
			now: "2026-09-28T23:00:00.000Z",
		});
		const legacy = createGoalToolDefinition({
			getGoalState: () => state,
			saveGoalState: (next) => {
				state = next;
			},
			now: () => "2026-09-28T23:01:00.000Z",
		});
		const [, , updateGoal] = createGoalLifecycleToolDefinitions(legacy);

		const paused = await updateGoal.execute(
			"pause-call",
			{ status: "paused" } as never,
			undefined,
			undefined,
			undefined as never,
		);

		expect(paused.isError).not.toBe(true);
		expect(state?.status).toBe("paused");
		expect(paused.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("goal pause_goal recorded") }),
		]);
	});

	it("keeps an active progress update lifecycle-neutral", async () => {
		let state: GoalState | undefined = createGoalState({ goalId: "goal-progress", userGoal: "Continue", now: "T0" });
		const legacy = createGoalToolDefinition({
			getGoalState: () => state,
			saveGoalState: (next) => {
				state = next;
			},
			now: () => "T1",
		});
		const [, , updateGoal] = createGoalLifecycleToolDefinitions(legacy);

		const progress = await updateGoal.execute(
			"progress-call",
			{ status: "active" },
			undefined,
			undefined,
			undefined as never,
		);

		expect(progress.isError).not.toBe(true);
		expect(state?.status).toBe("active");
	});
});
