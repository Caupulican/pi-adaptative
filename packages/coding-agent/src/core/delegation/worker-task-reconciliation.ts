/** Turns a logical worker's pending task-bearing mailbox messages into scheduled attempts, one message at a time in durable order, with bounded settlement and runtime-generation waits. */

import type { OrchestrationHome } from "../../kernel/session/session-bundle-paths.ts";
import type { TurnOriginRecord } from "../../kernel/turn-origin-stamp.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { AgentBindingContract } from "../orchestration/contracts.ts";
import { objectiveIsPaused } from "../orchestration/contracts.ts";
import type { SpecialistContextClaim } from "../orchestration/specialist-context-ownership.ts";
import type { AttemptRuntimeState } from "../orchestration/task-runtime.ts";
import { type RuntimeWorkLease, runtimeGenerationAdmission } from "../runtime-generation-admission.ts";
import type { WorkerAgentActivity, WorkerAgentMailbox, WorkerAgentMessage } from "./worker-agent-control.ts";
import type { WorkerControlTranscript } from "./worker-control-transcript.ts";
import { agentConversation, type WorkerConversationStore } from "./worker-conversation-store.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";
import type { WorkerDispatchScheduler } from "./worker-dispatch-scheduler.ts";
import type { WorkerLifecycle } from "./worker-lifecycle.ts";

export type TaskBearingReconciliation = {
	started: boolean;
	record?: LaneRecord;
	skipReason?: string;
};

interface WorkerTaskReconcilerOptions {
	readonly agentDir: string;
	readonly orchestrationHome: OrchestrationHome;
	getLifecycle(): WorkerLifecycle;
	scheduler: Pick<WorkerDispatchScheduler, "enqueue" | "drain">;
	recoveredRequest(attempt: AttemptRuntimeState): WorkerDelegationRequest;
	runsControlMessage?(messageId: string): boolean;
	isSpecialistSettled?(agentId: string): boolean;
	taskStartHeadroomSkipReason?(agent: AgentBindingContract): string | undefined;
	getCurrentSubmissionEpoch?(): number | undefined;
	noteAttemptOwnerEpoch?(attemptId: string, ownerEpoch: number): void;
	getConversationClaim?(agent: AgentBindingContract): SpecialistContextClaim | undefined;
	warn?(message: string): void;
}

interface WorkerTaskReconcilerPort {
	readonly options: WorkerTaskReconcilerOptions;
	readonly sessionRootAddress: string;
	readonly conversations: WorkerConversationStore;
	readonly transcript: WorkerControlTranscript;
	readonly reconcilingTaskBearingAgentIds: Set<string>;
	readonly taskBearingContinuationAgentIds: Set<string>;
	readonly runtimeWaiters: Map<string, () => void>;
	readonly isDisposed: () => boolean;
	readonly getMailbox: (agentId: string) => WorkerAgentMailbox;
	readonly activityForAgent: (agent: AgentBindingContract) => WorkerAgentActivity;
	readonly senderTurnOrigin: (senderAgentId: string | undefined, attemptId?: string) => TurnOriginRecord | undefined;
	readonly notifyStateChangedBestEffort: () => void;
	readonly acknowledgeDeliveredMailboxMessage: (agentId: string, messageId: string) => void;
	readonly beginWorkerReplyAcknowledgement: (target: AgentBindingContract, reply: WorkerAgentMessage) => unknown;
	readonly controlMessageAttempt: (agentId: string, message: WorkerAgentMessage) => AttemptRuntimeState | undefined;
	readonly cleanupPendingSkipReason: (agentId: string) => string;
	readonly reusableTaskAdmissionSkipReason: (agentId: string) => string | undefined;
}

