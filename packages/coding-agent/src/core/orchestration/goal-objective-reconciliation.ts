/** One durable reconciliation of goal metadata and current coverage, preserving independently owned evidence. */
import { isDeepStrictEqual } from "node:util";
import {
	type GoalObjectiveCursor,
	type GoalSourcePosition,
	isGoalObjectiveCursor,
} from "../goals/goal-correction-contract.ts";
import {
	type AppendOrchestrationEventInput,
	type EvidenceContract,
	MAX_ORCHESTRATION_ACCEPTANCE_CRITERIA,
	MAX_ORCHESTRATION_OBJECTIVES,
	type ObjectiveStatus,
	type OrchestrationEvent,
	toJsonObject,
} from "./contracts.ts";
import { goalEvidenceMirrorWithdrawals, isGoalCoverageRecord } from "./goal-evidence-mirror.ts";
import { goalObjectiveId } from "./goal-objective-id.ts";
import { objectiveNeedsCorrectedOutcome } from "./objective-criteria.ts";
import { assertObjectiveSynchronization, goalObjectiveMetadata } from "./objective-synchronization.ts";
import { assertLifetimeHeadroom } from "./retention.ts";
import { dispatchIdentifier, evidenceFromPayload, objectiveFromPayload } from "./task-runtime-codecs.ts";
import { assertRecordHasCapacity, projectionCapacity } from "./task-runtime-projection.ts";
import {
	type CreateObjectiveInput,
	DurableTaskRuntimeError,
	type ObjectiveRuntimeState,
	type TaskRuntimeProjection,
} from "./task-runtime-state.ts";

export interface GoalObjectiveSource {
	goalId: string;
	createdAt: string;
	status?: ObjectiveStatus;
	completionPolicy?: "owner_evidence" | "owner_override";
	cursor?: GoalObjectiveCursor;
	position?: GoalSourcePosition;
}

function sourceOf(value: GoalObjectiveSource): GoalObjectiveSource {
	const goalId = dispatchIdentifier(value.goalId, "goal source.goalId");
	if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)))
		throw new DurableTaskRuntimeError("Goal objective source lifetime is invalid.");
	if (value.status !== undefined && !["active", "paused", "completed", "cancelled"].includes(value.status))
		throw new DurableTaskRuntimeError("Goal objective desired status is invalid.");
	if (
		value.completionPolicy !== undefined &&
		value.completionPolicy !== "owner_evidence" &&
		value.completionPolicy !== "owner_override"
	)
		throw new DurableTaskRuntimeError("Goal objective completion policy is invalid.");
	return { ...value, goalId, createdAt: value.createdAt };
}

function cursorTransition(
	current: ObjectiveRuntimeState | undefined,
	source: GoalObjectiveSource,
): { cursor?: GoalObjectiveCursor; reopen: boolean } {
	const previous = current?.goalSource;
	const cursor = source.cursor;
	const fenced = previous?.lastCorrection !== undefined || cursor?.lastCorrection !== undefined;
	if (cursor !== undefined && (!isGoalObjectiveCursor(cursor) || cursor.createdAt !== source.createdAt))
		throw new DurableTaskRuntimeError("Goal objective source cursor is invalid.");
	if (fenced) {
		if (
			!cursor ||
			(previous &&
				(previous.createdAt !== cursor.createdAt ||
					cursor.revision < previous.revision ||
					(cursor.revision === previous.revision && cursor.definitionKey !== previous.definitionKey)))
		)
			throw new DurableTaskRuntimeError("Stale goal branch cannot change a corrected objective.");
		if (
			previous?.lastCorrection &&
			(!cursor.lastCorrection ||
				cursor.lastCorrection.revision < previous.lastCorrection.revision ||
				(cursor.lastCorrection.revision === previous.lastCorrection.revision &&
					cursor.lastCorrection.ownerEntryId !== previous.lastCorrection.ownerEntryId))
		)
			throw new DurableTaskRuntimeError("Goal branch does not retain the current owner correction.");
	}
	const correction = cursor?.lastCorrection;
	const fresh =
		correction !== undefined &&
		correction.ownerEntryId !== previous?.lastCorrection?.ownerEntryId &&
		correction.revision > (previous?.lastCorrection?.revision ?? -1);
	if (
		fresh &&
		current?.objective.status === "completed" &&
		correction.targetCompletionRevision < (previous?.revision ?? 0)
	)
		throw new DurableTaskRuntimeError("Owner correction targets an older objective completion source.");
	const reopen =
		current?.objective.status === "completed" &&
		fresh &&
		(source.status === "active" || source.status === "paused" || source.status === "cancelled") &&
		correction.targetCompletionRevision >= (previous?.revision ?? 0);
	if (
		objectiveNeedsCorrectedOutcome({ goalSource: cursor }) &&
		source.status === "completed" &&
		source.completionPolicy !== "owner_override"
	)
		throw new DurableTaskRuntimeError("Corrected goal requires fresh aggregate outcome proof before completion.");
	return { cursor, reopen };
}

