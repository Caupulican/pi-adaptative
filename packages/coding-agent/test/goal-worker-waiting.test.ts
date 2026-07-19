import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { SessionManager as InMemorySessionManager } from "@caupulican/pi-agent-core/node";
import { describe, expect, it, vi } from "vitest";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import { BackgroundLaneController, type BackgroundLaneControllerDeps } from "../src/core/background-lane-controller.ts";
import { GoalLoopController, type GoalLoopControllerDeps } from "../src/core/goal-loop-controller.ts";
import { DEFAULT_GOAL_CUMULATIVE_MAX_WORKER_SPEND_USD } from "../src/core/goals/goal-continuation-defaults.ts";
import { buildGoalRuntimeSnapshot } from "../src/core/goals/goal-runtime-snapshot.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";

/**
 * REPRO-FIRST: this file proves the bug before proving the fix.
 *
 * Before this fix, `GoalContinuationAction` had no `"waiting"` member and `evaluateGoalContinuation`
 * had no notion of an in-flight lane at all. A goal with an open requirement bound
 * (`Requirement.boundLaneId`) to a queued/running worker lane therefore read as plain
 * `action:"continue"`, which broke in two ways:
 *  (a) `GoalLoopController.continueGoalLoop` would submit a continuation pass against a goal that
 *      cannot have advanced (the bound worker is still running) — the very next read sees an
 *      unchanged progress signature and the loop STOPS with a misleading `goal_state_not_advanced`,
 *      even though the goal is nowhere near stalled; and
 *  (b) `BackgroundLaneController.scheduleGoalAutoContinueFromIdle` would happily arm the idle timer
 *      and race a second dispatch against the SAME open requirement while the first worker still runs.
 * Every test below asserts the FIXED behavior. Run against the pre-fix source, the "waiting" tests
 * fail because `continuation.action` is `"continue"` instead of `"waiting"` (proving (a)/(b) above);
 * this confirms the bug is real, warranting the fix below.
 */

function buildLaneControllerDeps(overrides: Partial<BackgroundLaneControllerDeps> = {}): BackgroundLaneControllerDeps {
	const sessionManager =
		(overrides.getSessionManager?.() as SessionManager | undefined) ??
		({
			getEntries: () => [],
			appendCustomEntry: () => "entry-1",
		} as unknown as SessionManager);
	return {
		isDisposed: () => false,
		getSessionId: () => "test-session",
		getCwd: () => "/repo",
		getAgentDir: () => "/tmp/pi-test-goal-worker-waiting",
		getSessionManager: () => sessionManager,
		getGoalStateSnapshot: () => undefined,
		getCapabilityEnvelope: () => undefined,
		saveWorkerResultSnapshot: () => "worker-result-entry",
		...overrides,
	} as unknown as BackgroundLaneControllerDeps;
}

function seedGoalWithOptionalBinding(sessionManager: SessionManager, args: { goalId: string; boundLaneId?: string }) {
	let state = createGoalState({ goalId: args.goalId, userGoal: "Ship the thing", now: "T0" });
	state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1", now: "T0" });
	if (args.boundLaneId !== undefined) {
		state = applyGoalEvent(state, {
			type: "dispatch_worker",
			id: "req-1",
			instructions: "do the thing",
			laneId: args.boundLaneId,
			now: "T1",
		});
	}
	appendGoalStateSnapshot(sessionManager, state);
	return state;
}