/** Reconciles one agent's task-bearing mailbox; the coordinator owns the in-progress sets and the admission around it. */
export class WorkerTaskReconciler {
	private readonly options: WorkerTaskReconcilerOptions;
	private readonly sessionRootAddress: string;
	private readonly conversations: WorkerConversationStore;
	private readonly transcript: WorkerControlTranscript;
	private readonly reconcilingTaskBearingAgentIds: Set<string>;
	private readonly taskBearingContinuationAgentIds: Set<string>;
	private readonly runtimeWaiters: Map<string, () => void>;
	private readonly isDisposed: () => boolean;
	private readonly getMailbox: (agentId: string) => WorkerAgentMailbox;
	private readonly activityForAgent: (agent: AgentBindingContract) => WorkerAgentActivity;
	private readonly senderTurnOrigin: (
		senderAgentId: string | undefined,
		attemptId?: string,
	) => TurnOriginRecord | undefined;
	private readonly notifyStateChangedBestEffort: () => void;
	private readonly acknowledgeDeliveredMailboxMessage: (agentId: string, messageId: string) => void;
	private readonly beginWorkerReplyAcknowledgement: (
		target: AgentBindingContract,
		reply: WorkerAgentMessage,
	) => unknown;
	private readonly controlMessageAttempt: (
		agentId: string,
		message: WorkerAgentMessage,
	) => AttemptRuntimeState | undefined;
	private readonly cleanupPendingSkipReason: (agentId: string) => string;
	private readonly reusableTaskAdmissionSkipReason: (agentId: string) => string | undefined;

	constructor(port: WorkerTaskReconcilerPort) {
		this.options = port.options;
		this.sessionRootAddress = port.sessionRootAddress;
		this.conversations = port.conversations;
		this.transcript = port.transcript;
		this.reconcilingTaskBearingAgentIds = port.reconcilingTaskBearingAgentIds;
		this.taskBearingContinuationAgentIds = port.taskBearingContinuationAgentIds;
		this.runtimeWaiters = port.runtimeWaiters;
		this.isDisposed = port.isDisposed;
		this.getMailbox = port.getMailbox;
		this.activityForAgent = port.activityForAgent;
		this.senderTurnOrigin = port.senderTurnOrigin;
		this.notifyStateChangedBestEffort = port.notifyStateChangedBestEffort;
		this.acknowledgeDeliveredMailboxMessage = port.acknowledgeDeliveredMailboxMessage;
		this.beginWorkerReplyAcknowledgement = port.beginWorkerReplyAcknowledgement;
		this.controlMessageAttempt = port.controlMessageAttempt;
		this.cleanupPendingSkipReason = port.cleanupPendingSkipReason;
		this.reusableTaskAdmissionSkipReason = port.reusableTaskAdmissionSkipReason;
	}

