/** Model-facing receipts for commands that change which worker runs a task. */
import type { WorkerAgentControlPort } from "../delegation/worker-agent-control.ts";
import type { ModelTransferRecord } from "../orchestration/model-transfer.ts";

export function handoffSummary(transfer: ModelTransferRecord) {
	const { status, sourceAgentId, successorAgentId, targetModelRef, taskId, reasonCode } = transfer;
	return status === "refused"
		? `Handoff from ${sourceAgentId} to ${targetModelRef} refused (${reasonCode}).`
		: `Handoff ${status} for task ${taskId}: ${sourceAgentId} → ${successorAgentId} (${targetModelRef}).`;
}

export function handoffWorkerReceipt(transfer: ModelTransferRecord) {
	const { sourceAgentId, reasonCode, status } = transfer;
	return {
		content: [{ type: "text" as const, text: handoffSummary(transfer) }],
		details: {
			action: "handoff" as const,
			started: transfer.successorStarted === true,
			accepted: status !== "refused",
			agentId: sourceAgentId,
			modelTransfer: transfer,
			skipReason: reasonCode,
		},
	};
}

export function interruptWorkerReceipt(
	agentId: string,
	haltReason: string | undefined,
	outcome: ReturnType<WorkerAgentControlPort["interruptWorkerAgent"]>,
) {
	const interruptText = !outcome.interrupted
		? outcome.reason === "agent_not_running"
			? `worker ${agentId} was not interrupted (agent_not_running): it has no running request to halt. A queued task starts on its own and cancel withdraws it; an idle worker has already finished its task.`
			: `worker ${agentId} was not interrupted (${outcome.reason ?? "unknown"})`
		: outcome.reason === "halt_already_requested"
			? `worker ${agentId} already has a halt in flight; its report arrives through the terminal handoff`
			: `worker ${agentId} halt requested: it finishes its current request, is told you stopped it${haltReason ? " and why" : ""}, and reports to you; its terminal handoff wakes you. A worker that reaches no request boundary in time is cancelled and that is reported instead. Continue it afterwards with follow_up on the same agentId. Do not poll or wait on it.`;
	return {
		content: [{ type: "text" as const, text: interruptText }],
		details: {
			started: outcome.interrupted,
			action: "interrupt" as const,
			agentId,
			...(outcome.mode ? { mode: outcome.mode } : {}),
			skipReason: outcome.reason,
		},
	};
}
