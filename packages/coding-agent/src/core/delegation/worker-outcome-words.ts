/**
 * Plain words for outcomes: the one text generator for lane and node rows (no ids, no codes) and the model-facing
 * handoff line (codes and requirement ids, no worker words). A leaf beside the contract so the lane projection reads it
 * without importing the outcome projection.
 */
import type { TaskEscalationRecord } from "../orchestration/task-runtime-state.ts";
import { boundedText } from "../util/bounded-line.ts";
import {
	type AbandonReason,
	type BlockerCode,
	isOutcomeFromNewerBuild,
	type NextAction,
	OUTCOME_LIMITS,
	type Outcome,
	type OutcomeStatus,
	type StoredOutcome,
} from "./worker-outcome-contract.ts";

/** The stored outcome when it describes this attempt (its last attempt) and this build can read it. */
export function sameOutcomeAttempt(stored: StoredOutcome | undefined, attemptId: string): Outcome | undefined {
	return stored && !isOutcomeFromNewerBuild(stored) && stored.attempts.at(-1)?.attemptId === attemptId
		? stored
		: undefined;
}

const STATUS_WORDS: Readonly<Record<OutcomeStatus, string>> = {
	succeeded: "Done",
	partial: "Partly done",
	blocked: "Blocked",
	failed: "Failed",
	cancelled: "Stopped",
};

const BLOCKER_WORDS: Readonly<Record<BlockerCode, string>> = {
	none: "",
	requirement_uncovered: "some required work is not done",
	evidence_missing: "proof is missing",
	evidence_contradicts_claim: "the report does not match what the worker ran",
	output_malformed: "the worker's answer could not be read",
	context_exhausted: "the worker ran out of context",
	time_exhausted: "the worker ran out of time",
	model_unfit: "the model was not suited to the task",
	verification_failed: "an independent check rejected the work",
	model_fit_open: "no model was clearly suited to the task",
	model_unavailable: "the model was not available",
	provider_transient: "the provider had a temporary problem",
	provider_quota: "the account ran out of quota",
	provider_auth: "the provider refused the sign-in",
	worker_reported_blocker: "the worker reported a blocker",
	missing_input: "the worker is missing an input",
	dependency_wrong: "something it depends on is wrong",
	needs_owner_decision: "your decision is needed",
	needs_root_answer: "the lead agent's answer is needed",
	external_unavailable: "an outside service is unavailable",
	scope_denied: "the work reached outside its allowed area",
	owner_authority_required: "your permission is needed",
	verification_pending: "waiting for an independent check",
	unverified_result: "the result has not been checked",
	budget_exhausted: "the budget ran out",
	deadline_reached: "the deadline passed",
	capacity_unavailable: "there was no room to run it",
	placement_unreachable: "the machine it was sent to could not be reached",
	interrupted: "it was interrupted",
	action_outcome_unknown: "whether an action took effect is unknown",
	result_unverifiable: "the result could not be checked",
	dependency_failed: "work it depended on failed",
	preflight_failed: "a check before starting failed",
	request_rejected: "the request was refused",
	cancelled_by_owner: "it was cancelled",
	superseded: "it is no longer needed",
	unclassified: "the cause is not known",
};

/** The plain words of one blocker code: what went wrong, with no ids and no code. */
export function blockerWords(blocker: BlockerCode): string {
	return BLOCKER_WORDS[blocker];
}

/** The plain next step of an abandoned task, by the reason it was abandoned. */
const ABANDON_PHRASES: Readonly<Record<AbandonReason, string>> = {
	cancelled: "nothing more will run",
	dependency: "nothing more will run until the work it depends on is fixed",
	superseded: "nothing more will run",
	stopped: "nothing more will run until it is started again",
};

/** Whether the outcome's rerun is placed: a `task.escalation_scheduled` record exists for its outcome and rung. */
export function rerunScheduled(outcome: Outcome, escalations: readonly TaskEscalationRecord[] | undefined): boolean {
	const action = outcome.nextAction;
	return (
		action.kind === "rerun_uncovered" &&
		(escalations ?? []).some((entry) => entry.outcomeId === outcome.outcomeId && entry.rung === action.rung)
	);
}

/**
 * The plain next step of one action, without ids. A rerun reads as running only once it is placed (`scheduled`);
 * until then it is the decided next step, which the fleet may still refuse.
 */
export function nextActionPhrase(action: NextAction, scheduled = false): string {
	switch (action.kind) {
		case "accept":
			return "use the result";
		case "verify_in_lane":
			return "follow up with the same worker";
		case "verify_independently":
			return "check the result before relying on it";
		case "host_check":
			return "run the requirement checks";
		case "rerun_uncovered":
			if (scheduled)
				return action.rung === 1 ? "running again with more thinking" : "running again on another model";
			return action.rung === 1
				? "a rerun with more thinking, once it is placed"
				: "a rerun on another model, once it is placed";
		case "retry_after":
			return "try again later";
		case "wait_capacity":
			return "waiting for room to run";
		case "replace":
			return "running it again on this machine";
		case "fix_request":
			return "fix the request and start again";
		case "ask_owner":
			return "your decision is needed";
		case "ask_root":
			return "waiting for the lead agent's answer";
		case "abandon":
			return ABANDON_PHRASES[action.reason];
	}
}

/**
 * One plain line for a lane or node row: what happened and what comes next, at most 280 characters. `escalations` are the
 * task's scheduled escalation records; without them a rerun never reads as running.
 */
export function describeNextAction(outcome: Outcome, escalations?: readonly TaskEscalationRecord[]): string {
	const blocker = BLOCKER_WORDS[outcome.blocker];
	const required = outcome.coverage.required.length;
	const coverage =
		required > 0 && outcome.status !== "cancelled"
			? `; ${outcome.coverage.covered.length} of ${required} requirement${required === 1 ? "" : "s"} met`
			: "";
	const line = `${STATUS_WORDS[outcome.status]}${blocker ? `: ${blocker}` : ""}${coverage}. Next: ${nextActionPhrase(outcome.nextAction, rerunScheduled(outcome, escalations))}.`;
	return boundedText(line, OUTCOME_LIMITS.describeChars);
}

const MAX_HANDOFF_IDS = 8;

function idList(ids: readonly string[]): string {
	const shown = ids.slice(0, MAX_HANDOFF_IDS).map((id) => boundedText(id, 80));
	const more = ids.length - shown.length;
	return `${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`;
}

/**
 * The model-facing outcome line of a terminal handoff: status, blocker code, requirement coverage with ids, assurance.
 * Codes and requirement ids only; no worker words.
 */
export function describeOutcomeForHandoff(outcome: Outcome): string {
	const { required, covered, uncovered } = outcome.coverage;
	const ids = [
		covered.length > 0 ? `covered: ${idList(covered.map((entry) => entry.id))}` : undefined,
		uncovered.length > 0
			? `uncovered: ${idList(uncovered.map((entry) => `${entry.id} ${entry.reason}`))}`
			: undefined,
	].filter((part): part is string => part !== undefined);
	return `Outcome: ${outcome.status} (blocker: ${outcome.blocker}; requirements met: ${covered.length} of ${required.length}${ids.length > 0 ? ` [${ids.join("; ")}]` : ""}; assurance: ${outcome.assurance})`;
}
