import type { SessionManager } from "@caupulican/pi-agent-core/node";
import {
	appendSessionSnapshot,
	decodeSessionSnapshotPayload,
	getLatestSessionSnapshotOnBranch,
	type SessionSnapshotCodec,
	type SessionSnapshotPayload,
} from "../session-snapshot.ts";
import { cloneTaskStepsState, isTaskStepsState, type TaskStepsState } from "./task-state.ts";

export const TASK_STEPS_STATE_CUSTOM_TYPE = "task_steps_state";

export type TaskStepsStateSnapshotPayload = SessionSnapshotPayload<"state", TaskStepsState>;

const TASK_STEPS_STATE_SNAPSHOT_CODEC: SessionSnapshotCodec<TaskStepsState, "state"> = {
	customType: TASK_STEPS_STATE_CUSTOM_TYPE,
	valueKey: "state",
	isValue: isTaskStepsState,
	clone: cloneTaskStepsState,
};

export function appendTaskStepsStateSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	state: TaskStepsState,
): string {
	return appendSessionSnapshot(sessionManager, TASK_STEPS_STATE_SNAPSHOT_CODEC, state);
}

/** Pure payload decode: validates + clones a task-steps snapshot payload. No SessionManager access,
 * so unit tests can exercise decoding directly against a constructed `data` value. */
export function decodeTaskStepsStateSnapshotPayload(data: unknown): TaskStepsState | undefined {
	return decodeSessionSnapshotPayload(data, TASK_STEPS_STATE_SNAPSHOT_CODEC);
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
	return getLatestSessionSnapshotOnBranch(sessionManager, TASK_STEPS_STATE_SNAPSHOT_CODEC);
}