function reconcileGoalObjective(
	state: TaskRuntimeProjection,
	input: CreateObjectiveInput & { objectiveId: string },
	evidence: readonly EvidenceContract[],
	source: GoalObjectiveSource,
	now: string,
): ObjectiveRuntimeState {
	const origin = sourceOf(source);
	if (input.objectiveId !== goalObjectiveId(origin.goalId))
		throw new DurableTaskRuntimeError("Goal objective reconciliation has a conflicting source identity.");
	if (evidence.length > MAX_ORCHESTRATION_ACCEPTANCE_CRITERIA)
		throw new DurableTaskRuntimeError("Goal objective coverage exceeds its criterion bound.");
	for (const item of evidence) {
		if (!isGoalCoverageRecord(item, input.objectiveId) || item.metadata?.sourceGoalCreatedAt !== origin.createdAt)
			throw new DurableTaskRuntimeError("Goal objective coverage has a conflicting source or receipt shape.");
	}
	const current = state.objectives[input.objectiveId];
	if (!current) assertRecordHasCapacity(state.objectives, MAX_ORCHESTRATION_OBJECTIVES, "objective");
	const withdrawn = goalEvidenceMirrorWithdrawals(current?.evidence ?? [], evidence, origin.goalId);
	return assertObjectiveSynchronization(
		state,
		{ ...input, constraints: current?.objective.constraints ?? input.constraints },
		evidence,
		withdrawn,
		now,
		(required) => assertLifetimeHeadroom(state, projectionCapacity(state), required),
	);
}

export function goalObjectiveReconciliationEvent(
	state: TaskRuntimeProjection,
	input: CreateObjectiveInput & { objectiveId: string },
	evidence: readonly EvidenceContract[],
	source: GoalObjectiveSource,
	now: string,
): AppendOrchestrationEventInput | undefined {
	const origin = sourceOf(source);
	const current = state.objectives[input.objectiveId];
	const transition = cursorTransition(current, origin);
	if (current?.goalSource?.lastCorrection || origin.cursor?.lastCorrection) {
		if (
			!origin.position ||
			origin.position.goalEntryId !== origin.cursor?.goalEntryId ||
			(current?.goalSource && !origin.position.isDescendantOf(current.goalSource.goalEntryId))
		)
			throw new DurableTaskRuntimeError(
				"Corrected goal synchronization requires its current certified journal lineage.",
			);
	}
	const candidate = goalObjectiveMetadata(
		{ ...input, constraints: current?.objective.constraints ?? input.constraints },
		current,
		now,
	);
	const metadataChanged = !current || !isDeepStrictEqual({ ...current.objective, updatedAt: now }, candidate);
	const objective = !metadataChanged && current ? current.objective : candidate;
	const terminal = current?.objective.status === "completed" || current?.objective.status === "cancelled";
	const targetStatus =
		terminal && !transition.reopen
			? current.objective.status
			: (origin.status ?? current?.objective.status ?? "active");
	const retained = new Map(current?.evidence.map((item) => [item.evidenceId, item]) ?? []);
	if (
		!metadataChanged &&
		isDeepStrictEqual(current?.goalSource, transition.cursor) &&
		targetStatus === current?.objective.status &&
		goalEvidenceMirrorWithdrawals(current?.evidence ?? [], evidence, origin.goalId).length === 0 &&
		evidence.every((item) => isDeepStrictEqual(item, retained.get(item.evidenceId)))
	)
		return undefined;
	return {
		type: "objective.goal_reconciled",
		aggregateId: input.objectiveId,
		actor: "kernel",
		payload: toJsonObject({
			objective,
			coverage: evidence,
			goalId: source.goalId,
			goalCreatedAt: source.createdAt,
			...(transition.cursor ? { goalSource: transition.cursor } : {}),
			...(current?.goalSource ? { previousGoalEntryId: current.goalSource.goalEntryId } : {}),
			targetStatus,
			...(targetStatus === "completed" ? { completionPolicy: origin.completionPolicy ?? "owner_evidence" } : {}),
		}),
	};
}

