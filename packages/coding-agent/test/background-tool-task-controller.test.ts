import type { AgentContext, BackgroundToolCallCompletion, BackgroundToolCallContext } from "@caupulican/pi-agent-core";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	BackgroundToolTaskController,
	type BackgroundToolTaskRecord,
	createBackgroundToolTerminalMessage,
} from "../src/core/background-tool-task-controller.ts";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "slow", arguments: { value: "x" } }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function controlledContext(toolCallId = "call-1") {
	let resolveCompletion: ((completion: BackgroundToolCallCompletion) => void) | undefined;
	const completion = new Promise<BackgroundToolCallCompletion>((resolve) => {
		resolveCompletion = resolve;
	});
	const assistant = assistantMessage();
	const toolCall = { type: "toolCall" as const, id: toolCallId, name: "slow", arguments: { value: "x" } };
	const context: BackgroundToolCallContext = {
		assistantMessage: assistant,
		toolCall,
		args: toolCall.arguments,
		context: { systemPrompt: "", messages: [], tools: [] } satisfies AgentContext,
		elapsedMs: 15_000,
		completion,
		cancel: vi.fn(),
	};
	return { context, resolveCompletion: resolveCompletion! };
}

function createHarness(sessionId: string) {
	const persisted: BackgroundToolTaskRecord[] = [];
	const notifications: BackgroundToolTaskRecord[] = [];
	const wakeSignals: boolean[] = [];
	const liveSignals: string[][] = [];
	const artifactStore = createInMemoryArtifactStore();
	const controller = new BackgroundToolTaskController({
		getSessionId: () => sessionId,
		getArtifactStore: () => artifactStore,
		persist: (record) => persisted.push(record),
		notifyTerminal: async (records, options) => {
			notifications.push(...records);
			wakeSignals.push(options.wakeParent);
		},
		onLiveTasksChanged: (tasks) => liveSignals.push(tasks.map((task) => task.taskId)),
	});
	return { controller, artifactStore, persisted, notifications, wakeSignals, liveSignals };
}

