import type { GoalState } from "../goals/goal-state.ts";
import { goalObjectiveId, isGoalObjectiveId } from "../orchestration/work-state-projection.ts";

/** Host lifetime changes stop an obsolete pass without recording failure or progress for its successor. */
export class ObjectiveExecutionInterruptedError extends Error {
	readonly reason: "session_disposed" | "goal_replaced";

	constructor(reason: "session_disposed" | "goal_replaced") {
		super(`The objective loop was interrupted: ${reason}.`);
		this.name = "ObjectiveExecutionInterruptedError";
		this.reason = reason;
	}
}

/** Goal routes retain their admitted identity; unrelated durable objectives keep their own policy. */
export function assertCurrentGoalObjective(objectiveId: string, goal: GoalState | undefined): GoalState | undefined {
	if (isGoalObjectiveId(objectiveId) && (!goal || goalObjectiveId(goal.goalId) !== objectiveId)) {
		throw new ObjectiveExecutionInterruptedError("goal_replaced");
	}
	return goal;
}
