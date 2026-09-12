import { Agent } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { GoalSessionController } from "../src/core/goals/goal-session-controller.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import {
	appendGoalClearedSnapshot,
	appendGoalStateSnapshot,
	GOAL_STATE_CUSTOM_TYPE,
	getLatestGoalStateSnapshot,
} from "../src/core/goals/session-goal-state.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("Phase 9A: Goal State Session Persistence", () => {
	it("appendGoalStateSnapshot stores a custom entry with customType 'goal_state'", () => {
		const sessionManager = SessionManager.inMemory();
		const state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });

		const entryId = appendGoalStateSnapshot(sessionManager, state);
		expect(typeof entryId).toBe("string");

		const entries = sessionManager.getEntries();
		expect(entries.length).toBe(1);
		const entry = entries[0];
		expect(entry?.type).toBe("custom");
		if (entry?.type !== "custom") throw new Error("Expected custom entry");
		expect(entry.customType).toBe(GOAL_STATE_CUSTOM_TYPE);
	});

	it("getLatestGoalStateSnapshot returns the newest valid goal state when multiple snapshots exist", () => {
		const sessionManager = SessionManager.inMemory();
		const state1 = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state1);

		const state2 = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T1" });
		state2.stallTurns = 5;
		appendGoalStateSnapshot(sessionManager, state2);

		const latest = getLatestGoalStateSnapshot(sessionManager);
		expect(latest).toBeDefined();
		expect(latest?.createdAt).toBe("T1");
		expect(latest?.stallTurns).toBe(5);
	});

	it("malformed goal_state entries are ignored and do not throw", () => {
		const sessionManager = SessionManager.inMemory();

		sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, { version: 1 }); // Missing state
		sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, { version: 2, state: {} }); // Wrong version
		sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, "malformed"); // Not an object

		const state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);

		const latest = getLatestGoalStateSnapshot(sessionManager);
		expect(latest).toBeDefined();
		expect(latest?.goalId).toBe("g1");
	});

	it("fails closed on a corrupt newest goal payload instead of resurrecting older work", () => {
		const sessionManager = SessionManager.inMemory();

		const validState = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		appendGoalStateSnapshot(sessionManager, validState);

		const newerValidState = createGoalState({ goalId: "g2", userGoal: "Ignore me", now: "T1" });
		const payload = Object.assign(new Date(0), { version: 1, state: newerValidState });
		sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, payload);

		const latest = getLatestGoalStateSnapshot(sessionManager);
		expect(latest).toBeUndefined();
	});

	it("fails closed when the newest goal checkpoint is invalid", () => {
		const sessionManager = SessionManager.inMemory();

		const validState = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		appendGoalStateSnapshot(sessionManager, validState);

		const newerValidState1 = createGoalState({ goalId: "g2", userGoal: "Ignore me", now: "T1" });
		newerValidState1.stallTurns = Number.NaN;
		sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, { version: 1, state: newerValidState1 });

		const newerValidState2 = createGoalState({ goalId: "g3", userGoal: "Ignore me", now: "T2" });
		newerValidState2.stallTurns = Infinity;
		sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, { version: 1, state: newerValidState2 });

		const latest = getLatestGoalStateSnapshot(sessionManager);
		expect(latest).toBeUndefined();
	});

	it("journals canonical transitions linearly and replays the exact state", () => {
		const sessionManager = SessionManager.inMemory();
		let state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);
		for (let index = 1; index <= 500; index++) {
			const previous = state;
			state = applyGoalEvent(state, { type: "no_progress", now: `T${index}` });
			appendGoalStateSnapshot(sessionManager, state, previous);
		}

		expect(getLatestGoalStateSnapshot(sessionManager)).toEqual(state);
		const bytes = Buffer.byteLength(JSON.stringify(sessionManager.getEntries()), "utf8");
		expect(bytes).toBeLessThan(250_000);
	});

	it("reuses the reconstructed state while the newest goal journal entry is unchanged", () => {
		const sessionManager = SessionManager.inMemory();
		let state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);
		for (let index = 1; index <= 100; index++) {
			const previous = state;
			state = applyGoalEvent(state, { type: "no_progress", now: `T${index}` });
			appendGoalStateSnapshot(sessionManager, state, previous);
		}

		let reads = 0;
		const source = {
			getLatestCustomEntryOnBranch: (...args: Parameters<SessionManager["getLatestCustomEntryOnBranch"]>) => {
				reads++;
				return sessionManager.getLatestCustomEntryOnBranch(...args);
			},
		};
		expect(getLatestGoalStateSnapshot(source)).toEqual(state);
		const replayReads = reads;
		expect(replayReads).toBeGreaterThan(1);
		expect(getLatestGoalStateSnapshot(source)).toEqual(state);
		expect(reads).toBe(replayReads + 1);
	});

	it("a clear tombstone prevents older active state from reappearing", () => {
		const sessionManager = SessionManager.inMemory();
		const state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);
		appendGoalClearedSnapshot(sessionManager, state, "T1");
		expect(getLatestGoalStateSnapshot(sessionManager)).toBeUndefined();
	});

	it("snapshots do not retain caller-owned nested array references", () => {
		const sessionManager = SessionManager.inMemory();
		let state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });

		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Fix typo", now: "T0" });

		const evidenceIds = ["ev-1"];
		state = applyGoalEvent(state, { type: "satisfy_requirement", id: "req-1", evidenceIds, now: "T1" });

		appendGoalStateSnapshot(sessionManager, state);

		evidenceIds.push("ev-2");

		const latest = getLatestGoalStateSnapshot(sessionManager);
		expect(latest?.requirements[0].evidenceIds).toEqual(["ev-1"]);
		expect(latest?.requirements[0].evidenceIds).not.toBe(evidenceIds);
	});

	it("AgentSession accessors save and restore the latest snapshot using an in-memory SessionManager", () => {
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.inMemory();
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing test model");

		const agent = new Agent({
			getApiKey: () => "test",
			initialState: {
				model,
				systemPrompt: "test",
				tools: [],
				thinkingLevel: "off",
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			resourceLoader: createTestResourceLoader(),
			cwd: process.cwd(),
			modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
		});

		const state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		session.saveGoalStateSnapshot(state);

		const retrieved = session.getGoalStateSnapshot();
		expect(retrieved).toBeDefined();
		expect(retrieved?.goalId).toBe("g1");
	});

	it("registers the goal tool, allows an unbudgeted agent start, and drives state end to end", async () => {
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.inMemory();
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing test model");

		const agent = new Agent({
			getApiKey: () => "test",
			initialState: { model, systemPrompt: "test", tools: [], thinkingLevel: "off" },
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			resourceLoader: createTestResourceLoader(),
			cwd: process.cwd(),
			modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
		});

		// The goal producer tool must be active by default, otherwise the model can
		// never record goal state and /goal-continue stays inert.
		expect(session.getActiveToolNames()).toContain("goal");
		const goalTool = session.getToolDefinition("goal");
		expect(goalTool).toBeDefined();
		if (!goalTool) throw new Error("goal tool not registered");

		const before = session.getGoalRuntimeSnapshot({ maxStallTurns: 20 });
		expect(before.continuation.reasonCode).toBe("missing_goal_state");

		const started = await goalTool.execute(
			"call-1",
			{ action: "start", goalId: "g1", userGoal: "Ship feature" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(started.isError).not.toBe(true);
		expect(session.getGoalStateSnapshot()).toMatchObject({ goalId: "g1", userGoal: "Ship feature" });
		await goalTool.execute(
			"call-2",
			{ action: "add_requirement", requirementId: "r1", text: "Implement X" },
			undefined,
			undefined,
			undefined as never,
		);

		const after = session.getGoalRuntimeSnapshot({ maxStallTurns: 20 });
		expect(after.goalState?.goalId).toBe("g1");
		expect(after.continuation.action).toBe("continue");
		expect(after.continuation.openRequirementIds).toEqual(["r1"]);
	});
});

describe("goal state snapshot sharing", () => {
	it("returns one frozen value per journal position and a new one after a write", () => {
		const sessionManager = SessionManager.inMemory();
		appendGoalStateSnapshot(sessionManager, createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" }));
		const first = getLatestGoalStateSnapshot(sessionManager);
		expect(first).toBeDefined();
		expect(getLatestGoalStateSnapshot(sessionManager)).toBe(first);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first?.events)).toBe(true);

		appendGoalStateSnapshot(sessionManager, applyGoalEvent(first!, { type: "cancel_goal", now: "T1" }));
		const second = getLatestGoalStateSnapshot(sessionManager);
		expect(second).not.toBe(first);
		expect(second?.status).toBe("cancelled");
		expect(first?.status).not.toBe("cancelled");
	});
});