describe("the 'waiting' continuation state (goal-runtime-snapshot + BackgroundLaneController)", () => {
	it("a worker dispatched (queued/running) against an open requirement yields action:'waiting'/reasonCode:'worker_in_flight'", () => {
		const sessionManager = InMemorySessionManager.inMemory();
		const controller = new BackgroundLaneController(
			buildLaneControllerDeps({ getSessionManager: () => sessionManager }),
		);

		controller.recordManagedLane({ laneId: "tmux-job-1", phase: "dispatch", goalId: "g1" });
		const dispatchedLaneId = controller.getLaneRecords()[0]?.laneId;
		expect(dispatchedLaneId).toBeDefined();

		seedGoalWithOptionalBinding(sessionManager, { goalId: "g1", boundLaneId: dispatchedLaneId });

		const snapshot = buildGoalRuntimeSnapshot({
			sessionManager,
			settings: { maxStallTurns: 20 },
			laneRecords: controller.getLaneRecords(),
		});

		expect(snapshot.continuation.action).toBe("waiting");
		expect(snapshot.continuation.reasonCode).toBe("worker_in_flight");
	});

	it("resumes to action:'continue' once the bound worker terminates", () => {
		const sessionManager = InMemorySessionManager.inMemory();
		const controller = new BackgroundLaneController(
			buildLaneControllerDeps({ getSessionManager: () => sessionManager }),
		);

		controller.recordManagedLane({ laneId: "tmux-job-2", phase: "dispatch", goalId: "g1" });
		const dispatchedLaneId = controller.getLaneRecords()[0]?.laneId as string;
		seedGoalWithOptionalBinding(sessionManager, { goalId: "g1", boundLaneId: dispatchedLaneId });

		const whileRunning = buildGoalRuntimeSnapshot({
			sessionManager,
			settings: { maxStallTurns: 20 },
			laneRecords: controller.getLaneRecords(),
		});
		expect(whileRunning.continuation.action).toBe("waiting");

		controller.recordManagedLane({ laneId: "tmux-job-2", phase: "terminal", status: "succeeded" });

		const afterTerminal = buildGoalRuntimeSnapshot({
			sessionManager,
			settings: { maxStallTurns: 20 },
			laneRecords: controller.getLaneRecords(),
		});
		expect(afterTerminal.continuation.action).toBe("continue");
		expect(afterTerminal.continuation.reasonCode).toBe("goal_active");
	});

	it("a goal with no bound worker is unaffected — single-branch path stays action:'continue'", () => {
		const sessionManager = InMemorySessionManager.inMemory();
		seedGoalWithOptionalBinding(sessionManager, { goalId: "g1" });

		const snapshot = buildGoalRuntimeSnapshot({
			sessionManager,
			settings: { maxStallTurns: 20 },
			laneRecords: [],
		});

		expect(snapshot.continuation.action).toBe("continue");
		expect(snapshot.continuation.reasonCode).toBe("goal_active");
	});

	it("omitting laneRecords entirely keeps the pre-existing (lane-unaware) behavior byte-identical", () => {
		const sessionManager = InMemorySessionManager.inMemory();
		seedGoalWithOptionalBinding(sessionManager, { goalId: "g1" });

		const snapshot = buildGoalRuntimeSnapshot({
			sessionManager,
			settings: { maxStallTurns: 20 },
		});

		expect(snapshot.continuation.action).toBe("continue");
	});

	it("a lane bound to the requirement but tagged with a DIFFERENT goalId does not trigger waiting", () => {
		const sessionManager = InMemorySessionManager.inMemory();
		const controller = new BackgroundLaneController(
			buildLaneControllerDeps({ getSessionManager: () => sessionManager }),
		);
		controller.recordManagedLane({ laneId: "tmux-job-3", phase: "dispatch", goalId: "some-other-goal" });
		const dispatchedLaneId = controller.getLaneRecords()[0]?.laneId as string;
		seedGoalWithOptionalBinding(sessionManager, { goalId: "g1", boundLaneId: dispatchedLaneId });

		const snapshot = buildGoalRuntimeSnapshot({
			sessionManager,
			settings: { maxStallTurns: 20 },
			laneRecords: controller.getLaneRecords(),
		});

		expect(snapshot.continuation.action).toBe("continue");
	});
});

