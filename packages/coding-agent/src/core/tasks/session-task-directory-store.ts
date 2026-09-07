import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { TaskDirectoryStore } from "./task-directory-controller.ts";
import { restoreTaskDirectoryState } from "./task-directory-state.ts";

export const TASK_DIRECTORY_STATE_CUSTOM_TYPE = "task_directory_state";

/**
 * Directory bindings use their own versioned state in the existing session journal. Unlike advisory
 * checklist snapshots, corrupt latest execution authority cannot fall back to an older valid record.
 */
export function createSessionTaskDirectoryStore(
	session: Pick<SessionManager, "getLatestCustomEntryOnBranch" | "appendCustomEntry">,
): TaskDirectoryStore {
	const read: TaskDirectoryStore["read"] = () => {
		const entry = session.getLatestCustomEntryOnBranch(TASK_DIRECTORY_STATE_CUSTOM_TYPE);
		return { state: entry ? restoreTaskDirectoryState(entry.data) : undefined, revisionId: entry?.id ?? null };
	};
	return {
		read,
		commit(state, expectedRevisionId) {
			const current = read();
			if (current.revisionId !== expectedRevisionId)
				throw new Error("Task directory state changed; refresh before retrying");
			const validated = restoreTaskDirectoryState(state);
			if (current.state && validated.revision <= current.state.revision)
				throw new Error("Task directory revision must increase");
			// SessionManager appends synchronously, so no task can interleave between comparison and append.
			return session.appendCustomEntry(TASK_DIRECTORY_STATE_CUSTOM_TYPE, validated);
		},
	};
}
