import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { WorkerAgentMailbox } from "./worker-agent-control.ts";
import type { WorkerConversationStore, WorkerProjectContextReference } from "./worker-conversation-store.ts";
import { WorkerLifecycle } from "./worker-lifecycle.ts";
import { isLocalProcessAlive, isLocalWorkerProcessOwnerProvenDead } from "./worker-process-owner.ts";
import type { WorkerProjectAllocation, WorkerProjectPreparation } from "./worker-project-directory.ts";

interface PreparedSetup {
	lifecycle: WorkerLifecycle;
	snapshot: TaskRuntimeProjection;
	attempt?: AttemptRuntimeState;
}

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
		const setup = this.inspectSetup(reference.parentSessionId, reference.logicalAgentId, reference);
		if (!setup?.attempt) return;
		const attempt = setup.attempt;
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
					this.cancelPreparedSetup(setup, "worker_setup_owner_exited");
				},
			},
			publish,
		);
	}

	/** Caller holds the allocation lock, so no transcript can be bound until settlement finishes. */
	settleUnbound(
		allocation: WorkerProjectAllocation,
		preparation: WorkerProjectPreparation | null,
		reason: "owner_exit" | "preparation_failed",
		release: () => void,
	): void {
		if (
			reason === "owner_exit" &&
			!isLocalWorkerProcessOwnerProvenDead(allocation.owner.incarnation, isLocalProcessAlive)
		)
			return;
		if (preparation === null) {
			release();
			return;
		}
		const setup = this.inspectSetup(allocation.owner.parentSessionId, preparation.logicalAgentId);
		if (!setup || (setup.attempt && setup.attempt.dispatch.controlMessageId !== preparation.controlMessageId))
			throw new Error("Worker preparation cannot be proven quiescent for its exact command.");
		const mailbox = new WorkerAgentMailbox({
			agentDir: this.agentDir,
			parentSessionId: allocation.owner.parentSessionId,
			agentId: preparation.logicalAgentId,
		});
		if (
			!mailbox.withQuiescentMailbox(() => {
				this.cancelPreparedSetup(
					setup,
					reason === "owner_exit" ? "worker_setup_owner_exited" : "worker_setup_preparation_failed",
				);
				release();
			})
		)
			throw new Error("Worker preparation has pending mailbox obligations.");
	}

	private inspectSetup(
		parentSessionId: string,
		logicalAgentId: string,
		reference?: WorkerProjectContextReference,
	): PreparedSetup | undefined {
		const lifecycle = new WorkerLifecycle({ agentDir: this.agentDir, sessionId: parentSessionId });
		const snapshot = lifecycle.getTaskRuntimeSnapshot();
		const task = snapshot.tasks[logicalAgentId];
		if ((task && task.attemptIds.length !== 1) || (!task && reference)) return;
		const attempt = task ? snapshot.attempts[task.attemptIds[0]] : undefined;
		if (
			(task && !attempt) ||
			(attempt &&
				(attempt.lease ||
					attempt.agentId ||
					attempt.dispatch.executionKind === "managed-process" ||
					!["queued", "cancelled"].includes(attempt.status))) ||
			Object.values(snapshot.agents).some(
				(agent) =>
					agent.agentId === logicalAgentId ||
					(reference !== undefined &&
						(agent.resumeContext.sessionId === reference.resumeContext.sessionId ||
							agent.resumeContext.sessionFile === reference.resumeContext.sessionFile)),
			)
		)
			return;
		return { lifecycle, snapshot, attempt };
	}

	private cancelPreparedSetup({ lifecycle, snapshot, attempt }: PreparedSetup, reasonCode: string): void {
		if (!attempt) return;
		lifecycle.ledger.runtime.cancelAttempt(attempt.attemptId, reasonCode, {
			expectedLastOrdinal: snapshot.lastOrdinal,
			unleasedOnly: true,
		});
		// Reuse the canonical bounded terminal outbox; never replay abandoned instructions.
		lifecycle.getPendingTerminalNotifications();
	}
}
