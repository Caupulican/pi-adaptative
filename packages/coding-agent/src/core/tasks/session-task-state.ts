import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { cloneTaskStepsState, isTaskStepsState, type TaskStepsState } from "./task-state.ts";

export const TASK_STEPS_STATE_CUSTOM_TYPE = "task_steps_state";

export interface TaskStepsStateSnapshotPayload {
	version: 1;
	state: TaskStepsState;
}

export function appendTaskStepsStateSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	state: TaskStepsState,
): string {
	const payload: TaskStepsStateSnapshotPayload = {
		version: 1,
		state: cloneTaskStepsState(state),
	};
	return sessionManager.appendCustomEntry(TASK_STEPS_STATE_CUSTOM_TYPE, payload);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Pure payload decode: validates + clones a task-steps snapshot payload. No SessionManager access,
 * so unit tests can exercise decoding directly against a constructed `data` value. */
export function decodeTaskStepsStateSnapshotPayload(data: unknown): TaskStepsState | undefined {
	if (!isPlainRecord(data) || data.version !== 1 || !("state" in data)) return undefined;
	if (isTaskStepsState(data.state)) return cloneTaskStepsState(data.state);
	return undefined;
}

/**
 * Most recent VALID task-steps snapshot on the active branch. Walks leaf→root ancestry via
 * `getLatestCustomEntryOnBranch`, skipping entries whose payload fails to decode and resuming
 * the search from that entry's parent, so an older valid snapshot still wins over a newer
 * malformed one (matches the pre-branch-scoping flat-list resolution semantics).
 */
export function getLatestTaskStepsStateSnapshot(
	sessionManager: Pick<SessionManager, "getLatestCustomEntryOnBranch">,
): TaskStepsState | undefined {
	let fromId: string | undefined;
	for (;;) {
		const entry = sessionManager.getLatestCustomEntryOnBranch(TASK_STEPS_STATE_CUSTOM_TYPE, fromId);
		if (!entry) return undefined;
		const decoded = decodeTaskStepsStateSnapshotPayload(entry.data);
		if (decoded !== undefined) return decoded;
		if (entry.parentId === null) return undefined;
		fromId = entry.parentId;
	}
}
