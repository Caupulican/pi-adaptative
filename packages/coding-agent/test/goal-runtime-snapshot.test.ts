import { Agent } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import { appendWorkerResultSnapshot } from "../src/core/delegation/session-worker-result.ts";
import { DEFAULT_GOAL_WORKER_WAIT_MS } from "../src/core/goals/goal-continuation-defaults.ts";
import { buildGoalRuntimeSnapshot } from "../src/core/goals/goal-runtime-snapshot.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { appendLearningDecisionSnapshot } from "../src/core/learning/session-learning-decision.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createEvidenceBundle } from "../src/core/research/evidence-bundle.ts";
import { appendEvidenceBundleSnapshot } from "../src/core/research/session-evidence-bundle.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("Phase 10B: Goal Runtime Snapshot", () => {
	it("empty entries produce missing-goal continuation ask-user and empty arrays", () => {
		const sessionManager = SessionManager.inMemory();
		const snapshot = buildGoalRuntimeSnapshot({
			sessionManager,
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
			sessionManager,
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
			sessionManager,
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
			sessionManager,
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
			sessionManager,
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
			sessionManager,
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
			sessionManager,
			settings: { maxStallTurns: 3 },
		});

		// Mutate everything returned
		if (snapshot1.goalState) snapshot1.goalState.userGoal = "Mutated";
		if (snapshot1.latestEvidenceBundle) snapshot1.latestEvidenceBundle.query = "Mutated";
		snapshot1.workerResults[0].summary = "Mutated";
		snapshot1.learningDecisions[0].summary = "Mutated";

		const snapshot2 = buildGoalRuntimeSnapshot({
			sessionManager,
			settings: { maxStallTurns: 3 },
		});

		expect(snapshot2.goalState?.userGoal).toBe("Task");
		expect(snapshot2.latestEvidenceBundle?.query).toBe("q");
		expect(snapshot2.workerResults[0].summary).toBe("W1");
		expect(snapshot2.learningDecisions[0].summary).toBe("L1");
	});

	describe("never-hang wait-timeout wired through buildGoalRuntimeSnapshot", () => {
		function seedBoundInFlight(sessionManager: SessionManager, boundAt: string) {
			let state = createGoalState({ goalId: "g1", userGoal: "Task", now: "T0" });
			state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req", now: "T0" });
			state = applyGoalEvent(state, {
				type: "dispatch_worker",
				id: "req-1",
				instructions: "do it",
				laneId: "lane-1",
				now: boundAt,
			});
			appendGoalStateSnapshot(sessionManager, state);
			const laneRecords: LaneRecord[] = [{ laneId: "lane-1", type: "worker", status: "running", goalId: "g1" }];
			return laneRecords;
		}

		it("an injected 'now' within the injected maxWorkerWaitMs of boundAt stays 'waiting'", () => {
			const sessionManager = SessionManager.inMemory();
			const laneRecords = seedBoundInFlight(sessionManager, "2026-01-01T00:00:00.000Z");

			const snapshot = buildGoalRuntimeSnapshot({
				sessionManager,
				settings: { maxStallTurns: 3 },
				laneRecords,
				now: () => "2026-01-01T00:30:00.000Z",
				maxWorkerWaitMs: 60 * 60_000,
			});

			expect(snapshot.continuation.action).toBe("waiting");
			expect(snapshot.continuation.reasonCode).toBe("worker_in_flight");
		});

		it("an injected 'now' past boundAt + maxWorkerWaitMs escalates to action:'ask-user'/reasonCode:'worker_wait_timeout'", () => {
			const sessionManager = SessionManager.inMemory();
			const laneRecords = seedBoundInFlight(sessionManager, "2026-01-01T00:00:00.000Z");

			const snapshot = buildGoalRuntimeSnapshot({
				sessionManager,
				settings: { maxStallTurns: 3 },
				laneRecords,
				now: () => "2026-01-01T02:00:00.000Z",
				maxWorkerWaitMs: 60 * 60_000,
			});

			expect(snapshot.continuation.action).toBe("ask-user");
			expect(snapshot.continuation.reasonCode).toBe("worker_wait_timeout");
		});

		it("with now/maxWorkerWaitMs omitted, a freshly bound worker waits under the real default (DEFAULT_GOAL_WORKER_WAIT_MS)", () => {
			const sessionManager = SessionManager.inMemory();
			const laneRecords = seedBoundInFlight(sessionManager, new Date().toISOString());

			const snapshot = buildGoalRuntimeSnapshot({
				sessionManager,
				settings: { maxStallTurns: 3 },
				laneRecords,
			});

			expect(snapshot.continuation.action).toBe("waiting");
			expect(snapshot.continuation.reasonCode).toBe("worker_in_flight");
			expect(DEFAULT_GOAL_WORKER_WAIT_MS).toBeGreaterThan(0);
		});

		it("with now/maxWorkerWaitMs omitted, a worker bound well past the real default has already escalated", () => {
			const sessionManager = SessionManager.inMemory();
			const staleBoundAt = new Date(Date.now() - DEFAULT_GOAL_WORKER_WAIT_MS - 60_000).toISOString();
			const laneRecords = seedBoundInFlight(sessionManager, staleBoundAt);

			const snapshot = buildGoalRuntimeSnapshot({
				sessionManager,
				settings: { maxStallTurns: 3 },
				laneRecords,
			});

			expect(snapshot.continuation.action).toBe("ask-user");
			expect(snapshot.continuation.reasonCode).toBe("worker_wait_timeout");
		});
	});

	describe("worktree-sync lane status wired through buildGoalRuntimeSnapshot", () => {
		function seedBoundRequirement(sessionManager: SessionManager, laneId: string) {
			let state = createGoalState({ goalId: "g1", userGoal: "Task", now: "T0" });
			state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req", now: "T0" });
			state = applyGoalEvent(state, {
				type: "dispatch_worker",
				id: "req-1",
				instructions: "do it",
				laneId,
				now: "T1",
			});
			appendGoalStateSnapshot(sessionManager, state);
		}

		it("omitted worktreeLaneStatus: requirementWorktreeStates is undefined and continuation is unaffected", () => {
			const sessionManager = SessionManager.inMemory();
			seedBoundRequirement(sessionManager, "lane-1");

			const snapshot = buildGoalRuntimeSnapshot({
				sessionManager,
				settings: { maxStallTurns: 3 },
			});

			expect(snapshot.requirementWorktreeStates).toBeUndefined();
			expect(snapshot.continuation.action).toBe("continue");
			expect(snapshot.continuation.reasonCode).toBe("goal_active");
		});

		it("a syncRequired lane status entry surfaces requirementWorktreeStates and drives reasonCode lane_sync_required", () => {
			const sessionManager = SessionManager.inMemory();
			seedBoundRequirement(sessionManager, "lane-1");

			const snapshot = buildGoalRuntimeSnapshot({
				sessionManager,
				settings: { maxStallTurns: 3 },
				worktreeLaneStatus: [
					{
						laneKey: "g1-1",
						boundLaneId: "lane-1",
						fresh: false,
						stale: true,
						syncRequired: true,
						rebaseInProgress: false,
					},
				],
			});

			expect(snapshot.requirementWorktreeStates).toEqual([
				{
					requirementId: "req-1",
					laneKey: "g1-1",
					fresh: false,
					stale: true,
					syncRequired: true,
					rebaseInProgress: false,
				},
			]);
			expect(snapshot.continuation.action).toBe("continue");
			expect(snapshot.continuation.reasonCode).toBe("lane_sync_required");
		});

		it("a rebaseInProgress lane status entry drives reasonCode lane_sync_conflict (takes precedence over sync_required)", () => {
			const sessionManager = SessionManager.inMemory();
			seedBoundRequirement(sessionManager, "lane-1");

			const snapshot = buildGoalRuntimeSnapshot({
				sessionManager,
				settings: { maxStallTurns: 3 },
				worktreeLaneStatus: [
					{
						laneKey: "g1-1",
						boundLaneId: "lane-1",
						fresh: false,
						stale: true,
						syncRequired: true,
						rebaseInProgress: true,
					},
				],
			});

			expect(snapshot.continuation.action).toBe("continue");
			expect(snapshot.continuation.reasonCode).toBe("lane_sync_conflict");
		});

		it("a worktreeLaneStatus entry whose boundLaneId matches nothing leaves requirementWorktreeStates empty and does not affect continuation", () => {
			const sessionManager = SessionManager.inMemory();
			seedBoundRequirement(sessionManager, "lane-1");

			const snapshot = buildGoalRuntimeSnapshot({
				sessionManager,
				settings: { maxStallTurns: 3 },
				worktreeLaneStatus: [
					{
						laneKey: "other-1",
						boundLaneId: "some-other-lane",
						fresh: true,
						stale: false,
						syncRequired: false,
						rebaseInProgress: false,
					},
				],
			});

			expect(snapshot.requirementWorktreeStates).toEqual([]);
			expect(snapshot.continuation.action).toBe("continue");
			expect(snapshot.continuation.reasonCode).toBe("goal_active");
		});
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