describe("GoalLoopController neither stalls nor races while a bound worker is in flight", () => {
	function makeSnapshot(action: "continue" | "waiting", reasonCode: string) {
		return {
			goalState: createGoalState({ goalId: "g1", userGoal: "Ship it", now: "T0" }),
			workerResults: [],
			learningDecisions: [],
			continuation: {
				action,
				reasonCode: reasonCode as never,
				message: "test",
				openRequirementIds: ["req-1"],
				blockedRequirementIds: [],
				satisfiedRequirementIds: [],
			},
		} as ReturnType<GoalLoopControllerDeps["getGoalRuntimeSnapshot"]>;
	}

	it("returns immediately with stopReason:'worker_in_flight' and submits zero passes while waiting (never goal_state_not_advanced)", async () => {
		const promptCalls: string[] = [];
		const recorded: Array<{ turns: number; wallClockMs: number }> = [];
		const controller = new GoalLoopController({
			getGoalRuntimeSnapshot: () => makeSnapshot("waiting", "worker_in_flight"),
			prompt: async (text) => {
				promptCalls.push(text);
			},
			recordGoalContinuationPass: (pass) => recorded.push(pass),
		});

		const result = await controller.continueGoalLoop({ maxStallTurns: 20, maxTurns: 5 });

		expect(result.turnsSubmitted).toBe(0);
		expect(result.stopReason).toBe("worker_in_flight");
		expect(promptCalls).toEqual([]);
		expect(recorded).toEqual([]);
	});

	it("resumes normal continuation once a later invocation's snapshot reports action:'continue' again", async () => {
		let waiting = true;
		const promptCalls: string[] = [];
		const controller = new GoalLoopController({
			getGoalRuntimeSnapshot: () =>
				waiting ? makeSnapshot("waiting", "worker_in_flight") : makeSnapshot("continue", "goal_active"),
			prompt: async (text) => {
				promptCalls.push(text);
			},
			recordGoalContinuationPass: () => {},
		});

		const whileWaiting = await controller.continueGoalLoop({ maxStallTurns: 20, maxTurns: 5 });
		expect(whileWaiting.stopReason).toBe("worker_in_flight");
		expect(promptCalls.length).toBe(0);

		// Mirrors the real system: the bound worker's terminal handoff lands, and by the time the NEXT
		// invocation reads the snapshot the lane is terminal, so continuation.action is "continue" again.
		waiting = false;
		const afterResume = await controller.continueGoalLoop({ maxStallTurns: 20, maxTurns: 1 });
		expect(afterResume.turnsSubmitted).toBe(1);
		expect(promptCalls.length).toBe(1);
	});
});

describe("worker-spend cumulative budget ceiling (goal-loop-controller)", () => {
	it("a goal already at/over the worker-spend ceiling stops immediately with goal_budget_exhausted, submitting no pass", async () => {
		const promptCalls: string[] = [];
		let state = createGoalState({ goalId: "g1", userGoal: "Ship it", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1", now: "T0" });
		state = { ...state, continuationWorkerSpendUsd: DEFAULT_GOAL_CUMULATIVE_MAX_WORKER_SPEND_USD };

		const controller = new GoalLoopController({
			getGoalRuntimeSnapshot: () => ({
				goalState: state,
				workerResults: [],
				learningDecisions: [],
				continuation: {
					action: "continue",
					reasonCode: "goal_active",
					message: "test",
					openRequirementIds: ["req-1"],
					blockedRequirementIds: [],
					satisfiedRequirementIds: [],
				},
			}),
			prompt: async (text) => {
				promptCalls.push(text);
			},
			recordGoalContinuationPass: () => {},
		});

		const result = await controller.continueGoalLoop({ maxStallTurns: 20, maxTurns: 5 });
		expect(result.turnsSubmitted).toBe(0);
		expect(result.stopReason).toBe("goal_budget_exhausted");
		expect(promptCalls).toEqual([]);
	});

	it("a fresh goal (worker spend 0) is not affected by the worker-spend ceiling", async () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Ship it", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1", now: "T0" });

		const controller = new GoalLoopController({
			getGoalRuntimeSnapshot: () => ({
				goalState: state,
				workerResults: [],
				learningDecisions: [],
				continuation: {
					action: "continue",
					reasonCode: "goal_active",
					message: "test",
					openRequirementIds: ["req-1"],
					blockedRequirementIds: [],
					satisfiedRequirementIds: [],
				},
			}),
			prompt: async () => {},
			recordGoalContinuationPass: () => {},
		});

		const result = await controller.continueGoalLoop({ maxStallTurns: 20, maxTurns: 5 });
		expect(result.stopReason).not.toBe("goal_budget_exhausted");
	});
});

