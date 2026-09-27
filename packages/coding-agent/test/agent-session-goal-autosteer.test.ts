import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalAutoContinueController } from "../src/core/goals/goal-auto-continue-controller.ts";
import { evaluateGoalContinuation } from "../src/core/goals/goal-continuation-controller.ts";
import type { GoalRuntimeSnapshot } from "../src/core/goals/goal-runtime-snapshot.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { tempDir } from "./temp-dir.ts";

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

	it("schedules recovery after the authoritative continuation decision reaches the stall threshold", async () => {
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
		let reads = 0;
		const { controller, continuationOptions } = createController(() => {
			reads++;
			return reads <= 2
				? snapshot
				: {
						...snapshot,
						continuation: { ...snapshot.continuation, action: "stop", reasonCode: "goal_completed" },
					};
		});

		controller.scheduleFromIdle();
		await vi.runAllTimersAsync();

		expect(snapshot.continuation).toMatchObject({ action: "continue", reasonCode: "stall_limit_reached" });
		expect(continuationOptions).toEqual([
			{
				maxTurns: 5,
				maxStallTurns: 3,
				maxWallClockMinutes: 2,
			},
		]);
	});

	it("does not inject a continuation when the foreground prompt opts out", async () => {
		const { controller, continuationOptions, snapshotSettings } = createController(activeSnapshot());

		controller.scheduleFromIdle({ autoContinueGoal: false });
		await vi.runAllTimersAsync();

		expect(snapshotSettings).toEqual([]);
		expect(continuationOptions).toEqual([]);
	});

	it("reconciles an armed continuation when live autonomy settings disable and re-enable it", async () => {
		const settingsManager = SettingsManager.create(
			tempDir("pi-goal-autosteer-project-"),
			tempDir("pi-goal-autosteer-agent-"),
		);
		settingsManager.setAutonomySettings({ ...AUTONOMY_SETTINGS, goalAutoContinueDelayMs: 25 });
		let loopCalls = 0;
		const activityStates: boolean[] = [];
		const controller = new GoalAutoContinueController({
			isDisposed: () => false,
			isGoalToolActive: () => true,
			getSettingsManager: () => settingsManager,
			getGoalRuntimeSnapshot: () => activeSnapshot(),
			hasInFlightLaneForGoal: () => false,
			continueGoalLoop: async () => {
				loopCalls++;
				return {
					turnsSubmitted: 1,
					stopReason: "turn_interrupted",
					finalSnapshot: activeSnapshot(),
				};
			},
			isForegroundBusy: () => false,
			waitForForegroundIdle: async () => {},
			markGoalToolUnavailable: () => {},
			emit: () => {},
			onContinuationActivity: () => activityStates.push(controller.hasPendingContinuation()),
		});

		controller.scheduleFromIdle();
		expect(controller.hasPendingContinuation()).toBe(true);
		expect(activityStates).toEqual([true]);

		settingsManager.setAutonomySettings({ ...settingsManager.getAutonomySettings(), goalAutoContinueDelayMs: 40 });
		expect(controller.hasPendingContinuation()).toBe(true);
		expect(activityStates).toEqual([true, true]);
		await vi.advanceTimersByTimeAsync(25);
		expect(loopCalls).toBe(0);

		settingsManager.setAutonomySettings({ ...settingsManager.getAutonomySettings(), goalAutoContinue: false });
		expect(controller.hasPendingContinuation()).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		expect(activityStates.at(-1)).toBe(false);
		await vi.advanceTimersByTimeAsync(40);
		expect(loopCalls).toBe(0);

		settingsManager.setAutonomySettings({ ...settingsManager.getAutonomySettings(), goalAutoContinue: true });
		expect(controller.hasPendingContinuation()).toBe(true);
		expect(activityStates.at(-1)).toBe(true);
		await vi.advanceTimersByTimeAsync(39);
		expect(loopCalls).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(loopCalls).toBe(1);
		expect(controller.hasPendingContinuation()).toBe(false);
		await settingsManager.flush();
	});

	it("unsubscribes settings reconciliation and clears its timer on disposal", () => {
		let settings = { ...AUTONOMY_SETTINGS, goalAutoContinueDelayMs: 25 };
		let settingsListener: (() => void) | undefined;
		let unsubscribeCalls = 0;
		const controller = new GoalAutoContinueController({
			isDisposed: () => false,
			isGoalToolActive: () => true,
			getSettingsManager: () =>
				({
					getAutonomySettings: () => settings,
					subscribeChanges: (listener: () => void) => {
						settingsListener = listener;
						return () => {
							unsubscribeCalls++;
						};
					},
				}) as never,
			getGoalRuntimeSnapshot: () => activeSnapshot(),
			hasInFlightLaneForGoal: () => false,
			continueGoalLoop: async () => ({
				turnsSubmitted: 1,
				stopReason: "turn_interrupted",
				finalSnapshot: activeSnapshot(),
			}),
			isForegroundBusy: () => false,
			waitForForegroundIdle: async () => {},
			markGoalToolUnavailable: () => {},
			emit: () => {},
		});

		controller.scheduleFromIdle();
		controller.dispose();
		expect(unsubscribeCalls).toBe(1);
		expect(controller.hasPendingContinuation()).toBe(false);
		expect(vi.getTimerCount()).toBe(0);

		settings = { ...settings, goalAutoContinueDelayMs: 1 };
		settingsListener?.();
		controller.dispose();
		expect(unsubscribeCalls).toBe(1);
		expect(controller.hasPendingContinuation()).toBe(false);
	});

	it("retains the last valid timer when live settings re-evaluation fails", async () => {
		const settingsManager = SettingsManager.create(
			tempDir("pi-goal-autosteer-failure-project-"),
			tempDir("pi-goal-autosteer-failure-agent-"),
		);
		settingsManager.setAutonomySettings({ ...AUTONOMY_SETTINGS, goalAutoContinueDelayMs: 25 });
		let failSnapshot = false;
		let loopCalls = 0;
		const activityStates: boolean[] = [];
		const warnings: string[] = [];
		const controller = new GoalAutoContinueController({
			isDisposed: () => false,
			isGoalToolActive: () => true,
			getSettingsManager: () => settingsManager,
			getGoalRuntimeSnapshot: () => {
				if (failSnapshot) throw new Error("snapshot unavailable");
				return activeSnapshot();
			},
			hasInFlightLaneForGoal: () => false,
			continueGoalLoop: async () => {
				loopCalls++;
				return {
					turnsSubmitted: 1,
					stopReason: "turn_interrupted",
					finalSnapshot: activeSnapshot(),
				};
			},
			isForegroundBusy: () => false,
			waitForForegroundIdle: async () => {},
			markGoalToolUnavailable: () => {},
			emit: (event) => {
				if (event.type === "warning") warnings.push(event.message);
			},
			onContinuationActivity: () => activityStates.push(controller.hasPendingContinuation()),
		});

		controller.scheduleFromIdle();
		failSnapshot = true;
		settingsManager.setAutonomySettings({ ...settingsManager.getAutonomySettings(), goalAutoContinueDelayMs: 40 });

		expect(controller.hasPendingContinuation()).toBe(true);
		expect(vi.getTimerCount()).toBe(1);
		expect(activityStates).toEqual([true]);
		expect(warnings).toEqual(["Goal auto-continuation settings reconciliation failed: snapshot unavailable"]);

		failSnapshot = false;
		settingsManager.setAutonomySettings({ ...settingsManager.getAutonomySettings() });
		expect(controller.hasPendingContinuation()).toBe(true);
		expect(vi.getTimerCount()).toBe(1);
		expect(activityStates).toEqual([true, true]);
		await vi.advanceTimersByTimeAsync(39);
		expect(loopCalls).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(loopCalls).toBe(1);
		await settingsManager.flush();
	});

	it("contains and reports a scheduled snapshot failure instead of rejecting unobserved", async () => {
		let snapshotReads = 0;
		const warnings: string[] = [];
		const controller = new GoalAutoContinueController({
			isDisposed: () => false,
			isGoalToolActive: () => true,
			getSettingsManager: () =>
				({
					getAutonomySettings: () => ({ ...AUTONOMY_SETTINGS, goalAutoContinueDelayMs: 10 }),
				}) as never,
			getGoalRuntimeSnapshot: () => {
				snapshotReads++;
				if (snapshotReads > 1) throw new Error("scheduled snapshot unavailable");
				return activeSnapshot();
			},
			hasInFlightLaneForGoal: () => false,
			continueGoalLoop: async () => {
				throw new Error("must not run");
			},
			isForegroundBusy: () => false,
			waitForForegroundIdle: async () => {},
			markGoalToolUnavailable: () => {},
			emit: (event) => {
				if (event.type === "warning") warnings.push(event.message);
			},
		});

		controller.scheduleFromIdle();
		await vi.advanceTimersByTimeAsync(10);

		expect(controller.hasPendingContinuation()).toBe(false);
		expect(warnings).toEqual(["Goal auto-continuation failed: scheduled snapshot unavailable"]);
	});

	it("wakes at a bound worker's recovery deadline without polling or an external terminal event", async () => {
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		let goalState = createGoalState({ goalId: "g1", userGoal: "Ship large task", now: "2026-01-01T00:00:00.000Z" });
		goalState = applyGoalEvent(goalState, {
			type: "add_requirement",
			id: "req-1",
			text: "Finish delegated work",
			now: "2026-01-01T00:00:00.000Z",
		});
		goalState = applyGoalEvent(goalState, {
			type: "dispatch_worker",
			id: "req-1",
			instructions: "finish it",
			laneId: "lane-1",
			now: "2026-01-01T00:00:00.000Z",
		});
		let terminal = false;
		let loopCalls = 0;
		const snapshot = (): GoalRuntimeSnapshot => {
			const continuation = terminal
				? {
						action: "stop" as const,
						reasonCode: "goal_cancelled" as const,
						message: "recovery completed",
						goalId: goalState.goalId,
						openRequirementIds: [],
						blockedRequirementIds: [],
						satisfiedRequirementIds: [],
					}
				: evaluateGoalContinuation({
						state: goalState,
						settings: { maxStallTurns: AUTONOMY_SETTINGS.maxStallTurns },
						inFlightGoalLaneIds: new Set(["lane-1"]),
						now: new Date().toISOString(),
						maxWorkerWaitMs: 60_000,
					});
			return { goalState, workerClaims: [], learningDecisions: [], continuation };
		};
		const controller = new GoalAutoContinueController({
			isDisposed: () => false,
			isGoalToolActive: () => true,
			getSettingsManager: () =>
				({
					getAutonomySettings: () => AUTONOMY_SETTINGS,
				}) as never,
			getGoalRuntimeSnapshot: snapshot,
			hasInFlightLaneForGoal: () => true,
			continueGoalLoop: async () => {
				loopCalls++;
				terminal = true;
				return { turnsSubmitted: 1, stopReason: "continuation_not_allowed", finalSnapshot: snapshot() };
			},
			isForegroundBusy: () => false,
			waitForForegroundIdle: async () => {},
			markGoalToolUnavailable: () => {},
			emit: () => {},
		});

		controller.scheduleFromIdle();

		expect(snapshot().continuation).toMatchObject({
			action: "waiting",
			reasonCode: "worker_in_flight",
			resumeAt: "2026-01-01T00:01:00.000Z",
		});
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(59_999);
		expect(loopCalls).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(loopCalls).toBe(1);
		expect(controller.hasPendingContinuation()).toBe(false);
	});

	it("re-arms when the scheduled wake observes a newer worker deadline", async () => {
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const goalState = createGoalState({ goalId: "g1", userGoal: "Ship large task", now: "T0" });
		let phase: "first_wait" | "later_wait" | "recover" | "done" = "first_wait";
		let loopCalls = 0;
		const snapshot = (): GoalRuntimeSnapshot => ({
			goalState,
			workerClaims: [],
			learningDecisions: [],
			continuation:
				phase === "done"
					? {
							action: "stop",
							reasonCode: "goal_cancelled",
							message: "done",
							openRequirementIds: [],
							blockedRequirementIds: [],
							satisfiedRequirementIds: [],
						}
					: phase === "recover"
						? {
								action: "continue",
								reasonCode: "worker_wait_timeout",
								message: "recover",
								openRequirementIds: ["req-1"],
								blockedRequirementIds: [],
								satisfiedRequirementIds: [],
							}
						: {
								action: "waiting",
								reasonCode: "worker_in_flight",
								message: "wait",
								resumeAt: phase === "first_wait" ? "2026-01-01T00:00:00.100Z" : "2026-01-01T00:00:00.200Z",
								openRequirementIds: ["req-1"],
								blockedRequirementIds: [],
								satisfiedRequirementIds: [],
							},
		});
		const controller = new GoalAutoContinueController({
			isDisposed: () => false,
			isGoalToolActive: () => true,
			getSettingsManager: () =>
				({
					getAutonomySettings: () => AUTONOMY_SETTINGS,
				}) as never,
			getGoalRuntimeSnapshot: snapshot,
			hasInFlightLaneForGoal: () => true,
			continueGoalLoop: async () => {
				loopCalls++;
				phase = "done";
				return { turnsSubmitted: 1, stopReason: "continuation_not_allowed", finalSnapshot: snapshot() };
			},
			isForegroundBusy: () => false,
			waitForForegroundIdle: async () => {},
			markGoalToolUnavailable: () => {},
			emit: () => {},
		});

		controller.scheduleFromIdle();
		phase = "later_wait";
		await vi.advanceTimersByTimeAsync(100);
		expect(loopCalls).toBe(0);
		expect(vi.getTimerCount()).toBe(1);

		phase = "recover";
		await vi.advanceTimersByTimeAsync(100);
		expect(loopCalls).toBe(1);
		expect(controller.hasPendingContinuation()).toBe(false);
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

	it("does not re-arm after an interrupted continuation turn", async () => {
		let callCount = 0;
		const controller = new GoalAutoContinueController({
			isDisposed: () => false,
			isGoalToolActive: () => true,
			getSettingsManager: () =>
				({
					getAutonomySettings: () => AUTONOMY_SETTINGS,
				}) as never,
			getGoalRuntimeSnapshot: () => activeSnapshot(),
			hasInFlightLaneForGoal: () => false,
			continueGoalLoop: async () => {
				callCount++;
				return {
					turnsSubmitted: 1,
					stopReason: "turn_interrupted",
					finalSnapshot: activeSnapshot(),
				};
			},
			isForegroundBusy: () => false,
			waitForForegroundIdle: async () => {},
			markGoalToolUnavailable: () => {},
			emit: () => {},
		});

		controller.scheduleFromIdle();
		await vi.advanceTimersToNextTimerAsync();

		expect(callCount).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("marks goal tool unavailable and avoids repeated zero-turn timers when goal tool is inactive", async () => {
		let markUnavailableCount = 0;
		let loopCallCount = 0;
		let currentStatus: "active" | "blocked" = "active";

		const controller = new GoalAutoContinueController({
			isDisposed: () => false,
			isGoalToolActive: () => false,
			getSettingsManager: () =>
				({
					getAutonomySettings: () => AUTONOMY_SETTINGS,
				}) as never,
			getGoalRuntimeSnapshot: () => {
				const base = activeSnapshot();
				if (currentStatus === "blocked") {
					const blockedState = {
						...base.goalState!,
						status: "blocked" as const,
						blockedReason: "goal_tool_unavailable: test",
					};
					return {
						...base,
						goalState: blockedState,
						continuation: evaluateGoalContinuation({
							state: blockedState,
							settings: { maxStallTurns: AUTONOMY_SETTINGS.maxStallTurns },
						}),
					};
				}
				return base;
			},
			hasInFlightLaneForGoal: () => false,
			continueGoalLoop: async () => {
				loopCallCount++;
				return {
					turnsSubmitted: 1,
					stopReason: "max_turns_reached",
					finalSnapshot: activeSnapshot(),
				};
			},
			isForegroundBusy: () => false,
			waitForForegroundIdle: async () => {},
			markGoalToolUnavailable: () => {
				markUnavailableCount++;
				currentStatus = "blocked";
			},
			emit: () => {},
		});

		controller.scheduleFromIdle();
		await vi.runAllTimersAsync();

		expect(markUnavailableCount).toBe(1);
		expect(loopCallCount).toBe(0);
		expect(controller.hasPendingContinuation()).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("automatically rearms after host-resumed transient throw at common settled boundary", async () => {
		let calls = 0;
		let action: "continue" | "stop" = "continue";

		const controller = new GoalAutoContinueController({
			isDisposed: () => false,
			isGoalToolActive: () => true,
			getSettingsManager: () =>
				({
					getAutonomySettings: () => ({
						...AUTONOMY_SETTINGS,
						goalAutoContinueDelayMs: 10,
					}),
				}) as never,
			getGoalRuntimeSnapshot: () => {
				const base = activeSnapshot();
				return {
					...base,
					continuation: {
						...base.continuation,
						action,
					},
				};
			},
			hasInFlightLaneForGoal: () => false,
			continueGoalLoop: async () => {
				calls++;
				if (calls === 1) {
					// Simulates host resuming a transient failure while turn is running
					controller.scheduleFromIdle();
					throw new Error("network: ECONNRESET after bounded provider retry");
				}
				action = "stop";
				return {
					turnsSubmitted: 1,
					stopReason: "continuation_not_allowed",
					finalSnapshot: activeSnapshot(),
				};
			},
			isForegroundBusy: () => false,
			waitForForegroundIdle: async () => {},
			markGoalToolUnavailable: () => {},
			emit: () => {},
		});

		controller.scheduleFromIdle();
		await vi.runAllTimersAsync();

		expect(calls).toBe(2);
		expect(controller.hasPendingContinuation()).toBe(false);
	});

	it("does not rearm after throw if owner stopped the goal", async () => {
		let calls = 0;
		let action: "continue" | "stop" = "continue";

		const controller = new GoalAutoContinueController({
			isDisposed: () => false,
			isGoalToolActive: () => true,
			getSettingsManager: () =>
				({
					getAutonomySettings: () => ({
						...AUTONOMY_SETTINGS,
						goalAutoContinueDelayMs: 10,
					}),
				}) as never,
			getGoalRuntimeSnapshot: () => {
				const base = activeSnapshot();
				return {
					...base,
					continuation: {
						...base.continuation,
						action,
					},
				};
			},
			hasInFlightLaneForGoal: () => false,
			continueGoalLoop: async () => {
				calls++;
				// Simulates owner stop
				action = "stop";
				controller.scheduleFromIdle();
				throw new Error("network: ECONNRESET after bounded provider retry");
			},
			isForegroundBusy: () => false,
			waitForForegroundIdle: async () => {},
			markGoalToolUnavailable: () => {},
			emit: () => {},
		});

		controller.scheduleFromIdle();
		await vi.runAllTimersAsync();

		expect(calls).toBe(1);
		expect(controller.hasPendingContinuation()).toBe(false);
	});
});