export function reduceGoalObjectiveReconciliation(
	state: TaskRuntimeProjection,
	event: OrchestrationEvent,
): {
	state: ObjectiveRuntimeState;
	targetStatus: ObjectiveStatus;
	completionPolicy: "owner_evidence" | "owner_override";
} {
	const objective = objectiveFromPayload(event.payload);
	if (objective.objectiveId !== event.aggregateId)
		throw new DurableTaskRuntimeError("Goal objective event does not match its aggregate.");
	const current = state.objectives[event.aggregateId];
	if (!current && objective.createdAt !== objective.updatedAt)
		throw new DurableTaskRuntimeError("Created goal objective has inconsistent metadata timestamps.");
	if (
		current
			? objective.status !== current.objective.status || objective.createdAt !== current.objective.createdAt
			: objective.status !== "active"
	)
		throw new DurableTaskRuntimeError("Goal objective reconciliation changed lifecycle ownership.");
	if (!Array.isArray(event.payload.coverage) || event.payload.coverage.length > MAX_ORCHESTRATION_ACCEPTANCE_CRITERIA)
		throw new DurableTaskRuntimeError("Goal objective reconciliation coverage is invalid.");
	const evidence = event.payload.coverage.map((item) => evidenceFromPayload(toJsonObject({ evidence: item })));
	if (event.actor !== "kernel")
		throw new DurableTaskRuntimeError("Goal objective reconciliation requires its host owner.");
	const source = sourceOf({
		goalId: dispatchIdentifier(event.payload.goalId, "goalId"),
		createdAt: dispatchIdentifier(event.payload.goalCreatedAt, "goalCreatedAt"),
		status: dispatchIdentifier(event.payload.targetStatus, "targetStatus") as ObjectiveStatus,
		...(event.payload.goalSource === undefined
			? {}
			: { cursor: event.payload.goalSource as unknown as GoalObjectiveCursor }),
		...(event.payload.completionPolicy === undefined
			? {}
			: {
					completionPolicy: dispatchIdentifier(event.payload.completionPolicy, "completionPolicy") as
						| "owner_evidence"
						| "owner_override",
				}),
	});
	if ((current?.goalSource?.goalEntryId ?? undefined) !== event.payload.previousGoalEntryId)
		throw new DurableTaskRuntimeError("Goal reconciliation source predecessor changed.");
	const transition = cursorTransition(current, source);
	const reconciled = reconcileGoalObjective(state, objective, evidence, source, objective.updatedAt);
	return {
		state: {
			...reconciled,
			...(transition.reopen
				? { objective: { ...reconciled.objective, status: source.status!, updatedAt: event.occurredAt } }
				: {}),
			...(transition.cursor ? { goalSource: transition.cursor } : {}),
		},
		targetStatus: source.status!,
		completionPolicy: source.completionPolicy ?? "owner_evidence",
	};
}

/** Reject clock regressions in the compound event before it can commit an unreadable snapshot. */
export function assertGoalReconciliationTime(
	before: TaskRuntimeProjection,
	after: TaskRuntimeProjection,
	objectiveId: string,
): void {
	const objective = after.objectives[objectiveId];
	if (!objective) return;
	const check = (
		previous: { createdAt: string; updatedAt: string } | undefined,
		current: { createdAt: string; updatedAt: string },
		label: string,
	): void => {
		if (
			Date.parse(current.updatedAt) < Date.parse(current.createdAt) ||
			(previous && Date.parse(current.updatedAt) < Date.parse(previous.updatedAt))
		)
			throw new DurableTaskRuntimeError(
				`Goal reconciliation clock moved before ${label}'s retained lifetime. Align the runtime and event-store clocks before retrying.`,
			);
	};
	check(before.objectives[objectiveId]?.objective, objective.objective, `objective '${objectiveId}'`);
	for (const taskId of objective.taskIds) {
		const task = after.tasks[taskId];
		if (!task) continue;
		check(before.tasks[taskId]?.task, task.task, `task '${taskId}'`);
		for (const attemptId of task.attemptIds) {
			const attempt = after.attempts[attemptId];
			if (!attempt) continue;
			check(before.attempts[attemptId], attempt, `attempt '${attemptId}'`);
			if (attempt.agentId) {
				const agent = after.agents[attempt.agentId];
				if (agent) check(before.agents[attempt.agentId], agent, `agent '${attempt.agentId}'`);
			}
		}
	}
}
