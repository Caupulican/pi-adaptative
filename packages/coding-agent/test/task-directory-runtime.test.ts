import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
		await runtime.change({ action: "register", workspaceId: "project", path: original });
		await runtime.change({ action: "select", workspaceId: "project" });
		renameSync(original, moved);
		const bound = runtime.bindTool(tool);
		await expect(bound.bindInvocation!("missing", {})).rejects.toHaveProperty("code", "ENOENT");
		expect(execute).not.toHaveBeenCalled();
		await runtime.change({ action: "reattach", workspaceId: "project", path: moved });
		const admitted = await bound.bindInvocation!("recovered", {});
		expect(admitted.executionContext.cwd).toBe(moved);
		await admitted.execute("recovered", {});
		admitted.release();
		expect(execute).toHaveBeenCalledOnce();
	});

	it("fences a restored foreign attachment and repairs it through the same registry", async () => {
		const initial = await runtime.getSnapshot();
		session.appendCustomEntry(TASK_DIRECTORY_STATE_CUSTOM_TYPE, {
			...initial,
			workspaces: initial.workspaces.map((workspace) => ({ ...workspace, attachmentId: "foreign-host" })),
		});
		await expect(runtime.bindTool(tool).bindInvocation!("foreign", {})).rejects.toThrow("reattach");
		expect(execute).not.toHaveBeenCalled();
		await runtime.change({ action: "reattach", workspaceId: "session", path: root });
		const admitted = await runtime.bindTool(tool).bindInvocation!("repaired", {});
		admitted.release();
	});

	it("fences a replacement directory at the same saved path until explicit reattachment", async () => {
		const project = join(root, "project");
		mkdirSync(project);
		await runtime.change({ action: "register", workspaceId: "project", path: project });
		await runtime.change({ action: "select", workspaceId: "project" });
		const before = await runtime.getSnapshot();
		const bound = runtime.bindTool(tool);
		// Ordinary content changes are not a change of directory identity.
		writeFileSync(join(project, "fixture.txt"), "synthetic content\r\n");
		const unchanged = await bound.bindInvocation!("unchanged", {});
		unchanged.release();
		renameSync(project, join(root, "previous-project"));
		mkdirSync(project);
		await expect(bound.bindInvocation!("replacement", {})).rejects.toThrow("reattach");
		expect(execute).not.toHaveBeenCalled();
		expect(await runtime.getSnapshot()).toEqual(before);
		await runtime.change({ action: "reattach", workspaceId: "project", path: project });
		const repaired = await bound.bindInvocation!("repaired", {});
		expect(repaired.executionContext.attachment.attachmentId).not.toBe(
			unchanged.executionContext.attachment.attachmentId,
		);
		await repaired.execute("repaired", {});
		repaired.release();
		expect(execute).toHaveBeenCalledOnce();
	});

	it("keeps concurrent callbacks in their captured task context without process-global chdir", async () => {
		const ambient = process.cwd();
		const other = join(root, "other");
		mkdirSync(other);
		await runtime.change({ action: "register", workspaceId: "other", path: other });
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

	it("retains directory identity across runtime restart instead of trusting the new occupant", async () => {
		const project = join(root, "persisted");
		mkdirSync(project);
		await runtime.change({ action: "register", workspaceId: "project", path: project });
		await runtime.change({ action: "select", workspaceId: "project" });
		const saved = await runtime.getSnapshot();
		await runtime.dispose();
		runtime = new TaskDirectoryRuntime({
			getCwd: () => root,
			getSessionManager: () => session,
			getActiveTaskId: () => activeTaskId,
			getEnvelopes: () => [],
		});
		const control = await runtime.bindTool(tool).bindInvocation!("restored", {});
		control.release();
		renameSync(project, join(root, "previous"));
		mkdirSync(project);
		await expect(runtime.bindTool(tool).bindInvocation!("replaced", {})).rejects.toThrow("reattach");
		expect(await runtime.getSnapshot()).toEqual(saved);
		expect(execute).not.toHaveBeenCalled();
	});

	it("detects a retargeted directory link and allows explicit reattachment", async () => {
		const first = join(root, "first");
		const second = join(root, "second");
		const link = join(root, "project-link");
		mkdirSync(first);
		mkdirSync(second);
		const kind = process.platform === "win32" ? "junction" : "dir";
		symlinkSync(first, link, kind);
		await runtime.change({ action: "register", workspaceId: "linked", path: link });
		await runtime.change({ action: "select", workspaceId: "linked" });
		const bound = runtime.bindTool(tool);
		const control = await bound.bindInvocation!("same-target", {});
		control.release();
		unlinkSync(link);
		symlinkSync(second, link, kind);
		await expect(bound.bindInvocation!("retargeted", {})).rejects.toThrow("reattach");
		expect(execute).not.toHaveBeenCalled();
		await runtime.change({ action: "reattach", workspaceId: "linked", path: link });
		const repaired = await bound.bindInvocation!("repaired", {});
		repaired.release();
	});

	it("keeps status and reattachment available when the ambient root is missing", async () => {
		const missing = join(root, "missing");
		await runtime.dispose();
		runtime = new TaskDirectoryRuntime({
			getCwd: () => missing,
			getSessionManager: () => session,
			getActiveTaskId: () => activeTaskId,
			getEnvelopes: () => [],
		});
		expect((await runtime.getSnapshot()).workspaces[0]?.root).toBe(missing);
		const bound = runtime.bindTool(tool);
		await expect(bound.bindInvocation!("missing", {})).rejects.toHaveProperty("code", "ENOENT");
		mkdirSync(missing);
		await expect(bound.bindInvocation!("appeared", {})).rejects.toThrow("reattach");
		await runtime.change({ action: "reattach", workspaceId: "session", path: missing });
		const repaired = await bound.bindInvocation!("repaired", {});
		repaired.release();
		expect(execute).not.toHaveBeenCalled();
	});
});
