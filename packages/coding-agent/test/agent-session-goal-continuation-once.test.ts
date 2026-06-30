import { Agent } from "@caupulican/pi-agent-core";
import { getModel } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("Phase 10D: AgentSession Goal Continuation Once", () => {
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
		// Override prompt to avoid LLM calls
		session.prompt = async (text: string, options?: unknown) => {
			promptCalls.push({ text, options });
		};

		return { sessionManager, session, promptCalls };
	}

	it("missing goal state returns submitted false and does not call prompt", async () => {
		const { session, promptCalls } = createTestSession();

		const result = await session.continueGoalOnce({ maxStallTurns: 3 });
		expect(result.submitted).toBe(false);
		expect(result.snapshot.continuation.action).toBe("ask-user");
		expect(promptCalls.length).toBe(0);
	});

	it("completed, blocked, and cancelled decisions do not call prompt", async () => {
		const completed = createTestSession();
		let completedState = createGoalState({ goalId: "g1", userGoal: "Test", now: "T0" });
		completedState = applyGoalEvent(completedState, { type: "complete_goal", now: "T1" });
		appendGoalStateSnapshot(completed.sessionManager, completedState);

		const completedResult = await completed.session.continueGoalOnce({ maxStallTurns: 3 });
		expect(completedResult.submitted).toBe(false);
		expect(completedResult.snapshot.continuation.action).toBe("finalize");
		expect(completed.promptCalls.length).toBe(0);

		const blocked = createTestSession();
		const blockedState = applyGoalEvent(createGoalState({ goalId: "g2", userGoal: "Test", now: "T0" }), {
			type: "block_goal",
			reason: "stuck",
			now: "T1",
		});
		appendGoalStateSnapshot(blocked.sessionManager, blockedState);

		const blockedResult = await blocked.session.continueGoalOnce({ maxStallTurns: 3 });
		expect(blockedResult.submitted).toBe(false);
		expect(blockedResult.snapshot.continuation.action).toBe("ask-user");
		expect(blocked.promptCalls.length).toBe(0);

		const cancelled = createTestSession();
		const cancelledState = applyGoalEvent(createGoalState({ goalId: "g3", userGoal: "Test", now: "T0" }), {
			type: "cancel_goal",
			now: "T1",
		});
		appendGoalStateSnapshot(cancelled.sessionManager, cancelledState);

		const cancelledResult = await cancelled.session.continueGoalOnce({ maxStallTurns: 3 });
		expect(cancelledResult.submitted).toBe(false);
		expect(cancelledResult.snapshot.continuation.action).toBe("stop");
		expect(cancelled.promptCalls.length).toBe(0);
	});

	it("active goal with open requirement calls prompt exactly once", async () => {
		const { session, sessionManager, promptCalls } = createTestSession();

		let state = createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);

		const result = await session.continueGoalOnce({ maxStallTurns: 3 });
		expect(result.submitted).toBe(true);
		expect(result.snapshot.continuation.action).toBe("continue");
		expect(result.prompt).toBeDefined();

		expect(promptCalls.length).toBe(1);
		const call = promptCalls[0];
		expect(call.text).toContain("Goal continuation context");
		expect(call.text).toContain("g1");
		expect(call.text).toContain("Req 1 text");

		expect(call.options).toEqual({
			expandPromptTemplates: false,
			processSlashCommands: false,
			autoContinueGoal: false,
		});
	});

	it("promptLimits are honored", async () => {
		const { session, sessionManager, promptCalls } = createTestSession();

		let state = createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);

		const result = await session.continueGoalOnce({
			maxStallTurns: 3,
			promptLimits: { maxTextLength: 100 },
		});

		expect(result.submitted).toBe(true);
		expect(result.prompt?.truncated).toBe(true);

		expect(promptCalls.length).toBe(1);
		expect(promptCalls[0].text.length).toBe(100);
	});
});
