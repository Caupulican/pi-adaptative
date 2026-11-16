/**
 * How far an unfinished goal is, as every view that shows a session's goal counts and marks it: the root session's
 * operator bar, and the roster rows, lists and chat badge of a bot whose own session holds a goal.
 */

import { type GoalState, isGoalExecutionActive, isGoalUnfinishedStatus } from "./goal-state.ts";

/** An unfinished goal's requirements satisfied of all it has, and whether it runs now (else it waits: paused, blocked, limited). */
export interface GoalProgress {
	readonly satisfied: number;
	readonly total: number;
	readonly executing: boolean;
}

/** The progress of `goal` while it is unfinished; undefined when there is no goal or it ended. */
export function unfinishedGoalProgress(goal: GoalState | undefined): GoalProgress | undefined {
	if (!goal || !isGoalUnfinishedStatus(goal.status)) return undefined;
	return {
		satisfied: goal.requirements.filter((requirement) => requirement.status === "satisfied").length,
		total: goal.requirements.length,
		executing: isGoalExecutionActive(goal.status),
	};
}

/** The mark an unfinished goal is drawn with: `◎`, with the count of its satisfied requirements when it has any (`◎ 2/3`). */
export function goalProgressMark(progress: GoalProgress): string {
	return progress.total > 0 ? `◎ ${progress.satisfied}/${progress.total}` : "◎";
}
