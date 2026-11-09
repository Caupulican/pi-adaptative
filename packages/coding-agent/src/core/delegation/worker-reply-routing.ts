/** Routes a worker's reply to its requester, another worker or the session root: source-side acknowledgement reservations, the delivery of each reply, and the reconciliation that settles a reply left half-routed. */

import type { TurnOriginRecord } from "../../kernel/turn-origin-stamp.ts";
import type { AgentBindingContract } from "../orchestration/contracts.ts";
import { recordDiscardedObligations } from "./obligation-ledger.ts";
import { type SessionRootMailbox, type SessionRootReply, sessionRootReplyMessageId } from "./session-root-mailbox.ts";
import {
	type WorkerAgentActivity,
	type WorkerAgentMailbox,
	type WorkerAgentMessage,
	type WorkerAgentReplyResult,
	WorkerControlDeadLetteredError,
	workerAgentMessageId,
} from "./worker-agent-control.ts";
import type { MandatoryTranscriptControlInput, WorkerControlTranscript } from "./worker-control-transcript.ts";
import type { WorkerLifecycle } from "./worker-lifecycle.ts";
import type { TaskBearingReconciliation } from "./worker-task-reconciliation.ts";

export type QueuedPeerMessage = ReturnType<WorkerAgentMailbox["enqueueWithReceipt"]>;

interface WorkerReplyRoutingOptions {
	readonly agentDir: string;
	readonly parentSessionId: string;
	getLifecycle(): WorkerLifecycle;
	warn?(message: string): void;
	runsControlMessage?(messageId: string): boolean;
}

interface WorkerReplyRoutingPort {
	readonly options: WorkerReplyRoutingOptions;
	readonly sessionRootAddress: string;
	readonly sessionRootMailbox: SessionRootMailbox;
	readonly sessionRootReconciliationFailures: Map<string, string>;
	readonly workerReplyReconciliationFailures: Map<string, string>;
	readonly transcript: WorkerControlTranscript;
	readonly getMailbox: (agentId: string) => WorkerAgentMailbox;
	readonly requireKnownAgent: (agentId: string) => AgentBindingContract;
	readonly activityForAgent: (agent: AgentBindingContract) => WorkerAgentActivity;
	readonly senderTurnOrigin: (senderAgentId: string | undefined, attemptId?: string) => TurnOriginRecord | undefined;
	readonly assertIdempotencyTarget: (targetAgentId: string, idempotencyKey: string) => void;
	readonly notifyStateChangedBestEffort: () => void;
	readonly reconcileTaskBearingMailbox: (agentId: string, expectedMessageId?: string) => TaskBearingReconciliation;
	readonly replyReconciliationAgents: () => AgentBindingContract[];
}

/** Routes worker replies and reconciles their source-side acknowledgements; the coordinator owns the maps and admission it passes in. */
export class WorkerReplyRouting {
	private readonly options: WorkerReplyRoutingOptions;
	private readonly sessionRootAddress: string;
	private readonly sessionRootMailbox: SessionRootMailbox;
	private readonly sessionRootReconciliationFailures: Map<string, string>;
	private readonly workerReplyReconciliationFailures: Map<string, string>;
	private readonly transcript: WorkerControlTranscript;
	private readonly getMailbox: (agentId: string) => WorkerAgentMailbox;
	private readonly requireKnownAgent: (agentId: string) => AgentBindingContract;
	private readonly activityForAgent: (agent: AgentBindingContract) => WorkerAgentActivity;
	private readonly senderTurnOrigin: (
		senderAgentId: string | undefined,
		attemptId?: string,
	) => TurnOriginRecord | undefined;
	private readonly assertIdempotencyTarget: (targetAgentId: string, idempotencyKey: string) => void;
	private readonly notifyStateChangedBestEffort: () => void;
	private readonly reconcileTaskBearingMailbox: (
		agentId: string,
		expectedMessageId?: string,
	) => TaskBearingReconciliation;
	private readonly replyReconciliationAgents: () => AgentBindingContract[];

