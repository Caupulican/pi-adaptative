import type { AgentContext, BackgroundToolCallCompletion, BackgroundToolCallContext } from "@caupulican/pi-agent-core";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { BackgroundToolTaskController } from "../src/core/background-tool-task-controller.ts";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";

function controlledContext() {
	let resolveCompletion: ((completion: BackgroundToolCallCompletion) => void) | undefined;
	const completion = new Promise<BackgroundToolCallCompletion>((resolve) => {
		resolveCompletion = resolve;
	});
	const toolCall = { type: "toolCall" as const, id: "call-1", name: "slow", arguments: {} };
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [toolCall],
		api: "openai-responses",
		provider: "faux",
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
		timestamp: 0,
	};
	const context: BackgroundToolCallContext = {
		assistantMessage,
		toolCall,
		args: {},
		context: { systemPrompt: "", messages: [], tools: [] } satisfies AgentContext,
		trigger: "clock",
		elapsedMs: 15_000,
		completion,
		cancel: vi.fn(),
	};
	return { context, resolveCompletion: resolveCompletion! };
}

describe("background tool task wait watchdog", () => {
	it("terminalizes an abort-ignoring task after the cancellation grace", async () => {
		vi.useFakeTimers();
		const notifications: boolean[] = [];
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => createInMemoryArtifactStore(),
			persist: () => {},
			notifyTerminal: (records) => {
				notifications.push(...records.map((record) => record.status === "canceled"));
			},
			cancelGraceMs: 1_000,
		});
		const controlled = controlledContext();
		try {
			controller.handoff(controlled.context);
			expect(controller.cancel("tool-task-1")).toBe(true);

			await vi.advanceTimersByTimeAsync(999);
			expect(controller.list()[0]).toMatchObject({ status: "running", cancellationRequested: true });
			await vi.advanceTimersByTimeAsync(1);
			await controller.waitForNotifications();

			expect(controller.list()[0]).toMatchObject({
				status: "canceled",
				output: expect.stringContaining("did not settle"),
			});
			expect(notifications).toEqual([true]);

			controlled.resolveCompletion({
				toolCall: controlled.context.toolCall,
				result: { content: [{ type: "text", text: "late success" }], details: {} },
				isError: false,
			});
			await Promise.resolve();
			expect(controller.list()[0]).toMatchObject({ status: "canceled" });
			expect(controller.list()[0]?.output).not.toContain("late success");
		} finally {
			await controller.shutdown();
			vi.useRealTimers();
		}
	});

	it("cancels and terminalizes a task whose maximum managed lifetime elapses", async () => {
		vi.useFakeTimers();
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => createInMemoryArtifactStore(),
			persist: () => {},
			notifyTerminal: () => {},
			maxRuntimeMs: 2_000,
			cancelGraceMs: 1_000,
		});
		const controlled = controlledContext();
		controlled.context.elapsedMs = 1_500;
		try {
			controller.handoff(controlled.context);

			await vi.advanceTimersByTimeAsync(499);
			expect(controller.list()[0]).toMatchObject({ status: "running" });
			expect(controlled.context.cancel).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(controller.list()[0]).toMatchObject({ status: "running", cancellationRequested: true });
			expect(controlled.context.cancel).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(1_000);

			expect(controller.list()[0]).toMatchObject({
				status: "canceled",
				output: expect.stringContaining("maximum managed lifetime"),
			});
		} finally {
			await controller.shutdown();
			vi.useRealTimers();
		}
	});

	it("treats a malformed foreground elapsed value as zero instead of losing task ownership", async () => {
		vi.useFakeTimers();
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => createInMemoryArtifactStore(),
			persist: () => {},
			notifyTerminal: () => {},
			maxRuntimeMs: 2_000,
			cancelGraceMs: 1_000,
		});
		const controlled = controlledContext();
		controlled.context.elapsedMs = Number.NaN;
		try {
			expect(() => controller.handoff(controlled.context)).not.toThrow();
			await vi.advanceTimersByTimeAsync(1_999);
			expect(controlled.context.cancel).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(controlled.context.cancel).toHaveBeenCalledOnce();
		} finally {
			await controller.shutdown();
			vi.useRealTimers();
		}
	});

	it("rejects bounds that exceed the runtime timer range", () => {
		expect(
			() =>
				new BackgroundToolTaskController({
					getSessionId: () => "session-a",
					getArtifactStore: () => createInMemoryArtifactStore(),
					persist: () => {},
					notifyTerminal: () => {},
					maxRuntimeMs: 2_147_483_648,
				}),
		).toThrow(/supported timer range/);
	});

	it("returns the running record before the tool timeout and later wakes on terminal completion", async () => {
		const notifications: Array<{ status: string; wakeParent: boolean }> = [];
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => createInMemoryArtifactStore(),
			persist: () => {},
			notifyTerminal: (records, options) => {
				notifications.push(...records.map((record) => ({ status: record.status, wakeParent: options.wakeParent })));
			},
			waitTimeoutMs: 1,
		});
		const controlled = controlledContext();
		controller.handoff(controlled.context);

		await expect(controller.wait("tool-task-1")).resolves.toMatchObject({ status: "running" });
		controlled.resolveCompletion({
			toolCall: controlled.context.toolCall,
			result: { content: [{ type: "text", text: "done" }], details: {} },
			isError: false,
		});
		await controller.waitForNotifications();

		expect(notifications).toEqual([{ status: "completed", wakeParent: true }]);
	});

	it("blocks for a caller-supplied bound instead of the controller default", async () => {
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => createInMemoryArtifactStore(),
			persist: () => {},
			notifyTerminal: () => {},
			waitTimeoutMs: 1,
		});
		const controlled = controlledContext();
		controller.handoff(controlled.context);
		const pending = controller.wait("tool-task-1", undefined, 60_000);
		await new Promise((resolve) => setTimeout(resolve, 20));
		controlled.resolveCompletion({
			toolCall: controlled.context.toolCall,
			result: { content: [{ type: "text", text: "done" }], details: {} },
			isError: false,
		});
		await expect(pending).resolves.toMatchObject({ status: "completed" });
		await expect(controller.wait("tool-task-1", undefined, 0)).rejects.toThrow(/positive integer/);
	});

	it("projects an aborted wait as a running snapshot rather than rejecting", async () => {
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => createInMemoryArtifactStore(),
			persist: () => {},
			notifyTerminal: () => {},
			waitTimeoutMs: 60_000,
		});
		const controlled = controlledContext();
		controller.handoff(controlled.context);
		const abort = new AbortController();
		abort.abort(new Error("generic harness timeout"));

		await expect(controller.wait("tool-task-1", abort.signal)).resolves.toMatchObject({ status: "running" });
	});
});
