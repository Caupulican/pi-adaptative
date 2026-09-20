/**
 * Durable objective-side record of owner clarifications.
 *
 * The human-input stack already owns the question, the dialog and the answer; this only correlates
 * them with the objective that asked, so a continuation running after a compaction or a restart
 * still knows what was asked and what came back. One writer, shared by the in-turn tool path and the
 * restart resume path, so both produce the same two events in the same order.
 */

import { type GoalStateRevision, getGoalStateRevision } from "./goal-lifecycle.ts";
import {
	applyGoalEvent,
	type GoalClarificationCategory,
	type GoalEvent,
	type GoalState,
	isGoalExecutionActive,
	MAX_GOAL_CLARIFICATION_ANSWER_LENGTH,
} from "./goal-state.ts";

export type GoalClarificationEvent = Extract<
	GoalEvent,
	{ type: "clarification_requested" } | { type: "clarification_answered" }
>;

export interface GoalClarificationLogPort {
	getGoalState(): GoalState | undefined;
	saveGoalState(state: GoalState, expected?: GoalStateRevision): void;
}

/** Bounded, whitespace-collapsed answer text; the exact answer stays in the human-input snapshot. */
export function boundClarificationAnswerSummary(text: string): string {
	const collapsed = text.replace(/\s+/gu, " ").trim();
	return collapsed.length <= MAX_GOAL_CLARIFICATION_ANSWER_LENGTH
		? collapsed
		: `${collapsed.slice(0, MAX_GOAL_CLARIFICATION_ANSWER_LENGTH)}…`;
}

/**
 * Appends one clarification event to the objective that asked. A no-op when that objective is no
 * longer the active one or is no longer executing: a stale answer must not resurrect or mutate a
 * goal that moved on. Returns whether the event was applied.
 */
export function recordObjectiveClarification(
	port: GoalClarificationLogPort,
	objectiveId: string,
	event: GoalClarificationEvent,
): boolean {
	const current = port.getGoalState();
	if (!current || current.goalId !== objectiveId || !isGoalExecutionActive(current.status)) return false;
	port.saveGoalState(applyGoalEvent(current, event), getGoalStateRevision(current));
	return true;
}

export function clarificationRequestedEvent(input: {
	requestId: string;
	category: GoalClarificationCategory;
	question: string;
	detail?: string;
	now: string;
}): GoalClarificationEvent {
	return {
		type: "clarification_requested",
		requestId: input.requestId,
		category: input.category,
		question: input.question,
		...(input.detail ? { detail: input.detail } : {}),
		now: input.now,
	};
}

export function clarificationAnsweredEvent(input: {
	requestId: string;
	answerText: string;
	cancelled: boolean;
	now: string;
}): GoalClarificationEvent {
	return {
		type: "clarification_answered",
		requestId: input.requestId,
		answerSummary: boundClarificationAnswerSummary(input.answerText),
		...(input.cancelled ? { cancelled: true } : {}),
		now: input.now,
	};
}
