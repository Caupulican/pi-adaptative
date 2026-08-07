import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { UserMessage } from "@caupulican/pi-ai";
import type { WorkerDelegationRunOutcome } from "../agent-session-contracts.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { AgentBindingContract } from "../orchestration/contracts.ts";
import type { AttemptRuntimeState } from "../orchestration/task-runtime.ts";
import {
	SessionRootMailbox,
	type SessionRootReply,
	type SessionRootReplyQuery,
	type SessionRootReplyWaitOptions,
	type SessionRootReplyWaitResult,
	sessionRootAddress,
	sessionRootReplyMessageId,
} from "./session-root-mailbox.ts";
import {
	type SessionRootWorkerAgentMessageOptions,
	type WorkerAgentActivity,
	type WorkerAgentControlPort,
	type WorkerAgentControlScope,
	WorkerAgentMailbox,
	type WorkerAgentMessage,
	type WorkerAgentMessageOptions,
	type WorkerAgentReplyResult,
	type WorkerAgentTaskMetadata,
	type WorkerAgentTaskStartOptions,
	type WorkerAgentTranscriptOptions,
	workerAgentMessageId,
} from "./worker-agent-control.ts";
import { type WorkerConversation, WorkerConversationStore } from "./worker-conversation-store.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";
import type { WorkerDispatchScheduler } from "./worker-dispatch-scheduler.ts";
import type { WorkerLifecycle } from "./worker-lifecycle.ts";

export interface WorkerAgentControlCoordinatorOptions {
	agentDir: string;
	parentSessionId: string;
	processOwnerId: string;
	isControlAvailable(): boolean;
	getLifecycle(): WorkerLifecycle;
	recoveredRequest(attempt: AttemptRuntimeState): WorkerDelegationRequest;
	run(request: WorkerDelegationRequest, record: LaneRecord): Promise<WorkerDelegationRunOutcome>;
	scheduler: Pick<WorkerDispatchScheduler, "enqueue" | "track" | "drain" | "dropQueued">;
	statusChanged(): void;
	abortLane(laneId: string, reasonCode: string): void;
	cancelLane(laneId: string, reasonCode: string): LaneRecord | undefined;
	yieldCapacity?(callerAgentId: string, targetAgentId: string): () => void;
	warn?(message: string): void;
}

type QueuedPeerMessage = ReturnType<WorkerAgentMailbox["enqueueWithReceipt"]>;

type TaskBearingReconciliation = {
	started: boolean;
	record?: LaneRecord;
	skipReason?: string;
};

type MandatoryTranscriptControlInput = {
	idempotencyKey: string;
	content: string;
	senderAgentId: string;
	threadId?: string;
	replyToMessageId?: string;
	task: WorkerAgentTaskMetadata;
};

/**
 * Sole owner of model-facing logical-agent controls and their durable inboxes.
 *
 * It deliberately owns no worker execution policy, provider loop, or terminal persistence. Those
 * controller-owned callbacks keep this narrow port from becoming a second lifecycle authority.
 */
export class WorkerAgentControlCoordinator implements WorkerAgentControlPort {
	private readonly options: WorkerAgentControlCoordinatorOptions;
	private readonly mailboxes = new Map<string, WorkerAgentMailbox>();
	private readonly stateListeners = new Set<() => void>();
	private readonly conversations = new WorkerConversationStore();
	private readonly reconcilingTaskBearingAgentIds = new Set<string>();
	private readonly taskBearingContinuationAgentIds = new Set<string>();
	private readonly sessionRootMailbox: SessionRootMailbox;
	private readonly sessionRootAddress: string;
	private readonly sessionRootReconciliationFailures = new Map<string, string>();
	private readonly workerReplyReconciliationFailures = new Map<string, string>();

	constructor(options: WorkerAgentControlCoordinatorOptions) {
		this.options = options;
		this.sessionRootAddress = sessionRootAddress(options.parentSessionId);
		this.sessionRootMailbox = new SessionRootMailbox({
			agentDir: options.agentDir,
			parentSessionId: options.parentSessionId,
		});
	}

	getProcessOwnerId(): string {
		return this.options.processOwnerId;
	}

	listWorkerAgents(scope: WorkerAgentControlScope = {}): AgentBindingContract[] {
		this.requireControl();
		const agents = Object.values(this.options.getLifecycle().getTaskRuntimeSnapshot().agents);
		const caller = scope.callerAgentId ? this.requireKnownAgent(scope.callerAgentId) : undefined;
		return agents
			.filter((agent) => !caller || agent.rootAgentId === caller.rootAgentId)
			.sort((left, right) => left.depth - right.depth || left.createdAt.localeCompare(right.createdAt));
	}

	/** Snapshot-only activity projection. Unlike waitForWorkerAgent, this never yields scheduler capacity. */
	getWorkerAgentActivity(agentId: string, scope: WorkerAgentControlScope = {}): WorkerAgentActivity {
		this.requireControl();
		const canonicalAgentId = agentId.trim();
		if (!canonicalAgentId) throw new Error("Logical worker agent id is required.");
		const agent = this.options.getLifecycle().getAgent(canonicalAgentId);
		if (!agent) return "unknown";
		this.requireVisibleAgent(canonicalAgentId, scope);
		return this.activityForAgent(agent);
	}

