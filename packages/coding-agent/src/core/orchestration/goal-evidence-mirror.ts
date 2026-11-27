/** Compact goal coverage and exact ownership of current and legacy objective mirrors. */

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { GoalEvidenceKind, GoalEvidenceRef, GoalState, Requirement } from "../goals/goal-state.ts";
import { requirementKey, requirementProofKey } from "../goals/requirement-proof.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import {
	type EvidenceContract,
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE_ROWS,
} from "./contracts.ts";
import { goalObjectiveId } from "./goal-objective-id.ts";
import { DurableTaskRuntimeError } from "./task-runtime-state.ts";

const GOAL_EVIDENCE_KINDS: Readonly<Record<GoalEvidenceKind, EvidenceContract["kind"]>> = {
	test: "test",
	tool: "command",
	check: "command",
	worker: "review",
	user: "external",
	file: "observation",
	finding: "observation",
};
const COVERAGE_FORMAT = "goal-requirement-coverage-v1";
const COVERAGE_FIELDS = [
	"projection",
	"sourceGoalId",
	"sourceGoalCreatedAt",
	"sourceRequirementId",
	"sourceRequirementKey",
	"sourceProofKey",
	"citationCount",
	"identityNonce",
];
const DIGEST = /^[a-f0-9]{64}$/u;
const LEGACY_FIELDS = new Set(["sourceGoalEvidenceId", "sourceKind", "uri", "sourceGoalId", "sourceRequirementId"]);

/** @deprecated Use goalCoverageMirrorId for new coverage. Remove when no journal retains per-citation mirror rows. */
export function goalEvidenceMirrorId(goalId: string, requirementId: string, evidenceId: string): string {
	const legacy = `goal-evidence:${goalId}:${requirementId}:${evidenceId}`;
	return [goalId, requirementId, evidenceId].every((part) => !part.includes(":")) &&
		legacy.length <= MAX_ORCHESTRATION_IDENTIFIER_LENGTH
		? legacy
		: `goal-evidence-hash:${createHash("sha256")
				.update(JSON.stringify([goalId, requirementId, evidenceId]))
				.digest("hex")}`;
}

export function goalCoverageMirrorId(goalId: string, createdAt: string, requirementId: string, nonce = 0): string {
	return `goal-coverage:v1:${createHash("sha256")
		.update(JSON.stringify([goalId, createdAt, requirementId, nonce]))
		.digest("hex")}`;
}

function coverageSummary(count: number): string {
	return `Accepted requirement proof with ${count} citation${count === 1 ? "" : "s"}; full observations remain in the source goal.`;
}

/** Strict data-only marker validation is shared by admission, replay, and snapshot capacity accounting. */
export function isGoalCoverageRecord(
	value: unknown,
	objectiveId: string,
): value is EvidenceContract & { kind: "observation"; trusted: true; criterionId: string } {
	if (!isPlainRecord(value) || !isPlainRecord(value.metadata)) return false;
	const source = value.metadata;
	if (
		Object.keys(source).length !== COVERAGE_FIELDS.length ||
		!COVERAGE_FIELDS.every((key) => Object.hasOwn(source, key))
	)
		return false;
	if (
		source.projection !== COVERAGE_FORMAT ||
		typeof source.sourceGoalId !== "string" ||
		goalObjectiveId(source.sourceGoalId) !== objectiveId ||
		typeof source.sourceGoalCreatedAt !== "string" ||
		!Number.isFinite(Date.parse(source.sourceGoalCreatedAt)) ||
		typeof source.sourceRequirementId !== "string" ||
		source.sourceRequirementId !== value.criterionId ||
		typeof source.sourceRequirementKey !== "string" ||
		!DIGEST.test(source.sourceRequirementKey) ||
		typeof source.sourceProofKey !== "string" ||
		!/^coverage-v2:[a-f0-9]{64}$/u.test(source.sourceProofKey) ||
		!Number.isSafeInteger(source.citationCount) ||
		Number(source.citationCount) <= 0 ||
		!Number.isSafeInteger(source.identityNonce) ||
		Number(source.identityNonce) < 0 ||
		Number(source.identityNonce) > MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE_ROWS
	)
		return false;
	return (
		value.evidenceId ===
			goalCoverageMirrorId(
				source.sourceGoalId,
				source.sourceGoalCreatedAt,
				source.sourceRequirementId,
				Number(source.identityNonce),
			) &&
		value.kind === "observation" &&
		value.trusted === true &&
		Array.isArray(value.artifactIds) &&
		value.artifactIds.length === 0 &&
		value.summary === coverageSummary(Number(source.citationCount)) &&
		typeof value.createdAt === "string" &&
		Number.isFinite(Date.parse(value.createdAt))
	);
}

