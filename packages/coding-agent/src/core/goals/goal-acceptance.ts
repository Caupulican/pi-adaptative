import type { GoalEvidenceRef, GoalState, Requirement } from "./goal-state.ts";

export function isTrustedGoalEvidence(evidence: GoalEvidenceRef): boolean {
	return evidence.kind === "user" || evidence.verified === true;
}

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
 * Completion events written before the flag existed are treated as legacy owner decisions so an
 * already-completed persisted goal cannot strand durable work during resume.
 */
export function hasGoalAcceptanceOverride(state: GoalState): boolean {
	if (state.acceptanceOverride !== undefined) return state.acceptanceOverride;
	const completion = [...state.events]
		.reverse()
		.find((event) => event.type === "complete_goal" || event.type === "complete_goal_manually");
	return (
		completion?.type === "complete_goal_manually" ||
		(completion?.type === "complete_goal" && completion.acceptanceOverride !== false)
	);
}
