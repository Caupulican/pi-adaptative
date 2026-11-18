/** The control mailbox scopes for root-authored messaging and quiescent model-transfer publication. */
import { modelTransferPendingForAgent } from "../orchestration/model-transfer-pending-index.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import type {
	SessionRootWorkerAgentMessageOptions,
	WorkerAgentMailbox,
	WorkerAgentMessageOptions,
} from "./worker-agent-control.ts";

export function sessionRootWorkerMessageOptions(
	options: SessionRootWorkerAgentMessageOptions,
	senderAgentId: string,
	receiptOrigin: WorkerReceiptOrigin | undefined,
): WorkerAgentMessageOptions {
	return {
		senderAgentId,
		...(receiptOrigin ? { receiptOrigin } : {}),
		...(options.threadId !== undefined ? { threadId: options.threadId } : {}),
		...(options.expectReply === true ? { expectReply: true } : {}),
		...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
		...(options.delegationObjectiveId !== undefined ? { delegationObjectiveId: options.delegationObjectiveId } : {}),
		...(options.agentWords !== undefined ? { agentWords: options.agentWords } : {}),
	};
}

export function withModelTransferSourceMailbox<T>(mailbox: WorkerAgentMailbox, agentId: string, publish: () => T): T {
	let result: T | undefined;
	if (
		!mailbox.withQuiescentMailbox(() => {
			result = publish();
		})
	)
		throw new Error(`Logical worker agent '${agentId}' has unresolved mailbox obligations.`);
	return result!;
}

export function assertWorkerMailboxAcceptsIntake(snapshot: TaskRuntimeProjection, agentId: string): void {
	if (snapshot.agents[agentId]?.status === "retired") throw new Error(`Logical worker agent '${agentId}' is retired.`);
	if (modelTransferPendingForAgent(snapshot, agentId))
		throw new Error(`Logical worker agent '${agentId}' is transferring its task.`);
}