/** Older mirrors require an exact tuple and source metadata; a similar prefix grants no ownership. */
export function isGoalEvidenceMirror(item: EvidenceContract, goalId: string): boolean {
	if (isGoalCoverageRecord(item, goalObjectiveId(goalId))) return true;
	const source = item.metadata;
	if (
		item.trusted !== true ||
		!source ||
		!Object.keys(source).every((key) => LEGACY_FIELDS.has(key)) ||
		(source.uri !== undefined && typeof source.uri !== "string") ||
		typeof source.sourceGoalEvidenceId !== "string" ||
		typeof source.sourceKind !== "string" ||
		!item.criterionId ||
		item.artifactIds.length !== 0
	)
		return false;
	if (source.sourceGoalId !== undefined && source.sourceGoalId !== goalId) return false;
	if (source.sourceRequirementId !== undefined && source.sourceRequirementId !== item.criterionId) return false;
	if (
		!Object.hasOwn(GOAL_EVIDENCE_KINDS, source.sourceKind) ||
		GOAL_EVIDENCE_KINDS[source.sourceKind as GoalEvidenceKind] !== item.kind
	)
		return false;
	return (
		item.evidenceId === goalEvidenceMirrorId(goalId, item.criterionId, source.sourceGoalEvidenceId) ||
		item.evidenceId === `goal-evidence:${goalId}:${item.criterionId}:${source.sourceGoalEvidenceId}`
	);
}

export function projectGoalCoverageRecord(
	goal: GoalState,
	requirement: Requirement,
	citations: readonly GoalEvidenceRef[],
	occupied: ReadonlySet<string>,
): EvidenceContract {
	for (let nonce = 0; nonce <= MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE_ROWS; nonce++) {
		const evidenceId = goalCoverageMirrorId(goal.goalId, goal.createdAt, requirement.id, nonce);
		if (occupied.has(evidenceId)) continue;
		return {
			evidenceId,
			criterionId: requirement.id,
			kind: "observation",
			summary: coverageSummary(citations.length),
			artifactIds: [],
			trusted: true,
			createdAt: requirement.updatedAt,
			metadata: {
				projection: COVERAGE_FORMAT,
				sourceGoalId: goal.goalId,
				sourceGoalCreatedAt: goal.createdAt,
				sourceRequirementId: requirement.id,
				sourceRequirementKey: requirementKey(requirement),
				sourceProofKey: requirementProofKey(requirement, citations),
				citationCount: citations.length,
				identityNonce: nonce,
			},
		};
	}
	throw new DurableTaskRuntimeError(
		"No free identity remains for the goal coverage receipt; independent evidence was preserved.",
	);
}

/** Select withdrawals once for both queue preflight and goal synchronization. */
export function goalEvidenceMirrorWithdrawals(
	current: readonly EvidenceContract[],
	projected: readonly EvidenceContract[],
	goalId: string,
): string[] {
	const accepted = new Map(projected.map((item) => [item.evidenceId, item]));
	return current
		.filter((item) => isGoalEvidenceMirror(item, goalId) && !isDeepStrictEqual(item, accepted.get(item.evidenceId)))
		.map((item) => item.evidenceId);
}
