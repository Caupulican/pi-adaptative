import type { ExecutionAttachment } from "@caupulican/pi-agent-core/paths";
import { describe, expect, it } from "vitest";
import {
	createTaskDirectoryState,
	MAX_TASK_DIRECTORY_BINDINGS,
	resolveTaskDirectoryContext,
	restoreTaskDirectoryState,
	transitionTaskDirectoryState,
} from "../src/core/tasks/task-directory-state.ts";

const first: ExecutionAttachment = {
	workspaceId: "first",
	attachmentId: "first-attachment",
	root: "/fixture/first",
	flavor: "posix",
	caseSensitive: true,
};
const second: ExecutionAttachment = {
	workspaceId: "second",
	attachmentId: "second-attachment",
	root: "D:\\fixture space\\日本語",
	flavor: "win32",
	caseSensitive: false,
};

describe("task directory state", () => {
	it("explicitly admits an unconfigured task at the selected workspace without inventing a pin", () => {
		const state = createTaskDirectoryState(first);
		const context = resolveTaskDirectoryContext(state, "new-task", "session", true);
		expect(context).toMatchObject({ cwd: first.root, taskId: "new-task" });
		expect(state.bindings).toEqual([]);
		expect(resolveTaskDirectoryContext(state, undefined, "session").cwd).toBe(first.root);
	});
	it("keeps pins stable while unpinned tasks follow workspace selection", () => {
		let state = createTaskDirectoryState(first);
		state = transitionTaskDirectoryState(state, { action: "register", attachment: second });
		state = transitionTaskDirectoryState(state, { action: "bind", taskId: "pinned", pinned: true, path: "package" });
		state = transitionTaskDirectoryState(state, { action: "bind", taskId: "following", pinned: false });
		const admitted = resolveTaskDirectoryContext(state, "following", "session");
		state = transitionTaskDirectoryState(state, { action: "select", workspaceId: "second" });
		expect(resolveTaskDirectoryContext(state, "pinned", "session").cwd).toBe("/fixture/first/package");
		expect(resolveTaskDirectoryContext(state, "following", "session").cwd).toBe(second.root);
		expect(admitted.cwd).toBe(first.root);
		expect(Object.isFrozen(admitted)).toBe(true);
	});

	it("lets the model pin distinct tasks to different registered workspaces", () => {
		let state = createTaskDirectoryState(first);
		state = transitionTaskDirectoryState(state, { action: "register", attachment: second });
		for (const attachment of [first, second]) {
			state = transitionTaskDirectoryState(state, {
				action: "bind",
				taskId: attachment.workspaceId,
				pinned: true,
				workspaceId: attachment.workspaceId,
				path: "src",
			});
		}
		const restored = restoreTaskDirectoryState(JSON.parse(JSON.stringify(state)));
		expect(resolveTaskDirectoryContext(restored, "first", "resumed").cwd).toBe("/fixture/first/src");
		expect(resolveTaskDirectoryContext(restored, "second", "resumed").cwd).toBe(`${second.root}\\src`);
		expect(restored).toEqual(state);
	});

	it("requires explicit reattachment and fences old contexts by attachment identity", () => {
		let state = createTaskDirectoryState(first);
		state = transitionTaskDirectoryState(state, { action: "bind", taskId: "task", pinned: true });
		const admitted = resolveTaskDirectoryContext(state, "task", "session");
		const moved = { ...first, root: "/relocated/first", attachmentId: "reattached" };
		expect(() => transitionTaskDirectoryState(state, { action: "register", attachment: moved })).toThrow();
		state = transitionTaskDirectoryState(state, { action: "reattach", attachment: moved });
		const current = resolveTaskDirectoryContext(state, "task", "session");
		expect(current.cwd).toBe(moved.root);
		expect(current.attachment.attachmentId).not.toBe(admitted.attachment.attachmentId);
		expect(current.generation).toBeGreaterThan(admitted.generation);
		expect(admitted.cwd).toBe(first.root);
	});

	it.each(["../escape", "/absolute", "\u0000", "D:relative", "D:\\absolute"])(
		"rejects unsafe portable directory %j atomically",
		(path) => {
			const state = createTaskDirectoryState(second);
			const before = JSON.stringify(state);
			expect(() =>
				transitionTaskDirectoryState(state, { action: "bind", taskId: "task", pinned: true, path }),
			).toThrow();
			expect(JSON.stringify(state)).toBe(before);
		},
	);

	it("pinning and unpinning are explicit revisions and replay is inert", () => {
		let state = createTaskDirectoryState(first);
		const command = { action: "bind", taskId: "task", pinned: true, path: "src" } as const;
		state = transitionTaskDirectoryState(state, command);
		expect(transitionTaskDirectoryState(state, command)).toBe(state);
		const revision = state.revision;
		state = transitionTaskDirectoryState(state, { action: "bind", taskId: "task", pinned: false });
		expect(state.revision).toBe(revision + 1);
		expect(resolveTaskDirectoryContext(state, "task", "session").cwd).toBe(first.root);
	});

	it("rejects missing bindings rather than borrowing another task's directory", () => {
		expect(() => resolveTaskDirectoryContext(createTaskDirectoryState(first), "missing", "session")).toThrow();
	});

	it("rejects corrupt snapshots instead of restoring an older or guessed binding", () => {
		let state = createTaskDirectoryState(first);
		state = transitionTaskDirectoryState(state, { action: "bind", taskId: "task", pinned: true });
		for (const broken of [
			{ ...state, version: 2 },
			{ ...state, revision: Number.MAX_SAFE_INTEGER + 1 },
			{ ...state, selectedWorkspaceId: "absent" },
			{ ...state, workspaces: [first, first] },
			{ ...state, bindings: [...state.bindings, ...state.bindings] },
			{ ...state, bindings: [{ ...state.bindings[0], workspaceId: "absent" }] },
		])
			expect(() => restoreTaskDirectoryState(broken)).toThrow();
	});

	it("bounds retained bindings and permits explicit removal before adding another", () => {
		let state = createTaskDirectoryState(first);
		for (let index = 0; index < MAX_TASK_DIRECTORY_BINDINGS; index++) {
			state = transitionTaskDirectoryState(state, { action: "bind", taskId: `task-${index}`, pinned: true });
		}
		expect(() => transitionTaskDirectoryState(state, { action: "bind", taskId: "overflow", pinned: true })).toThrow(
			"full",
		);
		state = transitionTaskDirectoryState(state, { action: "forget", taskId: "task-0" });
		state = transitionTaskDirectoryState(state, { action: "bind", taskId: "replacement", pinned: true });
		expect(state.bindings).toHaveLength(MAX_TASK_DIRECTORY_BINDINGS);
	});

	it("detaches snapshots and rejects revision exhaustion without wrapping", () => {
		const state = createTaskDirectoryState(first);
		const source = JSON.parse(JSON.stringify(state));
		const restored = restoreTaskDirectoryState(source);
		source.workspaces[0].root = "/changed";
		expect(restored.workspaces[0]?.root).toBe(first.root);
		expect(() =>
			transitionTaskDirectoryState(
				{ ...restored, revision: Number.MAX_SAFE_INTEGER },
				{
					action: "bind",
					taskId: "task",
					pinned: true,
				},
			),
		).toThrow("exhausted");
	});

	it("checks a portable directory again when workspace selection changes dialect", () => {
		let state = createTaskDirectoryState(first);
		state = transitionTaskDirectoryState(state, { action: "register", attachment: second });
		state = transitionTaskDirectoryState(state, {
			action: "bind",
			taskId: "task",
			pinned: false,
			path: "D:relative",
		});
		expect(() => transitionTaskDirectoryState(state, { action: "select", workspaceId: "second" })).toThrow();
		expect(state.selectedWorkspaceId).toBe("first");
	});
});