describe("worker spend sums onto the snapshot's continuationWorkerSpendUsd (advisory)", () => {
	it("sums costUsd across all of this goal's lanes (any status) and ignores other goals' lanes", () => {
		const sessionManager = InMemorySessionManager.inMemory();
		appendGoalStateSnapshot(sessionManager, createGoalState({ goalId: "g1", userGoal: "Ship it", now: "T0" }));

		const laneRecords: LaneRecord[] = [
			{ laneId: "worker-1", type: "worker", status: "succeeded", goalId: "g1", costUsd: 0.5 },
			{ laneId: "research-1", type: "research", status: "succeeded", goalId: "g1", costUsd: 0.25 },
			{ laneId: "worker-2", type: "worker", status: "running", goalId: "g1" },
			{ laneId: "worker-3", type: "worker", status: "succeeded", goalId: "some-other-goal", costUsd: 99 },
		];

		const snapshot = buildGoalRuntimeSnapshot({
			sessionManager,
			settings: { maxStallTurns: 20 },
			laneRecords,
		});

		expect(snapshot.goalState?.continuationWorkerSpendUsd).toBeCloseTo(0.75, 10);
	});

	it("without laneRecords, the durable field is left as-is (back-compat)", () => {
		const sessionManager = InMemorySessionManager.inMemory();
		appendGoalStateSnapshot(sessionManager, createGoalState({ goalId: "g1", userGoal: "Ship it", now: "T0" }));

		const snapshot = buildGoalRuntimeSnapshot({ sessionManager, settings: { maxStallTurns: 20 } });
		expect(snapshot.goalState?.continuationWorkerSpendUsd).toBe(0);
	});
});

describe("idle scheduler does not arm while a bound worker is in flight (belt-and-braces)", () => {
	function makeAutoContinueDeps(overrides: Partial<BackgroundLaneControllerDeps> = {}): BackgroundLaneControllerDeps {
		return buildLaneControllerDeps({
			getModelCapabilityProfile: () => ({ backgroundLanesEnabled: true }) as never,
			getSettingsManager: () =>
				({
					getAutonomySettings: () => ({ maxStallTurns: 20, goalAutoContinue: true, goalAutoContinueDelayMs: 0 }),
				}) as never,
			getGoalRuntimeSnapshot: () =>
				({
					goalState: createGoalState({ goalId: "g1", userGoal: "Ship it", now: "T0" }),
					workerResults: [],
					learningDecisions: [],
					continuation: {
						action: "continue",
						reasonCode: "goal_active",
						message: "test",
						openRequirementIds: ["req-1"],
						blockedRequirementIds: [],
						satisfiedRequirementIds: [],
					},
				}) as never,
			continueGoalLoop: async () =>
				({ turnsSubmitted: 0, stopReason: "max_turns_reached", finalSnapshot: {} }) as never,
			...overrides,
		});
	}

	it("does not arm the idle timer when a queued/running lane matches the active goal", () => {
		const controller = new BackgroundLaneController(makeAutoContinueDeps());
		controller.recordManagedLane({ laneId: "tmux-job-1", phase: "dispatch", goalId: "g1" });

		const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
		try {
			controller.scheduleGoalAutoContinueFromIdle();
			expect(timeoutSpy).not.toHaveBeenCalled();
		} finally {
			timeoutSpy.mockRestore();
		}
	});

	it("still arms the idle timer when no lane is in flight for the active goal (no regression)", () => {
		const controller = new BackgroundLaneController(makeAutoContinueDeps());

		const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
		try {
			controller.scheduleGoalAutoContinueFromIdle();
			expect(timeoutSpy).toHaveBeenCalledTimes(1);
		} finally {
			controller.clearGoalAutoContinueTimer();
			timeoutSpy.mockRestore();
		}
	});

	it("re-arms once the in-flight lane for the goal has terminated", () => {
		const controller = new BackgroundLaneController(makeAutoContinueDeps());
		controller.recordManagedLane({ laneId: "tmux-job-4", phase: "dispatch", goalId: "g1" });

		const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
		try {
			controller.scheduleGoalAutoContinueFromIdle();
			expect(timeoutSpy).not.toHaveBeenCalled();

			controller.recordManagedLane({ laneId: "tmux-job-4", phase: "terminal", status: "succeeded" });
			controller.scheduleGoalAutoContinueFromIdle();
			expect(timeoutSpy).toHaveBeenCalledTimes(1);
		} finally {
			controller.clearGoalAutoContinueTimer();
			timeoutSpy.mockRestore();
		}
	});
});
