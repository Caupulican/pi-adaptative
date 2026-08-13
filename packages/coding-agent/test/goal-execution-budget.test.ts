import { SessionManager } from "@caupulican/pi-agent-core/session";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@caupulican/pi-ai/faux";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { GoalLoopController } from "../src/core/goal-loop-controller.ts";
import { GoalBudgetExhaustedError } from "../src/core/goals/goal-execution-errors.ts";
import { GoalSessionController } from "../src/core/goals/goal-session-controller.ts";
import { applyGoalEvent, createGoalState, type GoalStatus } from "../src/core/goals/goal-state.ts";
import { appendGoalClearedSnapshot, appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { budgetedTokens } from "../src/core/orchestration/capability-gateway.ts";
import { createHarness } from "./suite/harness.ts";

describe("goal-owned execution budget", () => {
	it("rejects a model-created goal when the user submitted only ordinary task work", async () => {
		const harness = await createHarness();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("goal", {
					action: "start",
					goalId: "model-invented-goal",
					userGoal: "Investigate the task forever",
					tokenBudget: 40_000,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("ordinary task response"),
		]);

		await harness.session.prompt("Investigate and fix the reported bug", { autoContinueGoal: false });

		expect(harness.session.getGoalStateSnapshot()).toBeUndefined();
		const result = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "goal",
		);
		if (!result || result.role !== "toolResult") throw new Error("Expected goal tool result");
		expect(result.content).toEqual([
			expect.objectContaining({ text: expect.stringContaining("explicit owner authorization") }),
		]);
	});

	it("allows standalone explicit goal authority but only with the exact requested budget", async () => {
		const accepted = await createHarness({
			models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 100_000 }],
		});
		let firstRequestMaxTokens: number | undefined;
		accepted.setResponses([
			(_context, options) => {
				firstRequestMaxTokens = options?.maxTokens;
				return fauxAssistantMessage(
					fauxToolCall("goal", {
						action: "start",
						goalId: "explicit-goal",
						userGoal: "Continue the current work",
						tokenBudget: 40_000,
					}),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("goal recorded"),
		]);
		await accepted.session.prompt("this is a goal with a 40k token budget", { autoContinueGoal: false });
		expect(firstRequestMaxTokens).toBe(40_000);
		expect(accepted.session.getGoalStateSnapshot()).toMatchObject({
			goalId: "explicit-goal",
			tokenBudget: 40_000,
		});
		expect(accepted.session.getGoalStateSnapshot()?.tokensUsed).toBeGreaterThan(0);

		const rejected = await createHarness();
		rejected.setResponses([
			fauxAssistantMessage(
				fauxToolCall("goal", {
					action: "start",
					goalId: "invented-budget",
					userGoal: "Continue the current work",
					tokenBudget: 40_000,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("budget rejected"),
		]);
		await rejected.session.prompt("this is a goal", { autoContinueGoal: false });
		expect(rejected.session.getGoalStateSnapshot()).toBeUndefined();
	});

	it("uses the shared lean token charge for cache reads and cache writes", () => {
		const sessionManager = SessionManager.inMemory();
		appendGoalStateSnapshot(
			sessionManager,
			createGoalState({ goalId: "goal-cache-accounting", userGoal: "Use the explicit budget", now: "T0" }),
		);
		const controller = new GoalSessionController({
			getSessionManager: () => sessionManager,
			getModelProvider: () => "faux",
			getLaneRecords: () => [],
			getTaskRuntimeSnapshot: () => undefined,
			synchronizeGoalState: () => undefined,
			scheduleGoalAutoContinueFromIdle: () => undefined,
			prompt: async () => undefined,
			emitWarning: () => undefined,
		});
		const lease = controller.beginExecution("goal-cache-accounting");
		const message = fauxAssistantMessage("accounted response");
		message.usage = {
			input: 1_000,
			output: 100,
			cacheRead: 10_000,
			cacheWrite: 500,
			totalTokens: 11_600,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
		};

		controller.recordExecutionUsage(message);
		controller.endExecution(lease);

		const expected = budgetedTokens({
			inputTokens: 1_000,
			outputTokens: 100,
			cacheReadTokens: 10_000,
			cacheWriteTokens: 500,
			totalTokens: 11_600,
		});
		expect(expected).toBe(2_600);
		expect(controller.getState()?.tokensUsed).toBe(expected);
		expect(controller.getState()?.continuationSpendUsd).toBe(0.25);
	});

	it("reserves remaining output capacity without turning repeated prompt context into a request counter", () => {
		const sessionManager = SessionManager.inMemory();
		let goal = createGoalState({
			goalId: "goal-remaining-output",
			userGoal: "Use all requested work capacity",
			tokenBudget: 10_000,
			now: "T0",
		});
		goal = applyGoalEvent(goal, {
			type: "record_continuation_budget",
			turns: 0,
			wallClockMs: 0,
			tokens: 7_000,
			spendUsd: 0,
			now: "T1",
		});
		appendGoalStateSnapshot(sessionManager, goal);
		const controller = new GoalSessionController({
			getSessionManager: () => sessionManager,
			getModelProvider: () => "faux",
			getLaneRecords: () => [],
			getTaskRuntimeSnapshot: () => undefined,
			synchronizeGoalState: () => undefined,
			scheduleGoalAutoContinueFromIdle: () => undefined,
			prompt: async () => undefined,
			emitWarning: () => undefined,
		});
		const lease = controller.beginExecution("goal-remaining-output");

		expect(controller.admitProviderRequest()).toBe(3_000);
		expect(controller.getState()?.status).toBe("active");
		controller.endExecution(lease);
	});

	it("stops the goal cleanly before sending a doomed, truncated-output request when remaining drops below the minimum viable turn", () => {
		const sessionManager = SessionManager.inMemory();
		let goal = createGoalState({
			goalId: "goal-near-exhausted",
			userGoal: "Finish before the ceiling",
			tokenBudget: 200_000,
			now: "T0",
		});
		goal = applyGoalEvent(goal, {
			type: "record_continuation_budget",
			turns: 0,
			wallClockMs: 0,
			tokens: 199_400,
			spendUsd: 0,
			now: "T1",
		});
		appendGoalStateSnapshot(sessionManager, goal);
		const controller = new GoalSessionController({
			getSessionManager: () => sessionManager,
			getModelProvider: () => "faux",
			getLaneRecords: () => [],
			getTaskRuntimeSnapshot: () => undefined,
			synchronizeGoalState: () => undefined,
			scheduleGoalAutoContinueFromIdle: () => undefined,
			prompt: async () => undefined,
			emitWarning: () => undefined,
		});
		const lease = controller.beginExecution("goal-near-exhausted");

		// 600 tokens remain (200_000 - 199_400): far too small an output cap for a real response.
		// Previously this returned 600 as maxTokens, so the model paid the full input cost of the
		// turn only to be cut off mid-generation with stopReason "length". The goal must stop
		// cleanly BEFORE the request is sent instead.
		expect(() => controller.admitProviderRequest()).toThrowError(GoalBudgetExhaustedError);
		expect(() => controller.admitProviderRequest()).toThrowError(/goal_token_budget_exhausted/);
		expect(controller.getState()).toMatchObject({ status: "budget_limited", tokensUsed: 199_400 });
		controller.endExecution(lease);
	});

	it("still returns a generous protective cap, unmodified, when remaining is comfortably above the minimum viable turn", () => {
		const sessionManager = SessionManager.inMemory();
		const goal = createGoalState({
			goalId: "goal-comfortable-remaining",
			userGoal: "Keep going with headroom",
			tokenBudget: 200_000,
			now: "T0",
		});
		appendGoalStateSnapshot(sessionManager, goal);
		const controller = new GoalSessionController({
			getSessionManager: () => sessionManager,
			getModelProvider: () => "faux",
			getLaneRecords: () => [],
			getTaskRuntimeSnapshot: () => undefined,
			synchronizeGoalState: () => undefined,
			scheduleGoalAutoContinueFromIdle: () => undefined,
			prompt: async () => undefined,
			emitWarning: () => undefined,
		});
		const lease = controller.beginExecution("goal-comfortable-remaining");

		expect(controller.admitProviderRequest()).toBe(200_000);
		expect(controller.getState()?.status).toBe("active");
		controller.endExecution(lease);
	});

	it("returns a clean goal_budget_exhausted stop instead of rejecting when admission throws mid-loop", async () => {
		// Unit-level regression for the goal-loop-controller catch itself: simulates
		// admitProviderRequest throwing GoalBudgetExhaustedError from inside a submitted pass (as it
		// does once `markBudgetLimited` has already run synchronously) and asserts continueGoalLoop
		// resolves with the loop's own clean stop reason instead of rejecting the whole promise and
		// reclassifying an intentional, already-recorded stop as a generic continuation failure.
		let state = createGoalState({ goalId: "goal-loop-budget", userGoal: "Ship it", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Req 1", now: "T0" });
		const recordedFailures: unknown[] = [];
		const controller = new GoalLoopController({
			getGoalRuntimeSnapshot: () => ({
				goalState: state,
				workerClaims: [],
				learningDecisions: [],
				continuation: {
					action: "continue",
					reasonCode: "goal_active",
					message: "test",
					openRequirementIds: ["req-1"],
					blockedRequirementIds: [],
					satisfiedRequirementIds: [],
				},
			}),
			prompt: async () => {
				state = { ...state, status: "budget_limited" };
				throw new GoalBudgetExhaustedError("goal_token_budget_exhausted: 0 tokens remain");
			},
			recordGoalContinuationPass: () => {},
			recordGoalContinuationFailure: (error) => recordedFailures.push(error),
			markGoalBudgetLimited: () => {},
		});

		const result = await controller.continueGoalLoop({ maxStallTurns: 20, maxTurns: 3 });

		expect(result.stopReason).toBe("goal_budget_exhausted");
		expect(result.turnsSubmitted).toBe(1);
		expect(recordedFailures).toEqual([]);
	});

	function makeGoalController() {
		const sessionManager = SessionManager.inMemory();
		const controller = new GoalSessionController({
			getSessionManager: () => sessionManager,
			getModelProvider: () => "faux",
			getLaneRecords: () => [],
			getTaskRuntimeSnapshot: () => undefined,
			synchronizeGoalState: () => undefined,
			scheduleGoalAutoContinueFromIdle: () => undefined,
			prompt: async () => undefined,
			emitWarning: () => undefined,
		});
		return { sessionManager, controller };
	}

	function stopGoal(state: ReturnType<typeof createGoalState>, status: GoalStatus, now: string) {
		return status === "paused"
			? applyGoalEvent(state, { type: "pause_goal", now })
			: status === "completed"
				? applyGoalEvent(state, { type: "complete_goal_manually", now })
				: status === "cancelled"
					? applyGoalEvent(state, { type: "cancel_goal", now })
					: applyGoalEvent(state, {
							type: "system_stop_goal",
							status: status as "blocked" | "usage_limited" | "budget_limited",
							reason: `${status} for test`,
							now,
						});
	}

	it.each<GoalStatus>(["paused", "blocked", "usage_limited", "completed", "cancelled", "budget_limited"])(
		"drains an in-flight wrap-up when the goal becomes %s mid-turn, except budget_limited which stays denied",
		(status) => {
			const { sessionManager, controller } = makeGoalController();
			const initial = createGoalState({ goalId: `goal-${status}`, userGoal: "Stop safely", now: "T0" });
			appendGoalStateSnapshot(sessionManager, initial);
			// This lease already admitted a request while the goal was active (the tool-call turn
			// itself); the goal then ends mid-turn (e.g. the model just called `goal complete`/`block`).
			const lease = controller.beginExecution(initial.goalId);
			expect(controller.admitProviderRequest()).toBeUndefined();
			appendGoalStateSnapshot(sessionManager, stopGoal(initial, status, "T1"));

			if (status === "budget_limited") {
				// Budget exhaustion is a hard stop even for an already-admitted lease: no wrap-up
				// leniency, or the whole point of a token ceiling is defeated.
				expect(() => controller.admitProviderRequest()).toThrowError(/goal_token_budget_exhausted/);
			} else {
				// The in-flight turn drains gracefully instead of throwing an error at the user right
				// after a successful stop.
				expect(controller.admitProviderRequest()).toBeUndefined();
			}
			controller.endExecution(lease);
		},
	);

	it.each<GoalStatus>(["paused", "blocked", "usage_limited", "completed", "cancelled", "budget_limited"])(
		"denies a fresh turn admitted for the first time against an already-%s goal",
		(status) => {
			const { sessionManager, controller } = makeGoalController();
			// The goal is already stopped BEFORE this lease ever admits anything — simulates a new
			// continuation/turn adopting a goal that turns out to already be done, as opposed to one
			// that ends WHILE the turn's own lease is already in flight (see the drain test above).
			const born = createGoalState({ goalId: `goal-${status}-fresh`, userGoal: "Stop safely", now: "T0" });
			const stopped = stopGoal(born, status, "T1");
			const lease = controller.beginExecution(undefined, { adoptNewGoal: true });
			appendGoalStateSnapshot(sessionManager, stopped);

			if (status === "budget_limited") {
				expect(() => controller.admitProviderRequest()).toThrowError(/goal_token_budget_exhausted/);
			} else {
				expect(() => controller.admitProviderRequest()).toThrowError(
					new RegExp(`goal_execution_not_active: goal-${status}-fresh is ${status}`),
				);
			}
			controller.endExecution(lease);
		},
	);

	it("rejects a stale owned lease after goal replacement or disappearance", () => {
		for (const mode of ["replacement", "disappearance"] as const) {
			const sessionManager = SessionManager.inMemory();
			const initial = createGoalState({ goalId: `goal-stale-${mode}`, userGoal: "Stop safely", now: "T0" });
			appendGoalStateSnapshot(sessionManager, initial);
			const controller = new GoalSessionController({
				getSessionManager: () => sessionManager,
				getModelProvider: () => "faux",
				getLaneRecords: () => [],
				getTaskRuntimeSnapshot: () => undefined,
				synchronizeGoalState: () => undefined,
				scheduleGoalAutoContinueFromIdle: () => undefined,
				prompt: async () => undefined,
				emitWarning: () => undefined,
			});
			const lease = controller.beginExecution(initial.goalId);
			if (mode === "replacement") {
				appendGoalStateSnapshot(
					sessionManager,
					createGoalState({ goalId: "goal-replacement", userGoal: "New goal", now: "T1" }),
					initial,
				);
			} else {
				appendGoalClearedSnapshot(sessionManager, initial, "T1");
			}
			expect(() => controller.admitProviderRequest()).toThrowError(
				mode === "replacement"
					? /goal_execution_not_active: goal-stale-replacement no longer exists/
					: /goal_execution_not_active: goal-stale-disappearance no longer exists/,
			);
			controller.endExecution(lease);
		}
	});

	it("fails loudly instead of silently dropping buffered usage when the owned goal disappears mid-turn", () => {
		const sessionManager = SessionManager.inMemory();
		const initial = createGoalState({ goalId: "goal-usage-lost", userGoal: "Track usage safely", now: "T0" });
		appendGoalStateSnapshot(sessionManager, initial);
		const warnings: string[] = [];
		const controller = new GoalSessionController({
			getSessionManager: () => sessionManager,
			getModelProvider: () => "faux",
			getLaneRecords: () => [],
			getTaskRuntimeSnapshot: () => undefined,
			synchronizeGoalState: () => undefined,
			scheduleGoalAutoContinueFromIdle: () => undefined,
			prompt: async () => undefined,
			emitWarning: (message) => warnings.push(message),
		});
		const lease = controller.beginExecution(initial.goalId);
		const message = fauxAssistantMessage("response after the goal was cleared out from under this lease");
		message.usage = {
			input: 500,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 550,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
		};
		// The goal is cleared entirely WHILE this lease still holds unflushed usage from the response
		// above — resolveExecutionState can no longer find it, so recordExecutionUsage buffers the
		// usage as pending instead of charging it.
		appendGoalClearedSnapshot(sessionManager, initial, "T1");
		controller.recordExecutionUsage(message);

		// Ending the execution flushes the pending usage. It must not vanish silently: the session
		// gets an explicit warning, and the loss is recorded as a continuation failure — mirroring the
		// cursor-based accounting this replaced, which failed loudly on `goal_usage_cursor_lost`.
		controller.endExecution(lease);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("goal-usage-lost");
		expect(warnings[0]).toMatch(/pending/i);
	});

	it("drains the closing wrap-up through the session after the goal tool blocks mid-turn, then denies the next turn", async () => {
		const harness = await createHarness();
		try {
			const goal = createGoalState({ goalId: "goal-public-block", userGoal: "Stop after blocking", now: "T0" });
			harness.session.saveGoalStateSnapshot(goal);
			const admissions = vi.spyOn(harness.session.agent, "admitProviderRequest");
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("goal", { action: "block_goal", reason: "runaway tool loop" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("closing wrap-up after the goal was blocked mid-turn"),
			]);

			const result = await harness.session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 2 });
			// The already-in-flight turn's wrap-up drains through (both faux responses are consumed)
			// instead of throwing an error at the user right after the goal successfully stopped.
			expect(harness.faux.state.callCount).toBe(2);
			expect(admissions).toHaveBeenCalledTimes(2);
			// The loop itself still stops before starting a NEW turn: its own goal-state check between
			// passes sees the goal is no longer active and refuses to submit another continuation.
			expect(result.turnsSubmitted).toBe(1);
			expect(result.stopReason).toBe("continuation_not_allowed");
			expect(harness.session.getGoalStateSnapshot()).toMatchObject({
				goalId: goal.goalId,
				status: "blocked",
			});
		} finally {
			harness.cleanup();
		}
	});

	it("charges each assistant response and blocks the next provider request once the explicit budget is spent", async () => {
		const tick = vi.fn(async () => ({ content: [{ type: "text" as const, text: "tick" }], details: {} }));
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "tick",
						label: "Tick",
						description: "Advance one deterministic test step.",
						parameters: Type.Object({}),
						execute: tick,
					});
				},
			],
		});
		let goal = createGoalState({
			goalId: "goal-budget",
			userGoal: "Finish within the explicit budget",
			tokenBudget: 50_000,
			now: "T0",
		});
		goal = applyGoalEvent(goal, {
			type: "add_requirement",
			id: "req-1",
			text: "Run the bounded step",
			now: "T0",
		});
		appendGoalStateSnapshot(harness.sessionManager, goal);
		harness.setResponses([
			fauxAssistantMessage([fauxText("x".repeat(220_000)), fauxToolCall("tick", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not reach a second provider request"),
		]);

		const result = await harness.session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 1 });

		expect(tick).toHaveBeenCalledOnce();
		expect(harness.faux.state.callCount).toBe(1);
		expect(result.stopReason).toBe("goal_budget_exhausted");
		expect(harness.session.getGoalStateSnapshot()).toMatchObject({
			goalId: "goal-budget",
			status: "budget_limited",
		});
		expect(harness.session.getGoalStateSnapshot()?.tokensUsed).toBeGreaterThanOrEqual(50_000);
		// The mid-turn budget crossing ends the loop gracefully (shouldStopAfterTurn) instead of
		// admission throwing and Agent.handleRunFailure synthesizing a stopReason:"error" message.
		expect(
			harness.session.messages.filter((message) => message.role === "assistant" && message.stopReason === "error"),
		).toEqual([]);
	});

	it("ends the transcript on a clean stop, with no synthetic error message, when the goal crosses budget mid-turn via a tool-loop follow-up", async () => {
		// End-to-end regression for the shouldStopAfterTurn wiring: before this fix, the follow-up
		// admission attempt (needed because the first response's stopReason was "toolUse") would throw
		// goal_token_budget_exhausted. Agent.runWithLifecycle's catch-all never let that reject
		// agent.prompt() -- it converted the throw into a synthetic `stopReason: "error"` assistant
		// message appended to the visible transcript instead, right after the tool call. Now
		// chargeExecutionUsage's markBudgetLimited (already fired for the huge first response, before
		// the tool call even executes) is observed by the goal-owned shouldStopAfterTurn hook right
		// after the tool call's turn_end, so the loop ends cleanly via agent_end and never attempts the
		// doomed follow-up request at all.
		const tick = vi.fn(async () => ({ content: [{ type: "text" as const, text: "tick" }], details: {} }));
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "tick",
						label: "Tick",
						description: "Advance one deterministic test step.",
						parameters: Type.Object({}),
						execute: tick,
					});
				},
			],
		});
		let goal = createGoalState({
			goalId: "goal-clean-stop",
			userGoal: "Finish within the explicit budget",
			tokenBudget: 50_000,
			now: "T0",
		});
		goal = applyGoalEvent(goal, {
			type: "add_requirement",
			id: "req-1",
			text: "Run the bounded step",
			now: "T0",
		});
		appendGoalStateSnapshot(harness.sessionManager, goal);
		harness.setResponses([
			fauxAssistantMessage([fauxText("x".repeat(220_000)), fauxToolCall("tick", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not be reached: the budget was already crossed by the prior response"),
		]);

		const result = await harness.session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 1 });

		expect(tick).toHaveBeenCalledOnce();
		// The follow-up response is never even requested.
		expect(harness.faux.state.callCount).toBe(1);
		expect(result.turnsSubmitted).toBe(1);
		expect(result.stopReason).toBe("goal_budget_exhausted");
		expect(harness.session.getGoalStateSnapshot()).toMatchObject({
			goalId: "goal-clean-stop",
			status: "budget_limited",
		});

		// No stray stopReason:"error"/errorMessage anywhere in the visible transcript.
		for (const message of harness.session.messages) {
			if (message.role !== "assistant") continue;
			expect(message.stopReason).not.toBe("error");
			expect(message.errorMessage).toBeUndefined();
		}
		// The model-visible conversation ends on the normal tool-call response, not a crash message.
		const assistantMessages = harness.session.messages.filter((message) => message.role === "assistant");
		expect(assistantMessages).toHaveLength(1);
		expect(assistantMessages[0]).toMatchObject({ stopReason: "toolUse" });
	});

	it("blocks an owning goal when native tool markup escapes as plain text", async () => {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "must not run" }], details: {} }));
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "protocol_probe",
						label: "Protocol probe",
						description: "Deterministic protocol test tool.",
						parameters: Type.Object({ value: Type.String() }),
						execute,
					});
				},
			],
		});
		let goal = createGoalState({ goalId: "goal-protocol", userGoal: "Finish safely", now: "T0" });
		goal = applyGoalEvent(goal, {
			type: "add_requirement",
			id: "req-1",
			text: "Use the tool channel",
			now: "T0",
		});
		appendGoalStateSnapshot(harness.sessionManager, goal);
		harness.setResponses([
			fauxAssistantMessage('Working.\nto=functions.protocol_probe code\n{"value":"unsafe text"}'),
		]);

		const result = await harness.session.continueGoalLoop({ maxStallTurns: 3, maxTurns: 1 });

		expect(execute).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(1);
		expect(result.stopReason).toBe("continuation_not_allowed");
		expect(harness.session.getGoalStateSnapshot()).toMatchObject({
			goalId: "goal-protocol",
			status: "blocked",
			blockedReason: expect.stringContaining("native_tool_protocol_residue"),
		});
	});

	it("does not block an unrelated active goal for protocol residue in ordinary foreground work", async () => {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "must not run" }], details: {} }));
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "protocol_probe",
						label: "Protocol probe",
						description: "Deterministic protocol test tool.",
						parameters: Type.Object({ value: Type.String() }),
						execute,
					});
				},
			],
		});
		appendGoalStateSnapshot(
			harness.sessionManager,
			createGoalState({ goalId: "goal-unrelated", userGoal: "Remain active", now: "T0" }),
		);
		harness.setResponses([
			fauxAssistantMessage('Working.\nto=functions.protocol_probe code\n{"value":"unsafe text"}'),
		]);

		await harness.session.prompt("Run an unrelated foreground check", { autoContinueGoal: false });

		expect(execute).not.toHaveBeenCalled();
		expect(harness.session.getGoalStateSnapshot()).toMatchObject({
			goalId: "goal-unrelated",
			status: "active",
		});
	});
});
