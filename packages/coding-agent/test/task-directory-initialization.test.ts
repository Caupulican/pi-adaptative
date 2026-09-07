import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as nativeBackend from "../src/core/tasks/native-task-directory-backend.ts";
import { createNativeTaskDirectoryBackend } from "../src/core/tasks/native-task-directory-backend.ts";
import { TASK_DIRECTORY_STATE_CUSTOM_TYPE } from "../src/core/tasks/session-task-directory-store.ts";
import {
	TASK_DIRECTORY_INITIALIZATION_TIMEOUT_MS,
	TaskDirectoryRuntime,
} from "../src/core/tasks/task-directory-runtime.ts";

vi.mock("../src/core/tasks/native-task-directory-backend.ts", async (importOriginal) => {
	const original = await importOriginal<typeof nativeBackend>();
	return { ...original, createNativeTaskDirectoryBackend: vi.fn(original.createNativeTaskDirectoryBackend) };
});

describe("task directory initialization lifecycle", () => {
	let root: string;
	let project: string;
	let session: SessionManager;
	let runtime: TaskDirectoryRuntime;
	let activeTaskId: string | undefined;
	let backend: ReturnType<typeof createNativeTaskDirectoryBackend>;
	const gates: Array<() => void> = [];
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-directory-init-"));
		project = join(root, "project");
		mkdirSync(project);
		session = SessionManager.inMemory(root);
		activeTaskId = undefined;
		backend = createNativeTaskDirectoryBackend();
		vi.mocked(createNativeTaskDirectoryBackend).mockReturnValueOnce(backend);
		runtime = new TaskDirectoryRuntime({
			getCwd: () => root,
			getSessionManager: () => session,
			getActiveTaskId: () => activeTaskId,
			getEnvelopes: () => [],
		});
	});
	afterEach(async () => {
		for (const release of gates.splice(0)) release();
		await runtime.dispose();
		vi.useRealTimers();
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	function stallIdentity() {
		const original = backend.createAttachmentId.bind(backend);
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		gates.push(finish.resolve);
		const capture = vi.spyOn(backend, "createAttachmentId").mockImplementationOnce(async (...args) => {
			entered.resolve();
			await finish.promise;
			return original(...args);
		});
		return { entered: entered.promise, finish: finish.resolve, capture };
	}

	it("does no setup for a pre-cancelled caller and remains usable", async () => {
		const capture = vi.spyOn(backend, "createAttachmentId");
		await expect(runtime.getStatus(AbortSignal.abort())).rejects.toThrow();
		expect(capture).not.toHaveBeenCalled();
		expect((await runtime.getStatus()).unavailable).toBeUndefined();
		expect(capture).toHaveBeenCalledOnce();
	});

	it("shares initialization without letting one cancelled waiter cancel another", async () => {
		const gate = stallIdentity();
		const abort = new AbortController();
		const cancelled = runtime.getStatus(abort.signal);
		await gate.entered;
		const retained = runtime.getStatus();
		abort.abort(new Error("fixture cancellation"));
		await expect(cancelled).rejects.toThrow("fixture cancellation");
		gate.finish();
		expect((await retained).effective?.cwd).toBe(root);
		expect(gate.capture).toHaveBeenCalledOnce();
		expect(session.getLatestCustomEntryOnBranch(TASK_DIRECTORY_STATE_CUSTOM_TYPE)).toBeUndefined();
	});

	it("captures the task cursor before asynchronous setup", async () => {
		const gate = stallIdentity();
		activeTaskId = "first";
		const tool = runtime.bindTool({
			name: "read",
			label: "read",
			description: "fixture",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: {} }),
		});
		const pending = tool.bindInvocation!("first", {});
		await gate.entered;
		activeTaskId = "second";
		gate.finish();
		const lease = await pending;
		expect(lease.executionContext.taskId).toBe("first");
		lease.release();
	});

	it("does not retarget an in-flight registration when its caller mutates the command", async () => {
		await runtime.getSnapshot();
		const gate = stallIdentity();
		const command = { action: "register" as const, workspaceId: "project", path: project };
		const pending = runtime.change(command);
		await gate.entered;
		command.workspaceId = "changed";
		command.path = root;
		gate.finish();
		const state = await pending;
		expect(state.workspaces.find((item) => item.workspaceId === "project")?.root).toBe(project);
		expect(state.workspaces.some((item) => item.workspaceId === "changed")).toBe(false);
	});

	it("preserves registration order while attachment identity is pending", async () => {
		await runtime.getSnapshot();
		const gate = stallIdentity();
		const registered = runtime.change({ action: "register", workspaceId: "project", path: project });
		await gate.entered;
		const selected = runtime.change({ action: "select", workspaceId: "project" });
		const both = Promise.all([registered, selected]);
		gate.finish();
		await both;
		expect((await runtime.getStatus()).effective?.cwd).toBe(project);
	});

	it("disposes pending setup without waiting for a stalled backend", async () => {
		const gate = stallIdentity();
		const settled = vi.fn();
		const pending = runtime.getStatus().catch(settled);
		await gate.entered;
		await runtime.dispose();
		await setImmediate();
		expect(settled).toHaveBeenCalledOnce();
		gate.finish();
		await pending;
		expect(session.getLatestCustomEntryOnBranch(TASK_DIRECTORY_STATE_CUSTOM_TYPE)).toBeUndefined();
	});

	it("does not install late initialization into a replacement session", async () => {
		const gate = stallIdentity();
		const old = runtime.getStatus();
		const rejected = expect(old).rejects.toThrow();
		await gate.entered;
		session = SessionManager.inMemory(root);
		const fresh = await runtime.getStatus();
		gate.finish();
		await rejected;
		expect(fresh.effective?.sessionId).toBe(session.getSessionId());
		expect((await runtime.getSnapshot()).revision).toBe(0);
	});

	it.each([false, true])("fences a session change during final validation; replaced manager=%s", async (replace) => {
		const originalSession = session;
		const validate = backend.validateAttachment.bind(backend);
		vi.spyOn(backend, "validateAttachment").mockImplementationOnce(async (...args) => {
			await validate(...args);
			if (replace) session = SessionManager.inMemory(root);
			else session.newSession();
		});
		await expect(runtime.change({ action: "register", workspaceId: "project", path: project })).rejects.toThrow(
			"session",
		);
		expect(session.getLatestCustomEntryOnBranch(TASK_DIRECTORY_STATE_CUSTOM_TYPE)).toBeUndefined();
		expect(originalSession.getLatestCustomEntryOnBranch(TASK_DIRECTORY_STATE_CUSTOM_TYPE)).toBeUndefined();
	});

	it("cancels registration without committing its late identity", async () => {
		await runtime.getSnapshot();
		const gate = stallIdentity();
		const abort = new AbortController();
		const settled = vi.fn();
		const pending = runtime
			.change({ action: "register", workspaceId: "project", path: project }, abort.signal)
			.catch(settled);
		await gate.entered;
		abort.abort(new Error("fixture cancellation"));
		await setImmediate();
		expect(settled).toHaveBeenCalledOnce();
		gate.finish();
		await pending;
		expect((await runtime.getSnapshot()).revision).toBe(0);
		await runtime.change({ action: "register", workspaceId: "project", path: project });
		expect((await runtime.getSnapshot()).revision).toBe(1);
	});

	it("leaves status and explicit repair available after an initialization timeout", async () => {
		vi.useFakeTimers();
		const gate = stallIdentity();
		const settled = vi.fn();
		const pending = runtime.getStatus().then(settled);
		await gate.entered;
		await vi.advanceTimersByTimeAsync(TASK_DIRECTORY_INITIALIZATION_TIMEOUT_MS);
		expect(settled).toHaveBeenCalledOnce();
		expect(settled.mock.calls[0]?.[0].unavailable).toContain("timed out");
		gate.finish();
		await pending;
		vi.useRealTimers();
		await runtime.change({ action: "reattach", workspaceId: "session", path: root });
		expect((await runtime.getStatus()).unavailable).toBeUndefined();
	});

	it("offers explicit repair after permission failure without claiming an available root", async () => {
		vi.spyOn(backend, "createAttachmentId").mockRejectedValueOnce(
			Object.assign(new Error("fixture EACCES"), { code: "EACCES" }),
		);
		expect((await runtime.getStatus()).unavailable).toBe("fixture EACCES");
		await runtime.change({ action: "reattach", workspaceId: "session", path: root });
		expect((await runtime.getStatus()).unavailable).toBeUndefined();
	});

	it("does not replace a restored project when ambient identity is unavailable", async () => {
		await runtime.change({ action: "register", workspaceId: "project", path: project });
		await runtime.change({ action: "select", workspaceId: "project" });
		const saved = await runtime.getSnapshot();
		await runtime.dispose();
		vi.spyOn(backend, "createAttachmentId").mockRejectedValueOnce(new Error("fixture unavailable ambient root"));
		vi.mocked(createNativeTaskDirectoryBackend).mockReturnValueOnce(backend);
		runtime = new TaskDirectoryRuntime({
			getCwd: () => root,
			getSessionManager: () => session,
			getActiveTaskId: () => activeTaskId,
			getEnvelopes: () => [],
		});
		const status = await runtime.getStatus();
		expect(status.state).toEqual(saved);
		expect(status.unavailable).toBeUndefined();
		expect(status.effective?.cwd).toBe(project);
	});
});
