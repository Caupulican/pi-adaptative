import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { cloneGoalStateForStorage, type GoalState, isGoalState } from "./goal-state.ts";

export const GOAL_STATE_CUSTOM_TYPE = "goal_state";

export interface GoalStateSnapshotPayload {
	version: 1;
	state: GoalState;
}

export function appendGoalStateSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	state: GoalState,
): string {
	const payload: GoalStateSnapshotPayload = {
		version: 1,
		state: cloneGoalStateForStorage(state),
	};
	return sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, payload);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Pure payload decode: validates + clones a goal-state snapshot payload. No SessionManager access,
 * so unit tests can exercise decoding directly against a constructed `data` value. */
export function decodeGoalStateSnapshotPayload(data: unknown): GoalState | undefined {
	if (!isPlainRecord(data)) return undefined;
	if (data.version !== 1) return undefined;
	if (!("state" in data)) return undefined;
	const state = data.state;
	if (isGoalState(state)) return cloneGoalStateForStorage(state);
	return undefined;
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
	let fromId: string | undefined;
	for (;;) {
		const entry = sessionManager.getLatestCustomEntryOnBranch(GOAL_STATE_CUSTOM_TYPE, fromId);
		if (!entry) return undefined;
		const decoded = decodeGoalStateSnapshotPayload(entry.data);
		if (decoded !== undefined) return decoded;
		if (entry.parentId === null) return undefined;
		fromId = entry.parentId;
	}
}
