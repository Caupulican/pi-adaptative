import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { buildGoalRuntimeSnapshot } from "../src/core/goals/goal-runtime-snapshot.ts";
import { appendGoalStateSnapshot, getLatestGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createGoalToolDefinition, type GoalToolInput } from "../src/core/tools/goal.ts";

const ctx = undefined as unknown as ExtensionContext;

/**
 * Wires the real producer (goal tool) to the real consumer (goal runtime snapshot)
 * through a real in-memory session manager. This is the regression guard for the
 * gap that the goal continuation loop had no producer: before this tool, the
 * consumer always read empty state and returned missing_goal_state.
 */
function createProducer(sessionManager: SessionManager) {
	let counter = 0;
	const tool = createGoalToolDefinition({
		getGoalState: () => getLatestGoalStateSnapshot(sessionManager.getEntries()),
		saveGoalState: (state) => {
			appendGoalStateSnapshot(sessionManager, state);
		},
		now: () => `T${counter++}`,
	});
	return (input: GoalToolInput) => tool.execute("call", input, undefined, undefined, ctx);
}

describe("goal producer feeds the continuation consumer", () => {
	it("an active goal with an open requirement yields continuation action 'continue'", async () => {
		const sessionManager = SessionManager.inMemory();
		const run = createProducer(sessionManager);

		await run({ action: "start", goalId: "g1", userGoal: "Ship feature" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Implement X" });

		const snapshot = buildGoalRuntimeSnapshot({
			entries: sessionManager.getEntries(),
			settings: { maxStallTurns: 20 },
		});
		expect(snapshot.goalState?.goalId).toBe("g1");
		expect(snapshot.continuation.action).toBe("continue");
		expect(snapshot.continuation.reasonCode).toBe("goal_active");
		expect(snapshot.continuation.openRequirementIds).toEqual(["r1"]);
	});

	it("a completed goal yields continuation action 'finalize'", async () => {
		const sessionManager = SessionManager.inMemory();
		const run = createProducer(sessionManager);

		await run({ action: "start", goalId: "g1", userGoal: "Ship feature" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Implement X" });
		await run({ action: "satisfy_requirement", requirementId: "r1" });
		await run({ action: "complete" });

		const snapshot = buildGoalRuntimeSnapshot({
			entries: sessionManager.getEntries(),
			settings: { maxStallTurns: 20 },
		});
		expect(snapshot.continuation.action).toBe("finalize");
		expect(snapshot.continuation.reasonCode).toBe("goal_completed");
	});

	it("stall accumulation reaches the stall limit and asks the user", async () => {
		const sessionManager = SessionManager.inMemory();
		const run = createProducer(sessionManager);

		await run({ action: "start", goalId: "g1", userGoal: "Ship feature" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Implement X" });
		await run({ action: "no_progress" });
		await run({ action: "no_progress" });

		const snapshot = buildGoalRuntimeSnapshot({
			entries: sessionManager.getEntries(),
			settings: { maxStallTurns: 2 },
		});
		expect(snapshot.continuation.action).toBe("ask-user");
		expect(snapshot.continuation.reasonCode).toBe("stall_limit_reached");
	});

	it("with no producer activity the consumer reports missing_goal_state", () => {
		const sessionManager = SessionManager.inMemory();
		const snapshot = buildGoalRuntimeSnapshot({
			entries: sessionManager.getEntries(),
			settings: { maxStallTurns: 20 },
		});
		expect(snapshot.continuation.action).toBe("ask-user");
		expect(snapshot.continuation.reasonCode).toBe("missing_goal_state");
	});
});
