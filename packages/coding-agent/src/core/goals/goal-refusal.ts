/**
 * Why a goal action was refused, as a fact. Core reports the refusal and one formatter words it, so the owner's
 * commands read the interface's words while a model's tool result, a warning and a thrown diagnostic keep the English
 * wording they always read. Every refusal the owner's commands can show carries one of these beside its English
 * wording; a refusal only a model can reach keeps the wording alone.
 */

import { englishText, type InterfaceText } from "../language/interface-text.ts";
import type { GoalStatus } from "./goal-state.ts";

/**
 * The words of a refused goal action: `sessions.goal`, whose `statusWords` name a status and whose `refusal` entries
 * hold one sentence per refusal.
 */
export type GoalRefusalWords = InterfaceText["sessions"]["goal"];

/** The action a caller asked for when no goal existed: the refusal names the action it could not do. */
export type GoalRefusalAction = "pause" | "resume" | "edit" | "cancel" | "stop" | "complete";

/** What a goal action was refused for. */
export type GoalActionRefusal =
	| { readonly kind: "no_goal"; readonly action: GoalRefusalAction }
	| { readonly kind: "not_active"; readonly status: GoalStatus }
	| { readonly kind: "not_resumable"; readonly status: GoalStatus }
	| { readonly kind: "edit_goal_cancelled" }
	| { readonly kind: "edit_objective_empty" }
	| { readonly kind: "edit_objective_too_long"; readonly limit: number }
	| { readonly kind: "edit_token_budget_invalid" }
	| { readonly kind: "goal_already_ended"; readonly status: GoalStatus }
	| { readonly kind: "system_stop_unneeded"; readonly status: GoalStatus }
	| { readonly kind: "system_stop_reason_empty" }
	| { readonly kind: "clear_unsupported" }
	| { readonly kind: "start_goal_id_empty" }
	| { readonly kind: "start_objective_empty" }
	| { readonly kind: "start_goal_id_too_long"; readonly limit: number }
	| { readonly kind: "start_objective_too_long"; readonly limit: number }
	| { readonly kind: "start_token_budget_invalid" }
	| {
			readonly kind: "unfinished_goal";
			readonly goalId: string;
			readonly status: GoalStatus;
			readonly newGoalId: string;
	  }
	| { readonly kind: "reopen_requirement_id_empty" }
	| { readonly kind: "reopen_requirement_unknown"; readonly requirementId: string }
	| { readonly kind: "reopen_requirement_not_blocked"; readonly requirementId: string; readonly status: string }
	| { readonly kind: "goal_already_completed"; readonly goalId: string }
	| { readonly kind: "goal_already_cancelled"; readonly goalId: string };

/** The words of one refusal, in the language of `words`. */
export function describeGoalRefusal(refusal: GoalActionRefusal, words: GoalRefusalWords): string {
	const lines = words.refusal;
	switch (refusal.kind) {
		case "no_goal":
			return lines.noGoal(refusal.action);
		case "not_active":
			return lines.pauseNotActive(words.statusWords[refusal.status]);
		case "not_resumable":
			return lines.resumeNotResumable(words.statusWords[refusal.status]);
		case "edit_goal_cancelled":
			return lines.editGoalCancelled;
		case "edit_objective_empty":
			return lines.editObjectiveEmpty;
		case "edit_objective_too_long":
			return lines.editObjectiveTooLong(refusal.limit);
		case "edit_token_budget_invalid":
			return lines.editTokenBudgetInvalid;
		case "goal_already_ended":
			return lines.goalAlreadyEnded(words.statusWords[refusal.status]);
		case "system_stop_unneeded":
			return lines.systemStopUnneeded(words.statusWords[refusal.status]);
		case "system_stop_reason_empty":
			return lines.systemStopReasonEmpty;
		case "clear_unsupported":
			return lines.clearUnsupported;
		case "start_goal_id_empty":
			return lines.startGoalIdEmpty;
		case "start_objective_empty":
			return lines.startObjectiveEmpty;
		case "start_goal_id_too_long":
			return lines.startGoalIdTooLong(refusal.limit);
		case "start_objective_too_long":
			return lines.startObjectiveTooLong(refusal.limit);
		case "start_token_budget_invalid":
			return lines.startTokenBudgetInvalid;
		case "unfinished_goal":
			return lines.unfinishedGoal(refusal.goalId, refusal.status, refusal.newGoalId);
		case "reopen_requirement_id_empty":
			return lines.reopenRequirementIdEmpty;
		// The owner's command refuses an unknown or not-blocked requirement before it asks core, with these same words.
		case "reopen_requirement_unknown":
			return words.requirementUnknown(refusal.requirementId);
		case "reopen_requirement_not_blocked":
			return words.requirementNotBlocked(refusal.requirementId, refusal.status);
		case "goal_already_completed":
			return lines.goalAlreadyCompleted(refusal.goalId);
		case "goal_already_cancelled":
			return lines.goalAlreadyCancelled(refusal.goalId);
	}
}

/** A refused goal action: the English wording a model, a warning or a diagnostic reads, and the fact it words. */
export interface RefusedGoalAction {
	readonly ok: false;
	readonly error: string;
	readonly refusal: GoalActionRefusal;
}

/** Refuse a goal action: its English wording and the refusal that wording reports. */
export function refuseGoalAction(refusal: GoalActionRefusal): RefusedGoalAction {
	return { ok: false, error: describeGoalRefusal(refusal, englishText().sessions.goal), refusal };
}

/**
 * The owner's wording of a refused goal action: the refusal's fact when the result carries one, its English wording
 * when the refusal only a model can reach came back instead.
 */
export function refusedGoalActionText(
	result: { readonly error: string; readonly refusal?: GoalActionRefusal },
	words: GoalRefusalWords,
): string {
	return result.refusal === undefined ? result.error : describeGoalRefusal(result.refusal, words);
}
