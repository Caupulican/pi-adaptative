/**
 * Why a goal's automatic continuation is running, waiting or stopped, as one typed state with the owner's words for
 * it. The scheduler (`goal-auto-continue-controller.ts`) reports facts; the decision about which state they make is
 * this one function, and nothing here is read by the scheduling logic: it only describes.
 */

import { interfaceText } from "../language/interface-text.ts";
import type { GoalContinuationDecision, GoalContinuationReasonCode } from "./goal-continuation-controller.ts";

export type GoalAutoContinueState =
	| "no_goal"
	| "finished"
	| "owner_paused"
	| "budget_limit"
	| "usage_limit"
	| "owner_answer_needed"
	| "waiting_for_worker"
	| "waiting_for_background_task"
	| "off"
	| "tools_unavailable"
	| "interrupted"
	| "running"
	| "waiting_for_turn"
	| "scheduled"
	| "retrying"
	| "not_scheduled";

/** What the scheduler holds at one instant, plus the goal's own continuation decision. */
export interface GoalAutoContinueFacts {
	readonly continuation: Pick<GoalContinuationDecision, "reasonCode">;
	/** The `autonomy.goalAutoContinue` setting. */
	readonly enabled: boolean;
	/** The goal tools are in this session's tool set. */
	readonly toolsAvailable: boolean;
	/** A continuation is scheduled to start. */
	readonly armed: boolean;
	/** A continuation pass is running. */
	readonly running: boolean;
	/** A foreground turn is in progress that is not the continuation's own, and the continuation waits for it to end. */
	readonly waitingForTurn: boolean;
	/** A failed continuation will be tried again. */
	readonly retrying: boolean;
	/** The owner interrupted the last continuation and nothing was scheduled after it. */
	readonly interrupted: boolean;
}

/** The state a goal's own decision settles by itself; `undefined`: the goal is still working and the live facts decide. */
const DECIDED_BY_GOAL: Readonly<Record<GoalContinuationReasonCode, GoalAutoContinueState | undefined>> = {
	missing_goal_state: "no_goal",
	goal_completed: "finished",
	goal_cancelled: "finished",
	goal_paused: "owner_paused",
	goal_budget_limited: "budget_limit",
	goal_usage_limited: "usage_limit",
	goal_blocked: "owner_answer_needed",
	worker_in_flight: "waiting_for_worker",
	plan_in_flight: "waiting_for_worker",
	tool_task_in_flight: "waiting_for_background_task",
	goal_active: undefined,
	goal_completion_required: undefined,
	acceptance_evidence_required: undefined,
	blocked_requirements_present: undefined,
	stall_limit_reached: undefined,
	worker_wait_timeout: undefined,
	lane_sync_conflict: undefined,
	lane_sync_required: undefined,
	verification_repair_required: undefined,
};

/** The states in which the goal itself stops automatic work: nothing the scheduler holds changes them. */
const STOPPED_BY_GOAL: ReadonlySet<GoalAutoContinueState> = new Set([
	"no_goal",
	"finished",
	"owner_paused",
	"budget_limit",
	"usage_limit",
	"owner_answer_needed",
]);

/** The two settings-level reasons that stop automatic continuation for a goal that is still working. */
function configurationHold(
	facts: Pick<GoalAutoContinueFacts, "enabled" | "toolsAvailable">,
): "off" | "tools_unavailable" | undefined {
	if (!facts.enabled) return "off";
	return facts.toolsAvailable ? undefined : "tools_unavailable";
}

export function classifyGoalAutoContinue(facts: GoalAutoContinueFacts): GoalAutoContinueState {
	const decided = DECIDED_BY_GOAL[facts.continuation.reasonCode];
	if (decided !== undefined && STOPPED_BY_GOAL.has(decided)) return decided;
	const held = configurationHold(facts);
	if (held !== undefined) return held;
	if (decided !== undefined) return decided;
	if (facts.retrying) return "retrying";
	if (facts.running) return facts.waitingForTurn ? "waiting_for_turn" : "running";
	if (facts.armed) return "scheduled";
	if (facts.waitingForTurn) return "waiting_for_turn";
	return facts.interrupted ? "interrupted" : "not_scheduled";
}

/**
 * The reasons that stay true across requests for a goal that is still working: the setting, the tool set and the
 * owner's interrupt. Only these are told to the model, because the compact goal context must not change text on every
 * request; timings and per-pass states never are.
 */
export type GoalAutoContinueHold = Extract<GoalAutoContinueState, "off" | "tools_unavailable" | "interrupted">;

export function goalAutoContinueHold(
	facts: Pick<GoalAutoContinueFacts, "enabled" | "toolsAvailable" | "armed" | "running" | "interrupted">,
): GoalAutoContinueHold | undefined {
	const held = configurationHold(facts);
	if (held !== undefined) return held;
	return facts.interrupted && !facts.armed && !facts.running ? "interrupted" : undefined;
}

/** The owner's sentence for a state, for the status lines. */
export function describeGoalAutoContinue(state: GoalAutoContinueState): string {
	return interfaceText().autonomyStatus.autoContinue[state];
}

const MODEL_NOTES: Readonly<Record<GoalAutoContinueHold, string>> = {
	off: "Automatic continuation is off: the goal advances only on owner messages.",
	tools_unavailable: "Goal tools are unavailable this session: automatic continuation cannot run.",
	interrupted: "The owner interrupted automatic continuation: it resumes once the owner's next turn finishes.",
};

/** The one sentence the model is told for a hold, the same reason the owner's status shows. */
export function goalAutoContinueModelNote(hold: GoalAutoContinueHold | undefined): string | undefined {
	return hold === undefined ? undefined : MODEL_NOTES[hold];
}