	reconcileTaskBearingMailbox(
		agentId: string,
		expectedMessageId?: string,
		runtimeLease?: RuntimeWorkLease,
	): TaskBearingReconciliation {
		if (this.reconcilingTaskBearingAgentIds.has(agentId)) {
			return { started: false, skipReason: "worker_task_reconciliation_in_progress" };
		}
		this.reconcilingTaskBearingAgentIds.add(agentId);
		try {
			const agent = this.options.getLifecycle().getAgent(agentId);
			if (!agent) return { started: false, skipReason: "unknown_agent" };
			const mailbox = this.getMailbox(agentId);
			for (let settlement = 0; settlement < 64; settlement++) {
				const pending = mailbox.pendingTaskBearing();
				// The caller's own message is held while its delegation is paused; the messages behind it are not its concern.
				const expected =
					expectedMessageId === undefined ? undefined : pending.find((m) => m.messageId === expectedMessageId);
				if (expected && this.heldByPausedDelegation(expected))
					return { started: false, skipReason: "delegation_paused" };
				// A message filed under a paused delegation waits in place; the first message that is not held runs, so only the
				// order within one delegation is kept.
				const message = pending.find((candidate) => !this.heldByPausedDelegation(candidate));
				if (!message) return { started: false };
				if (this.options.runsControlMessage?.(message.messageId) === false)
					return { started: false, skipReason: "worker_agent_runs_in_parent" };
				if (this.reconcileTaskBearingTranscriptDelivery(agent, message)) {
					if (expectedMessageId === message.messageId) {
						return { started: false, skipReason: "worker_control_transcript_delivery_reconciled" };
					}
					continue;
				}
				this.beginWorkerReplyAcknowledgement(agent, message);
				const correlated = this.controlMessageAttempt(agent.agentId, message);
				if (correlated) {
					const scheduled = this.scheduleCorrelatedTaskBearingAttempt(correlated);
					if (scheduled.skipReason?.startsWith("worker_task_terminal_")) {
						const settled = this.settleTerminalTaskBearingMessage(
							agent,
							mailbox,
							message,
							scheduled,
							expectedMessageId,
						);
						if (settled) return settled;
						continue;
					}
					if (expectedMessageId && message.messageId !== expectedMessageId) {
						return { started: false, skipReason: "worker_task_waiting_for_older_message" };
					}
					return scheduled;
				}
				if (expectedMessageId && message.messageId !== expectedMessageId) {
					return { started: false, skipReason: "worker_task_waiting_for_older_message" };
				}
				const activity = this.activityForAgent(agent);
				if (activity !== "idle") return { started: false, skipReason: `worker_${activity}` };
				if (this.options.isSpecialistSettled?.(agent.agentId) === false) {
					// The pending turn stays pending: reconciliation runs again when the execution that
					// still owns this context signals its state change after disposal.
					return { started: false, skipReason: this.cleanupPendingSkipReason(agent.agentId) };
				}
				if (agent.status !== "registered") {
					const settled = this.settleTerminalTaskBearingMessage(
						agent,
						mailbox,
						message,
						{ started: false, skipReason: `agent_${agent.status}` },
						expectedMessageId,
					);
					if (settled) return settled;
					continue;
				}
				if (this.isDisposed()) return { started: false, skipReason: "worker_control_disposed" };
				const reader =
					runtimeLease ??
					runtimeGenerationAdmission(this.options.agentDir).tryAdmitWork({
						kind: "worker-control",
						label: agentId,
					});
				if (!reader) {
					this.waitForRuntimeGeneration(agentId);
					return { started: false, skipReason: "runtime_generation_replacement" };
				}
				try {
					reader.assertCurrent();
					const reuseSkipReason =
						this.options.taskStartHeadroomSkipReason?.(agent) ??
						this.reusableTaskAdmissionSkipReason(agent.agentId);
					if (reuseSkipReason) {
						this.transcript.reconcileControlTranscript(agent, message, true);
						this.acknowledgeDeliveredMailboxMessage(agent.agentId, message.messageId);
						const settlement = {
							started: false,
							skipReason: `${reuseSkipReason}:transcript_fallback_delivered`,
						};
						if (expectedMessageId === message.messageId) return settlement;
						continue;
					}
					try {
						this.enableAttemptAccountingForNextTask(agent);
						const newTask = message.task?.kind === "agent_turn" ? message.task.newTask : undefined;
						// A sender that carried a third party's words passes them on in what it sends: the message names them
						// since it was written; one written before it did is read from the worker sender's latest attempt.
						const sender =
							message.senderAgentId && message.senderAgentId !== this.sessionRootAddress
								? this.options.getLifecycle().getAgent(message.senderAgentId)
								: undefined;
						const senderOrigin =
							message.turnOrigin ?? (sender ? this.senderTurnOrigin(sender.agentId) : undefined);
						const prepared = this.options.getLifecycle().prepareAgentTurn({
							agentId: agent.agentId,
							instructions: message.content,
							controlMessageId: message.messageId,
							...(message.receiptOrigin ? { receiptOrigin: message.receiptOrigin } : {}),
							...(senderOrigin?.thirdParty ? { turnOrigin: senderOrigin } : {}),
							// Who started the turn, and the delegation its words belong to: both are read back from the mailbox.
							...(message.senderAgentId && message.senderAgentId !== this.sessionRootAddress
								? { senderAgentId: message.senderAgentId }
								: {}),
							...(message.delegationObjectiveId ? { delegationObjectiveId: message.delegationObjectiveId } : {}),
							...(message.task?.kind === "agent_turn" && message.task.dependsOnTaskIds
								? { dependsOnTaskIds: message.task.dependsOnTaskIds }
								: {}),
							// The persisted declaration of new work, read back from the mailbox: the process that
							// enqueued it may be long gone, and no caller repeats it after a restart.
							...(newTask
								? {
										...(newTask.goalId ? { goalId: newTask.goalId } : {}),
										...(newTask.controlForkMode ? { controlForkMode: newTask.controlForkMode } : {}),
										...(newTask.knowledgeReferences
											? { knowledgeReferences: newTask.knowledgeReferences }
											: {}),
										...(newTask.subscriptions ? { subscriptions: newTask.subscriptions } : {}),
										taskContext: {
											...(newTask.requirementIds ? { requirementIds: newTask.requirementIds } : {}),
											...(newTask.acceptanceCriterionIds
												? { acceptanceCriterionIds: newTask.acceptanceCriterionIds }
												: {}),
											...(newTask.resourcePointerIds
												? { resourcePointerIds: newTask.resourcePointerIds }
												: {}),
										},
									}
								: {}),
						});
						// `created` is the ledger's own decision, not a reconstruction of it -- a replayed
						// control message (e.g. a mailbox message redelivered after a resume) returns an
						// attempt that may predate the current process, and must never be re-stamped with
						// this process's epoch.
						if (prepared.created) {
							const ownerEpoch = this.options.getCurrentSubmissionEpoch?.();
							if (ownerEpoch !== undefined)
								this.options.noteAttemptOwnerEpoch?.(prepared.attempt.attemptId, ownerEpoch);
						}
						return this.scheduleTaskBearingAttempt(prepared.record, prepared.attempt);
					} catch (error) {
						const recovered = this.controlMessageAttempt(agent.agentId, message);
						if (recovered) {
							const scheduled = this.scheduleCorrelatedTaskBearingAttempt(recovered);
							if (scheduled.skipReason?.startsWith("worker_task_terminal_")) {
								const settled = this.settleTerminalTaskBearingMessage(
									agent,
									mailbox,
									message,
									scheduled,
									expectedMessageId,
								);
								if (settled) return settled;
								continue;
							}
							return {
								...scheduled,
								...(scheduled.skipReason
									? {}
									: { skipReason: "worker_task_recovered_after_prepare_interruption" }),
							};
						}
						return { started: false, skipReason: error instanceof Error ? error.message : String(error) };
					}
				} finally {
					if (!runtimeLease) reader.release();
				}
			}
			this.scheduleTaskBearingReconciliationContinuation(agentId);
			return { started: false, skipReason: "worker_task_reconciliation_bound_reached" };
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			try {
				this.options.warn?.(`Worker task-bearing mailbox reconciliation failed for ${agentId}: ${reason}`);
			} catch {
				// Diagnostics are observers; the pending mailbox remains the recovery source of truth.
			}
			return { started: false, skipReason: reason };
		} finally {
			this.reconcilingTaskBearingAgentIds.delete(agentId);
		}
	}

