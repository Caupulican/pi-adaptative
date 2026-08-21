import type { AgentTool } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
	BACKGROUND_TOOL_TASK_CUSTOM_TYPE,
	type BackgroundToolTaskRecord,
} from "../src/core/background-tool-task-controller.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { appendTaskStepsStateSnapshot } from "../src/core/tasks/session-task-state.ts";
import { createTaskStepsState, setTaskSteps } from "../src/core/tasks/task-state.ts";
import { createHarness, createHarnessWithExtensions } from "./test-harness.ts";

const slowParameters = Type.Object({});

describe("AgentSession background tool tasks", () => {
	it("hands a slow call off, continues the provider loop, persists it, and wakes only its owning session", async () => {
		let releaseSlow: (() => void) | undefined;
		const slowCompletion = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		let markStarted: (() => void) | undefined;
		const toolStarted = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const execute = vi.fn(async () => {
			markStarted?.();
			await slowCompletion;
			return { content: [{ type: "text" as const, text: "slow result" }], details: {} };
		});
		const slowTool: AgentTool<typeof slowParameters, Record<string, never>> = {
			name: "slow",
			label: "slow",
			description: "Deterministic slow test tool",
			parameters: slowParameters,
			execute,
		};
		const harness = createHarness({
			baseToolsOverride: { slow: slowTool },
			responses: [
				{ toolCalls: [{ id: "slow-call", name: "slow", args: {} }] },
				"foreground continued",
				"background completion acknowledged",
			],
		});
		// A base-tool override is an explicit surface: request session background control instead
		// of relying on it to bypass that surface as an implicit companion.
		harness.session.setActiveToolsByName(["slow", "tool_task"]);
		harness.agent.backgroundToolCallAfterMs = 5;

		let sawRunningLevel = false;
		let resolveTerminalLevel: (() => void) | undefined;
		const terminalLevel = new Promise<void>((resolve) => {
			resolveTerminalLevel = resolve;
		});
		let resolveNotificationReply: (() => void) | undefined;
		const notificationReply = new Promise<void>((resolve) => {
			resolveNotificationReply = resolve;
		});
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "background_tools") {
				if (event.tasks.some((task) => task.taskId === "tool-task-1")) sawRunningLevel = true;
				if (sawRunningLevel && event.tasks.length === 0) resolveTerminalLevel?.();
			}
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			const text = event.message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			if (text.includes("background completion acknowledged")) resolveNotificationReply?.();
		});

		try {
			const promptPromise = harness.session.prompt("run the slow tool");
			await toolStarted;
			const handoffCount = harness.session.backgroundRunningToolCalls("slow-call");
			expect(handoffCount).toBe(1);
			await promptPromise;
			expect(execute).toHaveBeenCalledOnce();
			expect(harness.faux.callCount).toBe(2);

			const runningRecords = harness.sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === BACKGROUND_TOOL_TASK_CUSTOM_TYPE ? [entry.data] : [],
				);
			expect(runningRecords).toEqual([
				expect.objectContaining({
					sessionId: harness.session.sessionId,
					taskId: "tool-task-1",
					status: "running",
				}),
			]);

			releaseSlow?.();
			await terminalLevel;
			await notificationReply;
			expect(harness.faux.callCount).toBe(3);

			const taskTool = harness.agent.state.tools.find((tool) => tool.name === "tool_task");
			expect(taskTool).toBeDefined();
			const result = await taskTool!.execute("inspect-task", { action: "wait", taskId: "tool-task-1" });
			expect(result.content).toEqual([{ type: "text", text: "slow result" }]);
			expect(result.details).toMatchObject({ taskId: "tool-task-1", status: "completed" });

			const persistedTransitions = harness.sessionManager.getEntries().flatMap((entry) =>
				entry.type === "custom" && entry.customType === BACKGROUND_TOOL_TASK_CUSTOM_TYPE
					? [
							{
								status: (entry.data as { status?: unknown } | undefined)?.status,
								terminalDelivery: (entry.data as { terminalDelivery?: unknown } | undefined)?.terminalDelivery,
							},
						]
					: [],
			);
			expect(persistedTransitions).toEqual([
				{ status: "running", terminalDelivery: undefined },
				{ status: "completed", terminalDelivery: "pending" },
				{ status: "completed", terminalDelivery: "delivered" },
			]);
		} finally {
			unsubscribe();
			releaseSlow?.();
			harness.cleanup();
		}
	});

	it("batches simultaneous terminal completions without racing the owning agent prompt", async () => {
		let releaseSlow: (() => void) | undefined;
		const slowCompletion = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const slowTool: AgentTool<typeof slowParameters, Record<string, never>> = {
			name: "slow",
			label: "slow",
			description: "Deterministic slow test tool",
			parameters: slowParameters,
			execute: async () => {
				await slowCompletion;
				return { content: [{ type: "text" as const, text: "slow result" }], details: {} };
			},
		};
		const harness = createHarness({
			baseToolsOverride: { slow: slowTool },
			responses: [
				{
					toolCalls: [
						{ id: "slow-call-1", name: "slow", args: {} },
						{ id: "slow-call-2", name: "slow", args: {} },
						{ id: "slow-call-3", name: "slow", args: {} },
					],
				},
				"foreground continued",
				"batched completion acknowledged",
			],
		});
		harness.session.setActiveToolsByName(["slow", "tool_task"]);
		harness.agent.backgroundToolCallAfterMs = 5;
		const warnings: string[] = [];
		const handoffs: string[] = [];
		let resolveAcknowledged: (() => void) | undefined;
		const acknowledged = new Promise<void>((resolve) => {
			resolveAcknowledged = resolve;
		});
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "warning") warnings.push(event.message);
			if (event.type !== "message_end") return;
			if (event.message.role === "custom" && event.message.customType === "background-tool-completion") {
				handoffs.push(
					typeof event.message.content === "string"
						? event.message.content
						: event.message.content
								.filter((block) => block.type === "text")
								.map((block) => block.text)
								.join("\n"),
				);
			}
			if (event.message.role !== "assistant") return;
			const text = event.message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			if (text.includes("batched completion acknowledged")) resolveAcknowledged?.();
		});

		try {
			await harness.session.prompt("run three slow tools");
			expect(harness.faux.callCount).toBe(2);
			releaseSlow?.();
			await Promise.race([
				acknowledged,
				new Promise<never>((_resolve, reject) =>
					setTimeout(() => reject(new Error("background completion notification timed out")), 1_000),
				),
			]);

			expect(
				warnings.filter((warning) => warning.includes("Failed to notify terminal background tool task")),
			).toEqual([]);
			expect(handoffs).toHaveLength(1);
			for (const taskId of ["tool-task-1", "tool-task-2", "tool-task-3"]) {
				expect(handoffs[0]).toContain(taskId);
			}
			expect(harness.faux.callCount).toBe(3);
		} finally {
			unsubscribe();
			releaseSlow?.();
			harness.cleanup();
		}
	});

	it("waits for asynchronous foreground preflight before delivering a terminal handoff", async () => {
		let releaseSlow: (() => void) | undefined;
		const slowCompletion = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		let releasePreflight: (() => void) | undefined;
		const preflightGate = new Promise<void>((resolve) => {
			releasePreflight = resolve;
		});
		let markPreflightEntered: (() => void) | undefined;
		const preflightEntered = new Promise<void>((resolve) => {
			markPreflightEntered = resolve;
		});
		const slowTool: AgentTool<typeof slowParameters, Record<string, never>> = {
			name: "slow",
			label: "slow",
			description: "Deterministic slow test tool",
			parameters: slowParameters,
			execute: async () => {
				await slowCompletion;
				return { content: [{ type: "text" as const, text: "slow result" }], details: {} };
			},
		};
		const harness = await createHarnessWithExtensions({
			baseToolsOverride: { slow: slowTool },
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text === "foreground preflight owner") {
							markPreflightEntered?.();
							await preflightGate;
						}
						return { action: "continue" };
					});
				},
			],
			responses: [
				{ toolCalls: [{ id: "slow-call", name: "slow", args: {} }] },
				"foreground continued",
				"preflight owner completed",
				"background completion acknowledged",
			],
		});
		harness.session.setActiveToolsByName(["slow", "tool_task"]);
		harness.agent.backgroundToolCallAfterMs = 5;
		let sawRunning = false;
		let markTaskTerminal: (() => void) | undefined;
		const taskTerminal = new Promise<void>((resolve) => {
			markTaskTerminal = resolve;
		});
		let markHandoffReply: (() => void) | undefined;
		const handoffReply = new Promise<void>((resolve) => {
			markHandoffReply = resolve;
		});
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "background_tools") {
				if (event.tasks.length > 0) sawRunning = true;
				if (sawRunning && event.tasks.length === 0) markTaskTerminal?.();
			}
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			const text = event.message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			if (text.includes("background completion acknowledged")) markHandoffReply?.();
		});

		try {
			await harness.session.prompt("start slow work");
			const foregroundPrompt = harness.session.prompt("foreground preflight owner");
			await preflightEntered;
			releaseSlow?.();
			await taskTerminal;

			expect(harness.faux.callCount).toBe(2);
			expect(
				harness.sessionManager
					.getEntries()
					.some((entry) => entry.type === "custom" && entry.customType === "background-tool-completion"),
			).toBe(false);

			releasePreflight?.();
			await foregroundPrompt;
			await handoffReply;
			expect(harness.faux.callCount).toBe(4);
		} finally {
			unsubscribe();
			releaseSlow?.();
			releasePreflight?.();
			harness.cleanup();
		}
	});

	it("reconstructs only the resumed session's durable task projection", async () => {
		const sessionManager = SessionManager.inMemory();
		const retained: BackgroundToolTaskRecord = {
			sessionId: sessionManager.getSessionId(),
			taskId: "tool-task-7",
			toolCallId: "retained-call",
			toolName: "slow",
			status: "completed",
			startedAt: "2026-08-01T12:00:00.000Z",
			completedAt: "2026-08-01T12:00:01.000Z",
			elapsedBeforeHandoffMs: 15_000,
			summary: "slow completed: retained output",
			output: "retained output",
		};
		sessionManager.appendCustomEntry(BACKGROUND_TOOL_TASK_CUSTOM_TYPE, retained);
		sessionManager.appendCustomEntry(BACKGROUND_TOOL_TASK_CUSTOM_TYPE, {
			...retained,
			sessionId: "another-session",
			taskId: "tool-task-99",
			output: "foreign output",
		});
		const harness = createHarness({ sessionManager });

		try {
			const taskTool = harness.agent.state.tools.find((tool) => tool.name === "tool_task");
			expect(taskTool).toBeDefined();
			const list = await taskTool!.execute("list-tasks", { action: "list" });
			const listText = list.content[0]?.type === "text" ? list.content[0].text : "";
			expect(listText).toContain("tool-task-7: completed");
			expect(listText).not.toContain("tool-task-99");

			const wait = await taskTool!.execute("wait-task", { action: "wait", taskId: "tool-task-7" });
			expect(wait.content).toEqual([{ type: "text", text: "retained output" }]);
		} finally {
			harness.cleanup();
		}
	});

	it("inherits durable task records only through a legitimate fork lineage", async () => {
		const sourceSessionManager = SessionManager.inMemory();
		const sourceSessionId = sourceSessionManager.getSessionId();
		const retained: BackgroundToolTaskRecord = {
			sessionId: sourceSessionId,
			taskId: "tool-task-7",
			toolCallId: "retained-call",
			toolName: "slow",
			status: "completed",
			startedAt: "2026-08-01T12:00:00.000Z",
			completedAt: "2026-08-01T12:00:01.000Z",
			elapsedBeforeHandoffMs: 15_000,
			summary: "slow completed: retained output",
			output: "retained output",
		};
		const retainedEntryId = sourceSessionManager.appendCustomEntry(BACKGROUND_TOOL_TASK_CUSTOM_TYPE, retained);
		const forkedSessionManager = sourceSessionManager.createBranchedSessionManager(retainedEntryId);
		forkedSessionManager.appendCustomEntry(BACKGROUND_TOOL_TASK_CUSTOM_TYPE, {
			...retained,
			sessionId: "unrelated-session",
			taskId: "tool-task-99",
		});
		const harness = createHarness({ sessionManager: forkedSessionManager });

		try {
			const taskTool = harness.agent.state.tools.find((tool) => tool.name === "tool_task");
			expect(taskTool).toBeDefined();
			const list = await taskTool!.execute("list-forked-tasks", { action: "list" });
			const listText = list.content[0]?.type === "text" ? list.content[0].text : "";
			expect(listText).toContain("tool-task-7: completed");
			expect(listText).not.toContain("tool-task-99");
		} finally {
			harness.cleanup();
		}
	});

	it("gives a resumed session normal task guidance, because the new user prompt already cleared the refusal", async () => {
		const sessionManager = SessionManager.inMemory();
		appendTaskStepsStateSnapshot(
			sessionManager,
			setTaskSteps(
				createTaskStepsState("T0"),
				[{ content: "Resolve the QA card", activeForm: "Resolving the QA card", status: "in_progress" }],
				"T1",
			),
		);
		// Persist the refused pair before constructing the resumed session. Loading through
		// buildSessionContext mirrors the SDK's restore boundary; no live-state seeding is allowed.
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "npm test" } }],
			api: "openai-completions",
			provider: "test",
			model: "faux",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "bash-1",
			toolName: "bash",
			content: [{ type: "text", text: '[harness] {"failure_code":"repeated_failed_operation"}' }],
			isError: true,
			timestamp: 2,
		});
		const restoredMessages = sessionManager.buildSessionContext().messages;
		const harness = createHarness({ sessionManager, responses: ["acknowledged"] });
		harness.agent.state.messages = restoredMessages;
		try {
			expect(harness.agent.state.messages.at(-1)).toMatchObject({
				role: "toolResult",
				toolCallId: "bash-1",
			});

			await harness.session.prompt("carry on");

			const taskContext = harness.agent.state.messages.flatMap((message) =>
				message.role === "custom" && typeof message.content === "string" && message.content.includes("TASK STEPS")
					? [message.content]
					: [],
			);

			expect(taskContext).toHaveLength(1);
			// The prompt that carries this guidance is itself the world advance that re-admits the
			// operation, so guidance must never describe it as still refused.
			for (const text of taskContext) {
				expect(text).toContain("FIRST: continue in_progress step: Resolving the QA card");
				expect(text).not.toContain("refused");
				expect(text).not.toContain("replay");
			}
		} finally {
			harness.cleanup();
		}
	});

	it("refuses repeated durable-task waits and still lets the model close out the goal turn", async () => {
		const sessionManager = SessionManager.inMemory();
		const failedTask: BackgroundToolTaskRecord = {
			sessionId: sessionManager.getSessionId(),
			taskId: "tool-task-1",
			toolCallId: "failed-call",
			toolName: "bash",
			status: "failed",
			startedAt: "2026-08-01T12:00:00.000Z",
			completedAt: "2026-08-01T12:00:30.000Z",
			elapsedBeforeHandoffMs: 15_000,
			summary: "bash failed after timing out",
			output: "Background bash task timed out after 30 seconds.",
		};
		sessionManager.appendCustomEntry(BACKGROUND_TOOL_TASK_CUSTOM_TYPE, failedTask);
		const goal = applyGoalEvent(
			createGoalState({ goalId: "goal-task-wait", userGoal: "Finish the audit", now: "T0" }),
			{ type: "add_requirement", id: "audit", text: "Audit the target", now: "T0" },
		);
		appendGoalStateSnapshot(sessionManager, goal);

		const responses = Array.from({ length: 4 }, (_, index) => ({
			toolCalls: [
				{
					id: `wait-call-${index + 1}`,
					name: "tool_task",
					args: { action: "wait", taskId: failedTask.taskId },
				},
			],
		}));
		const harness = createHarness({
			sessionManager,
			responses: [...responses, "The background task failure requires owner action."],
		});
		harness.session.setActiveToolsByName(["tool_task", "goal"]);
		harness.agent.maxStallTurns = 0;

		try {
			await harness.session.prompt("inspect the failed task", { autoContinueGoal: false });

			const toolResults = harness.agent.state.messages.filter((message) => message.role === "toolResult");
			const firstResultText = toolResults[0]?.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			expect(toolResults[0]?.errorKind).toBe("operation_outcome");
			expect(firstResultText).toContain("Background bash task timed out after 30 seconds.");
			expect(firstResultText).not.toContain("[harness]");
			for (const replay of toolResults.slice(1)) {
				const replayText = replay.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				expect(replayText).toContain('"failure_code":"repeated_failed_operation"');
			}

			const assistantText = harness.agent.state.messages
				.flatMap((message) =>
					message.role === "assistant"
						? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
						: [],
				)
				.join("\n");
			// The three identical replays are refused without executing anything, and the model keeps its
			// turn: the wrap-up is authored by the model rather than substituted by the harness.
			expect(harness.faux.callCount).toBe(5);
			expect(assistantText).not.toContain("Tool recovery stopped");
			expect(assistantText).toContain("The background task failure requires owner action.");
			// A repeated negative operation outcome is not a terminal run outcome and must not block the goal.
			expect(harness.session.getGoalStateSnapshot()).toMatchObject({ goalId: "goal-task-wait" });
			expect(harness.session.getGoalStateSnapshot()?.status).not.toBe("blocked");
			expect(harness.session.getGoalStateSnapshot()?.blockedReason ?? "").not.toContain("terminal_tool_failure");
		} finally {
			harness.cleanup();
		}
	});
});
