/** Validates the complete retained objective after planned withdrawals before any synchronization append. */

import { isDeepStrictEqual } from "node:util";
import {
	type EvidenceContract,
	MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE_ROWS,
	type ObjectiveContract,
	ORCHESTRATION_SCHEMA_VERSION,
	toJsonObject,
} from "./contracts.ts";
import { assertEvidenceCriteriaRetained } from "./objective-criteria.ts";
import { assertObjectiveEvidenceCapacity, objectiveEvidenceCounts } from "./objective-evidence-capacity.ts";
import { parseInputRiskBudget } from "./risk-budget.ts";
import {
	assertReferencedAcceptanceCriteriaRetained,
	dispatchIdentifier,
	evidenceFromPayload,
	objectiveFromPayload,
} from "./task-runtime-codecs.ts";
import {
	assertBoundedIdentifierList,
	assertProjectionRecordReplacementWithinLimits,
} from "./task-runtime-projection.ts";
import {
	type CreateObjectiveInput,
	DurableTaskRuntimeError,
	type ObjectiveRuntimeState,
	type OrchestrationProjectionHeadroomRequest,
	type TaskRuntimeProjection,
} from "./task-runtime-state.ts";

export function goalObjectiveMetadata(
	input: CreateObjectiveInput & { objectiveId: string },
	current: ObjectiveRuntimeState | undefined,
	now: string,
): ObjectiveContract {
	const objectiveId = dispatchIdentifier(input.objectiveId, "objective.objectiveId");
	const riskBudget = parseInputRiskBudget(input.riskBudget, "objective.riskBudget");
	const acceptanceCriteria = structuredClone(input.acceptanceCriteria ?? []);
	const title = input.title.trim();
	const description = input.description.trim();
	if (!title || !description) throw new DurableTaskRuntimeError("Objective title and description are required.");
	const projected: ObjectiveContract = current
		? {
				...current.objective,
				title,
				description,
				constraints: [...(input.constraints ?? [])],
				acceptanceCriteria,
				riskBudget,
				updatedAt: now,
			}
		: {
				schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
				objectiveId,
				title,
				description,
				status: "active",
				constraints: [...(input.constraints ?? [])],
				acceptanceCriteria,
				riskBudget,
				createdAt: now,
				updatedAt: now,
			};
	return projected;
}

export function assertObjectiveSynchronization(
	state: TaskRuntimeProjection,
	input: CreateObjectiveInput & { objectiveId: string },
	evidence: readonly EvidenceContract[],
	withdrawnEvidenceIds: readonly string[],
	now: string,
	assertHeadroom: (required: OrchestrationProjectionHeadroomRequest) => unknown,
): ObjectiveRuntimeState {
	const objectiveId = dispatchIdentifier(input.objectiveId, "objective.objectiveId");
	const current = state.objectives[objectiveId];
	assertBoundedIdentifierList(
		withdrawnEvidenceIds,
		MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE_ROWS,
		"Withdrawn objective evidence ids",
	);
	assertBoundedIdentifierList(
		evidence.map((item) => item.evidenceId),
		MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE_ROWS,
		"Objective evidence ids",
	);
	const withdrawn = new Set(withdrawnEvidenceIds);
	const retainedEvidence = current?.evidence.filter((item) => !withdrawn.has(item.evidenceId)) ?? [];

	const projected = goalObjectiveMetadata(input, current, now);
	const objective = objectiveFromPayload(toJsonObject({ objective: projected }));
	if (current) {
		assertReferencedAcceptanceCriteriaRetained(state.tasks, current, objective.acceptanceCriteria);
	}

	const mergedEvidence = retainedEvidence.map((item) => structuredClone(item));
	const evidenceById = new Map(mergedEvidence.map((item) => [item.evidenceId, item]));
	for (const supplied of evidence) {
		const item = evidenceFromPayload(toJsonObject({ evidence: supplied }));
		const evidenceId = dispatchIdentifier(item.evidenceId, "objective evidence.evidenceId");
		if (!item.summary.trim() || !item.createdAt.trim()) {
			throw new DurableTaskRuntimeError("Objective evidence requires an id, summary, and creation time.");
		}
		const existing = evidenceById.get(evidenceId);
		if (existing) {
			if (!isDeepStrictEqual(existing, item)) {
				throw new DurableTaskRuntimeError(`Objective evidence '${evidenceId}' has conflicting content.`);
			}
			continue;
		}
		const retained = structuredClone(item);
		mergedEvidence.push(retained);
		evidenceById.set(evidenceId, retained);
	}
	assertEvidenceCriteriaRetained(objective.acceptanceCriteria, mergedEvidence);
	const metadataChanged = !current || !isDeepStrictEqual({ ...current.objective, updatedAt: now }, objective);
	const replacement = {
		...current,
		objective: !metadataChanged && current ? current.objective : objective,
		taskIds: current?.taskIds ?? [],
		evidence: mergedEvidence,
	};
	assertObjectiveEvidenceCapacity(state.objectives, replacement);
	const currentIndependent = current ? objectiveEvidenceCounts(objectiveId, current.evidence).independent : 0;
	assertHeadroom({
		objectives: current ? 0 : 1,
		evidence: Math.max(0, objectiveEvidenceCounts(objectiveId, mergedEvidence).independent - currentIndependent),
	});
	const changed = !isDeepStrictEqual(current, replacement);
	const finalOrdinal = state.lastOrdinal + Number(changed);
	assertProjectionRecordReplacementWithinLimits(
		{ ...state, lastOrdinal: finalOrdinal },
		"objectives",
		objectiveId,
		replacement,
	);
	return replacement;
}
