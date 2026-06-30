import { Agent } from "@caupulican/pi-agent-core";
import { getModel } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { appendWorkerResultSnapshot } from "../src/core/delegation/session-worker-result.ts";
import { buildGoalRuntimeSnapshot } from "../src/core/goals/goal-runtime-snapshot.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { appendLearningDecisionSnapshot } from "../src/core/learning/session-learning-decision.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createEvidenceBundle } from "../src/core/research/evidence-bundle.ts";
import { appendEvidenceBundleSnapshot } from "../src/core/research/session-evidence-bundle.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("Phase 10B: Goal Runtime Snapshot", () => {
	it("empty entries produce missing-goal continuation ask-user and empty arrays", () => {
		const sessionManager = SessionManager.inMemory();
		const snapshot = buildGoalRuntimeSnapshot({
			entries: sessionManager.getEntries(),
			settings: { maxStallTurns: 3 },
		});

		expect(snapshot.goalState).toBeUndefined();
		expect(snapshot.latestEvidenceBundle).toBeUndefined();
		expect(snapshot.workerResults).toEqual([]);
		expect(snapshot.learningDecisions).toEqual([]);
		expect(snapshot.continuation.action).toBe("ask-user");
		expect(snapshot.continuation.reasonCode).toBe("missing_goal_state");
	});

	it("aggregate includes latest goal state and latest evidence bundle", () => {
		const sessionManager = SessionManager.inMemory();

		appendGoalStateSnapshot(sessionManager, createGoalState({ goalId: "g1", userGoal: "Old", now: "T0" }));
		appendGoalStateSnapshot(sessionManager, createGoalState({ goalId: "g2", userGoal: "New", now: "T1" }));

		appendEvidenceBundleSnapshot(
			sessionManager,
			createEvidenceBundle({ query: "Old", sources: [], findings: [], now: "T0" }),
		);
		appendEvidenceBundleSnapshot(
			sessionManager,
			createEvidenceBundle({ query: "New", sources: [], findings: [], now: "T1" }),
		);

		const snapshot = buildGoalRuntimeSnapshot({
			entries: sessionManager.getEntries(),
			settings: { maxStallTurns: 3 },
		});

		expect(snapshot.goalState?.userGoal).toBe("New");
		expect(snapshot.latestEvidenceBundle?.query).toBe("New");
	});

	it("aggregate includes all worker results and learning decisions in chronological order", () => {
		const sessionManager = SessionManager.inMemory();

		appendWorkerResultSnapshot(sessionManager, {
			requestId: "w1",
			status: "completed",
			summary: "W1",
			changedFiles: [],
		});
		appendLearningDecisionSnapshot(sessionManager, {
			kind: "apply",
			reasonCode: "l1",
			confidence: 90,
			summary: "L1",
			requiresApproval: false,
		});
		appendWorkerResultSnapshot(sessionManager, {
			requestId: "w2",
			status: "completed",
			summary: "W2",
			changedFiles: [],
		});
		appendLearningDecisionSnapshot(sessionManager, {
			kind: "proposal",
			reasonCode: "l2",
			confidence: 90,
			summary: "L2",
			requiresApproval: true,
		});

		const snapshot = buildGoalRuntimeSnapshot({
			entries: sessionManager.getEntries(),
			settings: { maxStallTurns: 3 },
		});

		expect(snapshot.workerResults.length).toBe(2);
		expect(snapshot.workerResults[0].requestId).toBe("w1");
		expect(snapshot.workerResults[1].requestId).toBe("w2");

		expect(snapshot.learningDecisions.length).toBe(2);
		expect(snapshot.learningDecisions[0].reasonCode).toBe("l1");
		expect(snapshot.learningDecisions[1].reasonCode).toBe("l2");
	});

	it("continuation finalizes when latest goal has no open requirements", () => {
		const sessionManager = SessionManager.inMemory();
		const state = createGoalState({ goalId: "g1", userGoal: "Done", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);

		const snapshot = buildGoalRuntimeSnapshot({
			entries: sessionManager.getEntries(),
			settings: { maxStallTurns: 3 },
		});

		expect(snapshot.continuation.action).toBe("finalize");
		expect(snapshot.continuation.reasonCode).toBe("no_open_requirements");
	});

	it("continuation continues when latest goal has an open requirement", () => {
		const sessionManager = SessionManager.inMemory();
		let state = createGoalState({ goalId: "g1", userGoal: "Task", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req1", text: "Req", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);

		const snapshot = buildGoalRuntimeSnapshot({
			entries: sessionManager.getEntries(),
			settings: { maxStallTurns: 3 },
		});

		expect(snapshot.continuation.action).toBe("continue");
		expect(snapshot.continuation.reasonCode).toBe("goal_active");
	});

	it("invalid/malformed newer snapshot entries are ignored through existing loaders", () => {
		const sessionManager = SessionManager.inMemory();

		appendGoalStateSnapshot(sessionManager, createGoalState({ goalId: "valid-goal", userGoal: "Task", now: "T0" }));
		sessionManager.appendCustomEntry("goal_state", { version: 1, state: { invalid: true } });

		appendEvidenceBundleSnapshot(
			sessionManager,
			createEvidenceBundle({ query: "valid-evidence", sources: [], findings: [], now: "T0" }),
		);
		sessionManager.appendCustomEntry("evidence_bundle", { version: 1, bundle: { invalid: true } });

		appendWorkerResultSnapshot(sessionManager, {
			requestId: "valid-worker",
			status: "completed",
			summary: "Task",
			changedFiles: [],
		});
		sessionManager.appendCustomEntry("worker_result", { version: 1, result: { invalid: true } });

		appendLearningDecisionSnapshot(sessionManager, {
			kind: "apply",
			reasonCode: "valid-learning",
			confidence: 90,
			summary: "L",
			requiresApproval: false,
		});
		sessionManager.appendCustomEntry("learning_decision", { version: 1, decision: { invalid: true } });

		const snapshot = buildGoalRuntimeSnapshot({
			entries: sessionManager.getEntries(),
			settings: { maxStallTurns: 3 },
		});

		expect(snapshot.goalState?.goalId).toBe("valid-goal");
		expect(snapshot.latestEvidenceBundle?.query).toBe("valid-evidence");
		expect(snapshot.workerResults.length).toBe(1);
		expect(snapshot.workerResults[0].requestId).toBe("valid-worker");
		expect(snapshot.learningDecisions.length).toBe(1);
		expect(snapshot.learningDecisions[0].reasonCode).toBe("valid-learning");
	});

	it("returned snapshot values are insulated", () => {
		const sessionManager = SessionManager.inMemory();

		appendGoalStateSnapshot(sessionManager, createGoalState({ goalId: "g1", userGoal: "Task", now: "T0" }));
		appendEvidenceBundleSnapshot(
			sessionManager,
			createEvidenceBundle({ query: "q", sources: [], findings: [], now: "T0" }),
		);
		appendWorkerResultSnapshot(sessionManager, {
			requestId: "w1",
			status: "completed",
			summary: "W1",
			changedFiles: [],
		});
		appendLearningDecisionSnapshot(sessionManager, {
			kind: "apply",
			reasonCode: "l1",
			confidence: 90,
			summary: "L1",
			requiresApproval: false,
		});

		const snapshot1 = buildGoalRuntimeSnapshot({
			entries: sessionManager.getEntries(),
			settings: { maxStallTurns: 3 },
		});

		// Mutate everything returned
		if (snapshot1.goalState) snapshot1.goalState.userGoal = "Mutated";
		if (snapshot1.latestEvidenceBundle) snapshot1.latestEvidenceBundle.query = "Mutated";
		snapshot1.workerResults[0].summary = "Mutated";
		snapshot1.learningDecisions[0].summary = "Mutated";

		const snapshot2 = buildGoalRuntimeSnapshot({
			entries: sessionManager.getEntries(),
			settings: { maxStallTurns: 3 },
		});

		expect(snapshot2.goalState?.userGoal).toBe("Task");
		expect(snapshot2.latestEvidenceBundle?.query).toBe("q");
		expect(snapshot2.workerResults[0].summary).toBe("W1");
		expect(snapshot2.learningDecisions[0].summary).toBe("L1");
	});

	it("AgentSession getGoalRuntimeSnapshot returns aggregate using in-memory SessionManager", () => {
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

		appendGoalStateSnapshot(sessionManager, createGoalState({ goalId: "g1", userGoal: "Agent Test", now: "T0" }));

		const snapshot = session.getGoalRuntimeSnapshot({ maxStallTurns: 5 });
		expect(snapshot.goalState?.userGoal).toBe("Agent Test");
		expect(snapshot.continuation.maxStallTurns).toBe(5);
	});
});
