/** Bounded current goal evidence, with reserved space for each requirement's latest host measurement. */

import type { GoalEvidenceKind, GoalState } from "./goal-state.ts";
import { currentCheckEvidenceIds } from "./requirement-proof.ts";

function isGoalEvidenceKind(value: unknown): value is GoalEvidenceKind {
	return (
		value === "file" ||
		value === "test" ||
		value === "tool" ||
		value === "user" ||
		value === "finding" ||
		value === "worker" ||
		value === "check"
	);
}

const OPTIONAL_EVIDENCE_TEXT = ["uri", "requirementKey", "sourceAttemptId"] as const;

/** The receipt fields shared by the event journal and the current evidence snapshot. */
export function isGoalEvidenceFields(value: Record<string, unknown>): boolean {
	return (
		typeof value.id === "string" &&
		isGoalEvidenceKind(value.kind) &&
		typeof value.summary === "string" &&
		OPTIONAL_EVIDENCE_TEXT.every((key) => value[key] === undefined || typeof value[key] === "string") &&
		(value.verified === undefined || typeof value.verified === "boolean") &&
		(value.directHostCheck === undefined || value.directHostCheck === true) &&
		(value.outcome === undefined ||
			value.outcome === "succeeded" ||
			value.outcome === "failed" ||
			value.outcome === "canceled")
	);
}

export const MAX_GOAL_EVIDENCE = 512;

/** Current measurements have their own bounded slot so a full history cannot suppress a failure. */
export function goalEvidenceHasRoom(state: GoalState): boolean {
	const current = currentCheckEvidenceIds(state);
	return state.evidence.filter((evidence) => !current.has(evidence.id)).length < MAX_GOAL_EVIDENCE;
}

/** Only superseded, uncited checks leave the snapshot; their exact receipts remain in the goal journal. */
export function compactGoalCheckEvidence(state: GoalState): void {
	const current = currentCheckEvidenceIds(state);
	const superseded = new Set(
		state.evidence
			.filter((evidence) => evidence.kind === "check" && !current.has(evidence.id))
			.map((evidence) => evidence.id),
	);
	if (superseded.size === 0) return;
	state.requirements = state.requirements.map((requirement) =>
		requirement.status !== "satisfied" || !requirement.proofKey
			? { ...requirement, evidenceIds: requirement.evidenceIds.filter((id) => !superseded.has(id)) }
			: requirement,
	);
	const cited = new Set(state.requirements.flatMap((requirement) => requirement.evidenceIds));
	state.evidence = state.evidence.filter(
		(evidence) => evidence.kind !== "check" || current.has(evidence.id) || cited.has(evidence.id),
	);
}
