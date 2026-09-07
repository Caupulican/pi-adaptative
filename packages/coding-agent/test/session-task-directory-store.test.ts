import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { createEmptyUsage } from "@caupulican/pi-agent-core/usage";
import { describe, expect, it } from "vitest";
import {
	createSessionTaskDirectoryStore,
	TASK_DIRECTORY_STATE_CUSTOM_TYPE,
} from "../src/core/tasks/session-task-directory-store.ts";
import { createTaskDirectoryState, transitionTaskDirectoryState } from "../src/core/tasks/task-directory-state.ts";

function state() {
	return createTaskDirectoryState({
		workspaceId: "fixture",
		attachmentId: "attached",
		root: "/fixture/project",
		flavor: "posix",
		caseSensitive: true,
	});
}

describe("session task directory store", () => {
	it("does not let an old store write into a new session on the same manager", () => {
		const session = SessionManager.inMemory("/fixture/project");
		const store = createSessionTaskDirectoryStore(session);
		session.newSession();
		expect(() => store.commit(state(), null)).toThrow("session");
		expect(session.getLatestCustomEntryOnBranch(TASK_DIRECTORY_STATE_CUSTOM_TYPE)).toBeUndefined();
		expect(createSessionTaskDirectoryStore(session).read().state).toBeUndefined();
	});
	it("restores isolated branch-scoped bindings using the session journal", () => {
		const session = SessionManager.inMemory("/fixture/project");
		const store = createSessionTaskDirectoryStore(session);
		const root = store.commit(state(), null);
		const bound = transitionTaskDirectoryState(state(), {
			action: "bind",
			taskId: "task",
			pinned: true,
			path: "src",
		});
		const child = store.commit(bound, root);
		expect(store.read()).toEqual({ state: bound, revisionId: child });
		session.branch(root);
		expect(createSessionTaskDirectoryStore(session).read()).toEqual({ state: state(), revisionId: root });
		expect(createSessionTaskDirectoryStore(SessionManager.inMemory("/fixture/project")).read()).toEqual({
			state: undefined,
			revisionId: null,
		});
	});

	it("rejects stale writes without appending another record", () => {
		const session = SessionManager.inMemory("/fixture/project");
		const store = createSessionTaskDirectoryStore(session);
		store.commit(state(), null);
		const before = session.getLeafId();
		expect(() => store.commit(state(), null)).toThrow("changed");
		expect(session.getLeafId()).toBe(before);
	});

	it.each([{ version: 2 }, { version: 1, bindings: [] }])(
		"refuses corrupt latest state instead of resurrecting an older pin %#",
		(broken) => {
			const session = SessionManager.inMemory("/fixture/project");
			const store = createSessionTaskDirectoryStore(session);
			store.commit(state(), null);
			session.appendCustomEntry(TASK_DIRECTORY_STATE_CUSTOM_TYPE, broken);
			expect(() => store.read()).toThrow("snapshot");
		},
	);

	it("requires increasing revisions even when the caller holds the latest record id", () => {
		const session = SessionManager.inMemory("/fixture/project");
		const store = createSessionTaskDirectoryStore(session);
		const id = store.commit(state(), null);
		expect(() => store.commit(state(), id)).toThrow("revision");
		expect(store.read().revisionId).toBe(id);
	});

	it("restores pinned state after closing and reopening the actual session journal", () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-directory-store-"));
		try {
			const session = SessionManager.create(scratch, scratch, scratch);
			session.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "Synthetic fixture" }],
				api: "openai-completions",
				provider: "fixture",
				model: "fixture",
				usage: createEmptyUsage(),
				stopReason: "stop",
				timestamp: 0,
			});
			const bound = transitionTaskDirectoryState(state(), {
				action: "bind",
				taskId: "task",
				pinned: true,
				path: "src",
			});
			const id = createSessionTaskDirectoryStore(session).commit(bound, null);
			const file = session.getSessionFile();
			if (!file) throw new Error("Fixture did not persist its journal");
			const reopened = SessionManager.open(file, scratch, scratch);
			expect(createSessionTaskDirectoryStore(reopened).read()).toEqual({ state: bound, revisionId: id });
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
