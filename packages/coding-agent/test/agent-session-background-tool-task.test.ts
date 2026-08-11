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
import { createHarness, createHarnessWithExtensions } from "./test-harness.ts";

const slowParameters = Type.Object({});

describe("AgentSession background tool tasks", () => {
	it("hands a slow call off, continues the provider loop, persists it, and wakes only its owning session", async () => {
		let releaseSlow: (() => void) | undefined;
		const slowCompletion = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const execute = vi.fn(async () => {
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
			const promptOutcome = await Promise.race([
				harness.session.prompt("run the slow tool").then(() => "completed" as const),
				new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 250)),
			]);
			expect(promptOutcome).toBe("completed");
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

			const persistedStatuses = harness.sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === BACKGROUND_TOOL_TASK_CUSTOM_TYPE
						? [(entry.data as { status?: unknown } | undefined)?.status]
						: [],
				);
			expect(persistedStatuses).toEqual(["running", "completed"]);
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

	it("blocks goal continuation after a failed durable task wait exhausts recovery", async () => {
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

		const responses = Array.from({ length: 3 }, (_, index) => ({
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

			expect(harness.faux.callCount).toBe(4);
			expect(harness.session.getGoalStateSnapshot()).toMatchObject({
				goalId: "goal-task-wait",
				status: "blocked",
				blockedReason: expect.stringContaining("terminal_tool_failure: tool_task"),
			});
		} finally {
			harness.cleanup();
		}
	});
});
