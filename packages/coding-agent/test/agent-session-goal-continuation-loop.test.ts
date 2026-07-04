import { Agent } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("Phase 10E: AgentSession Goal Continuation Loop", () => {
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

	it("maxTurns <= 0 does not call prompt and returns max_turns_reached", async () => {
		const { session, promptCalls } = createTestSession();
		const result = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 0 });
		expect(result.turnsSubmitted).toBe(0);
		expect(result.stopReason).toBe("max_turns_reached");
		expect(promptCalls.length).toBe(0);
	});

	it("missing/non-continue goal returns continuation_not_allowed and does not call prompt", async () => {
		const { session, promptCalls } = createTestSession();
		const result = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 5 });
		expect(result.turnsSubmitted).toBe(0);
		expect(result.stopReason).toBe("continuation_not_allowed");
		expect(promptCalls.length).toBe(0);
	});

	it("open goal with prompt that does not save an updated goal state submits once then stops with goal_state_not_advanced", async () => {
		const { session, sessionManager, promptCalls } = createTestSession();

		let state = createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);

		const result = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 5 });
		expect(result.turnsSubmitted).toBe(1);
		expect(result.stopReason).toBe("goal_state_not_advanced");
		expect(promptCalls.length).toBe(1);
	});

	it("prompt that appends a completed goal snapshot submits once, then stops with continuation_not_allowed", async () => {
		const { session, sessionManager, promptCalls } = createTestSession();

		let state = createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);

		session.prompt = async (text: string, options?: unknown) => {
			promptCalls.push({ text, options });
			// Simulate the LLM turn finishing the goal
			const nextState = applyGoalEvent(state, {
				type: "satisfy_requirement",
				id: "req-1",
				evidenceIds: [],
				now: "T1",
			});
			appendGoalStateSnapshot(sessionManager, nextState);
		};

		const result = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 5 });
		expect(result.turnsSubmitted).toBe(1);
		expect(result.stopReason).toBe("continuation_not_allowed");
		expect(result.finalSnapshot.continuation.action).toBe("finalize");
		expect(promptCalls.length).toBe(1);
	});

	it("prompt that appends a progress snapshot with the requirement still open can run multiple turns until maxTurns is reached", async () => {
		const { session, sessionManager, promptCalls } = createTestSession();

		let state = createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);

		let callCount = 0;
		session.prompt = async (text: string, options?: unknown) => {
			promptCalls.push({ text, options });
			callCount++;
			// Simulate LLM doing work but leaving requirement open (e.g. adding a new requirement)
			state = applyGoalEvent(state, {
				type: "add_requirement",
				id: `req-new-${callCount}`,
				text: `Req new ${callCount}`,
				now: `T${callCount}`,
			});
			appendGoalStateSnapshot(sessionManager, state);
		};

		const result = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 3 });
		expect(result.turnsSubmitted).toBe(3);
		expect(result.stopReason).toBe("max_turns_reached");
		expect(promptCalls.length).toBe(3);
	});

	it("loop uses promptLimits by passing them through to continueGoalOnce", async () => {
		const { session, sessionManager, promptCalls } = createTestSession();

		let state = createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);

		const result = await session.continueGoalLoop({
			maxStallTurns: 3,
			maxTurns: 1,
			promptLimits: { maxTextLength: 100 },
		});

		expect(result.turnsSubmitted).toBe(1);
		expect(promptCalls.length).toBe(1);
		// Text should be truncated to length 100
		expect(promptCalls[0].text.length).toBe(100);
	});

	it("stops with wall_clock_budget_reached if time is exceeded during loop", async () => {
		const { session, sessionManager, promptCalls } = createTestSession();

		let state = createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);

		let callCount = 0;
		let mockNow = 100000000;
		session.prompt = async (text: string, options?: unknown) => {
			promptCalls.push({ text, options });
			callCount++;
			// Advance time by 60 minutes
			mockNow += 60 * 60_000;
			state = applyGoalEvent(state, {
				type: "add_requirement",
				id: `req-new-${callCount}`,
				text: `Req new ${callCount}`,
				now: `T${callCount}`,
			});
			appendGoalStateSnapshot(sessionManager, state);
		};

		const result = await session.continueGoalLoop({
			maxStallTurns: 3,
			maxTurns: 5,
			maxWallClockMinutes: 30, // 30 minutes
			now: () => mockNow,
		});

		// It should submit the first turn, but after returning, mockNow is +60 minutes which exceeds 30.
		// So it should return wall_clock_budget_reached and not submit a second turn.
		expect(result.turnsSubmitted).toBe(1);
		expect(result.stopReason).toBe("wall_clock_budget_reached");
		expect(promptCalls.length).toBe(1);
	});

	it("treats 0 as disabled for maxWallClockMinutes budget", async () => {
		const { session, sessionManager, promptCalls } = createTestSession();

		let state = createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);

		let callCount = 0;
		let mockNow = 100000000;
		session.prompt = async (text: string, options?: unknown) => {
			promptCalls.push({ text, options });
			callCount++;
			mockNow += 100 * 60_000; // +100 minutes
			state = applyGoalEvent(state, {
				type: "add_requirement",
				id: `req-new-${callCount}`,
				text: `Req new ${callCount}`,
				now: `T${callCount}`,
			});
			appendGoalStateSnapshot(sessionManager, state);
		};

		const result = await session.continueGoalLoop({
			maxStallTurns: 3,
			maxTurns: 3,
			maxWallClockMinutes: 0,
			now: () => mockNow,
		});

		expect(result.turnsSubmitted).toBe(3);
		expect(result.stopReason).toBe("max_turns_reached");
		expect(promptCalls.length).toBe(3);
	});
});
