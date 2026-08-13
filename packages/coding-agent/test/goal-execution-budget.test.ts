import { SessionManager } from "@caupulican/pi-agent-core/session";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@caupulican/pi-ai/faux";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { GoalSessionController } from "../src/core/goals/goal-session-controller.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
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
