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

/**
 * Human/manual completion and the explicit evidence-gate opt-out are authoritative overrides.
 * Completion events written before the flag existed are treated as legacy owner decisions so an
 * already-completed persisted goal cannot strand durable work during resume.
 */
export function hasGoalAcceptanceOverride(state: GoalState): boolean {
	const completion = [...state.events]
		.reverse()
		.find((event) => event.type === "complete_goal" || event.type === "complete_goal_manually");
	return (
		completion?.type === "complete_goal_manually" ||
		(completion?.type === "complete_goal" && completion.acceptanceOverride !== false)
	);
}
