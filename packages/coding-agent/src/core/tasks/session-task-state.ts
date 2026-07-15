import type { SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";
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

export function getLatestTaskStepsStateSnapshot(entries: readonly SessionEntry[]): TaskStepsState | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== TASK_STEPS_STATE_CUSTOM_TYPE) continue;
		const payload = entry.data;
		if (!isPlainRecord(payload) || payload.version !== 1 || !("state" in payload)) continue;
		if (isTaskStepsState(payload.state)) return cloneTaskStepsState(payload.state);
	}
	return undefined;
}
