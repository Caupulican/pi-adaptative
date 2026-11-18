/** Model-transfer state transitions admitted and replayed by the durable task ledger. */
import type { JsonObject } from "../autonomy/contracts.ts";
import { assertTransferHasNoDependentWork } from "./agent-retirement-lineage.ts";
import { pendingApprovalForTask } from "./approval-transitions.ts";
import { selectedTaskAttempt } from "./attempt-ordering.ts";
import { dispatchIdentifier, number } from "./codec-primitives.ts";
import { MAX_ORCHESTRATION_AGENT_BINDINGS, MAX_ORCHESTRATION_ATTEMPTS, type OrchestrationEvent } from "./contracts.ts";
import {
	assertCurrentModelTransferSource,
	assertModelTransferQuiescent,
	isModelTransferInterrupted,
	isRefusedModelTransferSuccessor,
	MAX_MODEL_TRANSFER_REFUSALS,
	type ModelTransferRecord,
	modelTransferByCommand,
	modelTransferFromValue,
	modelTransferIsPending,
	pendingModelTransferForTask,
} from "./model-transfer.ts";
import { assertTaskAttemptBudgetForState } from "./risk-budget.ts";
import { assertRecordHasCapacity } from "./task-runtime-projection.ts";
import {
	type AttemptRuntimeState,
	DurableTaskRuntimeError,
	type TaskRuntimeProjection,
	terminalAttemptStatus,
} from "./task-runtime-state.ts";
import { taskAwaitsVerification } from "./verification-identity.ts";

function assertAggregate(event: OrchestrationEvent, taskId: string): void {
	if (event.aggregateId !== taskId)
		throw new DurableTaskRuntimeError("Model transfer does not match its task aggregate.");
}

function assertSuccessorHeadroom(state: TaskRuntimeProjection, taskId: string): void {
	const task = state.tasks[taskId]!;
	const objective = state.objectives[task.task.objectiveId]?.objective;
	if (objective?.status !== "active")
		throw new DurableTaskRuntimeError(`Model transfer objective '${task.task.objectiveId}' is not active.`);
	if (pendingApprovalForTask(state, taskId))
		throw new DurableTaskRuntimeError(`Task '${taskId}' is awaiting approval.`);
	assertTaskAttemptBudgetForState(task, objective);
	assertRecordHasCapacity(state.agents, MAX_ORCHESTRATION_AGENT_BINDINGS, "agent binding");
	assertRecordHasCapacity(state.attempts, MAX_ORCHESTRATION_ATTEMPTS, "attempt");
}

