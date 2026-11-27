/**
 * How an objective's terminal result settles the goal that runs it: a completion is persisted only with trusted evidence
 * (or as the owner's override), a cancel and a budget stop are recorded, and a completion System One could not settle
 * goes to the owner with the goal held open. The goal session supplies its state access, its stop path and its owner and
 * scheduler hooks through `ObjectiveTerminalPort`; this module owns only the settlement decision.
 */

import { sameGoalExecution } from "../objective-execution/current-objective-execution.ts";
import type { ObjectiveTerminalResult } from "../objective-execution/objective-route.ts";
import { recordObjectiveClarification } from "./goal-clarification-log.ts";
import { decideGoalCompletion, type GoalCompletionSources, goalCompletionKey } from "./goal-completion-admission.ts";
import type { GoalCompletionOwnerDecision } from "./goal-completion-owner-decision.ts";
import type { GoalContinuationDecision } from "./goal-continuation-controller.ts";
import { type GoalStateRevision, getGoalStateRevision } from "./goal-lifecycle.ts";
import { applyGoalEvent, type GoalState, isGoalExecutionActive } from "./goal-state.ts";
import { completeGoalManually } from "./goal-tool-core.ts";

/** The goal session's own state access and effects, the only things a terminal settlement reaches. */
export interface ObjectiveTerminalPort {
	getState(): GoalState | undefined;
	getContinuation?(): GoalContinuationDecision;
	completionSources?(): GoalCompletionSources;
	saveState(state: GoalState, expected?: GoalStateRevision): void;
	stopActiveGoal(status: "blocked" | "budget_limited", reason: string): boolean;
	emitWarning(message: string): void;
	scheduleGoalAutoContinueFromIdle(): void;
	/** The owner's decision on an unsettled completion; undefined when no owner route is wired. */
	resolveCompletionRejection(input: {
		toolCallId: string;
		goalId: string;
		userGoal: string;
		reasons: readonly string[];
	}): Promise<GoalCompletionOwnerDecision> | undefined;
}

/** Settles the same persisted refusal after dispatch, on restart, or at the next primary entry. */
export function parkExhaustedExecutor(
	port: Pick<ObjectiveTerminalPort, "getContinuation" | "stopActiveGoal">,
): boolean {
	const decision = port.getContinuation?.();
	return (
		decision?.reasonCode === "executor_admission_exhausted" &&
		port.stopActiveGoal("blocked", `executor_admission_exhausted: ${decision.message}`)
	);
}

/** Objective check codes System One runs at a completion, named for the owner's question. */
const TRANSITION_CHECKS: Readonly<Record<string, string>> = {
	jev_024: "completion plausibility",
	jev_025: "primary completion",
	jev_026: "cold adversarial challenge",
	jev_027: "delivery truth",
	jev_028: "release readiness",
};

/**
 * The owner question for a completion System One could not settle: the authority line sends an
 * objective transition whose ambiguity outlived its gather-more budget to the owner, never to a close.
 */
function ambiguousCompletionQuestion(reasonCodes: readonly string[]): string {
	const held = reasonCodes.find((code) => /^jev_02[4-8]_ambiguous$/.test(code));
	const check = held ? (TRANSITION_CHECKS[held.slice(0, 7)] ?? held) : "completion";
	const doubts = reasonCodes.filter(
		(code) => code !== "system_one_ambiguous" && !/^jev_02[4-8]_ambiguous$/.test(code),
	);
	return `System One could not settle the objective's ${check} check${doubts.length > 0 ? ` (${doubts.join(", ")})` : ""}, so the goal is held open: say whether to accept it as complete, or what is still missing.`;
}

/**
 * The objective reached a terminal: the goal follows it, and says so when they disagree. A terminal belongs to the goal
 * whose objective ran the cycle; a goal that replaced it meanwhile is not moved. Resolves to whether a continuation
 * restart was scheduled.
 */
