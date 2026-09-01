import type { AgentTool } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import type { ToolResultMessage } from "@caupulican/pi-ai";
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
	it("stamps the active goal on background work started outside a goal continuation turn", async () => {
		let releaseSlow!: () => void;
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
		const sessionManager = SessionManager.inMemory();
		appendGoalStateSnapshot(
			sessionManager,
			createGoalState({ goalId: "goal-ambient", userGoal: "Finish ambient work", now: "T0" }),
		);
		const harness = createHarness({
			sessionManager,
			baseToolsOverride: { slow: slowTool },
			responses: [{ toolCalls: [{ id: "slow-call", name: "slow", args: {} }] }, "foreground done"],
		});
		harness.session.setActiveToolsByName(["slow", "tool_task"]);
		harness.agent.backgroundToolCallAfterMs = 5;
		let sawRunningTask = false;
		let markTaskRunning!: () => void;
		const taskRunning = new Promise<void>((resolve) => {
			markTaskRunning = resolve;
		});
		let markTaskTerminal!: () => void;
		const taskTerminal = new Promise<void>((resolve) => {
			markTaskTerminal = resolve;
		});
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "background_tools") {
				if (event.tasks.length > 0 && !sawRunningTask) {
					sawRunningTask = true;
					markTaskRunning();
				}
				if (sawRunningTask && event.tasks.length === 0) markTaskTerminal();
			}
		});

		try {
			// No goalExecutionId: an ordinary foreground turn taken while the goal is active. The work it
			// backgrounds is still the goal's, so completion must be able to see it and its terminal must
			// not wake a session whose goal already finished.
			const prompt = harness.session.prompt("do some ambient work", { autoContinueGoal: false });
			await taskRunning;
			releaseSlow();
			await taskTerminal;
			await prompt;

			const taskEdges = sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === BACKGROUND_TOOL_TASK_CUSTOM_TYPE
						? [entry.data as BackgroundToolTaskRecord]
						: [],
				);
			expect(taskEdges).not.toHaveLength(0);
			expect(taskEdges.every((record) => record.goalId === "goal-ambient")).toBe(true);
		} finally {
			unsubscribe();
			releaseSlow();
			harness.cleanup();
		}
	});
	it("injects a terminal into the next provider boundary of the same multi-request run", async () => {
		let releaseSlow!: () => void;
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
		const sessionManager = SessionManager.inMemory();
		appendGoalStateSnapshot(
			sessionManager,
			createGoalState({ goalId: "goal-boundary", userGoal: "Finish boundary work", now: "T0" }),
		);
		let releaseSecondStopCheck!: () => void;
		const secondStopCheckGate = new Promise<void>((resolve) => {
			releaseSecondStopCheck = resolve;
		});
		let markSecondStopCheck!: () => void;
		const secondStopCheckEntered = new Promise<void>((resolve) => {
			markSecondStopCheck = resolve;
		});
		const harness = createHarness({
			sessionManager,
			baseToolsOverride: { slow: slowTool },
			responses: [
				{ toolCalls: [{ id: "slow-call", name: "slow", args: {} }] },
				"foreground still working",
				"background completion acknowledged in-run",
			],
		});
		const previousShouldStopAfterTurn = harness.agent.shouldStopAfterTurn?.bind(harness.agent);
		let stopCheckCount = 0;
		harness.agent.shouldStopAfterTurn = async (signal) => {
			const shouldStop = (await previousShouldStopAfterTurn?.(signal)) ?? false;
			stopCheckCount++;
			if (stopCheckCount !== 2) return shouldStop;
			markSecondStopCheck();
			await secondStopCheckGate;
			return shouldStop;
		};
		harness.session.setActiveToolsByName(["slow", "tool_task"]);
		harness.agent.backgroundToolCallAfterMs = 5;
		let agentStarts = 0;
		let terminalMessages = 0;
		let sawRunningTask = false;
		let markTaskTerminal!: () => void;
		const taskTerminal = new Promise<void>((resolve) => {
			markTaskTerminal = resolve;
		});
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "agent_start") agentStarts++;
			if (event.type === "background_tools") {
				if (event.tasks.length > 0) sawRunningTask = true;
				if (sawRunningTask && event.tasks.length === 0) markTaskTerminal();
			}
			if (
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.customType === "background-tool-completion"
			) {
				terminalMessages++;
			}
		});

		try {
			const prompt = harness.session.prompt("continue the owned work", {
				autoContinueGoal: false,
				goalExecutionId: "goal-boundary",
			});
			await secondStopCheckEntered;
			releaseSlow();
			await taskTerminal;
			releaseSecondStopCheck();
			await prompt;

			expect(harness.faux.callCount).toBe(3);
			expect(agentStarts).toBe(1);
			expect(terminalMessages).toBe(1);
			const taskEdges = sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === BACKGROUND_TOOL_TASK_CUSTOM_TYPE
						? [entry.data as BackgroundToolTaskRecord]
						: [],
				);
			expect(taskEdges).not.toHaveLength(0);
			expect(taskEdges.every((record) => record.goalId === "goal-boundary")).toBe(true);
		} finally {
			unsubscribe();
			releaseSlow();
			releaseSecondStopCheck();
			harness.cleanup();
		}
	});

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

	it("keeps nine background calls across execution waves exact while a foreground sibling completes", async () => {
		const taskCount = 9;
		const release: Array<() => void> = [];
		const completions = Array.from(
			{ length: taskCount },
			() =>
				new Promise<void>((resolve) => {
					release.push(resolve);
				}),
		);
		const indexedParameters = Type.Object({ index: Type.Integer({ minimum: 0, maximum: taskCount - 1 }) });
		const fastParameters = Type.Object({});
		const slowExecutions: number[] = [];
		const foregroundExecutions: string[] = [];
		const slowTool: AgentTool<typeof indexedParameters, Record<string, never>> = {
			name: "slow",
			label: "slow",
			description: "Deterministic multi-wave background tool",
			parameters: indexedParameters,
			execute: async (_toolCallId, args) => {
				slowExecutions.push(args.index);
				await completions[args.index];
				return { content: [{ type: "text" as const, text: `slow ${args.index} completed` }], details: {} };
			},
		};
		const fastTool: AgentTool<typeof fastParameters, Record<string, never>> = {
			name: "fast",
			label: "fast",
			description: "Independent foreground control",
			parameters: fastParameters,
			execute: async (toolCallId) => {
				foregroundExecutions.push(toolCallId);
				return { content: [{ type: "text" as const, text: "fast foreground completed" }], details: {} };
			},
		};
		const harness = createHarness({
			baseToolsOverride: { slow: slowTool, fast: fastTool },
			responses: [
				{
					toolCalls: [
						...Array.from({ length: taskCount }, (_, index) => ({
							id: `slow-call-${index}`,
							name: "slow",
							args: { index },
						})),
						{ id: "foreground-call", name: "fast", args: {} },
					],
				},
				"foreground continued while every slow call is detached",
				...Array.from({ length: taskCount }, () => "terminal acknowledged"),
			],
		});
		harness.session.setActiveToolsByName(["slow", "fast", "tool_task"]);
		harness.agent.backgroundToolCallAfterMs = 5;
		const handoffTexts: string[] = [];
		let acknowledgements = 0;
		let waitForAcknowledgement: ((value: void | PromiseLike<void>) => void) | undefined;
		const unsubscribe = harness.session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.customType === "background-tool-completion"
			) {
				handoffTexts.push(
					typeof event.message.content === "string"
						? event.message.content
						: event.message.content
								.filter((block) => block.type === "text")
								.map((block) => block.text)
								.join("\n"),
				);
			}
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			const text = event.message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			if (!text.includes("terminal acknowledged")) return;
			acknowledgements++;
			waitForAcknowledgement?.();
			waitForAcknowledgement = undefined;
		});

		try {
			await harness.session.prompt("run nine slow tasks and one independent foreground task");
			expect(foregroundExecutions).toEqual(["foreground-call"]);
			expect([...slowExecutions].sort((left, right) => left - right)).toEqual(
				Array.from({ length: taskCount }, (_, index) => index),
			);
			const initialResults = harness.agent.state.messages.filter(
				(message): message is ToolResultMessage => message.role === "toolResult",
			);
			expect(initialResults.map((message) => message.toolCallId)).toEqual([
				...Array.from({ length: taskCount }, (_, index) => `slow-call-${index}`),
				"foreground-call",
			]);

			const running = harness.sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === BACKGROUND_TOOL_TASK_CUSTOM_TYPE
						? [entry.data as BackgroundToolTaskRecord]
						: [],
				)
				.filter((record) => record.status === "running");
			expect(running).toHaveLength(taskCount);
			const taskIdByCallId = new Map(running.map((record) => [record.toolCallId, record.taskId]));

			// Release in an order that crosses the first/second/third four-call execution waves.
			for (const index of [8, 0, 5, 1, 7, 2, 6, 3, 4]) {
				const expectedAcknowledgements = acknowledgements + 1;
				const acknowledged = new Promise<void>((resolve) => {
					waitForAcknowledgement = resolve;
				});
				release[index]!();
				await Promise.race([
					acknowledged,
					new Promise<never>((_resolve, reject) =>
						setTimeout(() => reject(new Error(`terminal ${index} acknowledgement timed out`)), 1_000),
					),
				]);
				expect(acknowledgements).toBe(expectedAcknowledgements);
			}

			expect(handoffTexts).toHaveLength(taskCount);
			const handedOffTaskIds = handoffTexts.flatMap((text) => text.match(/tool-task-\d+/g) ?? []);
			expect(handedOffTaskIds).toHaveLength(taskCount);
			expect(new Set(handedOffTaskIds)).toEqual(new Set(Array.from(taskIdByCallId.values())));
			const terminalRecords = harness.sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === BACKGROUND_TOOL_TASK_CUSTOM_TYPE
						? [entry.data as BackgroundToolTaskRecord]
						: [],
				)
				.filter((record) => record.status === "completed" && record.terminalDelivery === "delivered");
			expect(terminalRecords).toHaveLength(taskCount);
			expect(new Set(terminalRecords.map((record) => record.toolCallId))).toEqual(
				new Set(Array.from({ length: taskCount }, (_, index) => `slow-call-${index}`)),
			);
		} finally {
			unsubscribe();
			for (const resolve of release) resolve();
			await harness.cleanup();
		}
	});

	it("keeps foreground work and two out-of-order background terminals scoped to their exact calls", async () => {
		let releaseSlowA!: () => void;
		const slowACompletion = new Promise<void>((resolve) => {
			releaseSlowA = resolve;
		});
		let releaseSlowB!: () => void;
		const slowBCompletion = new Promise<void>((resolve) => {
			releaseSlowB = resolve;
		});
		const slowParameters = Type.Object({ task: Type.Union([Type.Literal("a"), Type.Literal("b")]) });
		const fastParameters = Type.Object({});
		const foregroundExecutions: string[] = [];
		const slowTool: AgentTool<typeof slowParameters, Record<string, never>> = {
			name: "slow",
			label: "slow",
			description: "Deterministic background test tool",
			parameters: slowParameters,
			execute: async (_toolCallId, args) => {
				if (args.task === "a") {
					await slowACompletion;
					return { content: [{ type: "text" as const, text: "slow a completed" }], details: {} };
				}
				await slowBCompletion;
				return {
					content: [{ type: "text" as const, text: "slow b failed" }],
					details: {},
					isError: true,
				};
			},
		};
		const fastTool: AgentTool<typeof fastParameters, Record<string, never>> = {
			name: "fast",
			label: "fast",
			description: "Deterministic foreground test tool",
			parameters: fastParameters,
			execute: async (toolCallId) => {
				foregroundExecutions.push(toolCallId);
				return { content: [{ type: "text" as const, text: "fast foreground completed" }], details: {} };
			},
		};
		const harness = createHarness({
			baseToolsOverride: { slow: slowTool, fast: fastTool },
			responses: [
				{
					toolCalls: [
						{ id: "slow-a-call", name: "slow", args: { task: "a" } },
						{ id: "fast-call", name: "fast", args: {} },
						{ id: "slow-b-call", name: "slow", args: { task: "b" } },
					],
				},
				"foreground continued after the two handoffs",
				"failed background terminal acknowledged",
				"completed background terminal acknowledged",
			],
		});
		harness.session.setActiveToolsByName(["slow", "fast", "tool_task"]);
		harness.agent.backgroundToolCallAfterMs = 5;
		const terminalHandoffs: string[] = [];
		let slowATaskId = "";
		let slowBTaskId = "";
		let acknowledgeSlowB!: () => void;
		const slowBAcknowledged = new Promise<void>((resolve) => {
			acknowledgeSlowB = resolve;
		});
		let acknowledgeSlowA!: () => void;
		const slowAAcknowledged = new Promise<void>((resolve) => {
			acknowledgeSlowA = resolve;
		});
		const unsubscribe = harness.session.subscribe((event) => {
			if (
				event.type !== "message_end" ||
				event.message.role !== "custom" ||
				event.message.customType !== "background-tool-completion"
			) {
				return;
			}
			const content =
				typeof event.message.content === "string"
					? event.message.content
					: event.message.content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("\n");
			terminalHandoffs.push(content);
			if (slowBTaskId && content.includes(slowBTaskId)) acknowledgeSlowB();
			if (slowATaskId && content.includes(slowATaskId)) acknowledgeSlowA();
		});

		try {
			await harness.session.prompt("run mixed foreground and background work");
			expect(foregroundExecutions).toEqual(["fast-call"]);
			expect(harness.faux.callCount).toBe(2);

			const runningRecords = harness.sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === BACKGROUND_TOOL_TASK_CUSTOM_TYPE
						? [entry.data as BackgroundToolTaskRecord]
						: [],
				)
				.filter((record) => record.status === "running");
			const taskA = runningRecords.find((record) => record.toolCallId === "slow-a-call");
			const taskB = runningRecords.find((record) => record.toolCallId === "slow-b-call");
			expect(taskA).toMatchObject({ sessionId: harness.session.sessionId, status: "running" });
			expect(taskB).toMatchObject({ sessionId: harness.session.sessionId, status: "running" });
			if (!taskA || !taskB) throw new Error("Expected both slow calls to be handed off");
			slowATaskId = taskA.taskId;
			slowBTaskId = taskB.taskId;

			releaseSlowB();
			await Promise.race([
				slowBAcknowledged,
				new Promise<never>((_resolve, reject) =>
					setTimeout(() => reject(new Error("slow B terminal notification timed out")), 1_000),
				),
			]);
			releaseSlowA();
			await Promise.race([
				slowAAcknowledged,
				new Promise<never>((_resolve, reject) =>
					setTimeout(() => reject(new Error("slow A terminal notification timed out")), 1_000),
				),
			]);

			expect(terminalHandoffs).toHaveLength(2);
			expect(terminalHandoffs.every((handoff) => handoff.includes("Parent woke."))).toBe(true);
			expect(terminalHandoffs[0]).toContain(`${taskB?.taskId}: failed tool=slow`);
			expect(terminalHandoffs[1]).toContain(`${taskA?.taskId}: completed tool=slow`);
			const terminals = harness.sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === BACKGROUND_TOOL_TASK_CUSTOM_TYPE
						? [entry.data as BackgroundToolTaskRecord]
						: [],
				)
				.filter((record) => record.status !== "running");
			expect(terminals).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ taskId: taskA?.taskId, toolCallId: "slow-a-call", status: "completed" }),
					expect.objectContaining({ taskId: taskB?.taskId, toolCallId: "slow-b-call", status: "failed" }),
				]),
			);
		} finally {
			unsubscribe();
			releaseSlowA();
			releaseSlowB();
			harness.cleanup();
		}
	});

	it("isolates colliding background task IDs for two sessions sharing one cwd", async () => {
		let releaseA!: () => void;
		const completionA = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		let releaseB!: () => void;
		const completionB = new Promise<void>((resolve) => {
			releaseB = resolve;
		});
		const sessionTool = (
			completion: Promise<void>,
			output: string,
		): AgentTool<typeof slowParameters, Record<string, never>> => ({
			name: "slow",
			label: "slow",
			description: "Deterministic session-owned background tool",
			parameters: slowParameters,
			execute: async () => {
				await completion;
				return { content: [{ type: "text" as const, text: output }], details: {} };
			},
		});
		const harnessA = createHarness({
			baseToolsOverride: { slow: sessionTool(completionA, "session A completed") },
			responses: [{ toolCalls: [{ id: "shared-call-a", name: "slow", args: {} }] }, "A foreground continued"],
		});
		const harnessB = createHarness({
			cwd: harnessA.tempDir,
			baseToolsOverride: { slow: sessionTool(completionB, "session B completed") },
			responses: [
				{ toolCalls: [{ id: "shared-call-b", name: "slow", args: {} }] },
				"B foreground continued",
				"B terminal acknowledged",
			],
		});
		harnessA.session.setActiveToolsByName(["slow", "tool_task"]);
		harnessB.session.setActiveToolsByName(["slow", "tool_task"]);
		harnessA.agent.backgroundToolCallAfterMs = 5;
		harnessB.agent.backgroundToolCallAfterMs = 5;
		let acknowledgeBTerminal!: () => void;
		const bTerminal = new Promise<void>((resolve) => {
			acknowledgeBTerminal = resolve;
		});
		const unsubscribeB = harnessB.session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.customType === "background-tool-completion"
			) {
				acknowledgeBTerminal();
			}
		});
		const recordsFor = (harness: typeof harnessA) =>
			harness.sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === BACKGROUND_TOOL_TASK_CUSTOM_TYPE
						? [entry.data as BackgroundToolTaskRecord]
						: [],
				);

		try {
			await Promise.all([
				harnessA.session.prompt("start session A background work"),
				harnessB.session.prompt("start session B background work"),
			]);
			expect(harnessA.session.sessionId).not.toBe(harnessB.session.sessionId);
			expect(recordsFor(harnessA)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ taskId: "tool-task-1", toolCallId: "shared-call-a", status: "running" }),
				]),
			);
			expect(recordsFor(harnessB)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ taskId: "tool-task-1", toolCallId: "shared-call-b", status: "running" }),
				]),
			);

			await harnessA.session.disposeAndWait();
			releaseB();
			await Promise.race([
				bTerminal,
				new Promise<never>((_resolve, reject) =>
					setTimeout(() => reject(new Error("session B terminal notification timed out")), 1_000),
				),
			]);

			const aRecords = recordsFor(harnessA);
			const bRecords = recordsFor(harnessB);
			expect(aRecords.every((record) => record.sessionId === harnessA.session.sessionId)).toBe(true);
			expect(bRecords.every((record) => record.sessionId === harnessB.session.sessionId)).toBe(true);
			expect(aRecords).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ taskId: "tool-task-1", toolCallId: "shared-call-a", status: "canceled" }),
				]),
			);
			expect(bRecords).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ taskId: "tool-task-1", toolCallId: "shared-call-b", status: "completed" }),
				]),
			);
			expect(
				harnessA
					.eventsOfType("message_end")
					.filter(
						(event) =>
							event.message.role === "custom" && event.message.customType === "background-tool-completion",
					),
			).toHaveLength(0);
			expect(
				harnessB
					.eventsOfType("message_end")
					.filter(
						(event) =>
							event.message.role === "custom" && event.message.customType === "background-tool-completion",
					),
			).toHaveLength(1);
		} finally {
			unsubscribeB();
			releaseA();
			releaseB();
			await harnessB.cleanup();
			await harnessA.cleanup();
		}
	});

	it("does not buy a late provider call for a terminal whose owning goal was superseded during preflight", async () => {
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
			],
		});
		harness.session.setActiveToolsByName(["slow", "tool_task"]);
		harness.agent.backgroundToolCallAfterMs = 5;
		let sawRunning = false;
		let markTaskTerminal: (() => void) | undefined;
		const taskTerminal = new Promise<void>((resolve) => {
			markTaskTerminal = resolve;
		});
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "background_tools") {
				if (event.tasks.length > 0) sawRunning = true;
				if (sawRunning && event.tasks.length === 0) markTaskTerminal?.();
			}
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
			expect(harness.faux.callCount).toBe(3);
			expect(JSON.stringify(harness.faux.contexts[2]?.messages)).not.toContain("Background tool terminal handoff");
		} finally {
			unsubscribe();
			releaseSlow?.();
			releasePreflight?.();
			harness.cleanup();
		}
	});

	it("still rides the owning turn's own next provider call when the terminal is ready first, buying no extra call", async () => {
		// The sibling test above proves the boundary route correctly DECLINES to fold into an
		// unrelated turn. This proves the fix did not silently degrade into "never fold": a task
		// that goes terminal while the SAME turn that started it is still running must still ride
		// that turn's own next provider call -- the latency optimization the boundary route exists
		// for -- with no separate call bought just to deliver the news. Gates on `shouldStopAfterTurn`
		// (same technique as "injects a terminal into the next provider boundary of the same
		// multi-request run" above) rather than a timer/event race: that hook is the one point
		// guaranteed to run between this turn's own calls, after backgrounding and before the next
		// request is built, so releasing the task there is deterministic instead of racing however
		// fast the tool loop happens to move on its own.
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
			responses: [{ toolCalls: [{ id: "slow-call", name: "slow", args: {} }] }, "foreground continued"],
		});
		harness.session.setActiveToolsByName(["slow", "tool_task"]);
		harness.agent.backgroundToolCallAfterMs = 5;

		let markTaskTerminal: (() => void) | undefined;
		const taskTerminal = new Promise<void>((resolve) => {
			markTaskTerminal = resolve;
		});
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "background_tools" && event.tasks.length === 0) markTaskTerminal?.();
		});

		const previousShouldStopAfterTurn = harness.agent.shouldStopAfterTurn?.bind(harness.agent);
		let stopCheckCount = 0;
		harness.agent.shouldStopAfterTurn = async (signal) => {
			const shouldStop = (await previousShouldStopAfterTurn?.(signal)) ?? false;
			stopCheckCount++;
			if (stopCheckCount === 1) {
				releaseSlow?.();
				await taskTerminal;
			}
			return shouldStop;
		};

		try {
			await harness.session.prompt("start slow work");

			// No extra provider call bought for the handoff: exactly the two responses this turn's
			// own tool loop needed -- the slow toolCall, then its own continuation -- nothing more.
			expect(harness.faux.callCount).toBe(2);
			expect(JSON.stringify(harness.faux.contexts[1]?.messages)).toContain("Background tool terminal handoff");
		} finally {
			unsubscribe();
			releaseSlow?.();
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
