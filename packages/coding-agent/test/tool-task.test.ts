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
		const tool = createToolTaskToolDefinition({
			list: () => [running],
			wait: vi.fn(),
			cancel: vi.fn(),
		});
		const result = await tool.execute("call", { action: "list" }, undefined, undefined, extensionContext);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("tool-task-1: running");
		expect(text).toContain("Do not poll");
		expect(result.details).toMatchObject({ kind: "list", count: 1 });
	});

	it("waits once on the controller's terminal event", async () => {
		const wait = vi.fn(async () => terminal);
		const tool = createToolTaskToolDefinition({ list: () => [running], wait, cancel: vi.fn() });
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

	it.each([
		["failed", failed],
		["canceled", canceled],
	] as const)("projects a %s terminal task as a failed tool call", async (_status, record) => {
		const tool = createToolTaskToolDefinition({
			list: () => [record],
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
	});

	it("projects an invalid or rejected wait as a failed tool call", async () => {
		const tool = createToolTaskToolDefinition({
			list: () => [],
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
		const tool = createToolTaskToolDefinition({ list: () => [running], wait: vi.fn(), cancel });
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
});
