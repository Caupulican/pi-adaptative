import { describe, expect, it, vi } from "vitest";
import type { BackgroundToolTaskRecord } from "../src/core/background-tool-task-controller.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createToolTaskToolDefinition } from "../src/core/tools/tool-task.ts";

const running: BackgroundToolTaskRecord = {
	sessionId: "session-a",
	taskId: "tool-task-1",
	toolCallId: "call-1",
	toolName: "bash",
	status: "running",
	startedAt: "2026-08-01T12:00:00.000Z",
	elapsedBeforeHandoffMs: 15_000,
	summary: "bash running in the background",
	output: "",
};

const terminal: BackgroundToolTaskRecord = {
	...running,
	status: "completed",
	completedAt: "2026-08-01T12:00:20.000Z",
	summary: "bash completed: tests passed",
	output: "tests passed",
};

const failed: BackgroundToolTaskRecord = {
	...running,
	status: "failed",
	completedAt: "2026-08-01T12:00:30.000Z",
	summary: "bash failed after timing out",
	output: '[harness] {"failure_key":"bash:timeout","occ":1}',
};

const verificationFailed: BackgroundToolTaskRecord = {
	...failed,
	terminalDelivery: "pending",
	piVerification: { version: 1, id: "verify-background", status: "failed", originTaskId: "tool-task-1" },
};

const verificationPassed: BackgroundToolTaskRecord = {
	...terminal,
	terminalDelivery: "pending",
	piVerification: { version: 1, id: "verify-background", status: "passed", originTaskId: "tool-task-1" },
};

const canceled: BackgroundToolTaskRecord = {
	...running,
	status: "canceled",
	completedAt: "2026-08-01T12:00:25.000Z",
	summary: "bash canceled",
	output: "Operation aborted",
};

const extensionContext = {} as ExtensionContext;

