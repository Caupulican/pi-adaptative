import type { AgentRequestId, BackgroundToolCallCompletion, BackgroundToolCallContext } from "@caupulican/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BackgroundToolTaskController,
	type BackgroundToolTaskControllerDeps,
	type BackgroundToolTaskRecord,
} from "../src/core/background-tool-task-controller.ts";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";

const requestId = "fixture-request" as AgentRequestId;
const usage = {
	input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function controlledCall(id = "fixture-call") {
	const completion = Promise.withResolvers<BackgroundToolCallCompletion>();
	const toolCall = { type: "toolCall" as const, id, name: "fixture", arguments: {} };
	const context: BackgroundToolCallContext = {
		requestId, toolCall, args: {},
		assistantMessage: {
			role: "assistant", content: [toolCall], api: "openai-responses", provider: "fixture", model: "fixture",
			usage, stopReason: "toolUse", timestamp: 0,
		},
		context: { systemPrompt: "", messages: [], tools: [] }, trigger: "manual", elapsedMs: 0,
		completion: completion.promise, cancel: vi.fn(),
	};
	const finished: BackgroundToolCallCompletion = {
		toolCall, isError: false,
		result: {
			content: [{ type: "text", text: `committed:${id}` }], usage,
			details: {
				piToolInvocation: { version: 1, requestId, execution: "completed", operationStatus: "success", postprocessingFailures: ["cleanup"] },
				piVerification: { version: 1, id: `verification-${id}`, status: "passed", outcome: "executed", evidence: "tests" },
			},
		},
	};
	return { context, completion, finished };
}

function createHarness(overrides: Partial<BackgroundToolTaskControllerDeps> = {}) {
	const persisted: BackgroundToolTaskRecord[] = [];
	const notifications: BackgroundToolTaskRecord[] = [];
	const errors: string[] = [];
	const controller = new BackgroundToolTaskController({
		getSessionId: () => "fixture-session", getArtifactStore: () => undefined,
		persist: (record) => { persisted.push(record); },
		notifyTerminal: (records) => { notifications.push(...records); },
		onError: (message) => { errors.push(message); },
		...overrides,
	});
	return { controller, persisted, notifications, errors };
}

describe("background terminal observer failures", () => {
	afterEach(() => vi.useRealTimers());
	it.each(["usage", "live", "both", "control"].flatMap((fault) =>
		["returns", "throws_undefined"].map((reporter) => ({ fault, reporter })),
	))("settles waiters and notifies the parent: $fault / $reporter", async ({ fault, reporter }) => {
		vi.useFakeTimers();
		const onError = vi.fn(() => { if (reporter === "throws_undefined") throw undefined; });
		const recordUsage = vi.fn(() => {
			if (fault === "usage" || fault === "both") throw new Error("usage observer failed");
		});
		const { controller, persisted, notifications } = createHarness({
			onError, recordUsage,
			onLiveTasksChanged: (tasks) => {
				if (tasks.length === 0 && (fault === "live" || fault === "both")) throw new Error("renderer failed");
			},
		});
		const call = controlledCall();
		expect(controller.handoff(call.context)).toBeDefined();
		let waiterSettled = false;
		const waiting = controller.wait("tool-task-1").then((record) => { waiterSettled = true; return record; });
		call.completion.resolve(call.finished);
		await controller.waitForNotifications();
		// No timer advancement: the existing waiter must be released by the terminal, not its watchdog.
		expect(waiterSettled).toBe(true);
		const result = await waiting;
		expect(result).toMatchObject({ status: "completed", output: "committed:fixture-call", usage });
		expect(result.piToolInvocation).toMatchObject({ execution: "completed", operationStatus: "success", postprocessingFailures: ["cleanup"] });
		expect(result.piVerification).toMatchObject({ status: "passed", originTaskId: "tool-task-1" });
		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toMatchObject({ status: "completed", output: result.output });
		expect(persisted.at(-1)).toMatchObject({ status: "completed", terminalDelivery: "delivered", usage });
		expect(recordUsage).toHaveBeenCalledOnce();
		expect(recordUsage).toHaveBeenCalledWith("tool-task-1", usage);
		expect(onError).toHaveBeenCalledTimes(fault === "both" ? 2 : fault === "control" ? 0 : 1);
		await controller.shutdown();
	});

	it("admits completion ownership when the live subscriber and its diagnostic both throw", async () => {
		const { controller, notifications } = createHarness({
			onLiveTasksChanged: () => { throw new Error("renderer failed"); },
			onError: () => { throw new Error("diagnostic failed"); },
		});
		const call = controlledCall();
		expect(controller.handoff(call.context)).toBeDefined();
		call.completion.resolve(call.finished);
		await controller.waitForNotifications();
		expect(notifications).toEqual([expect.objectContaining({ status: "completed", output: "committed:fixture-call" })]);
		await controller.shutdown();
	});

	it.each(["initial", "terminal"])("retains the %s persistence refusal when diagnostics throw", async (boundary) => {
		let writes = 0;
		const { controller, notifications } = createHarness({
			persist: () => { if (++writes > (boundary === "initial" ? 0 : 1)) throw new Error("write failed"); },
			onError: () => { throw undefined; },
		});
		const call = controlledCall();
		const handoff = controller.handoff(call.context);
		if (boundary === "initial") {
			expect(handoff).toBeUndefined();
			expect(controller.list()).toEqual([]);
		} else {
			expect(handoff).toBeDefined();
			call.completion.resolve(call.finished);
			await controller.waitForNotifications();
			expect(notifications).toEqual([expect.objectContaining({ status: "failed", output: expect.stringContaining("could not be persisted") })]);
			expect(notifications[0].piVerification).toBeUndefined();
			expect(controller.list()[0].piVerification).toBeUndefined();
		}
		await controller.shutdown();
	});

	it("continues shutdown across cancel and diagnostic failures", async () => {
		const { controller } = createHarness({ onError: () => { throw new Error("diagnostic failed"); } });
		const first = controlledCall("first");
		const second = controlledCall("second");
		first.context.cancel = vi.fn(() => { throw new Error("cancel failed"); });
		controller.handoff(first.context);
		controller.handoff(second.context);
		await controller.shutdown();
		expect(first.context.cancel).toHaveBeenCalledOnce();
		expect(second.context.cancel).toHaveBeenCalledOnce();
		expect(controller.list().map((record) => record.status)).toEqual(["canceled", "canceled"]);
	});

	it.each(["lookup", "remove", "cleanup", "control"])("notifies a new task despite old artifact pruning: %s", async (fault) => {
		const records: BackgroundToolTaskRecord[] = Array.from({ length: 64 }, (_, index) => ({
			sessionId: "fixture-session", taskId: `tool-task-${index + 1}`, toolCallId: `old-${index}`, toolName: "old",
			status: "completed", startedAt: "2026-09-01T00:00:00.000Z", completedAt: "2026-09-01T00:00:01.000Z",
			elapsedBeforeHandoffMs: 0, summary: "old completed", output: "old", terminalDelivery: "delivered",
			...(index === 0 ? { artifactId: "abcd" } : {}),
		}));
		const store = createInMemoryArtifactStore();
		const remove = vi.spyOn(store, "removeReference").mockImplementation(() => {
			if (fault === "remove") throw new Error("remove failed");
			return false;
		});
		const cleanup = vi.spyOn(store, "cleanup").mockImplementation(() => {
			if (fault === "cleanup") throw new Error("cleanup failed");
			return [];
		});
		let lookups = 0;
		const { controller, notifications } = createHarness({
			loadPersistedRecordsNewestFirst: () => records,
			getArtifactStore: () => {
				if (++lookups === 2 && fault === "lookup") throw new Error("lookup failed");
				return store;
			},
			onError: () => { throw undefined; },
		});
		const call = controlledCall();
		expect(controller.handoff(call.context)?.result.details).toMatchObject({ taskId: "tool-task-65" });
		call.completion.resolve(call.finished);
		await controller.waitForNotifications();
		expect(notifications).toEqual([expect.objectContaining({ taskId: "tool-task-65", status: "completed", output: "committed:fixture-call" })]);
		expect(controller.list()).toHaveLength(64);
		expect(remove).toHaveBeenCalledTimes(fault === "lookup" ? 0 : 1);
		expect(cleanup).toHaveBeenCalledTimes(fault === "lookup" || fault === "remove" ? 0 : 1);
		await controller.shutdown();
	});
});
