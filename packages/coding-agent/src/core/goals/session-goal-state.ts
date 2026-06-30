import type { SessionEntry, SessionManager } from "../session-manager.ts";
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

export function getLatestGoalStateSnapshot(entries: readonly SessionEntry[]): GoalState | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === GOAL_STATE_CUSTOM_TYPE) {
			const payload = entry.data;
			if (!isPlainRecord(payload)) continue;
			if (payload.version !== 1) continue;
			if (!("state" in payload)) continue;
			const state = payload.state;
			if (isGoalState(state)) {
				return cloneGoalStateForStorage(state);
			}
		}
	}
	return undefined;
}