	constructor(port: WorkerReplyRoutingPort) {
		this.options = port.options;
		this.sessionRootAddress = port.sessionRootAddress;
		this.sessionRootMailbox = port.sessionRootMailbox;
		this.sessionRootReconciliationFailures = port.sessionRootReconciliationFailures;
		this.workerReplyReconciliationFailures = port.workerReplyReconciliationFailures;
		this.transcript = port.transcript;
		this.getMailbox = port.getMailbox;
		this.requireKnownAgent = port.requireKnownAgent;
		this.activityForAgent = port.activityForAgent;
		this.senderTurnOrigin = port.senderTurnOrigin;
		this.assertIdempotencyTarget = port.assertIdempotencyTarget;
		this.notifyStateChangedBestEffort = port.notifyStateChangedBestEffort;
		this.reconcileTaskBearingMailbox = port.reconcileTaskBearingMailbox;
		this.replyReconciliationAgents = port.replyReconciliationAgents;
	}

	routeWorkerReplyToAgent(
		target: AgentBindingContract,
		sourceAgentId: string,
		request: WorkerAgentMessage,
		message: string,
	): WorkerAgentReplyResult {
		const activity = this.activityForAgent(target);
		const idempotencyKey = `peer-reply:${sourceAgentId}:${request.messageId}`;
		this.assertIdempotencyTarget(target.agentId, idempotencyKey);
		const replyMessageId = workerAgentMessageId(this.options.parentSessionId, idempotencyKey);
		const sourceMailbox = this.getMailbox(sourceAgentId);
		const reservationAlreadyActive = sourceMailbox.getReplyAcknowledgementId(request.messageId) === replyMessageId;
		if (!sourceMailbox.beginReplyAcknowledgement(request.messageId, replyMessageId, message)) {
			throw new Error("Worker reply source acknowledgement could not be acquired.");
		}
		const transcriptInput: MandatoryTranscriptControlInput = {
			idempotencyKey,
			content: message,
			senderAgentId: sourceAgentId,
			replyToMessageId: request.messageId,
			...(request.threadId ? { threadId: request.threadId } : {}),
			task: { kind: "agent_turn" },
		};
		const transcriptReplay = this.transcript.reconcileMandatoryControlTranscript(target, transcriptInput, false);
		if (transcriptReplay.delivered) {
			if (
				!sourceMailbox.commitReplyAcknowledgement(request.messageId, replyMessageId) &&
				sourceMailbox.getReplyAcknowledgementId(request.messageId) !== undefined
			) {
				throw new Error("Worker reply source acknowledgement did not commit after transcript replay.");
			}
			this.notifyStateChangedBestEffort();
			return {
				destination: "worker",
				messageId: replyMessageId,
				started: false,
				steering: false,
				skipReason: "worker_reply_already_accepted",
			};
		}
		if (target.status === "retired") {
			this.transcript.deliverMandatoryControlToRetiredTranscript(target, transcriptInput);
			if (
				!sourceMailbox.commitReplyAcknowledgement(request.messageId, replyMessageId) &&
				sourceMailbox.getReplyAcknowledgementId(request.messageId) !== undefined
			) {
				throw new Error("Worker reply source acknowledgement did not commit after retired-target delivery.");
			}
			this.notifyStateChangedBestEffort();
			return {
				destination: "worker",
				messageId: replyMessageId,
				started: false,
				steering: false,
				skipReason: "worker_reply_retired_target_transcript_delivery",
			};
		}
		const targetMailbox = this.getMailbox(target.agentId);
		const turnOrigin = this.senderTurnOrigin(sourceAgentId);
		let queued: QueuedPeerMessage;
		try {
			queued = targetMailbox.enqueueWithReceipt({
				kind: activity === "active" ? "steer" : "follow_up",
				content: message,
				senderAgentId: sourceAgentId,
				replyToMessageId: request.messageId,
				...(request.receiptOrigin ? { receiptOrigin: request.receiptOrigin } : {}),
				...(turnOrigin ? { turnOrigin } : {}),
				...(request.threadId ? { threadId: request.threadId } : {}),
				idempotencyKey,
				task: { kind: "agent_turn" },
			});
		} catch (error) {
			if (!reservationAlreadyActive) {
				this.rollbackReplyReservationAfterTargetRejection(sourceMailbox, request.messageId, replyMessageId, error);
			}
			throw error;
		}
		if (queued.messageId !== replyMessageId) {
			throw new Error("Worker reply target returned a divergent deterministic message identity.");
		}
		if (
			queued.status === "retained" &&
			queued.message.failedAt !== undefined &&
			queued.message.deliveredAt === undefined
		) {
			this.abandonDeadLetteredReply(
				sourceAgentId,
				sourceMailbox,
				request,
				replyMessageId,
				new WorkerControlDeadLetteredError(queued.messageId, queued.message.failureReason),
			);
		}
		if (queued.status === "completed_replay") {
			if (!targetMailbox.hasDeliveredControlReceipt(queued.messageId)) {
				throw new Error("Worker reply target replay has no durable delivery evidence.");
			}
			if (
				!sourceMailbox.commitReplyAcknowledgement(request.messageId, queued.messageId) &&
				sourceMailbox.getReplyAcknowledgementId(request.messageId) !== undefined
			) {
				throw new Error("Worker reply source acknowledgement did not commit after target replay.");
			}
			this.notifyStateChangedBestEffort();
			return {
				destination: "worker",
				messageId: queued.messageId,
				started: false,
				steering: false,
				skipReason: "worker_reply_already_accepted",
			};
		}
		this.beginWorkerReplyAcknowledgement(target, queued.message);
		if (queued.message.deliveredAt !== undefined) {
			if (
				!this.reconcileCompletedWorkerReplyAcknowledgement(
					sourceMailbox,
					request.messageId,
					target.agentId,
					queued.messageId,
				) &&
				sourceMailbox.getReplyAcknowledgementId(request.messageId) !== undefined
			) {
				throw new Error("Worker reply source acknowledgement did not commit after target delivery.");
			}
			this.notifyStateChangedBestEffort();
			return {
				destination: "worker",
				messageId: queued.messageId,
				started: false,
				steering: false,
				skipReason: "worker_reply_already_accepted",
			};
		}
		if (activity === "active") {
			this.notifyStateChangedBestEffort();
			if (!queued.created) {
				return {
					destination: "worker",
					messageId: queued.messageId,
					started: false,
					steering: false,
					skipReason: "worker_reply_already_accepted",
				};
			}
			return {
				destination: "worker",
				messageId: queued.messageId,
				started: false,
				steering: true,
			};
		}
		const reconciliation = this.reconcileTaskBearingMailbox(target.agentId, queued.messageId);
		this.notifyStateChangedBestEffort();
		return {
			destination: "worker",
			messageId: queued.messageId,
			started: reconciliation.started,
			steering: false,
			...(reconciliation.record ? { record: reconciliation.record } : {}),
			...(reconciliation.skipReason ? { skipReason: reconciliation.skipReason } : {}),
		};
	}

