import { SessionManager } from "@caupulican/pi-agent-core/node";
import type { ExecutionAttachment } from "@caupulican/pi-agent-core/paths";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { TaskDirectoryRuntime } from "../src/core/tasks/task-directory-runtime.ts";
import {
	createTaskDirectoryState,
	resolveTaskDirectoryContext,
	type TaskDirectoryBinding,
	transitionTaskDirectoryState,
} from "../src/core/tasks/task-directory-state.ts";
import { createTaskDirectoryToolDefinition } from "../src/core/tools/task-directory.ts";

const runtimes: TaskDirectoryRuntime[] = [];
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.dispose();
	vi.restoreAllMocks();
});

function fixture(large = false, character = "界") {
	const attachment = (index: number): ExecutionAttachment => ({
		workspaceId: `project-${index}`,
		attachmentId: `synthetic-attachment-${index}`,
		root: `/synthetic/${index}/${large ? character.repeat(4000) : "project"}`,
		flavor: "posix",
		caseSensitive: true,
	});
	let state = createTaskDirectoryState(attachment(0));
	if (large) {
		for (let index = 1; index < 32; index++)
			state = transitionTaskDirectoryState(state, { action: "register", attachment: attachment(index) });
		for (let index = 0; index < 128; index++)
			state = transitionTaskDirectoryState(state, {
				action: "bind",
				taskId: `task-${index}`,
				workspaceId: `project-${index % 32}`,
				pinned: true,
				path: `${index}/${character.repeat(4000)}`,
			});
	}
	const session = SessionManager.inMemory("/synthetic");
	let activeTaskId = large ? "task-0" : undefined;
	const runtime = new TaskDirectoryRuntime({
		getSessionManager: () => session,
		getCwd: () => "/synthetic",
		getActiveTaskId: () => activeTaskId,
		getEnvelopes: () => [],
	});
	runtimes.push(runtime);
	vi.spyOn(runtime, "getStatus").mockImplementation(async () => ({
		state,
		activeTaskId,
		effective: resolveTaskDirectoryContext(state, activeTaskId, session.getSessionId(), true),
		unavailable: undefined,
	}));
	const tool = createTaskDirectoryToolDefinition(runtime, () => undefined);
	return {
		state: () => state,
		change: () => {
			state = transitionTaskDirectoryState(state, { action: "forget", taskId: "task-127" });
		},
		switchSession: () => session.newSession(),
		switchTask: () => {
			activeTaskId = "task-1";
		},
		switchBranch: () => {
			// Another branch can hold a different snapshot with the same numerical revision.
			state = { ...state, selectedWorkspaceId: "project-1" };
		},
		async page(cursor?: string) {
			const input = { action: "status" as const, ...(cursor === undefined ? {} : { cursor }) };
			const result = await tool.execute("synthetic-page", input, undefined, undefined, {} as ExtensionContext);
			const text = result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(128 * 1024);
			expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThanOrEqual(128 * 1024);
			return JSON.parse(text) as {
				workspaces: ExecutionAttachment[];
				bindings: TaskDirectoryBinding[];
				nextCursor?: string;
			};
		},
	};
}

describe("bounded task directory status", () => {
	it("retains the complete small registry without requiring another call", async () => {
		const test = fixture();
		const page = await test.page();
		expect(page.workspaces).toEqual(test.state().workspaces);
		expect(page.bindings).toEqual([]);
		expect(page.nextCursor).toBeUndefined();
	});

	it("pages every full multibyte path exactly once without exceeding the byte budget", async () => {
		const test = fixture(true);
		const workspaces: ExecutionAttachment[] = [];
		const bindings: TaskDirectoryBinding[] = [];
		let cursor: string | undefined;
		let calls = 0;
		do {
			const page = await test.page(cursor);
			workspaces.push(...page.workspaces);
			bindings.push(...page.bindings);
			cursor = page.nextCursor;
			expect(++calls).toBeLessThanOrEqual(160);
		} while (cursor);
		expect(calls).toBeGreaterThan(1);
		expect(workspaces).toEqual(test.state().workspaces);
		expect(bindings).toEqual(test.state().bindings);
	});

	it("retains complete JSON-escaped path bytes at the registry path-length bound", async () => {
		const test = fixture(true, "\u0001");
		const page = await test.page();
		expect(page.workspaces[0]).toEqual(test.state().workspaces[0]);
	});

	it.each(["change", "switchSession", "switchTask", "switchBranch"] as const)(
		"refuses stale continuation after %s while permitting unchanged replay",
		async (action) => {
			const test = fixture(true);
			const cursor = (await test.page()).nextCursor;
			expect(cursor).toBeDefined();
			const control = await test.page(cursor);
			expect(await test.page(cursor)).toEqual(control);
			test[action]();
			await expect(test.page(cursor)).rejects.toThrow("request status without a cursor");
			await expect(test.page()).resolves.toBeDefined();
		},
	);

	it.each(["", "malformed", `${"0".repeat(64)}:1`, `${"f".repeat(64)}:999`, "x".repeat(1000)])(
		"rejects invalid or foreign cursor %# without changing saved state",
		async (cursor) => {
			const test = fixture();
			const before = test.state();
			await expect(test.page(cursor)).rejects.toThrow("request status without a cursor");
			expect(test.state()).toBe(before);
		},
	);

	it("rejects an out-of-range offset even with the current fingerprint", async () => {
		const test = fixture(true);
		const cursor = (await test.page()).nextCursor!;
		expect(cursor).toBeDefined();
		await expect(test.page(cursor.replace(/:\d+$/, ":999"))).rejects.toThrow("cursor is invalid");
		await expect(test.page(cursor)).resolves.toBeDefined();
	});
});
