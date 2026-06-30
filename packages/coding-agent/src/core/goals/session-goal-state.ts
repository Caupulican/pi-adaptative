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

export function getLatestGoalStateSnapshot(entries: readonly SessionEntry[]): GoalState | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === GOAL_STATE_CUSTOM_TYPE) {
			const payload = entry.data;
			if (
				payload &&
				typeof payload === "object" &&
				"version" in payload &&
				(payload as Record<string, unknown>).version === 1 &&
				"state" in payload
			) {
				const state = (payload as Record<string, unknown>).state;
				if (isGoalState(state)) {
					return cloneGoalStateForStorage(state);
				}
			}
		}
	}
	return undefined;
}
