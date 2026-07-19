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

/**
 * The goal-loop stall signature must key on MEANINGFUL progress (satisfied requirements +
 * ref-backed evidence), not raw event count/updatedAt/stallTurns. These tests exercise that
 * directly: hollow goal-tool churn must stop the loop with `goal_state_not_advanced`, while a
 * satisfied requirement or ref-backed evidence must keep it going.
 */
describe("goal-loop-controller: meaningful progress signature", () => {
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

	it("hollow add_requirement/reopen_requirement churn that satisfies nothing stops with goal_state_not_advanced", async () => {
		const { session, sessionManager, promptCalls } = createTestSession();

		let state = createGoalState({ goalId: "g-hollow", userGoal: "User Goal Here", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);

		let callCount = 0;
		session.prompt = async (text: string, options?: unknown) => {
			promptCalls.push({ text, options });
			callCount++;
			// Hollow churn: reopen the (already open) requirement and add a fresh never-satisfied
			// requirement. Both events bump `events.length`/`updatedAt`/`stallTurns` under the OLD key,
			// but satisfy nothing and add no evidence, so the new signature must not move.
			state = applyGoalEvent(state, { type: "reopen_requirement", id: "req-1", now: `T${callCount}a` });
			state = applyGoalEvent(state, {
				type: "add_requirement",
				id: `req-new-${callCount}`,
				text: `Req new ${callCount}`,
				now: `T${callCount}b`,
			});
			appendGoalStateSnapshot(sessionManager, state);
		};

		const result = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 5 });
		expect(result.turnsSubmitted).toBe(1);
		expect(result.stopReason).toBe("goal_state_not_advanced");
		expect(promptCalls.length).toBe(1);
	});

	it("satisfying a requirement each turn advances the signature and keeps the loop going until maxTurns", async () => {
		const { session, sessionManager, promptCalls } = createTestSession();

		// Three open requirements so satisfying 2 of them (one per turn) still leaves one open.
		let state = createGoalState({ goalId: "g-satisfy", userGoal: "User Goal Here", now: "T0" });
		for (let i = 1; i <= 3; i++) {
			state = applyGoalEvent(state, { type: "add_requirement", id: `req-${i}`, text: `Req ${i} text`, now: "T0" });
		}
		appendGoalStateSnapshot(sessionManager, state);

		let callCount = 0;
		session.prompt = async (text: string, options?: unknown) => {
			promptCalls.push({ text, options });
			callCount++;
			state = applyGoalEvent(state, {
				type: "satisfy_requirement",
				id: `req-${callCount}`,
				evidenceIds: [],
				now: `T${callCount}`,
			});
			appendGoalStateSnapshot(sessionManager, state);
		};

		const result = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 2 });
		expect(result.turnsSubmitted).toBe(2);
		expect(result.stopReason).toBe("max_turns_reached");
		expect(promptCalls.length).toBe(2);
	});

	it("adding evidence with verified UNDEFINED does NOT advance the signature and stops with goal_state_not_advanced", async () => {
		const { session, sessionManager, promptCalls } = createTestSession();

		// Requirement stays open the whole time; unverified evidence accrual alone must not fool the
		// stall guard (verified:undefined is untrusted — it covers both "not yet checked" AND kinds
		// that carry no checkable ref at all, e.g. "user"/"finding"/"test").
		let state = createGoalState({ goalId: "g-evidence-undefined", userGoal: "User Goal Here", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);

		let callCount = 0;
		session.prompt = async (text: string, options?: unknown) => {
			promptCalls.push({ text, options });
			callCount++;
			state = applyGoalEvent(state, {
				type: "add_evidence",
				id: `ev-${callCount}`,
				kind: "tool",
				summary: `Evidence ${callCount}`,
				uri: `tool-call-${callCount}`,
				now: `T${callCount}`,
			});
			appendGoalStateSnapshot(sessionManager, state);
		};

		const result = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 5 });
		expect(result.turnsSubmitted).toBe(1);
		expect(result.stopReason).toBe("goal_state_not_advanced");
		expect(promptCalls.length).toBe(1);
	});

	it("spamming kind:finding evidence with a fabricated uri every turn does NOT advance the signature (closes the undefined-verified loophole)", async () => {
		const { session, sessionManager, promptCalls } = createTestSession();

		// kind:"finding" carries no checkable ref at all, so `verified` is always undefined no matter
		// what `uri` says — a model could otherwise spam this every turn to defeat stall detection.
		let state = createGoalState({ goalId: "g-finding-spam", userGoal: "User Goal Here", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);

		let callCount = 0;
		session.prompt = async (text: string, options?: unknown) => {
			promptCalls.push({ text, options });
			callCount++;
			state = applyGoalEvent(state, {
				type: "add_evidence",
				id: `ev-${callCount}`,
				kind: "finding",
				summary: `Finding ${callCount}`,
				uri: `https://fabricated-source-${callCount}.example`,
				now: `T${callCount}`,
			});
			appendGoalStateSnapshot(sessionManager, state);
		};

		const result = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 5 });
		expect(result.turnsSubmitted).toBe(1);
		expect(result.stopReason).toBe("goal_state_not_advanced");
		expect(promptCalls.length).toBe(1);
	});

	it("adding kind:user evidence with a ref advances the signature and keeps the loop going (trusted set, mirrors the complete gate)", async () => {
		const { session, sessionManager, promptCalls } = createTestSession();

		let state = createGoalState({ goalId: "g-evidence-user", userGoal: "User Goal Here", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);

		let callCount = 0;
		session.prompt = async (text: string, options?: unknown) => {
			promptCalls.push({ text, options });
			callCount++;
			state = applyGoalEvent(state, {
				type: "add_evidence",
				id: `ev-${callCount}`,
				kind: "user",
				summary: `User-confirmed evidence ${callCount}`,
				uri: `user-confirmation-${callCount}`,
				now: `T${callCount}`,
			});
			appendGoalStateSnapshot(sessionManager, state);
		};

		const result = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 2 });
		expect(result.turnsSubmitted).toBe(2);
		expect(result.stopReason).toBe("max_turns_reached");
		expect(promptCalls.length).toBe(2);
	});

	it("adding ref-backed evidence with verified: true advances the signature and keeps the loop going", async () => {
		const { session, sessionManager, promptCalls } = createTestSession();

		let state = createGoalState({ goalId: "g-evidence-verified", userGoal: "User Goal Here", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);

		let callCount = 0;
		session.prompt = async (text: string, options?: unknown) => {
			promptCalls.push({ text, options });
			callCount++;
			state = applyGoalEvent(state, {
				type: "add_evidence",
				id: `ev-${callCount}`,
				kind: "tool",
				summary: `Evidence ${callCount}`,
				uri: `tool-call-${callCount}`,
				verified: true,
				now: `T${callCount}`,
			});
			appendGoalStateSnapshot(sessionManager, state);
		};

		const result = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 2 });
		expect(result.turnsSubmitted).toBe(2);
		expect(result.stopReason).toBe("max_turns_reached");
		expect(promptCalls.length).toBe(2);
	});

	it("adding evidence explicitly marked verified: false does NOT advance the signature and stops with goal_state_not_advanced", async () => {
		const { session, sessionManager, promptCalls } = createTestSession();

		let state = createGoalState({ goalId: "g-evidence-bogus", userGoal: "User Goal Here", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1 text", now: "T0" });
		appendGoalStateSnapshot(sessionManager, state);

		let callCount = 0;
		session.prompt = async (text: string, options?: unknown) => {
			promptCalls.push({ text, options });
			callCount++;
			// A ref that failed validation (bogus toolCallId/path) must not count toward progress.
			state = applyGoalEvent(state, {
				type: "add_evidence",
				id: `ev-${callCount}`,
				kind: "tool",
				summary: `Bogus evidence ${callCount}`,
				uri: `bogus-tool-call-${callCount}`,
				verified: false,
				now: `T${callCount}`,
			});
			appendGoalStateSnapshot(sessionManager, state);
		};

		const result = await session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 5 });
		expect(result.turnsSubmitted).toBe(1);
		expect(result.stopReason).toBe("goal_state_not_advanced");
		expect(promptCalls.length).toBe(1);
	});
});