	private waitForRuntimeGeneration(agentId: string): void {
		if (this.isDisposed() || this.runtimeWaiters.has(agentId)) return;
		const admission = runtimeGenerationAdmission(this.options.agentDir);
		const unsubscribe = admission.subscribeAvailability(() => {
			if (admission.isReplacing || this.isDisposed()) return;
			unsubscribe();
			this.runtimeWaiters.delete(agentId);
			this.reconcileTaskBearingMailbox(agentId);
			this.notifyStateChangedBestEffort();
		});
		this.runtimeWaiters.set(agentId, unsubscribe);
	}

	private scheduleTaskBearingReconciliationContinuation(agentId: string): void {
		if (this.taskBearingContinuationAgentIds.has(agentId)) return;
		this.taskBearingContinuationAgentIds.add(agentId);
		queueMicrotask(() => {
			this.taskBearingContinuationAgentIds.delete(agentId);
			this.reconcileTaskBearingMailbox(agentId);
		});
	}

	reconcileTaskBearingTranscriptDelivery(target: AgentBindingContract, message: WorkerAgentMessage): boolean {
		if (!this.transcript.reconcileControlTranscript(target, message, false).delivered) return false;
		this.acknowledgeDeliveredMailboxMessage(target.agentId, message.messageId);
		return true;
	}