	routeWorkerReplyToSessionRoot(
		source: AgentBindingContract,
		sourceMailbox: WorkerAgentMailbox,
		request: WorkerAgentMessage,
		message: string,
	): WorkerAgentReplyResult {
		const replyMessageId = sessionRootReplyMessageId(this.options.parentSessionId, source.agentId, request.messageId);
		const reservationAlreadyActive = sourceMailbox.getReplyAcknowledgementId(request.messageId) === replyMessageId;
		const replyInput = {
			sourceAgentId: source.agentId,
			requestMessageId: request.messageId,
			...(request.threadId ? { threadId: request.threadId } : {}),
			content: message,
		};
		try {
			this.sessionRootMailbox.assertReplyInput(replyInput);
		} catch (error) {
			if (reservationAlreadyActive) {
				this.rollbackReplyReservationAfterTargetRejection(sourceMailbox, request.messageId, replyMessageId, error);
			}
			throw error;
		}
		if (!sourceMailbox.beginReplyAcknowledgement(request.messageId, replyMessageId, message)) {
			throw new Error("Session root reply source acknowledgement could not be acquired.");
		}
		let accepted: ReturnType<SessionRootMailbox["enqueueReply"]>;
		try {
			accepted = this.sessionRootMailbox.enqueueSourceOwnedReply(replyInput);
		} catch (error) {
			if (!reservationAlreadyActive) {
				this.rollbackReplyReservationAfterTargetRejection(sourceMailbox, request.messageId, replyMessageId, error);
			}
			throw error;
		}
		if (accepted.messageId !== replyMessageId) {
			throw new Error("Session root reply target returned a divergent deterministic message identity.");
		}
		if (accepted.status === "completed_replay") {
			if (
				!sourceMailbox.commitReplyAcknowledgement(request.messageId, accepted.messageId) &&
				sourceMailbox.getReplyAcknowledgementId(request.messageId) !== undefined
			) {
				throw new Error("Session root reply source acknowledgement did not commit after target replay.");
			}
			this.releaseSessionRootSourceReceiptBestEffort(accepted.messageId);
		} else {
			this.reconcileSessionRootReply(accepted.reply);
		}
		this.notifyStateChangedBestEffort();
		return { destination: "session_root", messageId: accepted.messageId };
	}

