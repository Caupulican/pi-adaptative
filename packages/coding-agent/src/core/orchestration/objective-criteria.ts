/** Cardinality and retained-reference rules for durable objective acceptance criteria. */
import { type AcceptanceCriterion, type EvidenceContract, MAX_ORCHESTRATION_ACCEPTANCE_CRITERIA } from "./contracts.ts";
import { isGoalCoverageRecord } from "./goal-evidence-mirror.ts";
import {
	DurableTaskRuntimeError,
	type ObjectiveRuntimeState,
	type TaskRuntimeProjection,
} from "./task-runtime-state.ts";

export function assertAcceptanceCriterionCount(count: number): void {
	if (count > MAX_ORCHESTRATION_ACCEPTANCE_CRITERIA)
		throw new DurableTaskRuntimeError(
			`Objective acceptance criteria exceed their ${MAX_ORCHESTRATION_ACCEPTANCE_CRITERIA}-criterion limit.`,
		);
}

export function assertAcceptanceCriteria(criteria: readonly AcceptanceCriterion[]): void {
	assertAcceptanceCriterionCount(criteria.length);
	const criterionIds = criteria.map((criterion) => criterion.id);
	if (
		criterionIds.some((id) => !id.trim()) ||
		new Set(criterionIds).size !== criterionIds.length ||
		criteria.some((criterion) => !criterion.description.trim())
	) {
		throw new DurableTaskRuntimeError("Objective acceptance criteria require unique ids and descriptions.");
	}
}

export function assertReferencedAcceptanceCriteriaRetained(
	tasks: TaskRuntimeProjection["tasks"],
	current: ObjectiveRuntimeState,
	acceptanceCriteria: readonly AcceptanceCriterion[],
): void {
	const retainedCriterionIds = new Set(acceptanceCriteria.map((criterion) => criterion.id));
	const referencedRemovedIds = current.taskIds.flatMap((taskId) =>
		(tasks[taskId]?.task.acceptanceCriterionIds ?? []).filter(
			(criterionId) => !retainedCriterionIds.has(criterionId),
		),
	);
	if (referencedRemovedIds.length > 0) {
		throw new DurableTaskRuntimeError(
			`Cannot remove acceptance criteria referenced by tasks: ${[...new Set(referencedRemovedIds)].join(", ")}.`,
		);
	}
}

/** All retained evidence must still name a criterion the objective can restore. */
export function assertEvidenceCriteriaRetained(
	criteria: readonly AcceptanceCriterion[],
	evidence: readonly EvidenceContract[],
): void {
	const ids = new Set(criteria.map((criterion) => criterion.id));
	for (const item of evidence) {
		if (item.criterionId && !ids.has(item.criterionId))
			throw new DurableTaskRuntimeError(
				`Objective evidence references unknown acceptance criterion '${item.criterionId}'.`,
			);
	}
}

/** Owner corrections require a current review of the complete amended outcome. */
export function objectiveNeedsCorrectedOutcome(
	objective: Pick<ObjectiveRuntimeState, "goalSource"> | undefined,
): boolean {
	return Boolean(objective?.goalSource?.lastCorrection && !objective.goalSource.correctedOutcomeProof);
}

/** A corrected goal earns coverage again; its older independent observations remain available for review. */
export function provenObjectiveCriterionIds(
	objective: ObjectiveRuntimeState,
	evidence: readonly EvidenceContract[] = objective.evidence,
): Set<string> {
	const current = objective.goalSource?.lastCorrection
		? objective.evidence.filter((item) => isGoalCoverageRecord(item, objective.objective.objectiveId))
		: evidence;
	return new Set(current.flatMap((item) => (item.trusted && item.criterionId ? [item.criterionId] : [])));
}