export function applyModelTransferEvent(
	state: TaskRuntimeProjection,
	event: OrchestrationEvent,
	applyAttemptQueued: (
		state: TaskRuntimeProjection,
		payload: JsonObject,
		occurredAt: string,
		transfer: ModelTransferRecord,
	) => void,
): void {
	const attempts = state.attempts as Record<string, AttemptRuntimeState>;
	const agents = state.agents;
	switch (event.type) {
		case "model_transfer.requested": {
			const transfer = modelTransferFromValue(event.payload, "model_transfer.requested");
			assertAggregate(event, transfer.taskId);
			const source = assertCurrentModelTransferSource(state, transfer);
			assertTransferHasNoDependentWork(state, transfer.sourceAgentId);
			assertSuccessorHeadroom(state, transfer.taskId);
			const status = state.tasks[transfer.taskId]!.task.status;
			const selected = selectedTaskAttempt(state, transfer.taskId);
			const interrupted =
				isModelTransferInterrupted(source) || (selected && isRefusedModelTransferSuccessor(source, selected));
			if (status === "completed" || (status === "cancelled" && !interrupted))
				throw new DurableTaskRuntimeError(`Task '${transfer.taskId}' is already '${status}'.`);
			if (
				transfer.status !== "requested" ||
				modelTransferByCommand(source, transfer.commandId) ||
				pendingModelTransferForTask(state, transfer.taskId) ||
				(source.modelTransfer !== undefined && source.modelTransfer.status !== "refused") ||
				agents[transfer.successorAgentId] ||
				attempts[transfer.successorAttemptId]
			)
				throw new DurableTaskRuntimeError("Model transfer request conflicts with retained work.");
			const refusals = source.modelTransfer
				? [...(source.modelTransferRefusals ?? []), source.modelTransfer]
				: source.modelTransferRefusals;
			if (refusals && refusals.length > MAX_MODEL_TRANSFER_REFUSALS)
				throw new DurableTaskRuntimeError("Model transfer retry history has reached its limit.");
			attempts[source.attemptId] = {
				...source,
				modelTransfer: transfer,
				...(refusals ? { modelTransferRefusals: refusals } : {}),
			};
			break;
		}
		case "model_transfer.successor_admitted": {
			const sourceAttemptId = dispatchIdentifier(event.payload.sourceAttemptId, "model transfer source attempt");
			const commandId = dispatchIdentifier(event.payload.commandId, "model transfer command");
			const transfer = attempts[sourceAttemptId]?.modelTransfer;
			if (transfer?.status !== "requested" || transfer.commandId !== commandId)
				throw new DurableTaskRuntimeError("Model transfer successor was not requested.");
			assertAggregate(event, transfer.taskId);
			const source = assertCurrentModelTransferSource(state, transfer);
			assertTransferHasNoDependentWork(state, transfer.sourceAgentId);
			assertModelTransferQuiescent(source);
			if (taskAwaitsVerification(state, transfer.taskId))
				throw new DurableTaskRuntimeError("Model transfer source awaits independent verification.");
			if (agents[transfer.successorAgentId])
				throw new DurableTaskRuntimeError("Model transfer successor already has an unrelated binding.");
			assertSuccessorHeadroom(state, transfer.taskId);
			applyAttemptQueued(
				state,
				{
					attemptId: transfer.successorAttemptId,
					taskId: transfer.taskId,
					dispatch: event.payload.dispatch ?? null,
				},
				event.occurredAt,
				transfer,
			);
			attempts[source.attemptId] = {
				...attempts[source.attemptId]!,
				modelTransfer: { ...transfer, status: "successor_admitted" },
			};
			break;
		}
		case "model_transfer.successor_accepted": {
			const attemptId = dispatchIdentifier(event.payload.attemptId, "model transfer successor attempt");
			const leaseId = dispatchIdentifier(event.payload.leaseId, "model transfer successor lease");
			const fencingToken = number(event.payload.fencingToken, "model transfer successor fence");
			const successor = attempts[attemptId];
			const sourceId = successor?.modelTransferSourceAttemptId;
			const source = sourceId ? attempts[sourceId] : undefined;
			const transfer = source?.modelTransfer;
			if (!source || transfer?.status !== "successor_admitted" || transfer.successorAttemptId !== attemptId)
				throw new DurableTaskRuntimeError("Accepted successor has no admitted model transfer command.");
			assertAggregate(event, transfer.taskId);
			const agent = agents[transfer.successorAgentId];
			if (
				successor?.status !== "running" ||
				successor.agentId !== transfer.successorAgentId ||
				agent?.activeAttemptId !== attemptId ||
				agent.resumeContext.modelRef !== transfer.targetModelRef ||
				successor.lease?.leaseId !== leaseId ||
				successor.lease.fencingToken !== fencingToken ||
				Date.parse(event.occurredAt) >= Date.parse(successor.lease.expiresAt)
			)
				throw new DurableTaskRuntimeError("Model transfer acceptance needs the successor's live execution fence.");
			attempts[source.attemptId] = { ...source, modelTransfer: { ...transfer, successorStarted: true } };
			break;
		}
		case "model_transfer.settled": {
			const sourceAttemptId = dispatchIdentifier(event.payload.sourceAttemptId, "model transfer source attempt");
			const commandId = dispatchIdentifier(event.payload.commandId, "model transfer command");
			const source = attempts[sourceAttemptId];
			const transfer = source?.modelTransfer;
			if (!source || !transfer || transfer.commandId !== commandId || !modelTransferIsPending(transfer))
				throw new DurableTaskRuntimeError("Model transfer has no pending command.");
			assertAggregate(event, transfer.taskId);
			const settled = modelTransferFromValue(
				{
					...transfer,
					status: event.payload.status,
					...(event.payload.reasonCode === undefined ? {} : { reasonCode: event.payload.reasonCode }),
				},
				"model_transfer.settled",
			);
			if (settled.status === "completed") {
				const successor = attempts[transfer.successorAttemptId];
				if (
					transfer.status !== "successor_admitted" ||
					agents[transfer.sourceAgentId]?.status !== "retired" ||
					!agents[transfer.successorAgentId] ||
					successor?.agentId !== transfer.successorAgentId ||
					!transfer.successorStarted
				)
					throw new DurableTaskRuntimeError(
						"Model transfer completion needs a started successor and retired source.",
					);
			} else if (settled.status !== "refused") {
				throw new DurableTaskRuntimeError("Model transfer disposition is invalid.");
			} else if (transfer.status === "successor_admitted") {
				const successor = attempts[transfer.successorAttemptId];
				if (!successor || !terminalAttemptStatus(successor.status) || transfer.successorStarted)
					throw new DurableTaskRuntimeError(
						"Refusing an admitted model transfer needs a successor that settled before starting.",
					);
			}
			attempts[sourceAttemptId] = { ...source, modelTransfer: settled };
			break;
		}
		default:
			throw new DurableTaskRuntimeError("Unexpected model transfer event.");
	}
}