describe("GoalSessionController transient recovery and bounded failure streak", () => {
	function createTestController(
		options: {
			sessionManager?: SessionManager;
			laneRecords?: Array<{ goalId: string; laneId: string; status: "queued" | "running" | "completed" }>;
			backgroundToolTasks?: Array<{
				goalId?: string;
				taskId: string;
				toolCallId: string;
				status: "running" | "completed";
			}>;
		} = {},
	) {
		const sessionManager = options.sessionManager ?? SessionManager.inMemory();
		let scheduledCount = 0;
		const controller = new GoalSessionController({
			getSessionManager: () => sessionManager,
			getModelProvider: () => "anthropic",
			getLaneRecords: () => (options.laneRecords ?? []) as never,
			getTaskRuntimeSnapshot: () => undefined,
			getBackgroundToolTasks: () => (options.backgroundToolTasks ?? []) as never,
			synchronizeGoalState: () => {},
			scheduleGoalAutoContinueFromIdle: () => {
				scheduledCount++;
			},
			prompt: async () => {},
			emitWarning: () => {},
		});
		return { controller, sessionManager, getScheduledCount: () => scheduledCount };
	}

	it("recovers transient provider failure on first attempt and rearms auto-continue", () => {
		const { controller, getScheduledCount } = createTestController();
		controller.saveState(createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" }));

		// Record first transient provider failure
		(controller as unknown as { recordContinuationFailure(e: unknown): void }).recordContinuationFailure(
			new Error("rate_limit: 429 Too Many Requests (attempt 1)"),
		);

		const state = controller.getState();
		expect(state?.status).toBe("active");
		expect(state?.systemFailureStreak).toBe(1);
		expect(getScheduledCount()).toBeGreaterThan(0);
	});

	it("stops as blocked on repeated failure without progress and refuses auto-resume on restart", () => {
		const { controller, sessionManager } = createTestController();
		controller.saveState(createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" }));

		const helper = controller as unknown as { recordContinuationFailure(e: unknown): void };

		// First failure: auto-resumes
		helper.recordContinuationFailure(new Error("rate_limit: 429 Too Many Requests at 14:00:00"));
		expect(controller.getState()?.status).toBe("active");
		expect(controller.getState()?.systemFailureStreak).toBe(1);

		// Second failure with alternating timestamp: hits ceiling, stays blocked
		helper.recordContinuationFailure(new Error("rate_limit: 429 Too Many Requests at 14:00:05"));
		const blocked = controller.getState();
		expect(blocked?.status).toBe("blocked");
		expect(blocked?.systemFailureStreak).toBe(2);

		// Restart / restoreAfterResume negative: repeated failure does not auto-resume
		const restartController = createTestController({ sessionManager }).controller;
		const restored = restartController.restoreAfterResume();
		expect(restored).toBe(false);
		expect(restartController.getState()?.status).toBe("blocked");
	});

	it("resets failure streak on trusted progress so future transient failures can recover", () => {
		const { controller } = createTestController();
		controller.saveState(createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" }));

		const helper = controller as unknown as { recordContinuationFailure(e: unknown): void };

		// First failure: streak = 1
		helper.recordContinuationFailure(new Error("rate_limit: 429 Too Many Requests"));
		expect(controller.getState()?.systemFailureStreak).toBe(1);

		// Evidenced trusted progress resets streak
		const current = controller.getState()!;
		const withProgress = applyGoalEvent(current, {
			type: "add_evidence",
			id: "ev-1",
			kind: "test",
			summary: "tests pass",
			verified: true,
			outcome: "succeeded",
			now: "T1",
		});
		controller.saveState(withProgress);
		expect(controller.getState()?.systemFailureStreak).toBe(0);

		// Subsequent failure is now allowed to recover again
		helper.recordContinuationFailure(new Error("server_error: 500 Internal Error"));
		expect(controller.getState()?.status).toBe("active");
		expect(controller.getState()?.systemFailureStreak).toBe(1);
	});

	it("keeps goal active when independent work is in flight during system interruption", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		state = applyGoalEvent(state, {
			type: "add_requirement",
			id: "req-1",
			text: "Implement something",
			now: "T0",
		});
		state = applyGoalEvent(state, {
			type: "dispatch_worker",
			id: "req-1",
			instructions: "do work",
			laneId: "lane-worker-1",
			now: "T0",
		});

		const { controller } = createTestController({
			laneRecords: [{ goalId: "g1", laneId: "lane-worker-1", status: "running" }],
		});
		controller.saveState(state);

		const helper = controller as unknown as { recordContinuationFailure(e: unknown): void };
		helper.recordContinuationFailure(new Error("server_error: 503 Service Unavailable"));

		// Because lane-worker-1 is running for this goal, the goal remains active
		expect(controller.getState()?.status).toBe("active");
	});

	it("preserves systemFailureStreak and runawayRecoverySignature across serialization and replay", () => {
		const sessionManager = SessionManager.inMemory();
		let state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		state = applyGoalEvent(state, {
			type: "system_stop_goal",
			status: "blocked",
			reason: "network: connect ECONNREFUSED",
			now: "T1",
		});
		// Provider stop increments systemFailureStreak
		expect(state.systemFailureStreak).toBe(1);

		state = applyGoalEvent(state, {
			type: "system_stop_goal",
			status: "blocked",
			reason: "runaway_tool_loop: signature sig1 3 times without progress",
			now: "T2",
		});
		// Runaway stop must NOT increment provider streak
		expect(state.systemFailureStreak).toBe(1);

		state = applyGoalEvent(state, {
			type: "resume_goal",
			source: "system",
			now: "T3",
		});
		expect(state.runawayRecoverySignature).toBe("runaway_tool_loop: signature sig1 3 times without progress");

		appendGoalStateSnapshot(sessionManager, state);
		const restored = getLatestGoalStateSnapshot(sessionManager);

		expect(restored?.systemFailureStreak).toBe(1);
		expect(restored?.runawayRecoverySignature).toBe("runaway_tool_loop: signature sig1 3 times without progress");
	});

	it("keeps repeated runaway blocked across restart even after intervening provider-success accounting event", () => {
		const sessionManager = SessionManager.inMemory();
		const { controller } = createTestController({ sessionManager });
		const state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		controller.saveState(state);

		const runawayReason = "runaway_tool_loop: repeated tool-call signature sig1 3 times without progress";

		// First runaway guard stop: auto-resumes once
		const firstRecovery = controller.recoverFromHarnessGuard({
			reason: "repeated_tool_call",
			signature: "sig1",
			repeats: 3,
		});
		expect(firstRecovery).toBe("resumed");
		expect(controller.getState()?.status).toBe("active");
		expect(controller.getState()?.runawayRecoverySignature).toBe(runawayReason);

		// Intervening successful provider continuation turn without legacy evidence
		// resets failure streak to 0, but leaves runawayRecoverySignature intact
		let current = controller.getState()!;
		current = applyGoalEvent(current, {
			type: "record_continuation_budget",
			turns: 1,
			wallClockMs: 10,
			tokens: 100,
			spendUsd: 0.01,
			outcome: "completed",
			completionTurn: (current.continuationTurnsUsed ?? 0) + 1,
			now: "T1",
		});
		controller.saveState(current);
		expect(controller.getState()?.systemFailureStreak).toBe(0);
		expect(controller.getState()?.runawayRecoverySignature).toBe(runawayReason);

		// Second runaway with same signature: must stay blocked, refusing recovery
		const secondRecovery = controller.recoverFromHarnessGuard({
			reason: "repeated_tool_call",
			signature: "sig1",
			repeats: 3,
		});
		expect(secondRecovery).toBe("blocked");
		expect(controller.getState()?.status).toBe("blocked");

		// Simulate restart: restoreAfterResume on a new controller instance must refuse to auto-resume the repeated runaway
		const restartController = createTestController({ sessionManager }).controller;
		const restored = restartController.restoreAfterResume();
		expect(restored).toBe(false);
		expect(restartController.getState()?.status).toBe("blocked");
	});

	it("permits first runaway recovery even after prior network failure and system resume", () => {
		const { controller } = createTestController();
		const state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		controller.saveState(state);

		const helper = controller as unknown as { recordContinuationFailure(e: unknown): void };
		// 1. Transient network failure triggers auto-resume
		helper.recordContinuationFailure(new Error("network error: connection lost"));
		expect(controller.getState()?.status).toBe("active");
		expect(controller.getState()?.systemFailureStreak).toBe(1);
		// Prior network resume must NOT set or exhaust runawayRecoverySignature
		expect(controller.getState()?.runawayRecoverySignature).toBeUndefined();

		// 2. Runaway tool loop occurs for the first time: must still be admitted and resumed!
		const runawayRecovery = controller.recoverFromHarnessGuard({
			reason: "repeated_tool_call",
			signature: "loop-sig",
			repeats: 3,
		});
		expect(runawayRecovery).toBe("resumed");
		expect(controller.getState()?.status).toBe("active");
		expect(controller.getState()?.runawayRecoverySignature).toBe(
			"runaway_tool_loop: repeated tool-call signature loop-sig 3 times without progress",
		);
		// Runaway recovery must NOT increment provider failure streak
		expect(controller.getState()?.systemFailureStreak).toBe(1);
	});

	it("keeps repeated runaway blocked across event truncation and restart", () => {
		const sessionManager = SessionManager.inMemory();
		const { controller } = createTestController({ sessionManager });
		const state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		controller.saveState(state);

		// First runaway guard stop: auto-resumes once
		const firstRecovery = controller.recoverFromHarnessGuard({
			reason: "repeated_tool_call",
			signature: "sig-truncate",
			repeats: 3,
		});
		expect(firstRecovery).toBe("resumed");
		expect(controller.getState()?.status).toBe("active");

		// Simulate event truncation (compaction dropping old events)
		const truncatedState = {
			...controller.getState()!,
			events: [],
		};
		controller.saveState(truncatedState);
		expect(controller.getState()?.events.length).toBe(0);
		expect(controller.getState()?.runawayRecoverySignature).toBeDefined();

		// Second runaway with same signature: must stay blocked, refusing recovery even with empty event history
		const secondRecovery = controller.recoverFromHarnessGuard({
			reason: "repeated_tool_call",
			signature: "sig-truncate",
			repeats: 3,
		});
		expect(secondRecovery).toBe("blocked");
		expect(controller.getState()?.status).toBe("blocked");

		// Restart simulation: restoreAfterResume on a new controller instance refuses auto-resume
		const restartController = createTestController({ sessionManager }).controller;
		const restored = restartController.restoreAfterResume();
		expect(restored).toBe(false);
		expect(restartController.getState()?.status).toBe("blocked");
	});

	it("resets provider streak only on fresh completion turn ordinal after system resume while preserving runaway fence and resisting replayed ordinals", () => {
		const sessionManager = SessionManager.inMemory();
		const { controller } = createTestController({ sessionManager });
		const initialState = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		controller.saveState(initialState);

		// 1. Runaway stop and auto-resume sets runawayRecoverySignature
		const firstRecovery = controller.recoverFromHarnessGuard({
			reason: "repeated_tool_call",
			signature: "sig-active-replay",
			repeats: 3,
		});
		expect(firstRecovery).toBe("resumed");
		expect(controller.getState()?.status).toBe("active");
		const expectedSignature =
			"runaway_tool_loop: repeated tool-call signature sig-active-replay 3 times without progress";
		expect(controller.getState()?.runawayRecoverySignature).toBe(expectedSignature);

		// 2. Transient network failure triggers auto-resume, leaving state active with failure streak 1
		const helper = controller as unknown as { recordContinuationFailure(e: unknown): void };
		helper.recordContinuationFailure(new Error("network error: connection lost"));
		expect(controller.getState()?.status).toBe("active");
		expect(controller.getState()?.systemFailureStreak).toBe(1);
		expect(controller.getState()?.runawayRecoverySignature).toBe(expectedSignature);

		// 3. Stale / invalid completionTurn (0) on active goal does NOT reset failure streak
		let current = controller.getState()!;
		const staleReplay = applyGoalEvent(current, {
			type: "record_continuation_budget",
			turns: 1,
			wallClockMs: 50,
			tokens: 25,
			spendUsd: 0.005,
			outcome: "completed",
			completionTurn: 0,
			now: "T1",
		});
		expect(staleReplay.systemFailureStreak).toBe(1);

		// 4. Expected ordinal (1) resets failure streak, but leaves runawayRecoverySignature intact
		current = applyGoalEvent(current, {
			type: "record_continuation_budget",
			turns: 1,
			wallClockMs: 50,
			tokens: 25,
			spendUsd: 0.005,
			outcome: "completed",
			completionTurn: 1,
			now: "T2",
		});
		expect(current.systemFailureStreak).toBe(0);
		expect(current.runawayRecoverySignature).toBe(expectedSignature);
		expect(current.continuationTurnsUsed).toBe(1);
		controller.saveState(current);

		// 5. Another transient network failure bumps streak again to 1
		helper.recordContinuationFailure(new Error("network error: connection lost"));
		expect(controller.getState()?.status).toBe("active");
		expect(controller.getState()?.systemFailureStreak).toBe(1);

		// 6. Simulate compaction dropping event history (truncate events)
		const truncatedState = {
			...controller.getState()!,
			events: [],
		};
		controller.saveState(truncatedState);
		expect(controller.getState()?.events.length).toBe(0);

		// 7. Retry the SAME ordinal (1) on truncated state: pre-state continuationTurnsUsed is 1, so expected is 2!
		// Replaying same ordinal (1) must NOT reset failure streak
		current = controller.getState()!;
		const replayedSameOrdinal = applyGoalEvent(current, {
			type: "record_continuation_budget",
			turns: 1,
			wallClockMs: 50,
			tokens: 25,
			spendUsd: 0.005,
			outcome: "completed",
			completionTurn: 1,
			now: "T3",
		});
		expect(replayedSameOrdinal.systemFailureStreak).toBe(1);

		// 8. Fresh next ordinal (2 = pre-state continuationTurnsUsed + 1) resets failure streak but preserves runaway signature
		const freshNextOrdinal = applyGoalEvent(current, {
			type: "record_continuation_budget",
			turns: 1,
			wallClockMs: 50,
			tokens: 25,
			spendUsd: 0.005,
			outcome: "completed",
			completionTurn: 2,
			now: "T4",
		});
		expect(freshNextOrdinal.systemFailureStreak).toBe(0);
		expect(freshNextOrdinal.runawayRecoverySignature).toBe(expectedSignature);
		expect(freshNextOrdinal.continuationTurnsUsed).toBe(2);
		controller.saveState(freshNextOrdinal);

		// 9. Restart check: create a NEW GoalSessionController on the same SessionManager
		const restartController = createTestController({ sessionManager }).controller;
		expect(restartController.getState()?.systemFailureStreak).toBe(0);
		expect(restartController.getState()?.runawayRecoverySignature).toBe(expectedSignature);
		expect(restartController.getState()?.continuationTurnsUsed).toBe(2);
	});

	it("does not replenish failure streak from replayed completion or duplicate receipt URI evidence", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		state = applyGoalEvent(state, {
			type: "system_stop_goal",
			status: "blocked",
			reason: "network: connection refused",
			now: "T1",
		});
		expect(state.systemFailureStreak).toBe(1);

		// 1. Replayed completion outcome on a blocked (non-active) goal does NOT reset failure streak
		const replayedCompletion = applyGoalEvent(state, {
			type: "record_continuation_budget",
			turns: 1,
			wallClockMs: 10,
			tokens: 100,
			spendUsd: 0.01,
			outcome: "completed",
			now: "T2",
		});
		expect(replayedCompletion.systemFailureStreak).toBe(1);

		// 2. Add first verified evidence with specific receipt URI -> resets failure streak
		let activeState = applyGoalEvent(state, {
			type: "resume_goal",
			source: "owner",
			now: "T3",
		});
		expect(activeState.systemFailureStreak).toBe(0);

		// Fail again
		activeState = applyGoalEvent(activeState, {
			type: "system_stop_goal",
			status: "blocked",
			reason: "network: connection timeout",
			now: "T4",
		});
		expect(activeState.systemFailureStreak).toBe(1);

		// Resume and add verified evidence
		activeState = applyGoalEvent(activeState, {
			type: "resume_goal",
			source: "system",
			now: "T5",
		});
		activeState = applyGoalEvent(activeState, {
			type: "add_evidence",
			id: "ev-1",
			kind: "file",
			summary: "Initial verified fix",
			uri: "file:///workspace/fix.ts",
			verified: true,
			outcome: "succeeded",
			now: "T6",
		});
		expect(activeState.systemFailureStreak).toBe(0);
		const initialRev = activeState.progressRevision;

		// Fail again -> streak 1
		activeState = applyGoalEvent(activeState, {
			type: "system_stop_goal",
			status: "blocked",
			reason: "network: connection reset",
			now: "T7",
		});
		expect(activeState.systemFailureStreak).toBe(1);

		// Attempt to reset failure streak by replaying duplicate receipt URI under different ID and summary
		activeState = applyGoalEvent(activeState, {
			type: "resume_goal",
			source: "system",
			now: "T8",
		});
		const duplicateReplay = applyGoalEvent(activeState, {
			type: "add_evidence",
			id: "ev-2-replayed",
			kind: "file",
			summary: "Reworded summary for same fix",
			uri: "file:///workspace/fix.ts",
			verified: true,
			outcome: "succeeded",
			now: "T9",
		});
		// Duplicate receipt URI is rejected from resetting failure streak or bumping progress revision
		expect(duplicateReplay.systemFailureStreak).toBe(1);
		expect(duplicateReplay.progressRevision).toBe(initialRev);

		// Authoritative fresh receipt URI resets failure streak
		const freshEvidence = applyGoalEvent(activeState, {
			type: "add_evidence",
			id: "ev-3-fresh",
			kind: "file",
			summary: "Different verified receipt",
			uri: "file:///workspace/test.ts",
			verified: true,
			outcome: "succeeded",
			now: "T10",
		});
		expect(freshEvidence.systemFailureStreak).toBe(0);
		expect(freshEvidence.progressRevision).toBe((initialRev ?? 0) + 1);
	});
});