describe("tool_task", () => {
	it("lists bounded session tasks without encouraging polling", async () => {
		const observe = vi.fn(() => [running]);
		const tool = createToolTaskToolDefinition({
			list: () => [running],
			observe,
			wait: vi.fn(),
			cancel: vi.fn(),
		});
		const result = await tool.execute("call", { action: "list" }, undefined, undefined, extensionContext);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("tool-task-1: running");
		expect(text).toContain("Do not poll");
		expect(result.details).toMatchObject({ kind: "list", count: 1 });
		expect(observe).toHaveBeenCalledOnce();
	});

	it("observes only terminal tasks included in the bounded list result", async () => {
		const records = Array.from({ length: 40 }, (_, index) => ({
			...terminal,
			taskId: `tool-task-${index + 1}`,
			toolCallId: `call-${index + 1}`,
		}));
		const observe = vi.fn();
		const tool = createToolTaskToolDefinition({
			list: () => records,
			observe,
			wait: vi.fn(),
			cancel: vi.fn(),
		});

		const result = await tool.execute("call", { action: "list" }, undefined, undefined, extensionContext);

		expect(observe).toHaveBeenCalledWith(records.slice(-32).map((record) => record.taskId));
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("8 older task(s) omitted") });
	});

	it("waits once on the controller's terminal event", async () => {
		const wait = vi.fn(async () => terminal);
		const tool = createToolTaskToolDefinition({
			list: () => [running],
			observe: () => [running],
			wait,
			cancel: vi.fn(),
		});
		const signal = new AbortController().signal;
		const result = await tool.execute(
			"call",
			{ action: "wait", taskId: "tool-task-1" },
			signal,
			undefined,
			extensionContext,
		);
		expect(wait).toHaveBeenCalledWith("tool-task-1", signal);
		expect(result.content).toEqual([{ type: "text", text: "tests passed" }]);
		expect(result.details).toMatchObject({ kind: "wait", taskId: "tool-task-1", status: "completed" });
		expect(result.isError).not.toBe(true);
	});

	it("returns a running snapshot as nonterminal control flow instead of a tool failure", async () => {
		const tool = createToolTaskToolDefinition({
			list: () => [running],
			observe: () => [running],
			wait: async () => running,
			cancel: vi.fn(),
		});

		const result = await tool.execute(
			"call",
			{ action: "wait", taskId: running.taskId },
			undefined,
			undefined,
			extensionContext,
		);

		expect(result.isError).not.toBe(true);
		expect(result.details).toMatchObject({ kind: "wait", taskId: running.taskId, status: "running" });
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("terminal handoff will wake the session"),
		});
	});

	it.each([
		["failed", failed],
		["canceled", canceled],
	] as const)("projects a %s terminal task as a failed tool call", async (_status, record) => {
		const tool = createToolTaskToolDefinition({
			list: () => [record],
			observe: () => [record],
			wait: async () => record,
			cancel: vi.fn(),
		});
		const result = await tool.execute(
			"call",
			{ action: "wait", taskId: record.taskId },
			undefined,
			undefined,
			extensionContext,
		);
		expect(result.content).toEqual([{ type: "text", text: record.output }]);
		expect(result.details).toMatchObject({ kind: "wait", taskId: record.taskId, status: record.status });
		expect(result.isError).toBe(true);
		expect(result.errorKind).toBe("operation_outcome");
	});

	it("preserves a failed pending background verification through its single wait result", async () => {
		const tool = createToolTaskToolDefinition({
			list: () => [verificationFailed],
			observe: () => [verificationFailed],
			wait: async () => verificationFailed,
			cancel: vi.fn(),
		});

		const result = await tool.execute(
			"call",
			{ action: "wait", taskId: verificationFailed.taskId },
			undefined,
			undefined,
			extensionContext,
		);

		expect(result.details).toMatchObject({
			kind: "wait",
			piVerification: { version: 1, id: "verify-background", status: "failed", originTaskId: "tool-task-1" },
		});
	});

	it("preserves a pending pass only after a rejected wait is retried", async () => {
		const wait = vi
			.fn<() => Promise<BackgroundToolTaskRecord>>()
			.mockRejectedValueOnce(new Error("transient wait interruption"))
			.mockResolvedValueOnce(verificationPassed);
		const tool = createToolTaskToolDefinition({
			list: () => [verificationPassed],
			observe: () => [verificationPassed],
			wait,
			cancel: vi.fn(),
		});

		const first = await tool.execute(
			"call-first",
			{ action: "wait", taskId: verificationPassed.taskId },
			undefined,
			undefined,
			extensionContext,
		);
		const retry = await tool.execute(
			"call-retry",
			{ action: "wait", taskId: verificationPassed.taskId },
			undefined,
			undefined,
			extensionContext,
		);

		expect(first.details).toMatchObject({ kind: "error", reason: "transient wait interruption" });
		expect(first.details).not.toHaveProperty("piVerification");
		expect(retry.details).toMatchObject({ piVerification: { status: "passed" } });
	});

	it("does not replay verification from a delivered terminal or a running watchdog snapshot", async () => {
		const delivered = { ...verificationPassed, terminalDelivery: "delivered" as const };
		const watchdogRecord = { ...running, taskId: "tool-task-2", toolCallId: "call-2" };
		const tool = createToolTaskToolDefinition({
			list: () => [delivered, watchdogRecord],
			observe: () => [delivered, watchdogRecord],
			wait: async (taskId) => (taskId === delivered.taskId ? delivered : watchdogRecord),
			cancel: vi.fn(),
		});

		const stale = await tool.execute(
			"call-stale",
			{ action: "wait", taskId: delivered.taskId },
			undefined,
			undefined,
			extensionContext,
		);
		const watchdog = await tool.execute(
			"call-watchdog",
			{ action: "wait", taskId: watchdogRecord.taskId },
			undefined,
			undefined,
			extensionContext,
		);

		expect(stale.details).not.toHaveProperty("piVerification");
		expect(watchdog.details).not.toHaveProperty("piVerification");
	});

	it("does not invent verification metadata for an ordinary pending terminal", async () => {
		const ordinary = { ...terminal, terminalDelivery: "pending" as const };
		const tool = createToolTaskToolDefinition({
			list: () => [ordinary],
			observe: () => [ordinary],
			wait: async () => ordinary,
			cancel: vi.fn(),
		});

		const result = await tool.execute(
			"call-ordinary",
			{ action: "wait", taskId: ordinary.taskId },
			undefined,
			undefined,
			extensionContext,
		);

		expect(result.details).not.toHaveProperty("piVerification");
	});

	it("projects an invalid or rejected wait as a failed tool call", async () => {
		const tool = createToolTaskToolDefinition({
			list: () => [],
			observe: () => [],
			wait: async () => {
				throw new Error("Unknown background tool task tool-task-missing");
			},
			cancel: vi.fn(),
		});

		const invalid = await tool.execute("call", { action: "wait" }, undefined, undefined, extensionContext);
		expect(invalid.details).toMatchObject({ kind: "error", reason: "invalid_task_id" });
		expect(invalid.isError).toBe(true);

		const rejected = await tool.execute(
			"call",
			{ action: "wait", taskId: "tool-task-missing" },
			undefined,
			undefined,
			extensionContext,
		);
		expect(rejected.details).toMatchObject({ kind: "error", taskId: "tool-task-missing" });
		expect(rejected.isError).toBe(true);
	});

	it("requests cancellation only for an addressed task", async () => {
		const cancel = vi.fn((taskId: string) => taskId === "tool-task-1");
		const tool = createToolTaskToolDefinition({
			list: () => [running],
			observe: () => [running],
			wait: vi.fn(),
			cancel,
		});
		const result = await tool.execute(
			"call",
			{ action: "cancel", taskId: "tool-task-1" },
			undefined,
			undefined,
			extensionContext,
		);
		expect(cancel).toHaveBeenCalledWith("tool-task-1");
		expect(result.content[0]).toMatchObject({ text: "Cancellation requested for tool-task-1." });
	});

	it("reports an empty session snapshot without the polling guidance", async () => {
		const observe = vi.fn();
		const tool = createToolTaskToolDefinition({
			list: () => [],
			observe,
			wait: vi.fn(),
			cancel: vi.fn(),
		});

		const result = await tool.execute("call", { action: "list" }, undefined, undefined, extensionContext);

		expect(result.content).toEqual([{ type: "text", text: "No background tool tasks in this session." }]);
		expect(result.details).toMatchObject({ kind: "list", count: 0 });
		expect(observe).toHaveBeenCalledWith([]);
	});

	it("names a cancellation that addressed nothing so the model does not assume it landed", async () => {
		const cancel = vi.fn(() => false);
		const tool = createToolTaskToolDefinition({
			list: () => [terminal],
			observe: () => [terminal],
			wait: vi.fn(),
			cancel,
		});

		const result = await tool.execute(
			"call",
			{ action: "cancel", taskId: "tool-task-gone" },
			undefined,
			undefined,
			extensionContext,
		);

		expect(cancel).toHaveBeenCalledWith("tool-task-gone");
		expect(result.content[0]).toMatchObject({ text: "No running background tool task named tool-task-gone." });
		expect(result.details).toMatchObject({ kind: "cancel", taskId: "tool-task-gone", reason: "not_running" });
	});

	it("falls back to the summary when a terminal task produced no output", async () => {
		const silent = { ...terminal, output: "" };
		const tool = createToolTaskToolDefinition({
			list: () => [silent],
			observe: () => [silent],
			wait: async () => silent,
			cancel: vi.fn(),
		});

		const result = await tool.execute(
			"call",
			{ action: "wait", taskId: silent.taskId },
			undefined,
			undefined,
			extensionContext,
		);

		expect(result.content).toEqual([{ type: "text", text: silent.summary }]);
	});

	it("surfaces the artifact id so a spilled result stays addressable", async () => {
		const spilled = { ...terminal, artifactId: "artifact-7" };
		const tool = createToolTaskToolDefinition({
			list: () => [spilled],
			observe: () => [spilled],
			wait: async () => spilled,
			cancel: vi.fn(),
		});

		const result = await tool.execute(
			"call",
			{ action: "wait", taskId: spilled.taskId },
			undefined,
			undefined,
			extensionContext,
		);

		expect(result.details).toMatchObject({ kind: "wait", taskId: spilled.taskId, artifactId: "artifact-7" });
	});

	it("projects a non-Error wait rejection as readable text instead of losing it", async () => {
		const tool = createToolTaskToolDefinition({
			list: () => [running],
			observe: () => [running],
			wait: async () => {
				throw "controller went away";
			},
			cancel: vi.fn(),
		});

		const result = await tool.execute(
			"call",
			{ action: "wait", taskId: running.taskId },
			undefined,
			undefined,
			extensionContext,
		);

		expect(result.content).toEqual([{ type: "text", text: "controller went away" }]);
		expect(result.details).toMatchObject({ kind: "error", taskId: running.taskId, reason: "controller went away" });
		expect(result.isError).toBe(true);
	});

	// Origin: session 01a058a5. The waited scan was the only work in flight, so "continue independent
	// work" had no referent and the model spent turns restating that a search was still running.
	it("reports elapsed progress when the wait watchdog elapses on a running task", async () => {
		const startedAt = new Date(Date.now() - 90_000).toISOString();
		const tool = createToolTaskToolDefinition({
			list: () => [],
			observe: vi.fn(),
			wait: async () => ({ ...running, startedAt }),
			cancel: vi.fn(),
		});

		const result = await tool.execute(
			"call",
			{ action: "wait", taskId: running.taskId },
			undefined,
			undefined,
			extensionContext,
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Still running after 90s.");
		expect(text).not.toContain("continue independent work");
		expect(result.details).toMatchObject({ kind: "wait", status: "running" });
	});
});
