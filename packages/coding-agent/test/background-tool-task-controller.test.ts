import type { AgentContext, BackgroundToolCallCompletion, BackgroundToolCallContext } from "@caupulican/pi-agent-core";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	BackgroundToolTaskController,
	type BackgroundToolTaskRecord,
	collectCitedRunningToolTaskIds,
	createBackgroundToolTerminalMessage,
	findBackgroundToolTask,
	isCompletedBackgroundToolEvidence,
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
	// Origin: session 01a058a5. `tool_task list` showed `…"tool":"bash","failure_code` — the record was
	// head-truncated mid-key, so the only field that says why the task failed was the field it lost.
	it("projects the cause out of a harness failure record instead of truncating its bookkeeping", async () => {
		const { controller, persisted } = createHarness("session-a");
		const call = controlledContext("call-1");
		controller.handoff(call.context);

		call.resolveCompletion({
			toolCall: call.context.toolCall,
			result: {
				content: [
					{
						type: "text",
						text: `[harness] ${JSON.stringify({
							MUST: true,
							failure_key: "bash:915721df0e58130b2c4b4d73f8df5071",
							occ: 1,
							kind_mistakes: 1,
							mistake_kind: "bash",
							state: "failed",
							phase: "timeout",
							tool: "bash",
							failure_code: "timeout",
							next_action: "Operation timed out. Narrow/split work.",
						})}`,
					},
				],
				details: {},
			},
			isError: true,
		});
		await controller.waitForNotifications();

		const summary = persisted.at(-1)?.summary ?? "";
		expect(summary).toContain("failure_code=timeout");
		expect(summary).toContain("phase=timeout");
		// Harness bookkeeping never gets to crowd out the cause.
		expect(summary).not.toContain("MUST");
		expect(summary).not.toContain("kind_mistakes");
		expect(summary).not.toContain("failure_key");
		await controller.shutdown();
	});

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
		expect(first.persisted.map((record) => record.status)).toEqual(["running", "completed", "completed"]);
		expect(first.notifications).toEqual([terminal]);
		expect(first.wakeSignals).toEqual([false]);
		expect(first.liveSignals.at(-1)).toEqual([]);
		expect(second.controller.list()[0]).toMatchObject({ status: "running", toolCallId: "call-b" });

		await first.controller.shutdown();
		await second.controller.shutdown();
	});

	it("persists the authoritative goal execution identity on every handed-off tool edge", async () => {
		const persisted: BackgroundToolTaskRecord[] = [];
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getGoalId: () => "goal-owning-tool",
			getArtifactStore: () => undefined,
			persist: (record) => persisted.push(record),
			notifyTerminal: vi.fn(),
		});
		const call = controlledContext();

		controller.handoff(call.context);
		expect(persisted[0]).toMatchObject({
			taskId: "tool-task-1",
			status: "running",
			goalId: "goal-owning-tool",
		});

		call.resolveCompletion({
			toolCall: call.context.toolCall,
			result: { content: [{ type: "text", text: "done" }], details: {} },
			isError: false,
		});
		await controller.waitForNotifications();
		expect(persisted.at(-1)).toMatchObject({
			taskId: "tool-task-1",
			status: "completed",
			goalId: "goal-owning-tool",
		});
		await controller.shutdown();
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

	it("retries terminal delivery after notifyTerminal rejects without dropping the persisted terminal", async () => {
		vi.useFakeTimers();
		const persisted: BackgroundToolTaskRecord[] = [];
		const delivered: BackgroundToolTaskRecord[] = [];
		const notifyTerminal = vi
			.fn<(records: readonly BackgroundToolTaskRecord[]) => Promise<void>>()
			.mockRejectedValueOnce(new Error("temporary handoff failure"))
			.mockResolvedValue(undefined);
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => undefined,
			persist: (record) => persisted.push(record),
			notifyTerminal: (records) => {
				delivered.push(...records);
				return notifyTerminal(records);
			},
		});
		const call = controlledContext();
		controller.handoff(call.context);
		call.resolveCompletion({
			toolCall: call.context.toolCall,
			result: { content: [{ type: "text", text: "done" }], details: {} },
			isError: false,
		});

		await vi.runAllTimersAsync();
		await controller.waitForNotifications();

		expect(notifyTerminal).toHaveBeenCalledTimes(2);
		expect(delivered).toHaveLength(2);
		expect(delivered[0]).toMatchObject({ taskId: "tool-task-1", status: "completed" });
		expect(delivered[1]).toMatchObject({ taskId: "tool-task-1", status: "completed" });
		expect(persisted).toEqual([
			expect.objectContaining({ taskId: "tool-task-1", status: "running" }),
			expect.objectContaining({ taskId: "tool-task-1", status: "completed" }),
			expect.objectContaining({ taskId: "tool-task-1", status: "completed", terminalDelivery: "delivered" }),
		]);
		await controller.shutdown();
	});

	it("marks a terminal event observed when tool_task list views it before delivery", async () => {
		let releaseDelivery!: () => void;
		const deliveryGate = new Promise<void>((resolve) => {
			releaseDelivery = resolve;
		});
		const delivered: BackgroundToolTaskRecord[] = [];
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => undefined,
			persist: () => {},
			notifyTerminal: async (records) => {
				await deliveryGate;
				delivered.push(...records);
			},
		});
		const call = controlledContext();
		controller.handoff(call.context);
		call.resolveCompletion({
			toolCall: call.context.toolCall,
			result: { content: [{ type: "text", text: "done" }], details: {} },
			isError: false,
		});
		await Promise.resolve();
		await Promise.resolve();

		const observed = controller.observe();
		releaseDelivery();
		await controller.waitForNotifications();

		expect(observed).toEqual([expect.objectContaining({ taskId: "tool-task-1", status: "completed" })]);
		expect(delivered).toEqual([expect.objectContaining({ taskId: "tool-task-1", observedAt: expect.any(String) })]);
		await controller.shutdown();
	});

	it("never publishes a successful completion or passing verification when its terminal record was not durable", async () => {
		const notifications: BackgroundToolTaskRecord[] = [];
		let writes = 0;
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => undefined,
			persist: () => {
				writes++;
				if (writes > 1) throw new Error("terminal write failed");
			},
			notifyTerminal: (records) => {
				notifications.push(...records);
			},
			onError: vi.fn(),
		});
		const call = controlledContext();
		controller.handoff(call.context);
		call.resolveCompletion({
			toolCall: call.context.toolCall,
			result: {
				content: [{ type: "text", text: "successful process output" }],
				details: { piVerification: { version: 1, id: "verify-undurable", status: "passed" } },
			},
			isError: false,
		});
		await controller.waitForNotifications();

		expect(controller.list()).toEqual([
			expect.objectContaining({
				status: "failed",
				output: expect.stringContaining("could not be persisted"),
			}),
		]);
		expect(notifications).toEqual([expect.objectContaining({ status: "failed" })]);
		expect(controller.list()[0]?.piVerification).toBeUndefined();
		expect(notifications[0]?.piVerification).toBeUndefined();
		await controller.shutdown();
	});

	it("drops contradictory passing verification from failed, canceled, and restored background terminals", async () => {
		const notifications: BackgroundToolTaskRecord[] = [];
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => undefined,
			persist: () => {},
			notifyTerminal: (records) => {
				notifications.push(...records);
			},
		});
		const failed = controlledContext("call-failed-pass");
		const canceled = controlledContext("call-canceled-pass");
		controller.handoff(failed.context);
		controller.handoff(canceled.context);
		controller.cancel("tool-task-2");
		failed.resolveCompletion({
			toolCall: failed.context.toolCall,
			result: {
				content: [{ type: "text", text: "failed process" }],
				details: { piVerification: { version: 1, id: "verify-contradictory", status: "passed" } },
			},
			isError: true,
		});
		canceled.resolveCompletion({
			toolCall: canceled.context.toolCall,
			result: {
				content: [{ type: "text", text: "canceled process" }],
				details: { piVerification: { version: 1, id: "verify-canceled", status: "passed" } },
			},
			isError: false,
		});
		await controller.waitForNotifications();

		expect(controller.list().map((record) => [record.status, record.piVerification])).toEqual([
			["failed", undefined],
			["canceled", undefined],
		]);
		expect(notifications.map((record) => [record.status, record.piVerification])).toEqual([
			["failed", undefined],
			["canceled", undefined],
		]);
		await controller.shutdown();

		const restoredNotifications: BackgroundToolTaskRecord[] = [];
		const restored = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => undefined,
			loadPersistedRecordsNewestFirst: () => [
				{
					sessionId: "session-a",
					taskId: "tool-task-7",
					toolCallId: "call-restored",
					toolName: "slow",
					status: "failed",
					startedAt: "2026-08-21T20:00:00.000Z",
					completedAt: "2026-08-21T20:00:01.000Z",
					elapsedBeforeHandoffMs: 15_000,
					summary: "slow failed",
					output: "failed",
					terminalDelivery: "pending",
					piVerification: {
						version: 1,
						id: "verify-restored-contradictory",
						status: "passed",
						originTaskId: "tool-task-7",
					},
				},
				{
					sessionId: "session-a",
					taskId: "tool-task-8",
					toolCallId: "call-restored-legacy",
					toolName: "slow",
					status: "completed",
					startedAt: "2026-08-21T20:00:00.000Z",
					completedAt: "2026-08-21T20:00:01.000Z",
					elapsedBeforeHandoffMs: 15_000,
					summary: "slow completed",
					output: "passed",
					terminalDelivery: "pending",
					piVerification: { version: 1, id: "verify-restored-legacy", status: "passed" },
				},
			],
			persist: () => {},
			notifyTerminal: (records) => {
				restoredNotifications.push(...records);
			},
		});
		await restored.waitForNotifications();
		expect(restored.list().map((record) => record.piVerification)).toEqual([undefined, undefined]);
		expect(restoredNotifications.map((record) => record.piVerification)).toEqual([undefined, undefined]);
		await restored.shutdown();
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

	it("replays only an explicitly pending terminal after restart", async () => {
		const pending: BackgroundToolTaskRecord = {
			sessionId: "session-a",
			taskId: "tool-task-7",
			toolCallId: "call-pending",
			toolName: "slow",
			goalId: "goal-restored",
			status: "completed",
			startedAt: "2026-08-01T12:00:00.000Z",
			completedAt: "2026-08-01T12:00:02.000Z",
			elapsedBeforeHandoffMs: 15_000,
			summary: "slow completed",
			output: "retained output",
			terminalDelivery: "pending",
		};
		const foreignPending: BackgroundToolTaskRecord = {
			...pending,
			sessionId: "session-b",
			taskId: "tool-task-8",
			toolCallId: "call-foreign-pending",
		};
		const delivered: BackgroundToolTaskRecord[] = [];
		const persisted: BackgroundToolTaskRecord[] = [];
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => undefined,
			loadPersistedRecordsNewestFirst: () => [foreignPending, pending],
			persist: (record) => persisted.push(record),
			notifyTerminal: (records) => {
				delivered.push(...records);
			},
		});

		await controller.waitForNotifications();

		expect(delivered).toEqual([
			expect.objectContaining({
				taskId: "tool-task-7",
				goalId: "goal-restored",
				terminalDelivery: "pending",
			}),
		]);
		expect(persisted).toEqual([expect.objectContaining({ taskId: "tool-task-7", terminalDelivery: "delivered" })]);
		expect(delivered).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ taskId: "tool-task-8", sessionId: "session-b" })]),
		);
		await controller.shutdown();
	});

	it("does not replay delivered or legacy terminal records after restart", async () => {
		const delivered: BackgroundToolTaskRecord = {
			sessionId: "session-a",
			taskId: "tool-task-8",
			toolCallId: "call-delivered",
			toolName: "slow",
			status: "completed",
			startedAt: "2026-08-01T12:00:00.000Z",
			completedAt: "2026-08-01T12:00:02.000Z",
			elapsedBeforeHandoffMs: 15_000,
			summary: "slow completed",
			output: "retained output",
			terminalDelivery: "delivered",
		};
		const legacy = { ...delivered, taskId: "tool-task-9", toolCallId: "call-legacy" };
		delete (legacy as Partial<BackgroundToolTaskRecord>).terminalDelivery;
		const notifyTerminal = vi.fn();
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => undefined,
			loadPersistedRecordsNewestFirst: () => [delivered, legacy],
			persist: vi.fn(),
			notifyTerminal,
		});

		await controller.waitForNotifications();

		expect(notifyTerminal).not.toHaveBeenCalled();
		await controller.shutdown();
	});

	it("does not hot-loop on a permanent terminal notification failure during shutdown", async () => {
		const notifyTerminal = vi.fn(async () => {
			throw new Error("handoff unavailable");
		});
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => undefined,
			persist: vi.fn(),
			notifyTerminal,
		});
		const call = controlledContext();
		controller.handoff(call.context);
		call.resolveCompletion({
			toolCall: call.context.toolCall,
			result: { content: [{ type: "text", text: "done" }], details: {} },
			isError: false,
		});
		await Promise.resolve();
		await Promise.resolve();

		await controller.shutdown();

		expect(notifyTerminal).toHaveBeenCalledOnce();
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
	it("refuses to build a terminal handoff message with no records", () => {
		expect(() => createBackgroundToolTerminalMessage([])).toThrow(TypeError);
	});

	it("names the spilled artifact and tells an unwoken parent to wait for the owner", () => {
		const record: BackgroundToolTaskRecord = {
			sessionId: "session-a",
			taskId: "tool-task-1",
			toolCallId: "call-1",
			toolName: "slow",
			status: "completed",
			startedAt: "2026-08-01T12:00:00.000Z",
			completedAt: "2026-08-01T12:00:01.000Z",
			elapsedBeforeHandoffMs: 15_000,
			summary: "slow completed",
			output: "done",
			artifactId: "abc123",
		};

		const message = createBackgroundToolTerminalMessage([record], { wakeParent: false });

		expect(message.content).toContain("Parent was not woken because the owning goal is no longer active");
		expect(message.content).not.toContain("Parent woke");
		expect(message.details.records).toEqual([
			{ taskId: "tool-task-1", status: "completed", toolName: "slow", artifactId: "abc123" },
		]);
	});

	it("refuses a wait watchdog that could never fire", () => {
		expect(
			() =>
				new BackgroundToolTaskController({
					getSessionId: () => "session-a",
					getArtifactStore: () => undefined,
					persist: vi.fn(),
					notifyTerminal: vi.fn(),
					waitTimeoutMs: 0,
				}),
		).toThrow(TypeError);
	});

	it("never hands off the control tool itself, and hands off nothing after shutdown", async () => {
		const { controller } = createHarness("session-a");
		const control = controlledContext("call-control");
		control.context.toolCall.name = "tool_task";

		expect(controller.handoff(control.context)).toBeUndefined();
		expect(controller.list()).toEqual([]);

		await controller.shutdown();
		expect(controller.handoff(controlledContext("call-after").context)).toBeUndefined();
		expect(controller.subscribeHandoffRequest("call-after", vi.fn())()).toBeUndefined();
		expect(controller.requestHandoff("call-after")).toBe(0);
	});

	it("fails a background task whose tool call rejected instead of leaving it running", async () => {
		const { controller } = createHarness("session-a");
		const call = controlledContext();
		(call.context as { completion: Promise<BackgroundToolCallCompletion> }).completion = Promise.reject(
			new Error("spawn ENOENT"),
		);
		controller.handoff(call.context);

		await expect(controller.wait("tool-task-1")).resolves.toMatchObject({
			status: "failed",
			output: expect.stringContaining("spawn ENOENT"),
		});
		await controller.shutdown();
	});

	it("keeps a non-Error tool-call rejection readable in the failed record", async () => {
		const { controller } = createHarness("session-a");
		const call = controlledContext();
		(call.context as { completion: Promise<BackgroundToolCallCompletion> }).completion =
			Promise.reject("worker vanished");
		controller.handoff(call.context);

		await expect(controller.wait("tool-task-1")).resolves.toMatchObject({
			status: "failed",
			output: expect.stringContaining("worker vanished"),
		});
		await controller.shutdown();
	});

	it("still records a requested cancellation when the canceller itself throws", async () => {
		const errors: string[] = [];
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => undefined,
			persist: vi.fn(),
			notifyTerminal: vi.fn(),
			onError: (message) => errors.push(message),
		});
		const call = controlledContext();
		call.context.cancel = vi.fn(() => {
			throw new Error("child already reaped");
		});
		controller.handoff(call.context);

		expect(controller.cancel("tool-task-1")).toBe(true);
		expect(errors).toEqual(["Failed to cancel background tool task tool-task-1"]);
		expect(controller.list()).toEqual([expect.objectContaining({ cancellationRequested: true })]);

		call.resolveCompletion({
			toolCall: call.context.toolCall,
			result: { content: [{ type: "text", text: "aborted" }], details: {} },
			isError: true,
		});
		await expect(controller.wait("tool-task-1")).resolves.toMatchObject({ status: "canceled" });
		await controller.shutdown();
	});

	it("starts a usable session when the persisted task log cannot be read", async () => {
		const errors: string[] = [];
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => undefined,
			loadPersistedRecordsNewestFirst: () => {
				throw new Error("session file unreadable");
			},
			persist: vi.fn(),
			notifyTerminal: vi.fn(),
			onError: (message) => errors.push(message),
		});

		expect(errors).toEqual(["Failed to load persisted background tool tasks"]);
		expect(controller.list()).toEqual([]);
		expect(controller.handoff(controlledContext().context)).toMatchObject({
			result: { details: { taskId: "tool-task-1" } },
		});
		await controller.shutdown();
	});

	it("restores accountable usage and drops a record whose usage is malformed", async () => {
		const usage = {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
		};
		const base: BackgroundToolTaskRecord = {
			sessionId: "session-a",
			taskId: "tool-task-1",
			toolCallId: "call-1",
			toolName: "slow",
			status: "completed",
			startedAt: "2026-08-01T12:00:00.000Z",
			completedAt: "2026-08-01T12:00:02.000Z",
			elapsedBeforeHandoffMs: 15_000,
			summary: "slow completed",
			output: "done",
			terminalDelivery: "delivered",
			usage,
		};
		const malformedCost = { ...base, taskId: "tool-task-2", toolCallId: "call-2", usage: { ...usage, cost: null } };
		const malformedField = {
			...base,
			taskId: "tool-task-3",
			toolCallId: "call-3",
			usage: { ...usage, totalTokens: Number.NaN },
		};
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => undefined,
			loadPersistedRecordsNewestFirst: () => [malformedField, malformedCost, base],
			persist: vi.fn(),
			notifyTerminal: vi.fn(),
		});

		expect(controller.list()).toEqual([expect.objectContaining({ taskId: "tool-task-1", usage })]);
		// The rejected ids are still consumed so a restored session cannot reissue them.
		expect(controller.handoff(controlledContext("call-new").context)).toMatchObject({
			result: { details: { taskId: "tool-task-4" } },
		});
		await controller.shutdown();
	});

	it("keeps running after a live-task subscriber throws", async () => {
		const errors: string[] = [];
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => undefined,
			persist: vi.fn(),
			notifyTerminal: vi.fn(),
			onLiveTasksChanged: () => {
				throw new Error("renderer detached");
			},
			onError: (message) => errors.push(message),
		});

		expect(controller.handoff(controlledContext().context)).toBeDefined();
		expect(errors).toEqual(["Failed to emit background tool task level signal"]);
		await controller.shutdown();
	});

	it("releases the artifact of a terminal task evicted by the retention bound", async () => {
		const removeReference = vi.fn(() => true);
		const cleanup = vi.fn(() => []);
		const records = Array.from({ length: 65 }, (_, index) => ({
			sessionId: "session-a",
			taskId: `tool-task-${index + 1}`,
			toolCallId: `call-${index + 1}`,
			toolName: "slow",
			status: "completed" as const,
			startedAt: "2026-08-01T12:00:00.000Z",
			completedAt: "2026-08-01T12:00:02.000Z",
			elapsedBeforeHandoffMs: 15_000,
			summary: "slow completed",
			output: "done",
			artifactId: `${index + 1}`.padStart(4, "0"),
			terminalDelivery: "delivered" as const,
		}));
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => ({ addReference: vi.fn(() => true), removeReference, cleanup }) as never,
			loadPersistedRecordsNewestFirst: () => records,
			persist: vi.fn(),
			notifyTerminal: vi.fn(),
		});

		expect(controller.list()).toHaveLength(64);
		expect(controller.list()[0]).toMatchObject({ taskId: "tool-task-2" });
		expect(removeReference).toHaveBeenCalledWith("0001", "background-tool-task:session-a:tool-task-1");
		expect(cleanup).toHaveBeenCalledOnce();
		await controller.shutdown();
	});
	it("matches evidence by task id or tool call id and reports no verdict for an unknown uri", () => {
		const refs = [
			{ taskId: "tool-task-1", toolCallId: "call-1", status: "running" as const },
			{ taskId: "tool-task-2", toolCallId: "call-2", status: "completed" as const },
			{ taskId: "tool-task-3", toolCallId: "call-3", status: "failed" as const },
		];

		expect(findBackgroundToolTask(refs, " call-2 ")).toMatchObject({ taskId: "tool-task-2" });
		expect(findBackgroundToolTask(refs, "   ")).toBeUndefined();
		expect(isCompletedBackgroundToolEvidence(refs, "tool-task-2")).toBe(true);
		expect(isCompletedBackgroundToolEvidence(refs, "call-3")).toBe(false);
		expect(isCompletedBackgroundToolEvidence(refs, "tool-task-missing")).toBeUndefined();
		expect(
			collectCitedRunningToolTaskIds({ records: refs, uris: ["call-1", "tool-task-1", "call-2", "nope"] }),
		).toEqual(["tool-task-1"]);
	});

	it("keeps image output out of the transcript and names a silent completion", async () => {
		const { controller } = createHarness("session-a");
		const withImage = controlledContext("call-image");
		const silent = controlledContext("call-silent");
		controller.handoff(withImage.context);
		controller.handoff(silent.context);

		withImage.resolveCompletion({
			toolCall: withImage.context.toolCall,
			result: {
				content: [
					{ type: "text", text: "chart rendered" },
					{ type: "image", data: "aGk=", mimeType: "image/png" },
				],
				details: {},
			},
			isError: false,
		});
		silent.resolveCompletion({
			toolCall: silent.context.toolCall,
			result: { content: [], details: {} },
			isError: false,
		});

		await expect(controller.wait("tool-task-1")).resolves.toMatchObject({
			output: "chart rendered\n[Image output retained outside the foreground transcript]",
		});
		await expect(controller.wait("tool-task-2")).resolves.toMatchObject({
			output: "Tool completed without text output.",
		});
		await controller.shutdown();
	});

	it("rejects a wait for an unknown task and returns the live snapshot for an already-aborted one", async () => {
		const { controller } = createHarness("session-a");
		const call = controlledContext();
		controller.handoff(call.context);
		const aborted = new AbortController();
		aborted.abort();

		await expect(controller.wait("tool-task-missing")).rejects.toThrow(
			"Unknown background tool task: tool-task-missing",
		);
		await expect(controller.wait("tool-task-1", aborted.signal)).resolves.toMatchObject({ status: "running" });
		await controller.shutdown();
	});

	it("reports a rejected tool call as canceled once cancellation was requested", async () => {
		let rejectCompletion!: (error: unknown) => void;
		const { controller } = createHarness("session-a");
		const call = controlledContext();
		(call.context as { completion: Promise<BackgroundToolCallCompletion> }).completion = new Promise((_, reject) => {
			rejectCompletion = reject;
		});
		controller.handoff(call.context);

		expect(controller.cancel("tool-task-1")).toBe(true);
		rejectCompletion(new Error("aborted by signal"));

		await expect(controller.wait("tool-task-1")).resolves.toMatchObject({
			status: "canceled",
			cancellationRequested: true,
		});
		await controller.shutdown();
	});

	it("accounts a completed background tool's usage against its task", async () => {
		const usage = {
			input: 40,
			output: 8,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 48,
			cost: { input: 0.4, output: 0.8, cacheRead: 0, cacheWrite: 0, total: 1.2 },
		};
		const recordUsage = vi.fn();
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => undefined,
			persist: vi.fn(),
			notifyTerminal: vi.fn(),
			recordUsage,
		});
		const call = controlledContext();
		controller.handoff(call.context);

		call.resolveCompletion({
			toolCall: call.context.toolCall,
			result: { content: [{ type: "text", text: "done" }], details: {}, usage },
			isError: false,
		});

		await expect(controller.wait("tool-task-1")).resolves.toMatchObject({ usage });
		expect(recordUsage).toHaveBeenCalledWith("tool-task-1", usage);
		await controller.shutdown();
	});

	it("restores the newest edge per task and refuses records that fail the durable record contract", async () => {
		const base = {
			sessionId: "session-a",
			toolCallId: "call-1",
			toolName: "slow",
			startedAt: "2026-08-01T12:00:00.000Z",
			completedAt: "2026-08-01T12:00:02.000Z",
			elapsedBeforeHandoffMs: 15_000,
			summary: "slow completed",
			output: "done",
			terminalDelivery: "delivered" as const,
		};
		const newest = { ...base, taskId: "tool-task-2", status: "completed" as const, output: "newest edge" };
		const stale = { ...base, taskId: "tool-task-2", status: "failed" as const, output: "stale edge" };
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => undefined,
			loadPersistedRecordsNewestFirst: () => [
				newest,
				stale,
				{ ...base, taskId: "tool-task-nine", status: "completed" as const },
				{ ...base, taskId: "tool-task-3", status: "completed" as const, usage: "not-a-record" },
				{ ...base, taskId: "tool-task-4", status: "completed" as const, elapsedBeforeHandoffMs: -1 },
				{ ...base, taskId: "tool-task-5", status: "completed" as const, completedAt: undefined },
				{ ...base, taskId: "tool-task-6", status: "completed" as const, artifactId: "not-hex!" },
				{ ...base, taskId: "tool-task-7", status: "completed" as const, piVerification: { version: 2 } },
				{ ...base, taskId: "tool-task-8", status: "completed" as const, unexpectedKey: true },
			],
			persist: vi.fn(),
			notifyTerminal: vi.fn(),
		});

		expect(controller.list()).toEqual([
			expect.objectContaining({ taskId: "tool-task-2", status: "completed", output: "newest edge" }),
		]);
		// A malformed id is not a task number, so it must not advance the session's id allocator.
		expect(controller.handoff(controlledContext("call-next").context)).toMatchObject({
			result: { details: { taskId: "tool-task-9" } },
		});
		await controller.shutdown();
	});

	it("evicts an artifact-free terminal task without touching the artifact store", async () => {
		const removeReference = vi.fn(() => true);
		const records = Array.from({ length: 65 }, (_, index) => ({
			sessionId: "session-a",
			taskId: `tool-task-${index + 1}`,
			toolCallId: `call-${index + 1}`,
			toolName: "slow",
			status: "completed" as const,
			startedAt: "2026-08-01T12:00:00.000Z",
			completedAt: "2026-08-01T12:00:02.000Z",
			elapsedBeforeHandoffMs: 15_000,
			summary: "slow completed",
			output: "done",
			terminalDelivery: "delivered" as const,
		}));
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () =>
				({ addReference: vi.fn(() => true), removeReference, cleanup: vi.fn(() => []) }) as never,
			loadPersistedRecordsNewestFirst: () => records,
			persist: vi.fn(),
			notifyTerminal: vi.fn(),
		});

		expect(controller.list()).toHaveLength(64);
		expect(removeReference).not.toHaveBeenCalled();
		await controller.shutdown();
	});
});
