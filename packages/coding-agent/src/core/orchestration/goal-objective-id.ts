/** Canonical identity of the durable objective projected from a goal. */
const GOAL_OBJECTIVE_PREFIX = "goal:";

export function goalObjectiveId(goalId: string): string {
	return `${GOAL_OBJECTIVE_PREFIX}${goalId}`;
}

export function isGoalObjectiveId(objectiveId: string): boolean {
	return objectiveId.startsWith(GOAL_OBJECTIVE_PREFIX);
}

export function sourceGoalId(objectiveId: string): string | undefined {
	return isGoalObjectiveId(objectiveId) ? objectiveId.slice(GOAL_OBJECTIVE_PREFIX.length) : undefined;
}
