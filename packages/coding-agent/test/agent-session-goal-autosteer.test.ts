import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalAutoContinueController } from "../src/core/goals/goal-auto-continue-controller.ts";
import { evaluateGoalContinuation } from "../src/core/goals/goal-continuation-controller.ts";
import type { GoalRuntimeSnapshot } from "../src/core/goals/goal-runtime-snapshot.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";

const AUTONOMY_SETTINGS = {
	goalAutoContinue: true,
	goalAutoContinueDelayMs: 0,
	goalContinueTurns: 5,
	goalContinueMaxWallClockMinutes: 2,
	maxStallTurns: 3,
};

function activeSnapshot(): GoalRuntimeSnapshot {
	const goalState = createGoalState({ goalId: "g1", userGoal: "Ship large task", now: "T0" });
	return {
		goalState,
		workerClaims: [],
		learningDecisions: [],
		continuation: evaluateGoalContinuation({
			state: goalState,
			settings: { maxStallTurns: AUTONOMY_SETTINGS.maxStallTurns },
		}),
	};
}

function createController(snapshotOrGetter: GoalRuntimeSnapshot | (() => GoalRuntimeSnapshot)) {
	const continuationOptions: Array<{
		maxTurns?: number;
		maxStallTurns: number;
		maxWallClockMinutes?: number;
	}> = [];
	const snapshotSettings: Array<{ maxStallTurns: number }> = [];
	const controller = new GoalAutoContinueController({
		isDisposed: () => false,
		isGoalToolActive: () => true,
		getSettingsManager: () =>
			({
				getAutonomySettings: () => AUTONOMY_SETTINGS,
			}) as never,
		getGoalRuntimeSnapshot: (settings) => {
			snapshotSettings.push(settings);
			return typeof snapshotOrGetter === "function" ? snapshotOrGetter() : snapshotOrGetter;
		},
		hasInFlightLaneForGoal: () => false,
		continueGoalLoop: async (options) => {
			continuationOptions.push(options);
			const snap = typeof snapshotOrGetter === "function" ? snapshotOrGetter() : snapshotOrGetter;
			return {
				turnsSubmitted: 1,
				stopReason: "max_turns_reached",
				finalSnapshot: snap,
			};
		},
		isForegroundBusy: () => false,
		waitForForegroundIdle: async () => {},
		markGoalToolUnavailable: () => {},
		emit: () => {},
	});
	return { controller, continuationOptions, snapshotSettings };
}

describe("GoalAutoContinueController idle autosteer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("forwards the host-owned turn, stall, and wall-clock limits to one scheduled loop", async () => {
		let pass = 0;
		const { controller, continuationOptions, snapshotSettings } = createController(() => {
			pass++;
			if (pass > 2) {
				return {
					...activeSnapshot(),
					continuation: {
						action: "stop",
						reasonCode: "goal_completed",
						message: "done",
						openRequirementIds: [],
						blockedRequirementIds: [],
						satisfiedRequirementIds: ["req-1"],
					},
				};
			}
			return activeSnapshot();
		});

		controller.scheduleFromIdle();
		await vi.runAllTimersAsync();

		expect(snapshotSettings).toEqual([{ maxStallTurns: 3 }, { maxStallTurns: 3 }, { maxStallTurns: 3 }]);
		expect(continuationOptions).toEqual([
			{
				maxTurns: 5,
				maxStallTurns: 3,
				maxWallClockMinutes: 2,
			},
		]);
	});

	it("does not schedule after the authoritative continuation decision reaches the stall limit", async () => {
		let goalState = createGoalState({ goalId: "g1", userGoal: "Ship large task", now: "T0" });
		goalState = applyGoalEvent(goalState, {
			type: "add_requirement",
			id: "req-1",
			text: "Ship the requested behavior",
			now: "T0",
		});
		for (let pass = 0; pass < AUTONOMY_SETTINGS.maxStallTurns; pass++) {
			goalState = applyGoalEvent(goalState, { type: "no_progress", now: `T${pass + 1}` });
		}
		const snapshot: GoalRuntimeSnapshot = {
			goalState,
			workerClaims: [],
			learningDecisions: [],
			continuation: evaluateGoalContinuation({
				state: goalState,
				settings: { maxStallTurns: AUTONOMY_SETTINGS.maxStallTurns },
			}),
		};
		const { controller, continuationOptions } = createController(snapshot);

		controller.scheduleFromIdle();
		await vi.runAllTimersAsync();

		expect(snapshot.continuation).toMatchObject({ action: "ask-user", reasonCode: "stall_limit_reached" });
		expect(continuationOptions).toEqual([]);
	});

	it("does not inject a continuation when the foreground prompt opts out", async () => {
		const { controller, continuationOptions, snapshotSettings } = createController(activeSnapshot());

		controller.scheduleFromIdle({ autoContinueGoal: false });
		await vi.runAllTimersAsync();

		expect(snapshotSettings).toEqual([]);
		expect(continuationOptions).toEqual([]);
	});

	it("re-arms scheduleFromIdle after a batch until the goal completes", async () => {
		let callCount = 0;
		const goalState = createGoalState({ goalId: "g1", userGoal: "Ship large task", now: "T0" });
		const activeSnap: GoalRuntimeSnapshot = {
			goalState,
			workerClaims: [],
			learningDecisions: [],
			continuation: {
				action: "continue",
				reasonCode: "goal_active",
				message: "active",
				openRequirementIds: ["req-1"],
				blockedRequirementIds: [],
				satisfiedRequirementIds: [],
			},
		};
		const completedSnap: GoalRuntimeSnapshot = {
			goalState: { ...goalState, status: "completed" },
			workerClaims: [],
			learningDecisions: [],
			continuation: {
				action: "stop",
				reasonCode: "goal_completed",
				message: "done",
				openRequirementIds: [],
				blockedRequirementIds: [],
				satisfiedRequirementIds: ["req-1"],
			},
		};

		const continuationOptions: unknown[] = [];
		const controller = new GoalAutoContinueController({
			isDisposed: () => false,
			isGoalToolActive: () => true,
			getSettingsManager: () =>
				({
					getAutonomySettings: () => AUTONOMY_SETTINGS,
				}) as never,
			getGoalRuntimeSnapshot: () => (callCount >= 2 ? completedSnap : activeSnap),
			hasInFlightLaneForGoal: () => false,
			continueGoalLoop: async (options) => {
				callCount++;
				continuationOptions.push(options);
				return {
					turnsSubmitted: 5,
					stopReason: "max_turns_reached",
					finalSnapshot: callCount >= 2 ? completedSnap : activeSnap,
				};
			},
			isForegroundBusy: () => false,
			waitForForegroundIdle: async () => {},
			markGoalToolUnavailable: () => {},
			emit: () => {},
		});

		controller.scheduleFromIdle();
		await vi.runAllTimersAsync();

		expect(continuationOptions).toHaveLength(2);
		expect(callCount).toBe(2);
	});
});
