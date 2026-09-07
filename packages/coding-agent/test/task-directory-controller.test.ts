import { setImmediate } from "node:timers/promises";
import type { ExecutionAttachment, ExecutionContext } from "@caupulican/pi-agent-core/paths";
import { describe, expect, it, vi } from "vitest";
import { TaskDirectoryController } from "../src/core/tasks/task-directory-controller.ts";
import {
	createTaskDirectoryState,
	type TaskDirectoryState,
	transitionTaskDirectoryState,
} from "../src/core/tasks/task-directory-state.ts";

const attachment: ExecutionAttachment = {
	workspaceId: "project",
	attachmentId: "attached",
	root: "/fixture/project",
	flavor: "posix",
	caseSensitive: true,
};

function fixture(validate: (context: ExecutionContext, signal?: AbortSignal) => Promise<void> = async () => {}) {
	let state = createTaskDirectoryState(attachment);
	let revisionId = "initial";
	const commit = vi.fn((next: TaskDirectoryState, expected: string | null) => {
		if (expected !== revisionId) throw new Error("stale directory state");
		state = next;
		revisionId = `revision-${state.revision}`;
		return revisionId;
	});
	const controller = new TaskDirectoryController({
		sessionId: "session",
		initialAttachment: attachment,
		store: { read: () => ({ state, revisionId }), commit },
		validate,
	});
	return { controller, commit, current: () => state };
}

