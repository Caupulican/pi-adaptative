import { Agent } from "@caupulican/pi-agent-core";
import { getModel } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import {
	appendGoalStateSnapshot,
	GOAL_STATE_CUSTOM_TYPE,
	getLatestGoalStateSnapshot,
} from "../src/core/goals/session-goal-state.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
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

		const latest = getLatestGoalStateSnapshot(sessionManager.getEntries());
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

		sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, { version: 1, state: { invalid: true } }); // Invalid state

		const latest = getLatestGoalStateSnapshot(sessionManager.getEntries());
		expect(latest).toBeDefined();
		expect(latest?.goalId).toBe("g1");
	});

	it("invalid/non-plain goal payload is ignored while an older valid state remains", () => {
		const sessionManager = SessionManager.inMemory();

		const validState = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		appendGoalStateSnapshot(sessionManager, validState);

		const newerValidState = createGoalState({ goalId: "g2", userGoal: "Ignore me", now: "T1" });
		const payload = Object.assign(new Date(0), { version: 1, state: newerValidState });
		sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, payload);

		const latest = getLatestGoalStateSnapshot(sessionManager.getEntries());
		expect(latest?.goalId).toBe("g1");
	});

	it("non-finite stallTurns is ignored while an older valid state remains", () => {
		const sessionManager = SessionManager.inMemory();

		const validState = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });
		appendGoalStateSnapshot(sessionManager, validState);

		const newerValidState1 = createGoalState({ goalId: "g2", userGoal: "Ignore me", now: "T1" });
		newerValidState1.stallTurns = Number.NaN;
		sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, { version: 1, state: newerValidState1 });

		const newerValidState2 = createGoalState({ goalId: "g3", userGoal: "Ignore me", now: "T2" });
		newerValidState2.stallTurns = Infinity;
		sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, { version: 1, state: newerValidState2 });

		const latest = getLatestGoalStateSnapshot(sessionManager.getEntries());
		expect(latest?.goalId).toBe("g1");
	});

	it("snapshots do not retain caller-owned nested array references", () => {
		const sessionManager = SessionManager.inMemory();
		let state = createGoalState({ goalId: "g1", userGoal: "Fix bugs", now: "T0" });

		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Fix typo", now: "T0" });

		const evidenceIds = ["ev-1"];
		state = applyGoalEvent(state, { type: "satisfy_requirement", id: "req-1", evidenceIds, now: "T1" });

		appendGoalStateSnapshot(sessionManager, state);

		evidenceIds.push("ev-2");

		const latest = getLatestGoalStateSnapshot(sessionManager.getEntries());
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
});