	private rollbackReplyReservationAfterTargetRejection(
		sourceMailbox: WorkerAgentMailbox,
		requestMessageId: string,
		replyMessageId: string,
		targetError: unknown,
	): never {
		try {
			if (
				!sourceMailbox.rollbackReplyAcknowledgement(requestMessageId, replyMessageId) &&
				sourceMailbox.getReplyAcknowledgementId(requestMessageId) === replyMessageId
			) {
				throw new Error("Worker reply source reservation did not roll back after target rejection.");
			}
		} catch (rollbackError) {
			throw new AggregateError(
				[targetError, rollbackError],
				"Worker reply target rejected after its source reservation could not be rolled back.",
			);
		}
		throw targetError;
	}

	reconcileSessionRootReplies(): void {
		let replies: SessionRootReply[];
		try {
			replies = this.sessionRootMailbox.retainedReplies();
			this.sessionRootReconciliationFailures.delete("session-root-mailbox");
		} catch (error) {
			this.recordSessionRootReconciliationFailure(
				"session-root-mailbox",
				error instanceof Error ? error.message : String(error),
			);
			return;
		}
		for (const reply of replies) {
			if (this.options.runsControlMessage?.(reply.requestMessageId) === false) continue;
			this.reconcileSessionRootReply(reply);
		}
	}

