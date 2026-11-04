import type { SessionManager } from "../../kernel/node.ts";
import {
	buildTaskDirectoryContextRecord,
	renderTaskDirectoryContext,
	type TaskDirectoryContextRecord,
} from "../comms/host-injection-records.ts";
import { createSessionTaskDirectoryStore, TASK_DIRECTORY_STATE_CUSTOM_TYPE } from "./session-task-directory-store.ts";
import { getLatestTaskStepsStateSnapshot, TASK_STEPS_STATE_CUSTOM_TYPE } from "./session-task-state.ts";
import { resolveTaskDirectoryContext, type TaskDirectoryState } from "./task-directory-state.ts";

export const TASK_DIRECTORY_CONTEXT_CUSTOM_TYPE = "task_directory_context";
export const TASK_DIRECTORY_CONTEXT_CLEARED =
	"TASK DIRECTORY CONTEXT: no saved workspace overrides on this branch. Earlier directory records are stale; tools use the session directory unless a new binding is selected.";

export interface TaskDirectoryContextPlan {
	content: string | undefined;
	/** The record `content` renders; absent for the cleared and invalid-state texts. */
	record?: TaskDirectoryContextRecord;
	isCurrent(): boolean;
}

/** Bounded model projection only. The journal and admission controller remain the execution authority. */
export function buildTaskDirectoryContext(
	state: TaskDirectoryState,
	taskId: string | undefined,
	sessionId: string,
): TaskDirectoryContextRecord {
	const context = resolveTaskDirectoryContext(state, taskId, sessionId, true);
	const pinned = state.bindings.find((binding) => binding.taskId === taskId)?.pinned ?? false;
	return buildTaskDirectoryContextRecord({
		revision: state.revision,
		selectedWorkspaceId: state.selectedWorkspaceId,
		active: {
			...(taskId !== undefined ? { taskId } : {}),
			pinned,
			workspaceId: context.attachment.workspaceId,
			cwd: context.cwd,
		},
		workspaces: state.workspaces.map(({ workspaceId, root }) => ({ workspaceId, root })),
		bindings: state.bindings,
	});
}

/** Reconstruct from branch state, not transcript retention; no filesystem probe or durable mutation. */
export function captureSessionTaskDirectoryContext(session: SessionManager): TaskDirectoryContextPlan {
	const sessionId = session.getSessionId();
	const directoryEntryId = session.getLatestCustomEntryOnBranch(TASK_DIRECTORY_STATE_CUSTOM_TYPE)?.id;
	const taskEntryId = session.getLatestCustomEntryOnBranch(TASK_STEPS_STATE_CUSTOM_TYPE)?.id;
	let content: string | undefined;
	let record: TaskDirectoryContextRecord | undefined;
	try {
		const state = createSessionTaskDirectoryStore(session).read().state;
		if (state) {
			const taskId = getLatestTaskStepsStateSnapshot(session)?.steps.find(
				(step) => step.status === "in_progress",
			)?.id;
			const built = buildTaskDirectoryContext(state, taskId, sessionId);
			content = renderTaskDirectoryContext(built);
			record = built;
		}
	} catch {
		// Keep model recovery available without resurrecting an older binding or exposing malformed payloads.
		content =
			"TASK DIRECTORY CONTEXT: saved state is invalid. Do not infer a directory from older records; inspect task_directory status and repair the saved binding before execution.";
	}
	return {
		content,
		...(record ? { record } : {}),
		isCurrent: () =>
			session.getSessionId() === sessionId &&
			session.getLatestCustomEntryOnBranch(TASK_DIRECTORY_STATE_CUSTOM_TYPE)?.id === directoryEntryId &&
			session.getLatestCustomEntryOnBranch(TASK_STEPS_STATE_CUSTOM_TYPE)?.id === taskEntryId,
	};
}
