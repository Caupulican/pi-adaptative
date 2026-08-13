import {
	applyGoalEvent,
	type GoalState,
	isGoalExecutionActive,
	isGoalResumableStatus,
	isGoalUnfinishedStatus,
	MAX_GOAL_OBJECTIVE_LENGTH,
} from "./goal-state.ts";
import { applyGoalAction, type GoalActionFailure, type GoalActionResult } from "./goal-tool-core.ts";

export interface GoalStateRevision {
	goalId: string;
	revision: number;
}

export function getGoalStateRevision(state: GoalState): GoalStateRevision {
	return { goalId: state.goalId, revision: state.revision ?? 0 };
}

/** Minimal durable seam shared by CLI, tools, and in-process session restoration. */
export interface PersistedGoalStateHost {
	getGoalStateSnapshot(): GoalState | undefined;
	saveGoalStateSnapshot(state: GoalState, expected?: GoalStateRevision): string;
	clearGoalStateSnapshot?(state: GoalState, now: string): string;
}

function missingGoal(action: string): GoalActionFailure {
	return { ok: false, error: `No goal exists to ${action}.` };
}

function persistResult(
	host: PersistedGoalStateHost,
	current: GoalState | undefined,
	result: GoalActionResult,
): GoalActionResult {
	if (!result.ok) return result;
	host.saveGoalStateSnapshot(result.state, current ? getGoalStateRevision(current) : undefined);
	return result;
}

export function pauseGoal(current: GoalState | undefined, now: string): GoalActionResult {
	if (!current) return missingGoal("pause");
	if (!isGoalExecutionActive(current.status)) {
		return { ok: false, error: `Goal '${current.goalId}' is ${current.status}; only active goals can be paused.` };
	}
	return { ok: true, state: applyGoalEvent(current, { type: "pause_goal", now }) };
}

export function resumeGoal(current: GoalState | undefined, now: string): GoalActionResult {
	if (!current) return missingGoal("resume");
	if (!isGoalResumableStatus(current.status)) {
		return {
			ok: false,
			error: `Goal '${current.goalId}' is ${current.status}; only paused, blocked, or usage-limited goals can be resumed.`,
		};
	}
	return { ok: true, state: applyGoalEvent(current, { type: "resume_goal", now }) };
}

export function editGoal(
	current: GoalState | undefined,
	args: { userGoal: string; tokenBudget?: number },
	now: string,
): GoalActionResult {
	if (!current) return missingGoal("edit");
	if (current.status === "cancelled") {
		return { ok: false, error: `Goal '${current.goalId}' is cancelled; start a new goal instead.` };
	}
	const userGoal = args.userGoal.trim();
	if (!userGoal) return { ok: false, error: "Goal objective must not be empty." };
	if (userGoal.length > MAX_GOAL_OBJECTIVE_LENGTH) {
		return { ok: false, error: `Goal objective must be at most ${MAX_GOAL_OBJECTIVE_LENGTH} characters.` };
	}
	if (args.tokenBudget !== undefined && (!Number.isSafeInteger(args.tokenBudget) || args.tokenBudget <= 0)) {
		return { ok: false, error: "Goal token budget must be a positive integer when provided." };
	}
	return {
		ok: true,
		state: applyGoalEvent(current, { type: "edit_goal", userGoal, tokenBudget: args.tokenBudget, now }),
	};
}

export function cancelGoal(current: GoalState | undefined, now: string): GoalActionResult {
	if (!current) return missingGoal("cancel");
	if (!isGoalUnfinishedStatus(current.status)) {
		return { ok: false, error: `Goal '${current.goalId}' is already ${current.status}.` };
	}
	return { ok: true, state: applyGoalEvent(current, { type: "cancel_goal", now }) };
}

/** Explicit owner replacement. The old and new states cross one persistence boundary. */
export function replaceGoal(
	args: { goalId: string; userGoal: string; tokenBudget?: number },
	now: string,
): GoalActionResult {
	return applyGoalAction(undefined, { action: "start", ...args }, now);
}

export function stopGoalFromSystem(
	current: GoalState | undefined,
	args: { status: "blocked" | "usage_limited" | "budget_limited"; reason: string },
	now: string,
): GoalActionResult {
	if (!current) return missingGoal("stop");
	if (!isGoalExecutionActive(current.status)) {
		return { ok: false, error: `Goal '${current.goalId}' is ${current.status}; no system stop is needed.` };
	}
	const reason = args.reason.trim();
	if (!reason) return { ok: false, error: "System goal stop requires a reason." };
	return { ok: true, state: applyGoalEvent(current, { type: "system_stop_goal", ...args, reason, now }) };
}

export function pausePersistedGoal(host: PersistedGoalStateHost, now = new Date().toISOString()): GoalActionResult {
	const current = host.getGoalStateSnapshot();
	return persistResult(host, current, pauseGoal(current, now));
}

export function resumePersistedGoal(host: PersistedGoalStateHost, now = new Date().toISOString()): GoalActionResult {
	const current = host.getGoalStateSnapshot();
	return persistResult(host, current, resumeGoal(current, now));
}

export function editPersistedGoal(
	host: PersistedGoalStateHost,
	args: { userGoal: string; tokenBudget?: number },
	now = new Date().toISOString(),
): GoalActionResult {
	const current = host.getGoalStateSnapshot();
	return persistResult(host, current, editGoal(current, args, now));
}

export function cancelPersistedGoal(host: PersistedGoalStateHost, now = new Date().toISOString()): GoalActionResult {
	const current = host.getGoalStateSnapshot();
	return persistResult(host, current, cancelGoal(current, now));
}

export type ClearPersistedGoalResult = { ok: true; cleared: boolean } | GoalActionFailure;

export function clearPersistedGoal(
	host: PersistedGoalStateHost,
	now = new Date().toISOString(),
): ClearPersistedGoalResult {
	const current = host.getGoalStateSnapshot();
	if (!current) return { ok: true, cleared: false };
	if (!host.clearGoalStateSnapshot) return { ok: false, error: "This session does not support clearing goals." };
	host.clearGoalStateSnapshot(current, now);
	return { ok: true, cleared: true };
}
