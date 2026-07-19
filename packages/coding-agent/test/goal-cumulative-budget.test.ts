import { Agent } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	DEFAULT_GOAL_CONTINUE_MAX_TURNS,
	DEFAULT_GOAL_CUMULATIVE_MAX_TURNS,
	DEFAULT_GOAL_CUMULATIVE_MAX_WALL_CLOCK_MS,
} from "../src/core/goals/goal-continuation-defaults.ts";
import { applyGoalEvent, createGoalState, isGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

function createTestSession() {
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

	const promptCalls: { text: string; options: unknown }[] = [];
	session.prompt = async (text: string, options?: unknown) => {
		promptCalls.push({ text, options });
	};

	return { sessionManager, session, promptCalls };
}

describe("per-goal cumulative continuation budget", () => {
	describe("pure reducer semantics (goal-state.ts)", () => {
		it("a fresh goal starts with clean (zero) cumulative counters", () => {
			const state = createGoalState({ goalId: "g1", userGoal: "Goal", now: "T0" });
			expect(state.continuationTurnsUsed).toBe(0);
			expect(state.continuationWallClockMs).toBe(0);
			expect(state.continuationSpendUsd).toBe(0);
			expect(state.continuationSpendCheckpointUsd).toBeUndefined();
		});

		it("record_continuation_budget accumulates turns and wall-clock across repeated events", () => {
			let state = createGoalState({ goalId: "g1", userGoal: "Goal", now: "T0" });
			state = applyGoalEvent(state, {
				type: "record_continuation_budget",
				turns: 1,
				wallClockMs: 1000,
				sessionCostUsd: 0.01,
				now: "T1",
			});
			state = applyGoalEvent(state, {
				type: "record_continuation_budget",
				turns: 1,
				wallClockMs: 2000,
				sessionCostUsd: 0.03,
				now: "T2",
			});
			expect(state.continuationTurnsUsed).toBe(2);
			expect(state.continuationWallClockMs).toBe(3000);
		});

		it("the first recorded pass establishes the spend checkpoint with a zero delta (no prior baseline)", () => {
			let state = createGoalState({ goalId: "g1", userGoal: "Goal", now: "T0" });
			state = applyGoalEvent(state, {
				type: "record_continuation_budget",
				turns: 1,
				wallClockMs: 1000,
				// Session already had $5 of unrelated spend before this goal's loop ever ran; the first
				// pass must not attribute all of it to itself.
				sessionCostUsd: 5.0,
				now: "T1",
			});
			expect(state.continuationSpendUsd).toBe(0);
			expect(state.continuationSpendCheckpointUsd).toBe(5.0);
		});

		it("subsequent passes attribute only the delta since the last recorded checkpoint", () => {
			let state = createGoalState({ goalId: "g1", userGoal: "Goal", now: "T0" });
			state = applyGoalEvent(state, {
				type: "record_continuation_budget",
				turns: 1,
				wallClockMs: 1000,
				sessionCostUsd: 5.0,
				now: "T1",
			});
			state = applyGoalEvent(state, {
				type: "record_continuation_budget",
				turns: 1,
				wallClockMs: 1000,
				sessionCostUsd: 5.25,
				now: "T2",
			});
			state = applyGoalEvent(state, {
				type: "record_continuation_budget",
				turns: 1,
				wallClockMs: 1000,
				sessionCostUsd: 5.4,
				now: "T3",
			});
			expect(state.continuationSpendUsd).toBeCloseTo(0.4, 10);
			expect(state.continuationSpendCheckpointUsd).toBe(5.4);
		});

		it("a non-increasing sessionCostUsd reading clamps the delta at zero (never goes negative)", () => {
			let state = createGoalState({ goalId: "g1", userGoal: "Goal", now: "T0" });
			state = applyGoalEvent(state, {
				type: "record_continuation_budget",
				turns: 1,
				wallClockMs: 1000,
				sessionCostUsd: 5.0,
				now: "T1",
			});
			state = applyGoalEvent(state, {
				type: "record_continuation_budget",
				turns: 1,
				wallClockMs: 1000,
				sessionCostUsd: 4.9, // e.g. a clock/read anomaly — must not go negative
				now: "T2",
			});
			expect(state.continuationSpendUsd).toBe(0);
		});

		it("does not perturb the goal-loop progress signature inputs (status/requirements/evidence unchanged)", () => {
			let state = createGoalState({ goalId: "g1", userGoal: "Goal", now: "T0" });
			state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1", now: "T0" });
			const before = { status: state.status, requirements: state.requirements, evidence: state.evidence };
			state = applyGoalEvent(state, {
				type: "record_continuation_budget",
				turns: 1,
				wallClockMs: 1000,
				sessionCostUsd: 0.1,
				now: "T1",
			});
			expect(state.status).toBe(before.status);
			expect(state.requirements).toEqual(before.requirements);
			expect(state.evidence).toEqual(before.evidence);
		});

		it("isGoalState accepts a legacy snapshot missing the cumulative-budget fields entirely", () => {
			const legacy = {
				goalId: "g1",
				userGoal: "Goal",
				status: "active",
				requirements: [],
				evidence: [],
				events: [],
				createdAt: "T0",
				updatedAt: "T0",
				lastProgressAt: "T0",
				stallTurns: 0,
				// no continuationTurnsUsed / continuationWallClockMs / continuationSpendUsd / checkpoint
			};
			expect(isGoalState(legacy)).toBe(true);
		});

		it("record_continuation_budget on a legacy state (undefined counters) treats them as zero", () => {
			const legacy = createGoalState({ goalId: "g1", userGoal: "Goal", now: "T0" });
			// Simulate a pre-migration snapshot by stripping the new fields.
			const stripped = { ...legacy };
			delete (stripped as Record<string, unknown>).continuationTurnsUsed;
			delete (stripped as Record<string, unknown>).continuationWallClockMs;
			delete (stripped as Record<string, unknown>).continuationSpendUsd;
			const updated = applyGoalEvent(stripped, {
				type: "record_continuation_budget",
				turns: 1,
				wallClockMs: 500,
				sessionCostUsd: 0.02,
				now: "T1",
			});
			expect(updated.continuationTurnsUsed).toBe(1);
			expect(updated.continuationWallClockMs).toBe(500);
		});
	});

	describe("defaults are conservative relative to single-invocation caps", () => {
		it("the cumulative turn ceiling is comfortably above the single-invocation default", () => {
			expect(DEFAULT_GOAL_CUMULATIVE_MAX_TURNS).toBeGreaterThan(DEFAULT_GOAL_CONTINUE_MAX_TURNS);
			// At least a few invocations' worth of headroom, not a near-immediate trip.
			expect(DEFAULT_GOAL_CUMULATIVE_MAX_TURNS).toBeGreaterThanOrEqual(DEFAULT_GOAL_CONTINUE_MAX_TURNS * 3);
		});

		it("the cumulative wall-clock ceiling is a multi-hour, not a multi-minute, budget", () => {
			expect(DEFAULT_GOAL_CUMULATIVE_MAX_WALL_CLOCK_MS).toBeGreaterThanOrEqual(60 * 60_000);
		});
	});

	describe("end-to-end loop (real AgentSession)", () => {
		it("cumulative turns/wall-clock persist across two separate continueGoalLoop invocations for one goal", async () => {
			const { session, sessionManager, promptCalls } = createTestSession();

			let state = createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" });
			state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
			appendGoalStateSnapshot(sessionManager, state);

			// The prompt never advances the goal, so each invocation submits exactly one pass and stops
			// with goal_state_not_advanced — mirrors the existing loop test's baseline scenario.
			session.prompt = async (text: string, options?: unknown) => {
				promptCalls.push({ text, options });
			};

			const first = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 5 });
			expect(first.turnsSubmitted).toBe(1);
			expect(first.stopReason).toBe("goal_state_not_advanced");

			const afterFirst = session.getGoalStateSnapshot();
			expect(afterFirst?.continuationTurnsUsed).toBe(1);

			const second = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 5 });
			expect(second.turnsSubmitted).toBe(1);
			expect(second.stopReason).toBe("goal_state_not_advanced");

			const afterSecond = session.getGoalStateSnapshot();
			// Cumulative — the second invocation's pass is ADDED to the first's, not reset.
			expect(afterSecond?.continuationTurnsUsed).toBe(2);
			expect(promptCalls.length).toBe(2);
		});

		it("a goal already at/over the cumulative turn ceiling stops immediately with goal_budget_exhausted", async () => {
			const { session, sessionManager, promptCalls } = createTestSession();

			let state = createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" });
			state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
			state = applyGoalEvent(state, {
				type: "record_continuation_budget",
				turns: DEFAULT_GOAL_CUMULATIVE_MAX_TURNS,
				wallClockMs: 1,
				sessionCostUsd: 0,
				now: "T1",
			});
			appendGoalStateSnapshot(sessionManager, state);

			const result = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 5 });
			expect(result.turnsSubmitted).toBe(0);
			expect(result.stopReason).toBe("goal_budget_exhausted");
			expect(promptCalls.length).toBe(0);
		});

		it("a goal already at/over the cumulative wall-clock ceiling stops immediately with goal_budget_exhausted", async () => {
			const { session, sessionManager, promptCalls } = createTestSession();

			let state = createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" });
			state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
			state = applyGoalEvent(state, {
				type: "record_continuation_budget",
				turns: 1,
				wallClockMs: DEFAULT_GOAL_CUMULATIVE_MAX_WALL_CLOCK_MS,
				sessionCostUsd: 0,
				now: "T1",
			});
			appendGoalStateSnapshot(sessionManager, state);

			const result = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 5 });
			expect(result.turnsSubmitted).toBe(0);
			expect(result.stopReason).toBe("goal_budget_exhausted");
			expect(promptCalls.length).toBe(0);
		});

		it("a fresh goal (clean cumulative counters) is not affected by the budget ceiling", async () => {
			const { session, sessionManager, promptCalls } = createTestSession();

			let state = createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" });
			state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
			appendGoalStateSnapshot(sessionManager, state);

			const result = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 5 });
			expect(result.stopReason).not.toBe("goal_budget_exhausted");
			expect(promptCalls.length).toBe(1);
		});

		it("recordGoalContinuationPass is a no-op when no goal state exists", () => {
			const { session } = createTestSession();
			expect(() => session.recordGoalContinuationPass({ turns: 1, wallClockMs: 10 })).not.toThrow();
			expect(session.getGoalStateSnapshot()).toBeUndefined();
		});
	});
});
