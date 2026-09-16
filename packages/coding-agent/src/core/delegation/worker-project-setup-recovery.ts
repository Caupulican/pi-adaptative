import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { WorkerAgentMailbox } from "./worker-agent-control.ts";
import type { WorkerConversationStore, WorkerProjectContextReference } from "./worker-conversation-store.ts";
import { WorkerLifecycle } from "./worker-lifecycle.ts";
import { isLocalProcessAlive, isLocalWorkerProcessOwnerProvenDead } from "./worker-process-owner.ts";
import type { WorkerProjectAllocation } from "./worker-project-directory.ts";

/** Reconcile only interrupted initial setup. A leased task or registered agent has another lifecycle. */
export class WorkerProjectSetupRecovery {
	private readonly agentDir: string;
	private readonly conversations: WorkerConversationStore;

	constructor(agentDir: string, conversations: WorkerConversationStore) {
		this.agentDir = agentDir;
		this.conversations = conversations;
	}

	settle(
		allocation: WorkerProjectAllocation,
		reference: WorkerProjectContextReference,
		publish: (enrolled: boolean) => void,
	): void {
		if (!isLocalWorkerProcessOwnerProvenDead(allocation.owner.incarnation, isLocalProcessAlive)) return;
		if (reference.parentSessionId !== allocation.owner.parentSessionId)
			throw new Error("Worker setup recovery has conflicting birth ownership.");
		if (reference.resumeContext.sessionFile && existsSync(reference.resumeContext.sessionFile)) {
			const binding = this.conversations.getProjectContextBinding({
				agentDir: this.agentDir,
				resumeContext: reference.resumeContext,
				expectedLogicalAgentId: reference.logicalAgentId,
			});
			// An allocation receipt describes birth only. It stops being a recovery candidate once
			// that context has moved on; the transcript remains the sole source of current ownership.
			if (binding && !isDeepStrictEqual(binding.ownership.claim, { ...allocation.owner, generation: 1 })) return;
		}
		const lifecycle = new WorkerLifecycle({ agentDir: this.agentDir, sessionId: reference.parentSessionId });
		const snapshot = lifecycle.getTaskRuntimeSnapshot();
		const task = snapshot.tasks[reference.logicalAgentId];
		if (task?.attemptIds.length !== 1) return;
		const attempt = snapshot.attempts[task.attemptIds[0]];
		if (
			!attempt ||
			attempt.lease ||
			attempt.agentId ||
			!["queued", "cancelled"].includes(attempt.status) ||
			Object.values(snapshot.agents).some(
				(agent) =>
					agent.agentId === reference.logicalAgentId ||
					agent.resumeContext.sessionId === reference.resumeContext.sessionId ||
					agent.resumeContext.sessionFile === reference.resumeContext.sessionFile,
			)
		)
			return;
		const mailbox = new WorkerAgentMailbox({
			agentDir: this.agentDir,
			parentSessionId: reference.parentSessionId,
			agentId: reference.logicalAgentId,
		});
		this.conversations.settleCancelledProjectSetup(
			{
				agentDir: this.agentDir,
				reference,
				...allocation,
				withQuiescence: (operation) => mailbox.withQuiescentMailbox(operation),
				beforeRelease: (conversation) => {
					if (
						conversation &&
						!isDeepStrictEqual(
							conversation.getBirthContextForkReference(),
							attempt.dispatch.birthContextForkReference,
						)
					)
						throw new Error("Worker setup task and transcript have different birth context.");
					lifecycle.ledger.runtime.cancelAttempt(attempt.attemptId, "worker_setup_owner_exited", {
						expectedLastOrdinal: snapshot.lastOrdinal,
						unleasedOnly: true,
					});
					// Use the lifecycle's canonical bounded terminal outbox. A restarted parent receives
					// the cancellation without ever replaying the abandoned task's instructions.
					lifecycle.getPendingTerminalNotifications();
				},
			},
			publish,
		);
	}
}
