/** Definition identity, receipt eligibility, and withdrawal of requirement proof. */

import { createHash } from "node:crypto";
import type { GoalEvent, GoalEvidenceRef, GoalState, Requirement } from "./goal-state.ts";

export function isTrustedGoalEvidence(evidence: GoalEvidenceRef): boolean {
	return evidence.verified === true && (evidence.kind !== "test" || evidence.outcome === "succeeded");
}

const currentWorkerEvidence = new WeakMap<GoalState, ReadonlySet<string>>();

/** Live admission is a read projection and never enters the durable goal record. */
export function attachCurrentWorkerEvidence(state: GoalState, ids: ReadonlySet<string>): GoalState {
	currentWorkerEvidence.set(state, ids);
	return state;
}

/** Carry the same admitted read view through a synchronous reducer transaction. */
export function inheritCurrentWorkerEvidence(before: GoalState, after: GoalState): void {
	const ids = currentWorkerEvidence.get(before);
	if (ids) currentWorkerEvidence.set(after, ids);
}

/** A worker observation stays current only while its host-attached generation remains admitted. */
export function hasCurrentWorkerGeneration(state: GoalState, evidence: GoalEvidenceRef): boolean {
	return (
		(evidence.kind !== "worker" && evidence.sourceAttemptId === undefined) ||
		currentWorkerEvidence.get(state)?.has(evidence.id) === true
	);
}

/** A check on an unfinished goal needs a direct host measurement or an identified worker attempt. */
export function hasCurrentCheckProvenance(state: GoalState, evidence: GoalEvidenceRef): boolean {
	return (
		evidence.kind !== "check" ||
		state.status === "completed" ||
		evidence.directHostCheck === true ||
		evidence.sourceAttemptId !== undefined
	);
}

/** Effective readiness follows current accepted proof while historical receipts remain durable. */
export function currentGoalRequirements(state: GoalState): readonly Requirement[] {
	const ambiguousChecks = new Set(
		state.evidence.filter((item) => !hasCurrentCheckProvenance(state, item)).map((item) => item.id),
	);
	return state.requirements.map((requirement) =>
		requirement.status === "satisfied" &&
		(requirement.proofKey !== undefined || requirement.evidenceIds.some((id) => ambiguousChecks.has(id))) &&
		getTrustedRequirementEvidence(state, requirement).length === 0
			? { ...requirement, status: "open" as const }
			: requirement,
	);
}
const COVERAGE_PROOF_PREFIX = "coverage-v2:";

export function requirementKey(requirement: Requirement): string {
	const check = requirement.check;
	return createHash("sha256")
		.update(
			JSON.stringify([
				requirement.id,
				requirement.text,
				requirement.createdAt,
				requirement.definitionAt,
				[...(requirement.dependencies ?? [])].sort(),
				check && [check.command, check.expectExitCode, check.outputContains, check.outputExcludes],
				...(requirement.definitionRevision === undefined ? [] : [requirement.definitionRevision]),
			]),
		)
		.digest("hex");
}

export function requirementProofKey(requirement: Requirement, evidence: readonly GoalEvidenceRef[]): string {
	const citations = evidence
		.map((item) => [
			item.id,
			item.kind,
			item.uri,
			item.summary,
			item.outcome,
			item.verified,
			item.createdAt,
			item.requirementKey,
			...(item.sourceAttemptId === undefined ? [] : [item.sourceAttemptId]),
			...(item.directHostCheck === undefined ? [] : [item.directHostCheck]),
		])
		.sort(([left], [right]) => String(left).localeCompare(String(right)));
	return `${COVERAGE_PROOF_PREFIX}${createHash("sha256")
		.update(JSON.stringify([requirementKey(requirement), citations]))
		.digest("hex")}`;
}

/** The latest measurement for exactly the current check definition, in durable evidence order. */
export function currentRequirementCheckEvidence(
	state: GoalState,
	requirement: Requirement,
): GoalEvidenceRef | undefined {
	const key = requirementKey(requirement);
	const latest = state.evidence.findLast((item) => item.kind === "check" && item.requirementKey === key);
	return latest && hasCurrentCheckProvenance(state, latest) ? latest : undefined;
}

function successfulCitations(state: GoalState, evidenceIds: readonly string[]): GoalEvidenceRef[] {
	const selected = new Set(evidenceIds);
	return state.evidence.filter(
		(evidence) =>
			selected.has(evidence.id) &&
			isTrustedGoalEvidence(evidence) &&
			evidence.outcome !== "failed" &&
			evidence.outcome !== "canceled",
	);
}