describe("task directory admission", () => {
	it("persists a validated binding and admits its immutable directory", async () => {
		const validate = vi.fn(async () => {});
		const { controller, commit } = fixture(validate);
		await controller.change({ action: "bind", taskId: "task", pinned: true, path: "src" });
		expect(commit).toHaveBeenCalledOnce();
		const lease = await controller.admit("task");
		expect(lease.context.cwd).toBe("/fixture/project/src");
		expect(Object.isFrozen(lease.context)).toBe(true);
		expect(validate).toHaveBeenCalledTimes(2);
		lease.release();
		lease.release();
		expect(controller.activeCount).toBe(0);
	});

	it("leaves durable state unchanged after validation or persistence failure", async () => {
		const validate = vi.fn(async () => {});
		const { controller, commit, current } = fixture(validate);
		const before = current();
		validate.mockRejectedValueOnce(new Error("EACCES"));
		await expect(controller.change({ action: "bind", taskId: "task", pinned: true })).rejects.toThrow("EACCES");
		expect(commit).not.toHaveBeenCalled();
		commit.mockImplementationOnce(() => {
			throw new Error("store unavailable");
		});
		await expect(controller.change({ action: "bind", taskId: "task", pinned: true })).rejects.toThrow(
			"store unavailable",
		);
		expect(current()).toBe(before);
	});

	it("does not retarget running work when selection changes", async () => {
		const { controller } = fixture();
		await controller.change({
			action: "register",
			attachment: { ...attachment, workspaceId: "other", attachmentId: "other-attachment", root: "/fixture/other" },
		});
		await controller.change({ action: "bind", taskId: "task", pinned: false });
		const original = await controller.admit("task");
		await controller.change({ action: "select", workspaceId: "other" });
		const next = await controller.admit("task");
		expect(original.context.cwd).toBe(attachment.root);
		expect(next.context.cwd).toBe("/fixture/other");
		original.release();
		next.release();
	});

	it("waits for the owning task to settle before rebinding, without blocking another task", async () => {
		const { controller } = fixture();
		for (const taskId of ["busy", "other"]) await controller.change({ action: "bind", taskId, pinned: true });
		const lease = await controller.admit("busy");
		let changed = false;
		const pending = controller.change({ action: "bind", taskId: "busy", pinned: true, path: "src" }).then(() => {
			changed = true;
		});
		const other = await controller.admit("other");
		expect(changed).toBe(false);
		other.release();
		lease.release();
		await pending;
		const rebound = await controller.admit("busy");
		expect(rebound.context.cwd).toBe("/fixture/project/src");
		rebound.release();
	});

	it("cancels a waiting rebind without mutation or leaking a wait listener", async () => {
		const { controller, commit } = fixture();
		await controller.change({ action: "bind", taskId: "task", pinned: true });
		const lease = await controller.admit("task");
		const abort = new AbortController();
		const pending = controller.change({ action: "forget", taskId: "task" }, abort.signal);
		abort.abort();
		await expect(pending).rejects.toThrow();
		lease.release();
		expect(commit).toHaveBeenCalledOnce();
		expect(controller.waiterCount).toBe(0);
	});

	it("cancels stalled admission and handles a late adapter rejection", async () => {
		const stalled = Promise.withResolvers<void>();
		const validate = vi.fn(async () => {});
		const { controller } = fixture(validate);
		await controller.change({ action: "bind", taskId: "task", pinned: true });
		validate.mockImplementationOnce(() => stalled.promise);
		const abort = new AbortController();
		const pending = controller.admit("task", abort.signal);
		abort.abort();
		await expect(pending).rejects.toThrow();
		expect(controller.activeCount).toBe(0);
		stalled.reject(new Error("late adapter error"));
		const lease = await controller.admit("task");
		lease.release();
	});

	it("rejects admission if the session journal changes during directory validation", async () => {
		const stalled = Promise.withResolvers<void>();
		const validate = vi.fn(async () => {});
		const { controller, commit, current } = fixture(validate);
		await controller.change({ action: "bind", taskId: "task", pinned: true });
		validate.mockImplementationOnce(() => stalled.promise);
		const pending = controller.admit("task");
		const next = transitionTaskDirectoryState(current(), {
			action: "bind",
			taskId: "task",
			pinned: true,
			path: "moved",
		});
		commit(next, "revision-1");
		stalled.resolve();
		await expect(pending).rejects.toThrow("changed");
		expect(controller.activeCount).toBe(0);
		const fresh = await controller.admit("task");
		expect(fresh.context.cwd).toBe("/fixture/project/moved");
		fresh.release();
	});

	it("does not let new admissions starve an already waiting rebind", async () => {
		const { controller } = fixture();
		await controller.change({ action: "bind", taskId: "task", pinned: true });
		const first = await controller.admit("task");
		const rebind = controller.change({ action: "bind", taskId: "task", pinned: true, path: "next" });
		let admitted = false;
		const later = controller.admit("task").then((lease) => {
			admitted = true;
			return lease;
		});
		await setImmediate();
		expect(admitted).toBe(false);
		first.release();
		await rebind;
		const second = await later;
		expect(second.context.cwd).toBe("/fixture/project/next");
		second.release();
	});

	it("waits for all leases on a workspace before reattachment", async () => {
		const { controller } = fixture();
		for (const taskId of ["first", "second"]) await controller.change({ action: "bind", taskId, pinned: true });
		const first = await controller.admit("first");
		const second = await controller.admit("second");
		let settled = false;
		const pending = controller
			.change({
				action: "reattach",
				attachment: {
					...attachment,
					root: "/fixture/moved",
					attachmentId: "reattached",
				},
			})
			.then(() => {
				settled = true;
			});
		first.release();
		await setImmediate();
		expect(settled).toBe(false);
		second.release();
		await pending;
		const next = await controller.admit("first");
		expect(next.context.cwd).toBe("/fixture/moved");
		expect(second.context.cwd).toBe(attachment.root);
		next.release();
	});

	it("teardown cancels waiters but does not pretend an active invocation has finished", async () => {
		const { controller, commit } = fixture();
		await controller.change({ action: "bind", taskId: "task", pinned: true });
		const active = await controller.admit("task");
		const waiting = controller.change({ action: "forget", taskId: "task" });
		controller.dispose();
		await expect(waiting).rejects.toThrow("disposed");
		expect(controller.activeCount).toBe(1);
		expect(controller.waiterCount).toBe(0);
		expect(commit).toHaveBeenCalledOnce();
		active.release();
		expect(controller.activeCount).toBe(0);
		await expect(controller.admit("task")).rejects.toThrow("disposed");
	});
});
