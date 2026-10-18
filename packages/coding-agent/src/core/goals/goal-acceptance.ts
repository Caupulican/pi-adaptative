import type { GoalEvidenceRef, GoalState, Requirement } from "./goal-state.ts";
import { applyGoalEvent, isTrustedGoalEvidence } from "./goal-state.ts";

export function getTrustedRequirementEvidence(state: GoalState, requirement: Requirement): GoalEvidenceRef[] {
	const evidenceIds = new Set(requirement.evidenceIds);
	return state.evidence.filter((evidence) => evidenceIds.has(evidence.id) && isTrustedGoalEvidence(evidence));
}

export function getUnprovenGoalRequirementIds(state: GoalState): string[] {
	return state.requirements
		.filter(
			(requirement) =>
				requirement.status !== "satisfied" || getTrustedRequirementEvidence(state, requirement).length === 0,
		)
		.map((requirement) => requirement.id);
}

const MAX_LEDGER_IDS_PER_CLASS = 20;

/**
 * The requirements/evidence ledger line `get_goal` and the legacy `goal` tool's "get" action
 * render (`summarizeGoalState`), extracted so `compact-goal-context.ts` can inject the identical
 * text into every request instead of leaving it reachable only through a `get_goal` round trip.
 * Only requirement/evidence COUNTS and host-generated ids are surfaced here, never free-text
 * requirement content, so this needs no untrusted-content escaping the way the objective does.
 * Undefined when the goal has never recorded a requirement (the common case for a goal managed
 * only through the modern `create_goal`/`get_goal`/`update_goal` trio, which has no action that
 * adds one — requirements/evidence are reachable only via the legacy unified `goal` tool).
 */
export function formatRequirementsLedgerLine(state: GoalState): string | undefined {
	if (state.requirements.length === 0) return undefined;
	const openIds = state.requirements
		.filter((requirement) => requirement.status === "open")
		.slice(0, MAX_LEDGER_IDS_PER_CLASS)
		.map((requirement) => requirement.id);
	const unprovenIds = state.requirements
		.filter(
			(requirement) =>
				requirement.status === "satisfied" && getTrustedRequirementEvidence(state, requirement).length === 0,
		)
		.slice(0, MAX_LEDGER_IDS_PER_CLASS)
		.map((requirement) => requirement.id);
	const pending = [
		...(openIds.length > 0 ? [`open: ${openIds.join(", ")}`] : []),
		...(unprovenIds.length > 0 ? [`unproven: ${unprovenIds.join(", ")}`] : []),
	];
	return `Legacy ledger: ${state.requirements.length} requirements, ${state.evidence.length} evidence${pending.length > 0 ? `; ${pending.join("; ")}` : ""}.`;
}

/**
 * Human/manual completion and the explicit evidence-gate opt-out are authoritative overrides.
 * An omitted flag is not owner authorization, including on restored completion events.
 */
export function hasGoalAcceptanceOverride(state: GoalState): boolean {
	if (state.acceptanceOverride !== undefined) return state.acceptanceOverride;
	const completion = [...state.events]
		.reverse()
		.find((event) => event.type === "complete_goal" || event.type === "complete_goal_manually");
	return (
		completion?.type === "complete_goal_manually" ||
		(completion?.type === "complete_goal" && completion.acceptanceOverride === true)
	);
}

/**
 * The reason a completed goal is not supported by its trusted evidence: no explicit override, and a requirement
 * without trusted evidence. Undefined when the completion stands.
 */
export function getGoalCompletionRefusal(state: GoalState): string | undefined {
	if (state.status !== "completed" || hasGoalAcceptanceOverride(state)) return undefined;
	const unprovenIds = getUnprovenGoalRequirementIds(state);
	if (unprovenIds.length === 0) return undefined;
	return `completion not supported: requirement(s) ${unprovenIds.slice(0, MAX_LEDGER_IDS_PER_CLASS).join(", ")} lack trusted evidence`;
}

/**
 * The reopen every continuation entry gives a completion its trusted evidence does not support: the goal reopened as
 * active with its refusal reason, and the one warning that says so. The goal is never left completed on unproven
 * evidence, and never blocked by it: its unproven requirements keep the continuation working until evidence exists.
 * Undefined when the completion stands, or when the goal's durable objective (`objectiveStatus`) is already settled
 * (completed or cancelled), so nothing is left to complete.
 */
export function reopenUnsupportedGoalCompletion(
	state: GoalState,
	objectiveStatus: string | undefined,
	now: string,
): { readonly state: GoalState; readonly warning: string } | undefined {
	if (objectiveStatus === "completed" || objectiveStatus === "cancelled") return undefined;
	const reason = getGoalCompletionRefusal(state);
	if (reason === undefined) return undefined;
	return {
		state: applyGoalEvent(state, { type: "reopen_unproven_completion", reason, now }),
		warning: `Goal ${state.goalId} ${reason}; the goal stays active to gather it.`,
	};
}