	readWorkerAgentTranscript(
		agentId: string,
		options: WorkerAgentTranscriptOptions = {},
	): ReturnType<WorkerAgentControlPort["readWorkerAgentTranscript"]> {
		this.requireControl();
		const agent = this.requireVisibleAgent(agentId, options);
		const cursor = options.cursor ?? 0;
		const maxMessages = options.maxMessages ?? 16;
		if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError("Worker transcript cursor is invalid.");
		if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 64) {
			throw new TypeError("Worker transcript page size must be from 1 through 64 messages.");
		}
		const transcript = this.conversations
			.open({
				agentDir: this.options.agentDir,
				resumeContext: agent.resumeContext,
				expectedLogicalAgentId: agent.agentId,
			})
			.getRawTranscript();
		if (cursor > transcript.length) throw new TypeError("Worker transcript cursor exceeds the transcript length.");
		const messages = transcript.slice(cursor, cursor + maxMessages);
		const nextCursor = cursor + messages.length;
		return {
			agentId: agent.agentId,
			cursor,
			totalMessages: transcript.length,
			messages,
			...(nextCursor < transcript.length ? { nextCursor } : {}),
		};
	}

	sendWorkerAgentMessage(
		agentId: string,
		message: string,
		options: WorkerAgentMessageOptions = {},
	): { messageId: string; queued: true } {
		this.requireControl();
		this.rejectGenericReplyOptions(options);
		const agent = this.requireVisibleAgent(agentId, { callerAgentId: options.senderAgentId });
		this.assertAgentAcceptsNewMessages(agent, options.idempotencyKey);
		const queued = this.enqueuePeerMessage(agent, "follow_up", message, options);
		this.notifyStateChangedBestEffort();
		return { messageId: queued.messageId, queued: true };
	}

	followUpWorkerAgent(
		agentId: string,
		message: string,
		options: WorkerAgentMessageOptions = {},
	): { started: boolean; steering: boolean; messageId: string; record?: LaneRecord; skipReason?: string } {
		this.requireControl();
		const agent = this.requireVisibleAgent(agentId, { callerAgentId: options.senderAgentId });
		return this.followUpAcceptedAgent(agent, message, options);
	}

	sendSessionRootWorkerAgentMessage(
		agentId: string,
		message: string,
		options: SessionRootWorkerAgentMessageOptions = {},
	): { messageId: string; queued: true } {
		this.requireControl();
		const agent = this.requireKnownAgent(agentId);
		this.assertAgentAcceptsNewMessages(agent, options.idempotencyKey);
		const queued = this.enqueuePeerMessage(agent, "follow_up", message, this.sessionRootMessageOptions(options));
		this.notifyStateChangedBestEffort();
		return { messageId: queued.messageId, queued: true };
	}

	followUpSessionRootWorkerAgent(
		agentId: string,
		message: string,
		options: SessionRootWorkerAgentMessageOptions = {},
	): { started: boolean; steering: boolean; messageId: string; record?: LaneRecord; skipReason?: string } {
		this.requireControl();
		return this.followUpAcceptedAgent(
			this.requireKnownAgent(agentId),
			message,
			this.sessionRootMessageOptions(options),
		);
	}

	replyToWorkerAgentMessage(sourceAgentId: string, message: string, replyToMessageId: string): WorkerAgentReplyResult {
		this.requireControl();
		const source = this.requireKnownAgent(sourceAgentId);
		const sourceMailbox = this.getMailbox(source.agentId);
		const completedReply = sourceMailbox.resolveCompletedReply(replyToMessageId, message);
		const activeAcknowledgementId = sourceMailbox.getReplyAcknowledgementId(replyToMessageId);
		if (
			completedReply &&
			activeAcknowledgementId !== undefined &&
			activeAcknowledgementId !== completedReply.replyMessageId
		) {
			throw new Error("Worker reply acknowledgement identity conflicts with its durable source receipt.");
		}
		if (completedReply && activeAcknowledgementId === undefined) {
			if (completedReply.requestSenderId === this.sessionRootAddress) {
				return { destination: "session_root", messageId: completedReply.replyMessageId };
			}
			const completedTarget = this.requireKnownAgent(completedReply.requestSenderId);
			if (source.rootAgentId !== completedTarget.rootAgentId) {
				throw new Error("Worker reply target is outside its agent tree.");
			}
			this.reconcileCompletedWorkerReplyAcknowledgement(
				sourceMailbox,
				replyToMessageId,
				completedTarget.agentId,
				completedReply.replyMessageId,
			);
			return {
				destination: "worker",
				messageId: completedReply.replyMessageId,
				started: false,
				steering: false,
				skipReason: "worker_reply_already_accepted",
			};
		}
		const request = sourceMailbox.getMessage(replyToMessageId);
		if (!request || request.deliveredAt === undefined || request.expectReply !== true) {
			throw new Error("Worker reply does not reference a delivered reply-expected message.");
		}
		if (!request.senderAgentId) throw new Error("Worker reply request has no routable requester.");
		if (request.senderAgentId === this.sessionRootAddress) {
			return this.routeWorkerReplyToSessionRoot(source, sourceMailbox, request, message);
		}
		const target = this.requireKnownAgent(request.senderAgentId);
		if (source.rootAgentId !== target.rootAgentId) {
			throw new Error("Worker reply target is outside its agent tree.");
		}
		if (target.status === "retired" && activeAcknowledgementId === undefined) {
			throw new Error(`Logical worker agent '${target.agentId}' is retired.`);
		}
		return this.routeWorkerReplyToAgent(target, source.agentId, request, message);
	}

	listSessionRootReplies(query: SessionRootReplyQuery = {}): SessionRootReply[] {
		this.requireControl();
		this.reconcileSessionRootSurface();
		return this.sessionRootMailbox.pendingReplies(query);
	}

	waitForSessionRootReplies(options: SessionRootReplyWaitOptions = {}): Promise<SessionRootReplyWaitResult> {
		this.requireControl();
		this.reconcileSessionRootSurface();
		return this.sessionRootMailbox.waitForReplies(options);
	}

	acknowledgeSessionRootReply(messageId: string, ackToken: string): boolean {
		this.requireControl();
		this.reconcileSessionRootSurface();
		const acknowledged = this.sessionRootMailbox.acknowledge(messageId, ackToken);
		if (acknowledged) {
			this.reconcileWorkerReplyOutboxesBestEffort();
			this.notifyStateChangedBestEffort();
		}
		return acknowledged;
	}

	private reconcileSessionRootSurface(): void {
		this.reconcileSessionRootReplies();
		this.reconcileWorkerReplyOutboxesBestEffort();
	}

	private followUpAcceptedAgent(
		agent: AgentBindingContract,
		message: string,
		options: WorkerAgentMessageOptions,
	): { started: boolean; steering: boolean; messageId: string; record?: LaneRecord; skipReason?: string } {
		this.rejectGenericReplyOptions(options);
		if (this.activityForAgent(agent) === "active") {
			const queued = this.enqueuePeerMessage(agent, "steer", message, options, { kind: "agent_turn" });
			this.notifyStateChangedBestEffort();
			if (
				queued.status === "completed_replay" ||
				queued.message.deliveredAt !== undefined ||
				queued.message.failedAt !== undefined
			) {
				return {
					started: false,
					steering: false,
					messageId: queued.messageId,
					skipReason: "worker_message_already_finalized",
				};
			}
			return { started: false, steering: true, messageId: queued.messageId };
		}
		if (agent.status !== "registered") {
			return { started: false, steering: false, messageId: "", skipReason: `agent_${agent.status}` };
		}
		return this.startIdleAgentTask(agent, message, options);
	}

	/**
	 * Atomically transition one idle persistent agent to a fresh task. There is no await between the
	 * activity check and durable prepare, so competing model calls cannot turn the loser into steering.
	 */
	startWorkerAgentTask(
		agentId: string,
		message: string,
		options: WorkerAgentTaskStartOptions = {},
	): { started: boolean; steering: false; messageId: string; record?: LaneRecord; skipReason?: string } {
		this.requireControl();
		const canonicalAgentId = agentId.trim();
		if (!canonicalAgentId) throw new Error("Logical worker agent id is required.");
		const candidate = this.options.getLifecycle().getAgent(canonicalAgentId);
		if (!candidate) return { started: false, steering: false, messageId: "", skipReason: "unknown_agent" };
		const agent = this.requireVisibleAgent(canonicalAgentId, options);
		if (options.idempotencyKey !== undefined) {
			const replay = this.replayWorkerAgentTask(agent, message, options.idempotencyKey);
			if (replay) return replay;
		}
		const activity = this.activityForAgent(agent);
		if (activity !== "idle") {
			return { started: false, steering: false, messageId: "", skipReason: `worker_${activity}` };
		}
		if (agent.status !== "registered") {
			return { started: false, steering: false, messageId: "", skipReason: `agent_${agent.status}` };
		}
		return this.startIdleAgentTask(
			agent,
			message,
			options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey },
		);
	}

	private replayWorkerAgentTask(
		agent: AgentBindingContract,
		message: string,
		idempotencyKey: string,
	): { started: boolean; steering: false; messageId: string; record?: LaneRecord; skipReason?: string } | undefined {
		this.assertIdempotencyTarget(agent.agentId, idempotencyKey);
		const messageId = workerAgentMessageId(this.options.parentSessionId, idempotencyKey);
		const mailbox = this.getMailbox(agent.agentId);
		const correlatedAttempt = this.controlMessageAttemptById(agent.agentId, messageId);
		if (correlatedAttempt) {
			if (correlatedAttempt.dispatch.instructions !== message.trim()) {
				throw new Error("Worker control idempotency identity conflicts with its durable dispatch.");
			}
			const record = this.options.getLifecycle().getRecord(correlatedAttempt.taskId);
			if (!record) {
				return {
					started: false,
					steering: false,
					messageId,
					skipReason: "orchestration_projection_missing",
				};
			}
			return { started: true, steering: false, messageId, record };
		}
		if (!mailbox.getMessage(messageId)) {
			return mailbox.hasControlReplayReceipt(messageId)
				? {
						started: false,
						steering: false,
						messageId,
						skipReason: "worker_task_receipt_without_attempt",
					}
				: undefined;
		}
		const acceptance = mailbox.enqueueWithReceipt({
			kind: "follow_up",
			content: message,
			idempotencyKey,
			task: { kind: "agent_turn" },
		});
		if (acceptance.status === "completed_replay") {
			return {
				started: false,
				steering: false,
				messageId,
				skipReason: "worker_task_receipt_without_attempt",
			};
		}
		const accepted = acceptance.message;
		const attempt = this.controlMessageAttempt(agent.agentId, accepted);
		if (attempt) {
			const record = this.options.getLifecycle().getRecord(attempt.taskId);
			if (!record) {
				return {
					started: false,
					steering: false,
					messageId,
					skipReason: "orchestration_projection_missing",
				};
			}
			// Idempotent API replay returns the original accepted start even after that attempt became
			// terminal. The record carries its current projection; no second task or scheduler entry is made.
			return { started: true, steering: false, messageId, record };
		}
		if (accepted.deliveredAt !== undefined) {
			return {
				started: false,
				steering: false,
				messageId,
				skipReason: "worker_task_delivered_without_attempt",
			};
		}
		const reconciliation = this.reconcileTaskBearingMailbox(agent.agentId, messageId);
		this.notifyStateChangedBestEffort();
		return {
			started: reconciliation.started,
			steering: false,
			messageId,
			...(reconciliation.record ? { record: reconciliation.record } : {}),
			...(reconciliation.skipReason ? { skipReason: reconciliation.skipReason } : {}),
		};
	}

	private startIdleAgentTask(
		agent: AgentBindingContract,
		message: string,
		options: WorkerAgentMessageOptions,
	): { started: boolean; steering: false; messageId: string; record?: LaneRecord; skipReason?: string } {
		const queued = this.enqueuePeerMessage(agent, "follow_up", message, options, { kind: "agent_turn" });
		if (queued.status === "completed_replay") {
			return {
				started: false,
				steering: false,
				messageId: queued.messageId,
				skipReason: "worker_message_already_finalized",
			};
		}
		const reconciliation = this.reconcileTaskBearingMailbox(agent.agentId, queued.messageId);
		this.notifyStateChangedBestEffort();
		return {
			started: reconciliation.started,
			steering: false,
			messageId: queued.messageId,
			...(reconciliation.record ? { record: reconciliation.record } : {}),
			...(reconciliation.skipReason ? { skipReason: reconciliation.skipReason } : {}),
		};
	}

	private sessionRootMessageOptions(options: SessionRootWorkerAgentMessageOptions): WorkerAgentMessageOptions {
		return {
			senderAgentId: this.sessionRootAddress,
			...(options.threadId !== undefined ? { threadId: options.threadId } : {}),
			...(options.expectReply === true ? { expectReply: true } : {}),
			...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
		};
	}

	private rejectGenericReplyOptions(options: WorkerAgentMessageOptions): void {
		if ("replyToMessageId" in options) {
			throw new Error("Worker replies must use the dedicated inferred-destination reply control.");
		}
	}

	private assertAgentAcceptsNewMessages(agent: AgentBindingContract, idempotencyKey?: string): void {
		if (agent.status !== "retired") return;
		if (idempotencyKey !== undefined) {
			const messageId = workerAgentMessageId(this.options.parentSessionId, idempotencyKey);
			const mailbox = this.getMailbox(agent.agentId);
			if (mailbox.getMessage(messageId) || mailbox.hasControlReplayReceipt(messageId)) return;
		}
		throw new Error(`Logical worker agent '${agent.agentId}' is retired.`);
	}

	private routeWorkerReplyToAgent(
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
		const transcriptReplay = this.reconcileMandatoryControlTranscript(target, transcriptInput, false);
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
			this.deliverMandatoryControlToRetiredTranscript(target, transcriptInput);
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
		let queued: QueuedPeerMessage;
		try {
			queued = targetMailbox.enqueueWithReceipt({
				kind: activity === "active" ? "steer" : "follow_up",
				content: message,
				senderAgentId: sourceAgentId,
				replyToMessageId: request.messageId,
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

	private routeWorkerReplyToSessionRoot(
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

	private deliverMandatoryControlToRetiredTranscript(
		target: AgentBindingContract,
		input: MandatoryTranscriptControlInput,
	): string {
		if (target.status !== "retired" || this.activityForAgent(target) === "active") {
			throw new Error("Mandatory transcript fallback requires a terminal logical worker target.");
		}
		const delivery = this.reconcileMandatoryControlTranscript(target, input, true);
		return delivery.messageId;
	}

	private reconcileMandatoryControlTranscript(
		target: AgentBindingContract,
		input: MandatoryTranscriptControlInput,
		appendIfMissing: boolean,
	): { messageId: string; delivered: boolean } {
		const messageId = workerAgentMessageId(this.options.parentSessionId, input.idempotencyKey);
		return this.reconcileControlTranscript(
			target,
			{
				messageId,
				kind: "follow_up",
				content: input.content,
				senderAgentId: input.senderAgentId,
				...(input.threadId ? { threadId: input.threadId } : {}),
				...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
				task: input.task,
				createdAt: new Date().toISOString(),
			},
			appendIfMissing,
		);
	}

	private reconcileControlTranscript(
		target: AgentBindingContract,
		message: WorkerAgentMessage,
		appendIfMissing: boolean,
	): { messageId: string; delivered: boolean } {
		const messageId = message.messageId;
		if (!target.resumeContext.sessionFile) {
			if (appendIfMissing) {
				throw new Error("Mandatory transcript fallback target has no durable session transcript.");
			}
			return { messageId, delivered: false };
		}
		const projected = this.mailboxMessage(message);
		const conversation = this.conversations.open({
			agentDir: this.options.agentDir,
			resumeContext: target.resumeContext,
			expectedLogicalAgentId: target.agentId,
		});
		const prefix = `[Worker control ${messageId}`;
		const existing = conversation
			.getRawTranscript()
			.filter(
				(message) =>
					message.role === "user" && typeof message.content === "string" && message.content.startsWith(prefix),
			);
		if (existing.some((message) => message.content !== projected.content)) {
			throw new Error("Worker control transcript identity conflicts with existing content.");
		}
		if (existing.length === 0 && appendIfMissing) conversation.appendMessage(projected);
		return { messageId, delivered: existing.length > 0 || appendIfMissing };
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
		for (const reply of replies) this.reconcileSessionRootReply(reply);
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

	private notifyStateChangedBestEffort(): void {
		try {
			this.options.statusChanged();
		} catch {
			// Notification observers cannot redefine durable task acceptance.
		}
		this.notifyStateListeners();
	}

	interruptWorkerAgent(
		agentId: string,
		scope: WorkerAgentControlScope = {},
	): { interrupted: boolean; reason?: string } {
		const { agent, attempt } = this.controlledAgentAttempt(agentId, scope);
		if (!attempt || (attempt.status !== "running" && attempt.status !== "leased")) {
			return { interrupted: false, reason: "agent_not_running" };
		}
		try {
			this.options.getLifecycle().suspendAgent(attempt.taskId, agent.agentId, this.options.processOwnerId);
			this.options.abortLane(attempt.taskId, "agent_interrupted");
			this.signalStateChanged();
			return { interrupted: true };
		} catch (error) {
			return { interrupted: false, reason: error instanceof Error ? error.message : String(error) };
		}
	}

	resumeWorkerAgent(
		agentId: string,
		scope: WorkerAgentControlScope = {},
	): { started: boolean; record?: LaneRecord; skipReason?: string } {
		const { attempt } = this.controlledAgentAttempt(agentId, scope);
		if (!attempt || attempt.status !== "suspended") return { started: false, skipReason: "agent_not_suspended" };
		const record = this.options.getLifecycle().getRecord(attempt.taskId);
		if (!record) return { started: false, skipReason: "orchestration_projection_missing" };
		const promise = this.options.run(this.options.recoveredRequest(attempt), record);
		this.options.scheduler.track(record.laneId, promise);
		this.signalStateChanged();
		return { started: true, record };
	}

	cancelWorkerAgent(
		agentId: string,
		reasonCode = "agent_cancelled",
		scope: WorkerAgentControlScope = {},
	): LaneRecord | undefined {
		const { attempt } = this.controlledAgentAttempt(agentId, scope);
		if (!attempt) return undefined;
		this.options.abortLane(attempt.taskId, reasonCode);
		const record = this.options.cancelLane(attempt.taskId, reasonCode);
		this.signalStateChanged();
		return record;
	}

	/** Event-driven wait: durable projection plus state/mailbox notifications, never output polling. */
	waitForWorkerAgent(
		agentId: string,
		timeoutMs = 30_000,
		scope: WorkerAgentControlScope = {},
	): Promise<{ status: WorkerAgentActivity }> {
		this.requireControl();
		const canonicalAgentId = agentId.trim();
		if (!canonicalAgentId) throw new Error("Logical worker agent id is required.");
		const target = this.options.getLifecycle().getAgent(canonicalAgentId);
		if (target) this.requireVisibleAgent(canonicalAgentId, scope);
		const boundedTimeoutMs = Number.isFinite(timeoutMs)
			? Math.max(1, Math.min(Math.floor(timeoutMs), 300_000))
			: 30_000;
		const currentStatus = (): WorkerAgentActivity => {
			const agent = this.options.getLifecycle().getAgent(canonicalAgentId);
			if (!agent) return "unknown";
			return this.activityForAgent(agent);
		};
		const immediate = currentStatus();
		if (immediate !== "active") return Promise.resolve({ status: immediate });
		return new Promise((resolve) => {
			let settled = false;
			let releaseYield = (): void => undefined;
			let unsubscribeMailbox = (): void => undefined;
			let unsubscribeState = (): void => undefined;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const settle = () => {
				if (settled) return;
				const next = currentStatus();
				if (next === "active") return;
				settled = true;
				unsubscribeMailbox();
				unsubscribeState();
				if (timeout) clearTimeout(timeout);
				releaseYield();
				resolve({ status: next });
			};
			unsubscribeMailbox = this.getMailbox(canonicalAgentId).subscribe(settle);
			unsubscribeState = this.subscribeStateChanges(settle);
			timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				unsubscribeMailbox();
				unsubscribeState();
				releaseYield();
				resolve({ status: currentStatus() });
			}, boundedTimeoutMs);
			if (typeof timeout === "object" && "unref" in timeout) timeout.unref();
			if (scope.callerAgentId && this.options.yieldCapacity) {
				const yielded = this.options.yieldCapacity(scope.callerAgentId, canonicalAgentId);
				if (settled) yielded();
				else releaseYield = yielded;
			}
			settle();
		});
	}

	/** Read mailbox items at a safe boundary and reconcile the narrow append-before-ack crash window. */
	mailboxMessagesForConversation(
		agentId: string,
		conversation: WorkerConversation,
		includeFollowUp: boolean,
	): AgentMessage[] {
		const mailbox = this.getMailbox(agentId);
		const pending = mailbox.pending();
		if (pending.length === 0) return [];
		const delivered = conversation.findDeliveredWorkerControlMessageIds(pending.map((message) => message.messageId));
		for (const messageId of delivered) this.acknowledgeDeliveredMailboxMessage(agentId, messageId);
		return mailbox
			.pending()
			.filter((message) => message.kind === "steer" || includeFollowUp)
			.map((message) => this.mailboxMessage(message));
	}

	/** Acknowledge only after the exact child transcript message has been durably appended. */
	acknowledgeMailboxMessage(agentId: string, message: { role: string; content: unknown }): void {
		if (message.role !== "user" || typeof message.content !== "string") return;
		const messageId = /^\[Worker control (worker-message-[^\]\s]+)(?: [^\]]+)?\]\n/.exec(message.content)?.[1];
		if (messageId) this.acknowledgeDeliveredMailboxMessage(agentId, messageId);
	}

	/** Called by controller-owned execution transitions after lifecycle state changed. */
	signalStateChanged(): void {
		this.reconcileTaskBearingMailboxTurns();
		this.notifyStateListeners();
	}

	/** Restart/idle boundary: adopt or schedule every oldest pending executable mailbox intent. */
	reconcileTaskBearingMailboxTurns(): void {
		const agents = this.replyReconciliationAgents();
		this.reconcileWorkerReplyOutboxes(agents);
		for (const agent of agents) this.reconcileTaskBearingMailbox(agent.agentId);
	}

	private replyReconciliationAgents(): AgentBindingContract[] {
		return Object.values(this.options.getLifecycle().getTaskRuntimeSnapshot().agents).sort(
			(left, right) => left.createdAt.localeCompare(right.createdAt) || left.agentId.localeCompare(right.agentId),
		);
	}

	private reconcileWorkerReplyOutboxes(agents: readonly AgentBindingContract[]): void {
		for (const agent of agents) this.reconcileWorkerReplyAcknowledgements(agent);
	}

	private reconcileWorkerReplyOutboxesBestEffort(): void {
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
				if (source.rootAgentId !== target.rootAgentId) {
					throw new Error("Worker reply target is outside its agent tree.");
				}
				this.routeWorkerReplyToAgent(target, source.agentId, request, acknowledgement.replyContent);
				this.workerReplyReconciliationFailures.delete(failureKey);
			} catch (error) {
				this.recordWorkerReplyReconciliationFailure(
					failureKey,
					error instanceof Error ? error.message : String(error),
				);
			}
		}
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

	private reconcileCompletedWorkerReplyAcknowledgement(
		sourceMailbox: WorkerAgentMailbox,
		requestMessageId: string,
		targetAgentId: string,
		replyMessageId: string,
	): boolean {
		if (sourceMailbox.getReplyAcknowledgementId(requestMessageId) !== replyMessageId) return false;
		if (!this.getMailbox(targetAgentId).hasDeliveredControlReceipt(replyMessageId)) return false;
		return sourceMailbox.commitReplyAcknowledgement(requestMessageId, replyMessageId);
	}

	private notifyStateListeners(): void {
		for (const listener of this.stateListeners) {
			try {
				listener();
			} catch {
				// State listeners are advisory; one observer cannot redefine or hide a durable mutation.
			}
		}
	}

	/** Route a terminal child edge to its owning parent without injecting into an active model turn. */
	deliverWorkerTerminalHandoff(args: {
		parentAgentId: string;
		childAgentId: string;
		terminalAttemptId: string;
		record: LaneRecord;
	}): { messageId: string; started: boolean; accepted: boolean; skipReason?: string } {
		const parent = this.requireKnownAgent(args.parentAgentId);
		const latest = this.latestAgentAttempt(parent);
		const active = latest?.status === "queued" || latest?.status === "leased" || latest?.status === "running";
		const content = [
			"Worker terminal handoff",
			`childAgentId=${args.childAgentId}`,
			`laneId=${args.record.laneId}`,
			`status=${args.record.status}`,
			...(args.record.reasonCode ? [`reasonCode=${args.record.reasonCode}`] : []),
			`Read the exact child evidence with delegate action="transcript" agentId="${args.childAgentId}".`,
		].join("\n");
		const idempotencyKey = `terminal-handoff:${args.terminalAttemptId}`;
		const transcriptInput: MandatoryTranscriptControlInput = {
			idempotencyKey,
			content,
			senderAgentId: args.childAgentId,
			task: { kind: "terminal_handoff", sourceAttemptId: args.terminalAttemptId },
		};
		this.assertIdempotencyTarget(parent.agentId, idempotencyKey);
		const transcriptReplay = this.reconcileMandatoryControlTranscript(parent, transcriptInput, false);
		if (transcriptReplay.delivered) {
			this.notifyStateChangedBestEffort();
			return { messageId: transcriptReplay.messageId, started: false, accepted: true };
		}
		if (parent.status === "retired") {
			const messageId = this.deliverMandatoryControlToRetiredTranscript(parent, transcriptInput);
			this.notifyStateChangedBestEffort();
			return {
				messageId,
				started: false,
				accepted: true,
				skipReason: "terminal_handoff_retired_target_transcript_delivery",
			};
		}
		const queued = this.getMailbox(parent.agentId).enqueueWithReceipt({
			kind: active ? "steer" : "follow_up",
			content,
			senderAgentId: args.childAgentId,
			idempotencyKey,
			task: { kind: "terminal_handoff", sourceAttemptId: args.terminalAttemptId },
		});
		if (queued.status === "completed_replay") {
			this.notifyStateChangedBestEffort();
			return { messageId: queued.messageId, started: false, accepted: true };
		}
		if (queued.message.deliveredAt !== undefined) {
			this.notifyStateChangedBestEffort();
			return { messageId: queued.messageId, started: false, accepted: true };
		}
		const reconciliation = this.reconcileTaskBearingMailbox(parent.agentId, queued.messageId);
		this.notifyStateChangedBestEffort();
		return {
			messageId: queued.messageId,
			started: reconciliation.started,
			accepted: true,
			...(reconciliation.skipReason ? { skipReason: reconciliation.skipReason } : {}),
		};
	}

	private reconcileTaskBearingMailbox(agentId: string, expectedMessageId?: string): TaskBearingReconciliation {
		if (this.reconcilingTaskBearingAgentIds.has(agentId)) {
			return { started: false, skipReason: "worker_task_reconciliation_in_progress" };
		}
		this.reconcilingTaskBearingAgentIds.add(agentId);
		try {
			const agent = this.options.getLifecycle().getAgent(agentId);
			if (!agent) return { started: false, skipReason: "unknown_agent" };
			const mailbox = this.getMailbox(agentId);
			for (let settlement = 0; settlement < 64; settlement++) {
				const message = mailbox.pendingTaskBearing()[0];
				if (!message) return { started: false };
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
				try {
					this.enableAttemptAccountingForNextTask(agent);
					const prepared = this.options.getLifecycle().prepareAgentTurn({
						agentId: agent.agentId,
						instructions: message.content,
						controlMessageId: message.messageId,
					});
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

	private scheduleTaskBearingReconciliationContinuation(agentId: string): void {
		if (this.taskBearingContinuationAgentIds.has(agentId)) return;
		this.taskBearingContinuationAgentIds.add(agentId);
		queueMicrotask(() => {
			this.taskBearingContinuationAgentIds.delete(agentId);
			this.reconcileTaskBearingMailbox(agentId);
		});
	}

	private reconcileTaskBearingTranscriptDelivery(target: AgentBindingContract, message: WorkerAgentMessage): boolean {
		if (!this.reconcileControlTranscript(target, message, false).delivered) return false;
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
		this.reconcileControlTranscript(agent, retained, true);
		this.acknowledgeDeliveredMailboxMessage(agent.agentId, retained.messageId);
		const settlement = {
			...scheduled,
			skipReason: `${scheduled.skipReason ?? "worker_task_terminal"}:transcript_fallback_delivered`,
		};
		return returnSettlement ? settlement : undefined;
	}

	private controlMessageAttempt(agentId: string, message: WorkerAgentMessage): AttemptRuntimeState | undefined {
		const attempt = this.controlMessageAttemptById(agentId, message.messageId);
		if (attempt && attempt.dispatch.instructions !== message.content) {
			throw new Error(`Worker control message '${message.messageId}' conflicts with its durable dispatch.`);
		}
		return attempt;
	}

	private controlMessageAttemptById(agentId: string, messageId: string): AttemptRuntimeState | undefined {
		const matches = Object.values(this.options.getLifecycle().getTaskRuntimeSnapshot().attempts).filter(
			(attempt) => attempt.dispatch.logicalLaneId === agentId && attempt.dispatch.controlMessageId === messageId,
		);
		if (matches.length > 1) {
			throw new Error(`Worker control message '${messageId}' owns multiple durable attempts.`);
		}
		return matches[0];
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
				agentDir: this.options.agentDir,
				resumeContext: agent.resumeContext,
				expectedLogicalAgentId: agent.agentId,
			})
			.enableAttemptUsageBoundaries();
	}

	private requireControl(): void {
		if (!this.options.isControlAvailable()) {
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		}
	}

	private requireKnownAgent(agentId: string): AgentBindingContract {
		const normalized = agentId.trim();
		if (!normalized) throw new Error("Logical worker agent id is required.");
		const agent = this.options.getLifecycle().getAgent(normalized);
		if (!agent) throw new Error(`Unknown logical worker agent '${normalized}'.`);
		return agent;
	}

	private requireVisibleAgent(agentId: string, scope: WorkerAgentControlScope): AgentBindingContract {
		const target = this.requireKnownAgent(agentId);
		if (!scope.callerAgentId) return target;
		const caller = this.requireKnownAgent(scope.callerAgentId);
		if (caller.rootAgentId !== target.rootAgentId) {
			throw new Error(`Logical worker agent '${target.agentId}' is outside the caller's agent tree.`);
		}
		return target;
	}

	private requireControllableAgent(agentId: string, scope: WorkerAgentControlScope): AgentBindingContract {
		const target = this.requireVisibleAgent(agentId, scope);
		if (!scope.callerAgentId) return target;
		const caller = this.requireKnownAgent(scope.callerAgentId);
		let cursor: AgentBindingContract | undefined = target;
		const visited = new Set<string>();
		while (cursor && !visited.has(cursor.agentId)) {
			if (cursor.agentId === caller.agentId) return target;
			visited.add(cursor.agentId);
			cursor = cursor.parentAgentId ? this.options.getLifecycle().getAgent(cursor.parentAgentId) : undefined;
		}
		throw new Error(`Logical worker agent '${target.agentId}' is outside its control subtree.`);
	}

	private latestAgentAttempt(agent: AgentBindingContract): AttemptRuntimeState | undefined {
		const lifecycle = this.options.getLifecycle();
		const latest = lifecycle.getLatestAgentAttempt?.(agent.agentId);
		if (latest) return latest;
		return agent.activeAttemptId ? lifecycle.getTaskRuntimeSnapshot().attempts[agent.activeAttemptId] : undefined;
	}

	private activityForAgent(agent: AgentBindingContract): WorkerAgentActivity {
		const attempt = this.latestAgentAttempt(agent);
		if (attempt?.status === "suspended" || agent.status === "suspended") return "suspended";
		if (attempt?.status === "queued" || attempt?.status === "leased" || attempt?.status === "running") {
			return "active";
		}
		return "idle";
	}

	private controlledAgentAttempt(
		agentId: string,
		scope: WorkerAgentControlScope,
	): {
		agent: AgentBindingContract;
		attempt: AttemptRuntimeState | undefined;
	} {
		this.requireControl();
		const agent = this.requireControllableAgent(agentId, scope);
		const attempt = this.latestAgentAttempt(agent);
		return { agent, attempt };
	}

	private getMailbox(agentId: string): WorkerAgentMailbox {
		let mailbox = this.mailboxes.get(agentId);
		if (!mailbox) {
			mailbox = new WorkerAgentMailbox({
				agentDir: this.options.agentDir,
				parentSessionId: this.options.parentSessionId,
				agentId,
			});
			this.mailboxes.set(agentId, mailbox);
		}
		return mailbox;
	}

	private subscribeStateChanges(listener: () => void): () => void {
		this.stateListeners.add(listener);
		return () => this.stateListeners.delete(listener);
	}

	private acknowledgeDeliveredMailboxMessage(agentId: string, messageId: string): void {
		const mailbox = this.getMailbox(agentId);
		const controlMessage = mailbox.getMessage(messageId);
		if (controlMessage) {
			const target = this.requireKnownAgent(agentId);
			const sourceMailbox = this.beginWorkerReplyAcknowledgement(target, controlMessage, true);
			mailbox.acknowledgeDelivered(messageId);
			if (
				sourceMailbox &&
				controlMessage.replyToMessageId &&
				!sourceMailbox.commitReplyAcknowledgement(controlMessage.replyToMessageId, controlMessage.messageId) &&
				sourceMailbox.getReplyAcknowledgementId(controlMessage.replyToMessageId) !== undefined
			) {
				throw new Error("Worker reply source acknowledgement did not commit.");
			}
			return;
		}
		mailbox.acknowledgeDelivered(messageId);
	}

	private beginWorkerReplyAcknowledgement(
		target: AgentBindingContract,
		reply: WorkerAgentMessage,
		allowCommittedSource = false,
	): WorkerAgentMailbox | undefined {
		if (reply.replyToMessageId === undefined) return undefined;
		if (!reply.senderAgentId) throw new Error("Worker reply routing metadata is incomplete.");
		const source = this.requireKnownAgent(reply.senderAgentId);
		if (source.rootAgentId !== target.rootAgentId) {
			throw new Error("Worker reply target is outside its agent tree.");
		}
		const sourceMailbox = this.getMailbox(source.agentId);
		const request = sourceMailbox.getMessage(reply.replyToMessageId);
		if (!request || request.expectReply !== true || request.deliveredAt === undefined) {
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

	private enqueuePeerMessage(
		target: AgentBindingContract,
		kind: "steer" | "follow_up",
		content: string,
		options: WorkerAgentMessageOptions,
		task?: WorkerAgentTaskMetadata,
	): QueuedPeerMessage {
		if (options.idempotencyKey !== undefined) {
			this.assertIdempotencyTarget(target.agentId, options.idempotencyKey);
		}
		return this.getMailbox(target.agentId).enqueueWithReceipt({
			kind,
			content,
			...options,
			...(task ? { task } : {}),
		});
	}

	private assertIdempotencyTarget(targetAgentId: string, idempotencyKey: string): void {
		const messageId = workerAgentMessageId(this.options.parentSessionId, idempotencyKey);
		for (const agent of Object.values(this.options.getLifecycle().getTaskRuntimeSnapshot().agents)) {
			if (agent.agentId === targetAgentId) continue;
			const mailbox = this.getMailbox(agent.agentId);
			if (mailbox.getMessage(messageId) || mailbox.hasControlReplayReceipt(messageId)) {
				throw new Error(
					`Worker control idempotency identity is already accepted by logical worker '${agent.agentId}'.`,
				);
			}
		}
	}

	private mailboxMessage(message: WorkerAgentMessage): UserMessage {
		const metadata = [
			message.senderAgentId ? `from=${message.senderAgentId}` : undefined,
			message.threadId ? `thread=${message.threadId}` : undefined,
			message.replyToMessageId ? `replyTo=${message.replyToMessageId}` : undefined,
			message.expectReply ? "replyExpected=true" : undefined,
		].filter((value): value is string => value !== undefined);
		return {
			role: "user",
			content: `[Worker control ${message.messageId}${metadata.length > 0 ? ` ${metadata.join(" ")}` : ""}]\n${message.content}`,
			timestamp: Date.now(),
		};
	}
}
