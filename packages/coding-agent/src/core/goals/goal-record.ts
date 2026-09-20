import type { GoalClarification, GoalState, GoalStatus } from "./goal-state.ts";

/** Most recent owner clarifications projected for the model; the durable ledger keeps the rest. */
export const MAX_PROJECTED_GOAL_CLARIFICATIONS = 5;
const MAX_PROJECTED_CLARIFICATION_QUESTION_LENGTH = 160;

function bounded(value: string, limit: number): string {
	const collapsed = value.replace(/\s+/gu, " ").trim();
	return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`;
}

/** One deterministic line per clarification: what was asked, and the owner's answer when it exists. */
export function formatGoalClarificationLine(clarification: GoalClarification): string {
	const question = bounded(clarification.question, MAX_PROJECTED_CLARIFICATION_QUESTION_LENGTH);
	if (clarification.status === "pending") return `pending: ${question}`;
	if (clarification.status === "cancelled") return `declined: ${question}`;
	return `answered: ${question} -> ${bounded(clarification.answerSummary ?? "", MAX_PROJECTED_CLARIFICATION_QUESTION_LENGTH)}`;
}

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
	/** Bounded tail of the objective's owner-clarification ledger, oldest first. */
	clarifications: readonly GoalClarification[];
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
		clarifications: (state.clarifications ?? []).slice(-MAX_PROJECTED_GOAL_CLARIFICATIONS),
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
		...(record.clarifications.length > 0
			? ["Owner clarifications:", ...record.clarifications.map((entry) => `- ${formatGoalClarificationLine(entry)}`)]
			: []),
	].join("\n");
}
