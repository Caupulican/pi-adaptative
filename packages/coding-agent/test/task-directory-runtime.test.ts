import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_DIRECTORY_STATE_CUSTOM_TYPE } from "../src/core/tasks/session-task-directory-store.ts";
import { TaskDirectoryRuntime } from "../src/core/tasks/task-directory-runtime.ts";

describe("native task directory runtime", () => {
	let root: string;
	let session: SessionManager;
	let runtime: TaskDirectoryRuntime;
	let activeTaskId: string | undefined;
	const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "executed" }], details: {} }));
	const tool: AgentTool = {
		name: "read",
		label: "Read",
		description: "Fixture",
		parameters: Type.Object({}),
		execute,
	};
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-task-runtime-"));
		session = SessionManager.inMemory(root);
		activeTaskId = undefined;
		execute.mockClear();
		runtime = new TaskDirectoryRuntime({
			getCwd: () => root,
			getSessionManager: () => session,
			getActiveTaskId: () => activeTaskId,
			getEnvelopes: () => [],
		});
	});
	afterEach(async () => {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	});

	it("requires explicit reattachment after a project moves instead of falling back to the ambient directory", async () => {
		const original = join(root, "original");
		const moved = join(root, "moved");
		mkdirSync(original);
		await runtime.change({ action: "register", attachment: runtime.createAttachment("project", original) });
		await runtime.change({ action: "select", workspaceId: "project" });
		renameSync(original, moved);
		const bound = runtime.bindTool(tool);
		await expect(bound.bindInvocation!("missing", {})).rejects.toHaveProperty("code", "ENOENT");
		expect(execute).not.toHaveBeenCalled();
		await runtime.change({ action: "reattach", attachment: runtime.createAttachment("project", moved) });
		const admitted = await bound.bindInvocation!("recovered", {});
		expect(admitted.executionContext.cwd).toBe(moved);
		await admitted.execute("recovered", {});
		admitted.release();
		expect(execute).toHaveBeenCalledOnce();
	});

	it("fences a restored foreign attachment and repairs it through the same registry", async () => {
		const initial = runtime.snapshot;
		session.appendCustomEntry(TASK_DIRECTORY_STATE_CUSTOM_TYPE, {
			...initial,
			workspaces: initial.workspaces.map((workspace) => ({ ...workspace, attachmentId: "foreign-host" })),
		});
		await expect(runtime.bindTool(tool).bindInvocation!("foreign", {})).rejects.toThrow("reattach");
		expect(execute).not.toHaveBeenCalled();
		await runtime.change({ action: "reattach", attachment: runtime.createAttachment("session", root) });
		const admitted = await runtime.bindTool(tool).bindInvocation!("repaired", {});
		admitted.release();
	});

	it("keeps concurrent callbacks in their captured task context without process-global chdir", async () => {
		const ambient = process.cwd();
		const other = join(root, "other");
		mkdirSync(other);
		await runtime.change({ action: "register", attachment: runtime.createAttachment("other", other) });
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const seen: string[] = [];
		const bound = runtime.bindTool({
			...tool,
			execute: async () => {
				seen.push(runtime.cwd);
				entered.resolve();
				await finish.promise;
				seen.push(runtime.cwd);
				return execute();
			},
		});
		activeTaskId = "first";
		const first = await bound.bindInvocation!("first", {});
		const running = first.execute("first", {});
		await entered.promise;
		await runtime.change({ action: "select", workspaceId: "other" });
		activeTaskId = "second";
		const second = await bound.bindInvocation!("second", {});
		expect(second.executionContext).toMatchObject({ taskId: "second", cwd: other });
		finish.resolve();
		await running;
		await second.execute("second", {});
		expect(seen).toEqual([root, root, other, other]);
		expect(runtime.executionContext).toBeUndefined();
		expect(process.cwd()).toBe(ambient);
		first.release();
		second.release();
	});
});