describe("BackgroundToolTaskController", () => {
	it("bounds a batched terminal handoff while retaining exact task identities", () => {
		const records = Array.from(
			{ length: 12 },
			(_, index): BackgroundToolTaskRecord => ({
				sessionId: "session-a",
				taskId: `tool-task-${index + 1}`,
				toolCallId: `call-${index + 1}`,
				toolName: "slow",
				status: "completed",
				startedAt: "2026-08-01T12:00:00.000Z",
				completedAt: "2026-08-01T12:00:01.000Z",
				elapsedBeforeHandoffMs: 15_000,
				summary: "slow completed",
				output: "retained outside the terminal handoff",
			}),
		);

		const message = createBackgroundToolTerminalMessage(records);
		expect(message.details.records.map((record) => record.taskId)).toEqual(
			Array.from({ length: 8 }, (_, index) => `tool-task-${index + 1}`),
		);
		expect(message.content).toContain("4 additional terminal tool task(s) omitted");
		expect(message.content).not.toContain("tool-task-9:");
		expect(message.content).toContain("tool_task action=wait");
	});

	it("owns task identity and terminal output per session", async () => {
		const first = createHarness("session-a");
		const second = createHarness("session-b");
		const firstCall = controlledContext("call-a");
		const secondCall = controlledContext("call-b");

		const firstHandoff = first.controller.handoff(firstCall.context);
		const secondHandoff = second.controller.handoff(secondCall.context);

		expect(firstHandoff?.result.details).toMatchObject({ taskId: "tool-task-1", sessionId: "session-a" });
		expect(secondHandoff?.result.details).toMatchObject({ taskId: "tool-task-1", sessionId: "session-b" });
		expect(first.controller.list()).toHaveLength(1);
		expect(second.controller.list()).toHaveLength(1);
		expect(first.liveSignals).toEqual([["tool-task-1"]]);

		let waitSettled = false;
		const waited = first.controller.wait("tool-task-1").then((record) => {
			waitSettled = true;
			return record;
		});
		await Promise.resolve();
		expect(waitSettled).toBe(false);

		const largeOutput = "line of useful output\n".repeat(5000);
		firstCall.resolveCompletion({
			toolCall: firstCall.context.toolCall,
			result: { content: [{ type: "text", text: largeOutput }], details: { ignored: largeOutput } },
			isError: false,
		});
		const terminal = await waited;
		await first.controller.waitForNotifications();

		expect(terminal).toMatchObject({
			taskId: "tool-task-1",
			sessionId: "session-a",
			status: "completed",
			artifactId: expect.any(String),
		});
		expect(terminal.output.length).toBeLessThan(40_000);
		expect(terminal.output).toContain("Full output: artifact tool-output:");
		expect(first.artifactStore.read(terminal.artifactId!)).toMatchObject({ content: largeOutput });
		expect(first.persisted.map((record) => record.status)).toEqual(["running", "completed"]);
		expect(first.notifications).toEqual([terminal]);
		expect(first.wakeSignals).toEqual([false]);
		expect(first.liveSignals.at(-1)).toEqual([]);
		expect(second.controller.list()[0]).toMatchObject({ status: "running", toolCallId: "call-b" });

		await first.controller.shutdown();
		await second.controller.shutdown();
	});

	it("delivers manual handoff requests as an event without polling", () => {
		const { controller } = createHarness("session-a");
		const first = vi.fn();
		const second = vi.fn();
		const unsubscribeFirst = controller.subscribeHandoffRequest("call-a", first);
		controller.subscribeHandoffRequest("call-b", second);

		expect(controller.requestHandoff("call-a")).toBe(1);
		expect(first).toHaveBeenCalledOnce();
		expect(second).not.toHaveBeenCalled();
		unsubscribeFirst();
		expect(controller.requestHandoff()).toBe(1);
		expect(second).toHaveBeenCalledOnce();
	});

	it("declines handoff when the initial durable session record cannot be written", () => {
		const errors: string[] = [];
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => undefined,
			persist: () => {
				throw new Error("disk full");
			},
			notifyTerminal: vi.fn(),
			onError: (message) => errors.push(message),
		});
		const call = controlledContext();

		expect(controller.handoff(call.context)).toBeUndefined();
		expect(controller.list()).toEqual([]);
		expect(errors).toEqual(["Failed to persist background tool task tool-task-1"]);
	});

	it("cancels only the addressed session task", async () => {
		const { controller } = createHarness("session-a");
		const call = controlledContext();
		controller.handoff(call.context);

		expect(controller.cancel("tool-task-1")).toBe(true);
		expect(call.context.cancel).toHaveBeenCalledOnce();
		expect(controller.cancel("missing")).toBe(false);

		call.resolveCompletion({
			toolCall: call.context.toolCall,
			result: { content: [{ type: "text", text: "Operation aborted" }], details: {} },
			isError: true,
		});
		await expect(controller.wait("tool-task-1")).resolves.toMatchObject({ status: "canceled" });
		await controller.shutdown();
	});

	it("wakes the owning session when completion has no event-driven waiter", async () => {
		const { controller, wakeSignals } = createHarness("session-a");
		const call = controlledContext();
		controller.handoff(call.context);

		call.resolveCompletion({
			toolCall: call.context.toolCall,
			result: { content: [{ type: "text", text: "done" }], details: {} },
			isError: false,
		});
		await controller.waitForNotifications();

		expect(wakeSignals).toEqual([true]);
		await controller.shutdown();
	});

	it("still wakes the owner when a dependency wait aborts immediately before completion", async () => {
		const { controller, wakeSignals } = createHarness("session-a");
		const call = controlledContext();
		controller.handoff(call.context);
		const abort = new AbortController();
		const wait = controller.wait("tool-task-1", abort.signal);

		call.resolveCompletion({
			toolCall: call.context.toolCall,
			result: { content: [{ type: "text", text: "done after abort" }], details: {} },
			isError: false,
		});
		abort.abort(new Error("foreground turn ended"));

		await expect(wait).resolves.toMatchObject({ status: "running", taskId: "tool-task-1" });
		await controller.waitForNotifications();
		expect(wakeSignals).toEqual([true]);
		await controller.shutdown();
	});

	it("serializes a terminal batch that arrives during an in-flight notification", async () => {
		let resolveFirstDeliveryStarted: (() => void) | undefined;
		const firstDeliveryStarted = new Promise<void>((resolve) => {
			resolveFirstDeliveryStarted = resolve;
		});
		let releaseFirstDelivery: (() => void) | undefined;
		const firstDelivery = new Promise<void>((resolve) => {
			releaseFirstDelivery = resolve;
		});
		const batches: string[][] = [];
		let activeDeliveries = 0;
		let maxActiveDeliveries = 0;
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => undefined,
			persist: () => {},
			notifyTerminal: async (records) => {
				activeDeliveries++;
				maxActiveDeliveries = Math.max(maxActiveDeliveries, activeDeliveries);
				batches.push(records.map((record) => record.taskId));
				try {
					if (batches.length === 1) {
						resolveFirstDeliveryStarted?.();
						await firstDelivery;
					}
				} finally {
					activeDeliveries--;
				}
			},
		});
		const first = controlledContext("call-first");
		const second = controlledContext("call-second");
		controller.handoff(first.context);
		controller.handoff(second.context);

		first.resolveCompletion({
			toolCall: first.context.toolCall,
			result: { content: [{ type: "text", text: "first done" }], details: {} },
			isError: false,
		});
		await firstDeliveryStarted;

		const secondTerminal = controller.wait("tool-task-2");
		second.resolveCompletion({
			toolCall: second.context.toolCall,
			result: { content: [{ type: "text", text: "second done" }], details: {} },
			isError: false,
		});
		await secondTerminal;
		expect(batches).toEqual([["tool-task-1"]]);

		releaseFirstDelivery?.();
		await controller.waitForNotifications();
		expect(batches).toEqual([["tool-task-1"], ["tool-task-2"]]);
		expect(maxActiveDeliveries).toBe(1);
		await controller.shutdown();
	});

	it("restores only the admitted session lineage and deterministically closes orphaned running tasks", async () => {
		const completed: BackgroundToolTaskRecord = {
			sessionId: "parent-session",
			taskId: "tool-task-3",
			toolCallId: "call-completed",
			toolName: "slow",
			status: "completed",
			startedAt: "2026-08-01T12:00:00.000Z",
			completedAt: "2026-08-01T12:00:02.000Z",
			elapsedBeforeHandoffMs: 15_000,
			summary: "slow completed: retained output",
			output: "retained output",
		};
		const orphaned: BackgroundToolTaskRecord = {
			...completed,
			taskId: "tool-task-4",
			toolCallId: "call-orphaned",
			status: "running",
			completedAt: undefined,
			summary: "slow running in the background",
			output: "",
		};
		const persisted: BackgroundToolTaskRecord[] = [];
		const notifications: BackgroundToolTaskRecord[] = [];
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "forked-session",
			getSessionLineageIds: () => ["forked-session", "parent-session"],
			getArtifactStore: () => undefined,
			loadPersistedRecordsNewestFirst: () => [
				{ ...completed, sessionId: "another-session", taskId: "tool-task-99" },
				{ ...completed, taskId: `tool-task-${"9".repeat(400)}` },
				{ invalid: true },
				orphaned,
				completed,
			],
			persist: (record) => persisted.push(record),
			notifyTerminal: (records) => {
				notifications.push(...records);
			},
		});

		expect(controller.list()).toEqual([
			expect.objectContaining({ taskId: "tool-task-3", status: "completed", output: "retained output" }),
			expect.objectContaining({
				taskId: "tool-task-4",
				status: "failed",
				output: expect.stringContaining("owning process ended"),
			}),
		]);
		expect(persisted).toEqual([expect.objectContaining({ taskId: "tool-task-4", status: "failed" })]);
		expect(notifications).toEqual([]);

		const call = controlledContext("call-new");
		expect(controller.handoff(call.context)?.result.details).toMatchObject({
			sessionId: "forked-session",
			taskId: "tool-task-5",
		});
		await controller.shutdown();
	});
});
