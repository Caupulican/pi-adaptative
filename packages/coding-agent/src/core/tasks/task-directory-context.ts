import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { createSessionTaskDirectoryStore, TASK_DIRECTORY_STATE_CUSTOM_TYPE } from "./session-task-directory-store.ts";
import { getLatestTaskStepsStateSnapshot, TASK_STEPS_STATE_CUSTOM_TYPE } from "./session-task-state.ts";
import { resolveTaskDirectoryContext, type TaskDirectoryState } from "./task-directory-state.ts";

export const TASK_DIRECTORY_CONTEXT_CUSTOM_TYPE = "task_directory_context";
export const MAX_TASK_DIRECTORY_CONTEXT_BYTES = 16 * 1024;
export const TASK_DIRECTORY_CONTEXT_CLEARED =
	"TASK DIRECTORY CONTEXT: no saved workspace overrides on this branch. Earlier directory records are stale; tools use the session directory unless a new binding is selected.";

export interface TaskDirectoryContextPlan {
	content: string | undefined;
	isCurrent(): boolean;
}

/** Bounded model projection only. The journal and admission controller remain the execution authority. */
export function formatTaskDirectoryContext(
	state: TaskDirectoryState,
	taskId: string | undefined,
	sessionId: string,
): string {
	const context = resolveTaskDirectoryContext(state, taskId, sessionId, true);
	const pinned = state.bindings.find((binding) => binding.taskId === taskId)?.pinned ?? false;
	const active = { taskId, pinned, workspaceId: context.attachment.workspaceId, cwd: context.cwd };
	const projection = {
		revision: state.revision,
		selectedWorkspaceId: state.selectedWorkspaceId,
		active,
		cwdOmitted: false,
		workspaces: [] as Array<{ workspaceId: string; root: string }>,
		bindings: [] as TaskDirectoryState["bindings"][number][],
		omittedWorkspaces: state.workspaces.length,
		omittedBindings: state.bindings.length,
	};
	const header = "TASK DIRECTORY CONTEXT\n";
	const footer =
		"\nSaved intent, not filesystem validation. task_steps selects the active task; unpinned tasks follow workspace selection. Use task_directory status to page through full state; admission validates the directory before execution.";
	const render = () => header + JSON.stringify(projection) + footer;
	// Never turn a truncated path into an executable-looking path. Very large paths are omitted explicitly.
	if (Buffer.byteLength(render()) > MAX_TASK_DIRECTORY_CONTEXT_BYTES) {
		projection.active.cwd = "";
		projection.cwdOmitted = true;
	}
	let remainingBytes = MAX_TASK_DIRECTORY_CONTEXT_BYTES - Buffer.byteLength(render());
	// Measure each row once. Decreasing omission counters can only shrink the baseline envelope.
	const appendRows = <T>(rows: readonly T[], target: T[]): number => {
		for (const row of rows) {
			const bytes = Buffer.byteLength(JSON.stringify(row)) + (target.length > 0 ? 1 : 0);
			if (bytes > remainingBytes) continue;
			target.push(row);
			remainingBytes -= bytes;
		}
		return rows.length - target.length;
	};
	projection.omittedWorkspaces = appendRows(
		state.workspaces.map(({ workspaceId, root }) => ({ workspaceId, root })),
		projection.workspaces,
	);
	projection.omittedBindings = appendRows(state.bindings, projection.bindings);
	return render();
}

/** Reconstruct from branch state, not transcript retention; no filesystem probe or durable mutation. */
export function captureSessionTaskDirectoryContext(session: SessionManager): TaskDirectoryContextPlan {
	const sessionId = session.getSessionId();
	const directoryEntryId = session.getLatestCustomEntryOnBranch(TASK_DIRECTORY_STATE_CUSTOM_TYPE)?.id;
	const taskEntryId = session.getLatestCustomEntryOnBranch(TASK_STEPS_STATE_CUSTOM_TYPE)?.id;
	let content: string | undefined;
	try {
		const state = createSessionTaskDirectoryStore(session).read().state;
		if (state) {
			const taskId = getLatestTaskStepsStateSnapshot(session)?.steps.find(
				(step) => step.status === "in_progress",
			)?.id;
			content = formatTaskDirectoryContext(state, taskId, sessionId);
		}
	} catch {
		// Keep model recovery available without resurrecting an older binding or exposing malformed payloads.
		content =
			"TASK DIRECTORY CONTEXT: saved state is invalid. Do not infer a directory from older records; inspect task_directory status and repair the saved binding before execution.";
	}
	return {
		content,
		isCurrent: () =>
			session.getSessionId() === sessionId &&
			session.getLatestCustomEntryOnBranch(TASK_DIRECTORY_STATE_CUSTOM_TYPE)?.id === directoryEntryId &&
			session.getLatestCustomEntryOnBranch(TASK_STEPS_STATE_CUSTOM_TYPE)?.id === taskEntryId,
	};
}
