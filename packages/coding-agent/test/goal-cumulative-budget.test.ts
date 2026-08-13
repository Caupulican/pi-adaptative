import { Agent } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
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
		});

		it("record_continuation_budget accumulates turns and wall-clock across repeated events", () => {
			let state = createGoalState({ goalId: "g1", userGoal: "Goal", now: "T0" });
			state = applyGoalEvent(state, {
				type: "record_continuation_budget",
				turns: 1,
				wallClockMs: 1000,
				tokens: 100,
				spendUsd: 0.01,
				now: "T1",
			});
			state = applyGoalEvent(state, {
				type: "record_continuation_budget",
				turns: 1,
				wallClockMs: 2000,
				tokens: 200,
				spendUsd: 0.03,
				now: "T2",
			});
			expect(state.continuationTurnsUsed).toBe(2);
			expect(state.continuationWallClockMs).toBe(3000);
			expect(state.tokensUsed).toBe(300);
			expect(state.continuationSpendUsd).toBeCloseTo(0.04, 10);
		});

		it("counts the first goal-owned provider response", () => {
			let state = createGoalState({ goalId: "g1", userGoal: "Goal", now: "T0" });
			state = applyGoalEvent(state, {
				type: "record_continuation_budget",
				turns: 1,
				wallClockMs: 1000,
				tokens: 250,
				spendUsd: 0.25,
				now: "T1",
			});
			expect(state.continuationSpendUsd).toBe(0.25);
			expect(state.tokensUsed).toBe(250);
		});

		it("sums exact goal-owned response spend without a whole-session checkpoint", () => {
			let state = createGoalState({ goalId: "g1", userGoal: "Goal", now: "T0" });
			state = applyGoalEvent(state, {
				type: "record_continuation_budget",
				turns: 1,
				wallClockMs: 1000,
				tokens: 10,
				spendUsd: 0.1,
				now: "T1",
			});
			state = applyGoalEvent(state, {
				type: "record_continuation_budget",
				turns: 1,
				wallClockMs: 1000,
				tokens: 20,
				spendUsd: 0.25,
				now: "T2",
			});
			state = applyGoalEvent(state, {
				type: "record_continuation_budget",
				turns: 1,
				wallClockMs: 1000,
				tokens: 30,
				spendUsd: 0.15,
				now: "T3",
			});
			expect(state.continuationSpendUsd).toBeCloseTo(0.5, 10);
			expect(state.tokensUsed).toBe(60);
		});

		it("clamps malformed negative pass usage at zero", () => {
			let state = createGoalState({ goalId: "g1", userGoal: "Goal", now: "T0" });
			state = applyGoalEvent(state, {
				type: "record_continuation_budget",
				turns: 1,
				wallClockMs: 1000,
				tokens: -100,
				spendUsd: -5,
				now: "T1",
			});
			expect(state.continuationSpendUsd).toBe(0);
			expect(state.tokensUsed).toBe(0);
		});

		it("does not perturb the goal-loop progress signature inputs (status/requirements/evidence unchanged)", () => {
			let state = createGoalState({ goalId: "g1", userGoal: "Goal", now: "T0" });
			state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1", now: "T0" });
			const before = { status: state.status, requirements: state.requirements, evidence: state.evidence };
			state = applyGoalEvent(state, {
				type: "record_continuation_budget",
				turns: 1,
				wallClockMs: 1000,
				tokens: 10,
				spendUsd: 0.1,
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
				tokens: 20,
				spendUsd: 0.02,
				now: "T1",
			});
			expect(updated.continuationTurnsUsed).toBe(1);
			expect(updated.continuationWallClockMs).toBe(500);
		});
	});

	describe("end-to-end loop (real AgentSession)", () => {
		it("cumulative turns/wall-clock persist across two separate continueGoalLoop invocations for one goal", async () => {
			const { session, sessionManager, promptCalls } = createTestSession();

			let state = createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" });
			state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
			appendGoalStateSnapshot(sessionManager, state);

			// Use an explicit one-turn limit so the two calls remain separate while the compact goal
			// record is intentionally unchanged between them.
			session.prompt = async (text: string, options?: unknown) => {
				promptCalls.push({ text, options });
			};

			const first = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 1 });
			expect(first.turnsSubmitted).toBe(1);
			expect(first.stopReason).toBe("max_turns_reached");

			const afterFirst = session.getGoalStateSnapshot();
			expect(afterFirst?.continuationTurnsUsed).toBe(1);

			const second = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 1 });
			expect(second.turnsSubmitted).toBe(1);
			expect(second.stopReason).toBe("max_turns_reached");

			const afterSecond = session.getGoalStateSnapshot();
			// Cumulative — the second invocation's pass is ADDED to the first's, not reset.
			expect(afterSecond?.continuationTurnsUsed).toBe(2);
			expect(promptCalls.length).toBe(2);
		});

		it("large observed wall-clock and spend remain telemetry when the owner supplied no budget", async () => {
			const { session, sessionManager, promptCalls } = createTestSession();

			let state = createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" });
			state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
			state = applyGoalEvent(state, {
				type: "record_continuation_budget",
				turns: 1,
				wallClockMs: 48 * 60 * 60_000,
				tokens: 0,
				spendUsd: 10_000,
				now: "T1",
			});
			state = { ...state, continuationWorkerSpendUsd: 10_000 };
			appendGoalStateSnapshot(sessionManager, state);

			const result = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 1 });
			expect(result.turnsSubmitted).toBe(1);
			expect(result.stopReason).toBe("max_turns_reached");
			expect(promptCalls.length).toBe(1);
		});

		it("an explicit durable token budget still stops the goal", async () => {
			const { session, sessionManager, promptCalls } = createTestSession();

			let state = createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0", tokenBudget: 100 });
			state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
			state = applyGoalEvent(state, {
				type: "record_continuation_budget",
				turns: 1,
				wallClockMs: 1,
				tokens: 100,
				spendUsd: 0,
				now: "T1",
			});
			appendGoalStateSnapshot(sessionManager, state);

			const result = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 5 });
			expect(result.turnsSubmitted).toBe(0);
			expect(result.stopReason).toBe("goal_budget_exhausted");
			expect(promptCalls.length).toBe(0);
		});

		it("recordGoalContinuationPass is a no-op when no goal state exists", () => {
			const { session } = createTestSession();
			expect(() => session.recordGoalContinuationPass({ turns: 1, wallClockMs: 10 })).not.toThrow();
			expect(session.getGoalStateSnapshot()).toBeUndefined();
		});
	});
});
