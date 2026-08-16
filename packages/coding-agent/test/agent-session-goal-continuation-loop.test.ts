import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { BackgroundLaneController } from "../src/core/background-lane-controller.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestManagedLaneDispatch } from "./managed-lane-fixture.ts";
import { createTestResourceLoader } from "./utilities.ts";

const testAgentDirs: string[] = [];

afterEach(() => {
	while (testAgentDirs.length > 0) {
		const agentDir = testAgentDirs.pop();
		if (agentDir) rmSync(agentDir, { recursive: true, force: true });
	}
});

describe("Phase 10E: AgentSession Goal Continuation Loop", () => {
	function createTestSession() {
		const agentDir = mkdtempSync(join(realpathSync.native(tmpdir()), "pi-goal-continuation-"));
		testAgentDirs.push(agentDir);
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
			agentDir,
			modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
		});

		const promptCalls: { text: string; options: unknown }[] = [];
		session.prompt = async (text: string, options?: unknown) => {
			promptCalls.push({ text, options });
		};

		return { sessionManager, session, promptCalls };
	}

	it("maxTurns 0 is unbounded and stops only when the goal reaches a terminal state", async () => {
		const { session, sessionManager, promptCalls } = createTestSession();
		const state = createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);
		session.prompt = async (text: string, options?: unknown) => {
			promptCalls.push({ text, options });
			appendGoalStateSnapshot(sessionManager, applyGoalEvent(state, { type: "complete_goal", now: "T1" }));
		};

		const result = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 0 });
		expect(result.turnsSubmitted).toBe(1);
		expect(result.stopReason).toBe("continuation_not_allowed");
		expect(promptCalls.length).toBe(1);
	});

	it("rejects negative or unsafe explicit turn limits", async () => {
		const { session } = createTestSession();
		await expect(session.continueGoalLoop({ maxStallTurns: 3, maxTurns: -1 })).rejects.toThrow(
			/non-negative safe integer/,
		);
		await expect(
			session.continueGoalLoop({ maxStallTurns: 3, maxTurns: Number.MAX_SAFE_INTEGER + 1 }),
		).rejects.toThrow(/non-negative safe integer/);
	});

	it("missing/non-continue goal returns continuation_not_allowed and does not call prompt", async () => {
		const { session, promptCalls } = createTestSession();
		const result = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 5 });
		expect(result.turnsSubmitted).toBe(0);
		expect(result.stopReason).toBe("continuation_not_allowed");
		expect(promptCalls.length).toBe(0);
	});

	it("counts unchanged continuation passes as stalls without relying on the model to report no_progress", async () => {
		const { session, sessionManager, promptCalls } = createTestSession();

		let state = createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);

		const result = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 5 });
		expect(result.turnsSubmitted).toBe(3);
		expect(result.stopReason).toBe("continuation_not_allowed");
		expect(result.finalSnapshot.goalState?.stallTurns).toBe(3);
		expect(result.finalSnapshot.continuation.reasonCode).toBe("stall_limit_reached");
		expect(promptCalls.length).toBe(3);
	});

	it("prompt that appends a completed goal snapshot submits once, then stops with continuation_not_allowed", async () => {
		const { session, sessionManager, promptCalls } = createTestSession();

		let state = createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);

		session.prompt = async (text: string, options?: unknown) => {
			promptCalls.push({ text, options });
			// Simulate the LLM turn proving the requirement and finishing the goal.
			let nextState = applyGoalEvent(state, {
				type: "add_evidence",
				id: "evidence-1",
				kind: "user",
				summary: "Owner-accepted proof",
				now: "T1",
			});
			nextState = applyGoalEvent(nextState, {
				type: "satisfy_requirement",
				id: "req-1",
				evidenceIds: ["evidence-1"],
				now: "T1",
			});
			nextState = applyGoalEvent(nextState, { type: "complete_goal", now: "T1" });
			appendGoalStateSnapshot(sessionManager, nextState);
		};

		const result = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 5 });
		expect(result.turnsSubmitted).toBe(1);
		expect(result.stopReason).toBe("continuation_not_allowed");
		expect(result.finalSnapshot.continuation.action).toBe("finalize");
		expect(promptCalls.length).toBe(1);
	});

	it("prompt that appends a progress snapshot with a requirement still open can run multiple turns until maxTurns is reached", async () => {
		const { session, sessionManager, promptCalls } = createTestSession();

		// Four open requirements so satisfying up to 3 of them (one per turn) still leaves one open,
		// keeping the continuation decision "continue" through every turn.
		let state = createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" });
		for (let i = 1; i <= 4; i++) {
			state = applyGoalEvent(state, { type: "add_requirement", id: `req-${i}`, text: `Req ${i} text`, now: "T0" });
		}
		appendGoalStateSnapshot(sessionManager, state);

		let callCount = 0;
		session.prompt = async (text: string, options?: unknown) => {
			promptCalls.push({ text, options });
			callCount++;
			// Simulate the LLM making genuine progress each turn while the explicit limit remains the
			// only per-invocation turn ceiling.
			state = applyGoalEvent(state, {
				type: "satisfy_requirement",
				id: `req-${callCount}`,
				evidenceIds: [],
				now: `T${callCount}`,
			});
			appendGoalStateSnapshot(sessionManager, state);
		};

		const result = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 3 });
		expect(result.turnsSubmitted).toBe(3);
		expect(result.stopReason).toBe("max_turns_reached");
		expect(promptCalls.length).toBe(3);
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

		// Four open requirements so satisfying up to 3 of them (one per turn) still leaves one open,
		// keeping the continuation decision "continue" through every turn.
		let state = createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" });
		for (let i = 1; i <= 4; i++) {
			state = applyGoalEvent(state, { type: "add_requirement", id: `req-${i}`, text: `Req ${i} text`, now: "T0" });
		}
		appendGoalStateSnapshot(sessionManager, state);

		let callCount = 0;
		let mockNow = 100000000;
		session.prompt = async (text: string, options?: unknown) => {
			promptCalls.push({ text, options });
			callCount++;
			mockNow += 100 * 60_000; // +100 minutes
			// Simulate genuine per-turn progress while the explicit limit remains authoritative.
			state = applyGoalEvent(state, {
				type: "satisfy_requirement",
				id: `req-${callCount}`,
				evidenceIds: [],
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

	describe("the 'waiting' continuation state, wired through the real production seam", () => {
		it("waits while a bound worker runs and resumes once it terminates", async () => {
			const { session, sessionManager, promptCalls } = createTestSession();

			// Reach the SAME BackgroundLaneController instance agent-session.ts wires into
			// `getGoalRuntimeSnapshot` (the one new seam this fix adds) -- proves the production wiring,
			// not just the isolated goal-continuation-controller/goal-runtime-snapshot units.
			const backgroundLanes = (session as unknown as { _backgroundLanes: BackgroundLaneController })
				._backgroundLanes;

			backgroundLanes.recordManagedLane({
				laneId: "tmux-job-e2e",
				phase: "dispatch",
				goalId: "g1",
				dispatch: createTestManagedLaneDispatch(),
			});
			const dispatchedLaneId = backgroundLanes.getLaneRecords()[0]?.laneId as string;
			expect(dispatchedLaneId).toBeDefined();

			let state = createGoalState({ goalId: "g1", userGoal: "User Goal Here", now: "T0" });
			state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
			state = applyGoalEvent(state, {
				type: "dispatch_worker",
				id: "req-1",
				instructions: "do the thing",
				laneId: dispatchedLaneId,
				now: "T1",
			});
			appendGoalStateSnapshot(sessionManager, state);

			// While the worker is in flight, the loop must pause with the benign worker_in_flight
			// stopReason and must submit zero passes.
			const whileRunning = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 5 });
			expect(whileRunning.turnsSubmitted).toBe(0);
			expect(whileRunning.stopReason).toBe("worker_in_flight");
			expect(whileRunning.finalSnapshot.continuation.action).toBe("waiting");
			expect(promptCalls.length).toBe(0);

			// The worker terminates; the goal resumes on its own on the next invocation.
			backgroundLanes.recordManagedLane({ laneId: "tmux-job-e2e", phase: "terminal", status: "succeeded" });

			const afterResume = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 1 });
			expect(afterResume.turnsSubmitted).toBe(1);
			expect(afterResume.stopReason).toBe("max_turns_reached");
			expect(promptCalls.length).toBe(1);
		});
	});
});
