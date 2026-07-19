/**
 * Turn-boundary task_steps contract monitor.
 *
 * Pure logic only: given the current task_steps state and the prior consecutive-violation streak,
 * decides whether the workflow contract described in the task_steps tool's `promptGuidelines`
 * (`tools/task-steps.ts`) — at most one in_progress step, and an in_progress step whenever open
 * steps remain — has been broken for N consecutive turns, and if so returns a ONE-LINE harness
 * note. No model calls, no I/O, no session access: the caller (`AutoLearnController`) owns reading
 * the task_steps state, persisting the returned streak across turns, and delivering the note
 * through the session's existing next-turn message surface. This is an advisory nudge, not an
 * enforcement gate.
 */

import type { TaskStepsState } from "./task-state.ts";

/** Consecutive violating turns required before a harness note fires. */
export const TASK_CONTRACT_VIOLATION_THRESHOLD = 3;

export interface TaskContractStreak {
	/** Number of consecutive turns the contract has been violated; reset to 0 on a compliant turn. */
	consecutiveViolations: number;
	/**
	 * Whether a note has already fired for the CURRENT streak. Re-arms to false only when the streak
	 * resets to 0 via a compliant turn, so a sustained violation emits exactly one note instead of
	 * repeating every turn past the threshold.
	 */
	noteFired: boolean;
}

export const INITIAL_TASK_CONTRACT_STREAK: TaskContractStreak = { consecutiveViolations: 0, noteFired: false };

export interface TaskContractCheckResult {
	streak: TaskContractStreak;
	/** Present only on the turn the streak first reaches the threshold. */
	note?: string;
}

/**
 * True when the task_steps contract is broken: more than one step is in_progress, or open
 * (non-terminal) steps remain with none in_progress. An absent state (no task list ever created)
 * is never a violation — there is nothing to enforce.
 */
export function isTaskStepsContractViolation(state: TaskStepsState | undefined): boolean {
	if (!state) return false;
	const inProgressCount = state.steps.filter((step) => step.status === "in_progress").length;
	if (inProgressCount > 1) return true;
	const openCount = state.steps.filter((step) => step.status !== "completed" && step.status !== "cancelled").length;
	return openCount > 0 && inProgressCount === 0;
}

function buildTaskContractNote(state: TaskStepsState | undefined, consecutiveViolations: number): string {
	const inProgressCount = state?.steps.filter((step) => step.status === "in_progress").length ?? 0;
	const reason =
		inProgressCount > 1
			? `${inProgressCount} steps are in_progress at once`
			: "open task_steps have none in_progress";
	return `Harness note: task_steps contract violated for ${consecutiveViolations} consecutive turns (${reason}) — set exactly one open step to in_progress before continuing.`;
}

/**
 * Advance the streak by one turn. Pure: takes the current task_steps state and the prior streak,
 * returns the next streak plus, only on the exact turn the streak first reaches `threshold`, a
 * ONE-LINE note. Callers must persist the returned streak and feed it back in as `priorStreak` on
 * the next turn.
 */
export function checkTaskStepsContract(
	state: TaskStepsState | undefined,
	priorStreak: TaskContractStreak,
	threshold: number = TASK_CONTRACT_VIOLATION_THRESHOLD,
): TaskContractCheckResult {
	if (!isTaskStepsContractViolation(state)) {
		return { streak: { consecutiveViolations: 0, noteFired: false } };
	}
	const consecutiveViolations = priorStreak.consecutiveViolations + 1;
	if (consecutiveViolations >= threshold && !priorStreak.noteFired) {
		return {
			streak: { consecutiveViolations, noteFired: true },
			note: buildTaskContractNote(state, consecutiveViolations),
		};
	}
	return { streak: { consecutiveViolations, noteFired: priorStreak.noteFired } };
}
