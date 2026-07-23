import type { SessionManager } from "@caupulican/pi-agent-core/node";
import {
	appendSessionSnapshot,
	decodeSessionSnapshotPayload,
	getLatestSessionSnapshotOnBranch,
	type SessionSnapshotCodec,
	type SessionSnapshotPayload,
} from "../session-snapshot.ts";
import { cloneGoalStateForStorage, type GoalState, isGoalState } from "./goal-state.ts";

export const GOAL_STATE_CUSTOM_TYPE = "goal_state";

export type GoalStateSnapshotPayload = SessionSnapshotPayload<"state", GoalState>;

const GOAL_STATE_SNAPSHOT_CODEC: SessionSnapshotCodec<GoalState, "state"> = {
	customType: GOAL_STATE_CUSTOM_TYPE,
	valueKey: "state",
	isValue: isGoalState,
	clone: cloneGoalStateForStorage,
};

export function appendGoalStateSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	state: GoalState,
): string {
	return appendSessionSnapshot(sessionManager, GOAL_STATE_SNAPSHOT_CODEC, state);
}

/** Pure payload decode: validates + clones a goal-state snapshot payload. No SessionManager access,
 * so unit tests can exercise decoding directly against a constructed `data` value. */
export function decodeGoalStateSnapshotPayload(data: unknown): GoalState | undefined {
	return decodeSessionSnapshotPayload(data, GOAL_STATE_SNAPSHOT_CODEC);
}

/**
 * Most recent VALID goal-state snapshot on the active branch. Walks leaf→root ancestry via
 * `getLatestCustomEntryOnBranch`, skipping entries whose payload fails to decode and resuming
 * the search from that entry's parent, so an older valid snapshot still wins over a newer
 * malformed one (matches the pre-branch-scoping flat-list resolution semantics).
 */
export function getLatestGoalStateSnapshot(
	sessionManager: Pick<SessionManager, "getLatestCustomEntryOnBranch">,
): GoalState | undefined {
	return getLatestSessionSnapshotOnBranch(sessionManager, GOAL_STATE_SNAPSHOT_CODEC);
}
