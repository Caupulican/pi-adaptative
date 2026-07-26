import type { GoalState, GoalStatus } from "./goal-state.ts";

/** Compact model/user projection. Detailed planning and evidence remain in their owning stores. */
export interface GoalRecord {
	goalId: string;
	objective: string;
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	tokensRemaining?: number;
	timeUsedSeconds: number;
	blockedReason?: string;
	createdAt: string;
	updatedAt: string;
}

export function projectGoalRecord(state: GoalState): GoalRecord {
	const tokensUsed = Math.max(0, state.tokensUsed ?? 0);
	return {
		goalId: state.goalId,
		objective: state.userGoal,
		status: state.status,
		...(state.tokenBudget === undefined
			? {}
			: {
					tokenBudget: state.tokenBudget,
					tokensRemaining: Math.max(0, state.tokenBudget - tokensUsed),
				}),
		tokensUsed,
		timeUsedSeconds: Math.max(0, Math.ceil((state.continuationWallClockMs ?? 0) / 1000)),
		blockedReason: state.blockedReason,
		createdAt: state.createdAt,
		updatedAt: state.updatedAt,
	};
}

export function formatGoalRecord(record: GoalRecord): string {
	const budget =
		record.tokenBudget === undefined
			? `${record.tokensUsed} tokens (unbounded)`
			: `${record.tokensUsed}/${record.tokenBudget} tokens; ${record.tokensRemaining ?? 0} remaining`;
	return [
		`Goal '${record.goalId}' (${record.status})`,
		`Objective: ${record.objective}`,
		`Usage: ${budget}; ${record.timeUsedSeconds}s active time.`,
		...(record.blockedReason ? [`Reason: ${record.blockedReason}`] : []),
	].join("\n");
}
