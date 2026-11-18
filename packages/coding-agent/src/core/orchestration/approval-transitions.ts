/** Authority and target identity for durable task-ledger approvals. */
import type { ApprovalRequestContract, ApprovalResolutionContract } from "./contracts.ts";
import {
	type ApprovalRuntimeState,
	DurableTaskRuntimeError,
	type TaskRuntimeProjection,
} from "./task-runtime-state.ts";

export function pendingApprovalForTask(state: TaskRuntimeProjection, taskId: string): ApprovalRuntimeState | undefined {
	const task = state.tasks[taskId];
	if (!task) return undefined;
	return Object.values(state.approvals).find(
		(approval) =>
			approval.status === "pending" &&
			approval.request.attemptId === undefined &&
			approval.request.objectiveId === task.task.objectiveId &&
			(approval.request.taskId === undefined || approval.request.taskId === taskId),
	);
}

export function assertApprovalRequestTransition(
	state: TaskRuntimeProjection,
	aggregateId: string,
	approval: ApprovalRequestContract,
): void {
	const expectedAggregateId = approval.attemptId ?? approval.taskId ?? approval.objectiveId;
	if (aggregateId !== expectedAggregateId) {
		throw new DurableTaskRuntimeError(`Approval target '${expectedAggregateId}' does not match its aggregate.`);
	}
	const objective = state.objectives[approval.objectiveId]?.objective;
	if (!objective) throw new DurableTaskRuntimeError(`Unknown objective '${approval.objectiveId}'.`);
	if (objective.status !== "active") {
		throw new DurableTaskRuntimeError(`Objective '${approval.objectiveId}' is not active.`);
	}
	if (approval.attemptId && !approval.taskId) {
		throw new DurableTaskRuntimeError("Attempt-scoped approval requires a taskId.");
	}
	if (approval.taskId) {
		const task = state.tasks[approval.taskId];
		if (!task || task.task.objectiveId !== approval.objectiveId) {
			throw new DurableTaskRuntimeError(`Approval task '${approval.taskId}' does not belong to its objective.`);
		}
	}
	if (approval.attemptId) {
		const attempt = state.attempts[approval.attemptId];
		if (!attempt || attempt.taskId !== approval.taskId) {
			throw new DurableTaskRuntimeError(`Approval attempt '${approval.attemptId}' does not belong to its task.`);
		}
		if (attempt.status !== "queued" || attempt.grantId) {
			throw new DurableTaskRuntimeError(`Approval attempt '${approval.attemptId}' is not awaiting policy.`);
		}
	}
	const pendingForTarget = Object.values(state.approvals).find(
		(candidate) =>
			candidate.status === "pending" &&
			candidate.request.objectiveId === approval.objectiveId &&
			candidate.request.taskId === approval.taskId &&
			candidate.request.attemptId === approval.attemptId,
	);
	if (pendingForTarget) {
		throw new DurableTaskRuntimeError(`Target already awaits approval '${pendingForTarget.request.approvalId}'.`);
	}
}

export function assertApprovalResolutionTransition(
	state: TaskRuntimeProjection,
	aggregateId: string,
	resolution: ApprovalResolutionContract,
): ApprovalRuntimeState {
	const approval = state.approvals[resolution.approvalId];
	if (!approval) throw new DurableTaskRuntimeError(`Unknown approval '${resolution.approvalId}'.`);
	const expectedAggregateId = approval.request.attemptId ?? approval.request.taskId ?? approval.request.objectiveId;
	if (aggregateId !== expectedAggregateId) {
		throw new DurableTaskRuntimeError(`Resolved approval target '${expectedAggregateId}' does not match aggregate.`);
	}
	if (approval.status !== "pending") {
		throw new DurableTaskRuntimeError(`Approval '${resolution.approvalId}' was already ${approval.status}.`);
	}
	return approval;
}