export async function settleObjectiveTerminal(
	port: ObjectiveTerminalPort,
	terminal: ObjectiveTerminalResult,
	goalId: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const state = port.getState();
	if (!state || state.goalId !== goalId || !isGoalExecutionActive(state.status)) return false;
	if (signal?.aborted) return false;
	if (terminal.goalCompletionKey && terminal.goalCompletionKey !== goalCompletionKey(state)) {
		port.scheduleGoalAutoContinueFromIdle();
		return true;
	}
	const now = new Date().toISOString();
	const reasons = terminal.reasonCodes.join(", ");
	switch (terminal.status) {
		case "complete": {
			const decision = decideGoalCompletion(state, port.completionSources?.() ?? {}, now);
			if (!decision.ok) {
				port.emitWarning(decision.error);
				port.scheduleGoalAutoContinueFromIdle();
				return true;
			}
			port.saveState(decision.state, getGoalStateRevision(state));
			return false;
		}
		case "cancelled":
			port.saveState(applyGoalEvent(state, { type: "cancel_goal", now }), getGoalStateRevision(state));
			return false;
		case "budget_exhausted":
			port.stopActiveGoal("budget_limited", reasons || "objective budget exhausted");
			return false;
		case "executor_unavailable":
			if (parkExhaustedExecutor(port)) return false;
			port.scheduleGoalAutoContinueFromIdle();
			return true;
		case "incomplete":
			port.scheduleGoalAutoContinueFromIdle();
			return true;
		default: {
			if (terminal.status === "semantic_gate_unavailable" && terminal.reasonCodes.includes("system_one_ambiguous")) {
				const decision = await port.resolveCompletionRejection({
					toolCallId: `objective-completion:${state.goalId}:${state.revision ?? 0}`,
					goalId: state.goalId,
					userGoal: state.userGoal,
					reasons: [ambiguousCompletionQuestion(terminal.reasonCodes)],
				});
				// The owner's reply lands in the goal's clarification ledger, where the next route and every
				// continuation read it; the goal may have moved on during the wait, so nothing below reuses
				// the state read before it.
				const answered = port.getState();
				if (
					signal?.aborted ||
					!answered ||
					!sameGoalExecution(state, answered) ||
					goalCompletionKey(state) !== goalCompletionKey(answered) ||
					(terminal.goalCompletionKey !== undefined &&
						!decideGoalCompletion(answered, port.completionSources?.() ?? {}, now).ok)
				) {
					port.emitWarning(
						"The goal changed while its completion question was open. The answer remains attached to the original question.",
					);
					return false;
				}
				const clarificationLog = {
					getGoalState: () => port.getState(),
					saveGoalState: (next: GoalState, expected?: GoalStateRevision) => {
						port.saveState(next, expected);
					},
				};
				for (const event of decision && decision.decision !== "deferred" ? decision.clarification : []) {
					if (!recordObjectiveClarification(clarificationLog, goalId, event)) {
						port.emitWarning(
							`The owner's completion decision for goal '${goalId}' was not recorded: that goal is no longer the active goal.`,
						);
						return false;
					}
				}
				const settled = port.getState();
				if (!settled || settled.goalId !== goalId || !isGoalExecutionActive(settled.status)) return false;
				if (decision?.decision === "accept_complete") {
					const completed = completeGoalManually(settled, new Date().toISOString());
					if (!completed.ok) {
						port.emitWarning(`The owner's completion override could not be applied: ${completed.error}`);
						return false;
					}
					port.saveState(completed.state, getGoalStateRevision(settled));
					return false;
				}
				if (!decision) {
					port.emitWarning("The completion decision router is unavailable; keeping the goal active.");
				}
				port.scheduleGoalAutoContinueFromIdle();
				return true;
			}
			port.stopActiveGoal("blocked", `${terminal.status}: ${reasons}`);
			return false;
		}
	}
}