	private reconcileSessionRootReply(reply: SessionRootReply): void {
		try {
			const source = this.options.getLifecycle().getAgent(reply.sourceAgentId);
			if (!source) {
				if (reply.sourceReconciledAt) {
					this.sessionRootReconciliationFailures.delete(reply.messageId);
					return;
				}
				throw new Error(`Unknown logical worker agent '${reply.sourceAgentId}'.`);
			}
			const sourceMailbox = this.getMailbox(source.agentId);
			const request = sourceMailbox.getMessage(reply.requestMessageId);
			if (!request) {
				if (reply.sourceReconciledAt) {
					this.releaseSessionRootSourceReceiptBestEffort(reply.messageId);
					this.sessionRootReconciliationFailures.delete(reply.messageId);
					return;
				}
				throw new Error("Session root reply source request is missing before reconciliation.");
			}
			if (
				request.deliveredAt === undefined ||
				request.expectReply !== true ||
				request.senderAgentId !== this.sessionRootAddress ||
				request.threadId !== reply.threadId
			) {
				throw new Error("Session root reply source request conflicts with its durable target.");
			}
			let acknowledgementId = sourceMailbox.getReplyAcknowledgementId(request.messageId);
			if (acknowledgementId && acknowledgementId !== reply.messageId) {
				throw new Error("Session root reply source request has a divergent acknowledgement marker.");
			}
			if (request.repliedAt !== undefined && acknowledgementId === undefined) {
				if (!reply.sourceReconciledAt) {
					throw new Error(
						"Session root reply source was marked replied without its exact acknowledgement marker.",
					);
				}
				this.releaseSessionRootSourceReceiptBestEffort(reply.messageId);
				this.sessionRootReconciliationFailures.delete(reply.messageId);
				return;
			}
			if (request.repliedAt === undefined) {
				if (!sourceMailbox.beginReplyAcknowledgement(request.messageId, reply.messageId, reply.content)) {
					throw new Error("Session root reply source acknowledgement could not be acquired.");
				}
				acknowledgementId = reply.messageId;
			}
			if (!this.sessionRootMailbox.markSourceReconciled(reply.messageId)) {
				throw new Error("Session root reply disappeared during source reconciliation.");
			}
			if (acknowledgementId === reply.messageId) {
				if (!sourceMailbox.commitReplyAcknowledgement(request.messageId, reply.messageId)) {
					const remaining = sourceMailbox.getReplyAcknowledgementId(request.messageId);
					if (remaining !== undefined) {
						throw new Error("Session root reply source acknowledgement did not commit.");
					}
				}
			}
			this.releaseSessionRootSourceReceiptBestEffort(reply.messageId);
			this.sessionRootReconciliationFailures.delete(reply.messageId);
		} catch (error) {
			this.recordSessionRootReconciliationFailure(
				reply.messageId,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	private recordSessionRootReconciliationFailure(messageId: string, reason: string): void {
		if (this.sessionRootReconciliationFailures.get(messageId) === reason) return;
		if (
			!this.sessionRootReconciliationFailures.has(messageId) &&
			this.sessionRootReconciliationFailures.size >= 128
		) {
			const oldest = this.sessionRootReconciliationFailures.keys().next().value;
			if (oldest) this.sessionRootReconciliationFailures.delete(oldest);
		}
		this.sessionRootReconciliationFailures.set(messageId, reason);
		try {
			this.options.warn?.(`Session root reply reconciliation failed for ${messageId}: ${reason}`);
		} catch {
			// Diagnostics are bounded observers; durable mailboxes remain authoritative.
		}
	}

	private releaseSessionRootSourceReceiptBestEffort(messageId: string): void {
		try {
			this.sessionRootMailbox.releaseSourceReplayReceipt(messageId);
			this.sessionRootReconciliationFailures.delete(`receipt:${messageId}`);
		} catch (error) {
			this.recordSessionRootReconciliationFailure(
				`receipt:${messageId}`,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	reconcileWorkerReplyOutboxes(agents: readonly AgentBindingContract[]): void {
		for (const agent of agents) this.reconcileWorkerReplyAcknowledgements(agent);
	}

	reconcileWorkerReplyOutboxesBestEffort(): void {
		try {
			this.reconcileWorkerReplyOutboxes(this.replyReconciliationAgents());
			this.workerReplyReconciliationFailures.delete("worker-reply-outbox-snapshot");
		} catch (error) {
			this.recordWorkerReplyReconciliationFailure(
				"worker-reply-outbox-snapshot",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	private reconcileWorkerReplyAcknowledgements(source: AgentBindingContract): void {
		const sourceMailbox = this.getMailbox(source.agentId);
		let acknowledgements: ReturnType<WorkerAgentMailbox["listReplyAcknowledgements"]>;
		try {
			acknowledgements = sourceMailbox.listReplyAcknowledgements();
			this.workerReplyReconciliationFailures.delete(`source:${source.agentId}`);
		} catch (error) {
			this.recordWorkerReplyReconciliationFailure(
				`source:${source.agentId}`,
				error instanceof Error ? error.message : String(error),
			);
			return;
		}
		for (const acknowledgement of acknowledgements) {
			if (this.options.runsControlMessage?.(acknowledgement.messageId) === false) continue;
			const failureKey = `reply:${source.agentId}:${acknowledgement.messageId}`;
			try {
				const request = sourceMailbox.getMessage(acknowledgement.messageId);
				if (!request?.senderAgentId) {
					throw new Error("Worker reply acknowledgement source request is missing routing metadata.");
				}
				if (request.senderAgentId === this.sessionRootAddress) {
					this.routeWorkerReplyToSessionRoot(source, sourceMailbox, request, acknowledgement.replyContent);
					this.workerReplyReconciliationFailures.delete(failureKey);
					continue;
				}
				const target = this.requireKnownAgent(request.senderAgentId);
				this.routeWorkerReplyToAgent(target, source.agentId, request, acknowledgement.replyContent);
				this.workerReplyReconciliationFailures.delete(failureKey);
			} catch (error) {
				if (error instanceof WorkerControlDeadLetteredError) {
					// Already settled at the routing step; the obligation is closed, not a recurring failure.
					this.workerReplyReconciliationFailures.delete(failureKey);
					continue;
				}
				this.recordWorkerReplyReconciliationFailure(
					failureKey,
					error instanceof Error ? error.message : String(error),
				);
			}
		}
	}

	/**
	 * A reply whose target copy was dead-lettered can never be delivered, and answering the request again
	 * would hit the same failed identity. Settle the source request as failed (`reply_dead_lettered`),
	 * terminal and attributed in the obligation ledger, never replied or acknowledged, then report it to
	 * the replier. An unwritable ledger never keeps the obligation open: the discard proceeds with a warning.
	 */
	private abandonDeadLetteredReply(
		sourceAgentId: string,
		sourceMailbox: WorkerAgentMailbox,
		request: WorkerAgentMessage,
		replyMessageId: string,
		cause: WorkerControlDeadLetteredError,
	): never {
		sourceMailbox.abandonReplyAcknowledgement(request.messageId, replyMessageId, "reply_dead_lettered", (settled) => {
			try {
				recordDiscardedObligations({
					agentDir: this.options.agentDir,
					parentSessionId: this.options.parentSessionId,
					kind: "reply_dead_lettered",
					agentId: sourceAgentId,
					reason: "reply_dead_lettered",
					settled: [settled],
				});
			} catch (error) {
				this.options.warn?.(
					`Reply ${replyMessageId} from ${sourceAgentId} was dead-lettered at its target; the obligation ledger could not be written: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
		this.notifyStateChangedBestEffort();
		throw cause;
	}

	private recordWorkerReplyReconciliationFailure(failureKey: string, reason: string): void {
		if (this.workerReplyReconciliationFailures.get(failureKey) === reason) return;
		if (
			!this.workerReplyReconciliationFailures.has(failureKey) &&
			this.workerReplyReconciliationFailures.size >= 128
		) {
			const oldest = this.workerReplyReconciliationFailures.keys().next().value;
			if (oldest) this.workerReplyReconciliationFailures.delete(oldest);
		}
		this.workerReplyReconciliationFailures.set(failureKey, reason);
		try {
			this.options.warn?.(`Worker reply acknowledgement recovery failed for ${failureKey}: ${reason}`);
		} catch {
			// Diagnostics are bounded observers; durable acknowledgement evidence remains authoritative.
		}
	}

	reconcileCompletedWorkerReplyAcknowledgement(
		sourceMailbox: WorkerAgentMailbox,
		requestMessageId: string,
		targetAgentId: string,
		replyMessageId: string,
	): boolean {
		if (sourceMailbox.getReplyAcknowledgementId(requestMessageId) !== replyMessageId) return false;
		if (!this.getMailbox(targetAgentId).hasDeliveredControlReceipt(replyMessageId)) return false;
		return sourceMailbox.commitReplyAcknowledgement(requestMessageId, replyMessageId);
	}

	beginWorkerReplyAcknowledgement(
		target: AgentBindingContract,
		reply: WorkerAgentMessage,
		allowCommittedSource = false,
	): WorkerAgentMailbox | undefined {
		if (reply.replyToMessageId === undefined) return undefined;
		if (!reply.senderAgentId) throw new Error("Worker reply routing metadata is incomplete.");
		const source = this.requireKnownAgent(reply.senderAgentId);
		const sourceMailbox = this.getMailbox(source.agentId);
		const request = sourceMailbox.getMessage(reply.replyToMessageId);
		if (request?.expectReply !== true || request.deliveredAt === undefined) {
			throw new Error("Worker reply does not reference a delivered reply-expected message.");
		}
		if (request.senderAgentId !== target.agentId) {
			throw new Error("Worker reply target does not match the original requester.");
		}
		if (request.threadId !== reply.threadId) {
			throw new Error("Worker reply thread conflicts with the original request.");
		}
		const activeAcknowledgementId = sourceMailbox.getReplyAcknowledgementId(request.messageId);
		if (activeAcknowledgementId && activeAcknowledgementId !== reply.messageId) {
			throw new Error("Worker reply acknowledgement identity conflicts with an active transaction.");
		}
		if (request.repliedAt !== undefined && activeAcknowledgementId === undefined) {
			if (allowCommittedSource || reply.deliveredAt !== undefined) return sourceMailbox;
			throw new Error("Worker reply source was marked replied without its exact acknowledgement marker.");
		}
		if (!sourceMailbox.beginReplyAcknowledgement(request.messageId, reply.messageId, reply.content)) {
			throw new Error("Worker reply source acknowledgement could not be acquired.");
		}
		return sourceMailbox;
	}
}
