/** Current objective evidence admission and withdrawal, with historical receipts retained by the event journal. */

import { isDeepStrictEqual } from "node:util";
import {
	type AppendOrchestrationEventInput,
	type EvidenceContract,
	type OrchestrationEvent,
	toJsonObject,
} from "./contracts.ts";
import { isGoalCoverageRecord, isGoalEvidenceMirror } from "./goal-evidence-mirror.ts";
import { sourceGoalId } from "./goal-objective-id.ts";
import { evidenceFromPayload, string } from "./task-runtime-codecs.ts";
import { assertObjectiveEvidenceHasCapacity } from "./task-runtime-projection.ts";
import {
	DurableTaskRuntimeError,
	type ObjectiveRuntimeState,
	type TaskRuntimeProjection,
} from "./task-runtime-state.ts";

function objectiveOf(state: TaskRuntimeProjection, objectiveId: string): ObjectiveRuntimeState {
	const objective = state.objectives[objectiveId];
	if (!objective) throw new DurableTaskRuntimeError(`Unknown objective '${objectiveId}'.`);
	return objective;
}

function validateEvidence(
	state: TaskRuntimeProjection,
	objectiveId: string,
	evidence: EvidenceContract,
): ObjectiveRuntimeState {
	const objective = objectiveOf(state, objectiveId);
	const coverage = isGoalCoverageRecord(evidence, objectiveId);
	if (coverage)
		throw new DurableTaskRuntimeError("Goal coverage receipts must be recorded by the atomic goal projection owner.");
	if (!evidence.evidenceId.trim() || !evidence.summary.trim() || !evidence.createdAt.trim())
		throw new DurableTaskRuntimeError("Objective evidence requires an id, summary, and creation time.");
	if (
		evidence.criterionId &&
		!objective.objective.acceptanceCriteria.some((criterion) => criterion.id === evidence.criterionId)
	)
		throw new DurableTaskRuntimeError(
			`Objective evidence references unknown acceptance criterion '${evidence.criterionId}'.`,
		);
	const existing = objective.evidence.find((item) => item.evidenceId === evidence.evidenceId);
	if (existing && !isDeepStrictEqual(existing, evidence))
		throw new DurableTaskRuntimeError(`Objective evidence '${evidence.evidenceId}' has conflicting content.`);
	if (!existing) assertObjectiveEvidenceHasCapacity(state.objectives, objective, evidence);
	return objective;
}

export function objectiveEvidenceRecordEvent(
	state: TaskRuntimeProjection,
	objectiveId: string,
	evidence: EvidenceContract,
): AppendOrchestrationEventInput | undefined {
	const objective = validateEvidence(state, objectiveId, evidence);
	if (objective.evidence.some((item) => item.evidenceId === evidence.evidenceId)) return undefined;
	const goalId = sourceGoalId(objectiveId);
	if (goalId !== undefined && isGoalEvidenceMirror(evidence, goalId))
		throw new DurableTaskRuntimeError(
			"This evidence identity and source metadata are reserved for historical goal receipts.",
		);
	return {
		type: "objective.evidence_recorded",
		aggregateId: objectiveId,
		actor: "kernel",
		payload: toJsonObject({ evidence }),
	};
}

export function reduceObjectiveEvidence(
	state: TaskRuntimeProjection,
	event: OrchestrationEvent,
): ObjectiveRuntimeState {
	if (event.type === "objective.evidence_withdrawn") {
		const current = objectiveOf(state, event.aggregateId);
		if (!Array.isArray(event.payload.evidenceIds))
			throw new DurableTaskRuntimeError("Evidence withdrawal requires evidenceIds.");
		const withdrawn = new Set(event.payload.evidenceIds.map((id) => string(id, "evidenceIds")));
		return { ...current, evidence: current.evidence.filter((item) => !withdrawn.has(item.evidenceId)) };
	}
	const evidence = evidenceFromPayload(event.payload);
	const current = validateEvidence(state, event.aggregateId, evidence);
	return current.evidence.some((item) => item.evidenceId === evidence.evidenceId)
		? current
		: { ...current, evidence: [...current.evidence, evidence] };
}