/** Keep observed facts separate from citations that can support a requirement's current outcome. */
export function getOutcomeCitations(state: GoalState, evidenceIds: readonly string[]): GoalEvidenceRef[] {
	const selected = successfulCitations(state, evidenceIds);
	const currentChecks = selected.some((item) => item.kind === "check") ? currentCheckEvidenceIds(state) : undefined;
	return selected.filter(
		(item) => hasCurrentWorkerGeneration(state, item) && (item.kind !== "check" || currentChecks?.has(item.id)),
	);
}

export function generalOutcomeCitations(evidence: readonly GoalEvidenceRef[]): GoalEvidenceRef[] {
	return evidence.filter(
		(item) =>
			item.kind === "file" ||
			item.kind === "tool" ||
			item.kind === "test" ||
			item.kind === "user" ||
			item.kind === "check",
	);
}

export function getTrustedRequirementEvidence(state: GoalState, requirement: Requirement): GoalEvidenceRef[] {
	if (requirement.status !== "satisfied") return [];
	const historical = state.status === "completed" && !requirement.proofKey?.startsWith(COVERAGE_PROOF_PREFIX);
	const evidence = historical
		? successfulCitations(state, requirement.evidenceIds)
		: getOutcomeCitations(state, requirement.evidenceIds);
	if (historical && requirement.proofKey === undefined) return evidence;
	const expected = requirementProofKey(requirement, evidence);
	return requirement.proofKey === expected ||
		(historical && requirement.proofKey === expected.slice(COVERAGE_PROOF_PREFIX.length))
		? evidence
		: [];
}

/** Compute the latest measurement per live definition in a single pass over the retained receipts. */
export function currentCheckEvidenceIds(state: GoalState): Set<string> {
	const definitions = new Set(state.requirements.filter((item) => item.check).map(requirementKey));
	const latest = new Map<string, GoalEvidenceRef>();
	for (const item of state.evidence) {
		if (item.kind === "check" && item.requirementKey && definitions.has(item.requirementKey))
			latest.set(item.requirementKey, item);
	}
	return new Set([...latest.values()].filter((item) => hasCurrentCheckProvenance(state, item)).map((item) => item.id));
}

export function reopenedRequirement(requirement: Requirement, now: string): Requirement {
	return {
		...requirement,
		status: "open",
		proofKey: undefined,
		evidenceIds: [],
		blockedReason: undefined,
		updatedAt: now,
	};
}

/** Withdraw acceptance in the transaction that changed a cited receipt or retired its definition. */
export function reconcileGoalEvidenceChange(before: GoalState, after: GoalState, event: GoalEvent): void {
	const changed = new Set<string>();
	if (event.type === "add_evidence") {
		if (before.evidence.some((item) => item.id === event.id)) changed.add(event.id);
		if (event.kind === "check" && event.requirementKey) {
			const previous = before.evidence.findLast(
				(item) => item.kind === "check" && item.requirementKey === event.requirementKey,
			);
			if (previous) changed.add(previous.id);
		}
	} else if (event.type === "set_requirement_check" || event.type === "add_requirement") {
		const previous = before.requirements.find((item) => item.id === event.id);
		if (!previous?.check) return;
		const receipt = currentRequirementCheckEvidence(before, previous);
		if (receipt) changed.add(receipt.id);
	} else return;
	if (changed.size === 0) return;
	after.requirements = after.requirements.map((item) =>
		item.status === "satisfied" &&
		item.proofKey &&
		item.evidenceIds.some((id) => changed.has(id)) &&
		getTrustedRequirementEvidence(after, item).length === 0
			? reopenedRequirement(item, event.now)
			: item,
	);
}

export function isPreviouslyTrustedReceiptReplay(
	existingEvidence: readonly GoalEvidenceRef[],
	newEvidence: GoalEvidenceRef,
): boolean {
	return existingEvidence.some((prev) => {
		if (!isTrustedGoalEvidence(prev)) return false;
		if (prev.kind !== newEvidence.kind || prev.outcome !== newEvidence.outcome) return false;
		if (newEvidence.uri !== undefined && newEvidence.uri.length > 0) {
			return prev.uri === newEvidence.uri;
		}
		return prev.id === newEvidence.id;
	});
}