	private settleTerminalTaskBearingMessage(
		agent: AgentBindingContract,
		mailbox: WorkerAgentMailbox,
		message: WorkerAgentMessage,
		scheduled: TaskBearingReconciliation,
		expectedMessageId?: string,
	): TaskBearingReconciliation | undefined {
		const returnSettlement = expectedMessageId === message.messageId;
		if (scheduled.skipReason && mailbox.deadLetterOrdinaryTask(message.messageId, scheduled.skipReason)) {
			return returnSettlement ? scheduled : undefined;
		}
		const retained = mailbox.getMessage(message.messageId);
		if (!retained || retained.deliveredAt !== undefined || retained.failedAt !== undefined) {
			return returnSettlement ? scheduled : undefined;
		}
		const activity = this.activityForAgent(agent);
		if (activity !== "idle") {
			return { ...scheduled, skipReason: `worker_${activity}:transcript_fallback_waiting` };
		}
		this.transcript.reconcileControlTranscript(agent, retained, true);
		this.acknowledgeDeliveredMailboxMessage(agent.agentId, retained.messageId);
		const settlement = {
			...scheduled,
			skipReason: `${scheduled.skipReason ?? "worker_task_terminal"}:transcript_fallback_delivered`,
		};
		return returnSettlement ? settlement : undefined;
	}

	private scheduleCorrelatedTaskBearingAttempt(attempt: AttemptRuntimeState): TaskBearingReconciliation {
		const record = this.options.getLifecycle().getRecord(attempt.taskId);
		if (!record) return { started: false, skipReason: "orchestration_projection_missing" };
		if (attempt.status === "queued") return this.scheduleTaskBearingAttempt(record, attempt);
		if (attempt.status === "leased" || attempt.status === "running" || attempt.status === "suspended") {
			return { started: true, record };
		}
		return { started: false, record, skipReason: `worker_task_terminal_${attempt.status}` };
	}

	private scheduleTaskBearingAttempt(record: LaneRecord, attempt: AttemptRuntimeState): TaskBearingReconciliation {
		try {
			this.options.scheduler.enqueue(record, this.options.recoveredRequest(attempt));
		} catch (error) {
			return {
				started: false,
				record,
				skipReason: error instanceof Error ? error.message : String(error),
			};
		}
		try {
			this.options.scheduler.drain();
			return { started: true, record };
		} catch (error) {
			return {
				started: true,
				record,
				skipReason: `worker_task_recovery_pending:${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	private enableAttemptAccountingForNextTask(agent: AgentBindingContract): void {
		if (!agent.resumeContext.sessionFile) return;
		this.conversations
			.open({
				...agentConversation(this.options, agent),
				projectClaim: this.options.getConversationClaim?.(agent),
			})
			.enableAttemptUsageBoundaries();
	}

	/** Whether a message is held: filed under a delegation that is paused, so it runs only once that delegation resumes. */
	private heldByPausedDelegation(message: WorkerAgentMessage): boolean {
		if (message.delegationObjectiveId === undefined) return false;
		const objective = this.options.getLifecycle().getTaskRuntimeSnapshot().objectives[message.delegationObjectiveId];
		return objectiveIsPaused(objective?.objective);
	}
}
