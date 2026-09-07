import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { fauxAssistantMessage } from "@caupulican/pi-ai/faux";
import { describe, expect, it } from "vitest";
import {
	createSessionTaskDirectoryStore,
	TASK_DIRECTORY_STATE_CUSTOM_TYPE,
} from "../src/core/tasks/session-task-directory-store.ts";
import { appendTaskStepsStateSnapshot, TASK_STEPS_STATE_CUSTOM_TYPE } from "../src/core/tasks/session-task-state.ts";
import {
	captureSessionTaskDirectoryContext,
	formatTaskDirectoryContext,
	MAX_TASK_DIRECTORY_CONTEXT_BYTES,
} from "../src/core/tasks/task-directory-context.ts";
import {
	createTaskDirectoryState,
	restoreTaskDirectoryState,
	transitionTaskDirectoryState,
} from "../src/core/tasks/task-directory-state.ts";
import { createTaskStepsState, setTaskSteps, updateTaskStep } from "../src/core/tasks/task-state.ts";

function fixture() {
	const session = SessionManager.inMemory("/fixture");
	const state = createTaskDirectoryState({
		workspaceId: "first",
		attachmentId: "synthetic-first",
		root: "/fixture/first",
		flavor: "posix",
		caseSensitive: true,
	});
	const store = createSessionTaskDirectoryStore(session);
	return { session, state, store };
}

describe("saved directory model context", () => {
	it("reconstructs pins and the active task from the reopened journal, then follows cursor changes", () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-directory-context-"));
		try {
			const session = SessionManager.create(scratch, scratch, scratch);
			session.appendMessage(fauxAssistantMessage("Synthetic journal anchor"));
			const { state } = fixture();
			const pinned = transitionTaskDirectoryState(state, {
				action: "bind",
				taskId: "step-1",
				pinned: true,
				path: "src",
			});
			createSessionTaskDirectoryStore(session).commit(pinned, null);
			const steps = setTaskSteps(
				createTaskStepsState("T0"),
				[{ content: "First", status: "in_progress" }, { content: "Second" }],
				"T1",
			);
			appendTaskStepsStateSnapshot(session, steps);
			const original = captureSessionTaskDirectoryContext(session);
			const file = session.getSessionFile();
			if (!file) throw new Error("Expected synthetic journal");
			const reopened = SessionManager.open(file, scratch, scratch);
			const restored = captureSessionTaskDirectoryContext(reopened);
			expect(restored.content).toBe(original.content);
			expect(restored.content).toContain('"cwd":"/fixture/first/src"');
			appendTaskStepsStateSnapshot(reopened, updateTaskStep(steps, "step-2", { status: "in_progress" }, "T2"));
			expect(restored.isCurrent()).toBe(false);
			const following = captureSessionTaskDirectoryContext(reopened).content;
			expect(following).toContain(
				'"active":{"taskId":"step-2","pinned":false,"workspaceId":"first","cwd":"/fixture/first"}',
			);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
	it("projects the authoritative pinned directory even when another workspace is selected", () => {
		const { session, state } = fixture();
		const registered = transitionTaskDirectoryState(state, {
			action: "register",
			attachment: {
				workspaceId: "drive",
				attachmentId: "synthetic-drive",
				root: "D:\\projects\\日本語",
				flavor: "win32",
				caseSensitive: false,
			},
		});
		const bound = transitionTaskDirectoryState(registered, {
			action: "bind",
			taskId: "first-task",
			pinned: true,
			workspaceId: "first",
			path: "src",
		});
		const selected = transitionTaskDirectoryState(bound, { action: "select", workspaceId: "drive" });
		const pinned = formatTaskDirectoryContext(selected, "first-task", session.getSessionId());
		expect(pinned).toContain('"cwd":"/fixture/first/src"');
		expect(pinned).toContain('"pinned":true');
		expect(pinned).toContain('"selectedWorkspaceId":"drive"');
		const following = formatTaskDirectoryContext(selected, "unbound-task", session.getSessionId());
		expect(following).toContain(JSON.stringify("D:\\projects\\日本語"));
		expect(following).toContain('"pinned":false');
		expect(formatTaskDirectoryContext(selected, "first-task", session.getSessionId())).toBe(pinned);
	});

	it.each(["directory", "task", "session", "branch"])(
		"invalidates an accepted projection after a %s change",
		(change) => {
			const { session, state, store } = fixture();
			const before = session.appendCustomEntry("synthetic-before-bindings", {});
			const root = store.commit(state, null);
			const first = captureSessionTaskDirectoryContext(session);
			expect(first.isCurrent()).toBe(true);
			if (change === "directory")
				store.commit(transitionTaskDirectoryState(state, { action: "bind", taskId: "one", pinned: true }), root);
			if (change === "task")
				session.appendCustomEntry(TASK_STEPS_STATE_CUSTOM_TYPE, { invalid: "synthetic task change" });
			if (change === "session") session.newSession();
			if (change === "branch") session.branch(before);
			expect(first.isCurrent()).toBe(false);
		},
	);

	it("does not infer overrides before registration, and detects registration during planning", () => {
		const { session, state, store } = fixture();
		const empty = captureSessionTaskDirectoryContext(session);
		expect(empty.content).toBeUndefined();
		expect(empty.isCurrent()).toBe(true);
		store.commit(state, null);
		expect(empty.isCurrent()).toBe(false);
		expect(captureSessionTaskDirectoryContext(session).content).toContain("TASK DIRECTORY CONTEXT");
	});

	it("reports corrupt latest state without exposing its payload or resurrecting an older pin", () => {
		const { session, state, store } = fixture();
		store.commit(state, null);
		session.appendCustomEntry(TASK_DIRECTORY_STATE_CUSTOM_TYPE, { payload: "SYNTHETIC_PRIVATE_SENTINEL" });
		const plan = captureSessionTaskDirectoryContext(session);
		expect(plan.content).toContain("saved state is invalid");
		expect(plan.content).not.toContain("SYNTHETIC_PRIVATE_SENTINEL");
		expect(plan.content).not.toContain("/fixture/first");
		expect(plan.isCurrent()).toBe(true);
	});

	it("bounds multibyte catalogues and omits whole paths instead of manufacturing partial paths", () => {
		const root = `/${"日".repeat(4000)}`;
		const state = restoreTaskDirectoryState({
			...createTaskDirectoryState({
				workspaceId: "long",
				attachmentId: "synthetic-long",
				root,
				flavor: "posix",
				caseSensitive: true,
			}),
			revision: 128,
			bindings: Array.from({ length: 128 }, (_, i) => ({
				taskId: `task-${i}`,
				pinned: true,
				workspaceId: "long",
				path: "本".repeat(4000),
			})),
		});
		const content = formatTaskDirectoryContext(state, "task-127", "synthetic-session");
		expect(Buffer.byteLength(content)).toBeLessThanOrEqual(MAX_TASK_DIRECTORY_CONTEXT_BYTES);
		const data = JSON.parse(content.split("\n")[1]!);
		expect(data.cwdOmitted).toBe(true);
		expect(data.active.cwd).toBe("");
		expect(data.omittedBindings).toBeGreaterThan(0);
		expect(data.bindings.length + data.omittedBindings).toBe(128);
		for (const row of data.bindings) expect(row.path).toBe("本".repeat(4000));
	});
});
