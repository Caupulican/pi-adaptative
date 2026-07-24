import type { GoalState } from "./goal-state.ts";
import { applyGoalAction, type GoalActionFailure, type GoalActionResult } from "./goal-tool-core.ts";

/** Minimal durable goal-state seam shared by CLI and in-process session resume. */
export interface PersistedGoalStateHost {
	getGoalStateSnapshot(): GoalState | undefined;
	saveGoalStateSnapshot(state: GoalState): string;
}

/** Apply and persist the one canonical blocked -> active goal transition. */
export function resumePersistedGoal(host: PersistedGoalStateHost, now = new Date().toISOString()): GoalActionResult {
	const resumed = applyGoalAction(host.getGoalStateSnapshot(), { action: "resume_goal" }, now);
	if (!resumed.ok) return resumed;
	host.saveGoalStateSnapshot(resumed.state);
	return resumed;
}

export type ResumeBlockedPersistedGoalResult =
	| { ok: true; resumed: false }
	| { ok: true; resumed: true; state: GoalState }
	| GoalActionFailure;

/** Resume only when a blocked goal is present; all other lifecycle states are an intentional no-op. */
export function resumeBlockedPersistedGoal(
	host: PersistedGoalStateHost,
	now = new Date().toISOString(),
): ResumeBlockedPersistedGoalResult {
	if (host.getGoalStateSnapshot()?.status !== "blocked") return { ok: true, resumed: false };
	const resumed = resumePersistedGoal(host, now);
	return resumed.ok ? { ...resumed, resumed: true } : resumed;
}
