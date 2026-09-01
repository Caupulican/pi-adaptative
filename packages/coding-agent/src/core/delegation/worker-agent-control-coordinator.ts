import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { UserMessage } from "@caupulican/pi-ai";
import type { WorkerDelegationRunOutcome } from "../agent-session-contracts.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import { latestAgentAttemptsByDurableOrder } from "../orchestration/attempt-ordering.ts";
import {
	type AgentBindingContract,
	type ArtifactContract,
	MAX_ORCHESTRATION_COLLECTION_LENGTH,
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	type WorkerResultContract,
} from "../orchestration/contracts.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import {
	SessionRootMailbox,
	type SessionRootReply,
	type SessionRootReplyQuery,
	type SessionRootReplyWaitOptions,
	type SessionRootReplyWaitResult,
	sessionRootAddress,
	sessionRootReplyMessageId,
} from "./session-root-mailbox.ts";
import type { WorkerClaimSnapshotPayload } from "./session-worker-claim.ts";
import {
	normalizeWorkerAgentDependencyTaskIds,
	type SessionRootWorkerAgentMessageOptions,
	type WorkerAgentActivity,
	type WorkerAgentBroadcastOptions,
	type WorkerAgentBroadcastResult,
	type WorkerAgentControlPort,
	type WorkerAgentControlScope,
	WorkerAgentMailbox,
	type WorkerAgentMessage,
	type WorkerAgentMessageOptions,
	type WorkerAgentReplyResult,
	type WorkerAgentRetireResult,
	type WorkerAgentTaskMetadata,
	type WorkerAgentTaskStartOptions,
	type WorkerAgentTranscriptOptions,
	type WorkerAgentView,
	type WorkerAgentWaitMode,
	workerAgentBroadcastTargetIdempotencyKey,
	workerAgentMessageId,
} from "./worker-agent-control.ts";
import {
	MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES,
	type WorkerConversation,
	WorkerConversationStore,
} from "./worker-conversation-store.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";
import type { WorkerDispatchScheduler } from "./worker-dispatch-scheduler.ts";
import { evaluateReusableWorkerTaskAdmission } from "./worker-fleet-limits.ts";
import type { WorkerLifecycle } from "./worker-lifecycle.ts";
import { projectWorkerTaskSessionView } from "./worker-task-view.ts";
import { WORKER_COMPLETION_ERROR_CAVEMAN_GUIDANCE } from "./worker-terminal-handoff-coordinator.ts";
import { workerTerminalOutputArtifact } from "./worker-terminal-output-artifact.ts";

export interface WorkerAgentControlCoordinatorOptions {
	agentDir: string;
	parentSessionId: string;
	processOwnerId: string;
	/** Controller-owned composition dependency; standalone coordinators receive a private default. */
	conversationStore?: WorkerConversationStore;
	isControlAvailable(): boolean;
	getLifecycle(): WorkerLifecycle;
	recoveredRequest(attempt: AttemptRuntimeState): WorkerDelegationRequest;
	run(request: WorkerDelegationRequest, record: LaneRecord): Promise<WorkerDelegationRunOutcome>;
	scheduler: Pick<WorkerDispatchScheduler, "enqueue" | "track" | "drain" | "dropQueued">;
	statusChanged(): void;
	getWorkerClaimSnapshot?(laneId: string): WorkerClaimSnapshotPayload | undefined;
	getWorkerResult?(laneId: string): Pick<WorkerResultContract, "artifacts"> | undefined;
	abortLane(laneId: string, reasonCode: string): void;
	cancelLane(laneId: string, reasonCode: string): LaneRecord | undefined;
	taskStartHeadroomSkipReason?(agent: AgentBindingContract): string | undefined;
	waitBlockedByCaller?(callerAgentId: string, targetAgentIds: readonly string[]): readonly string[];
	/** Yield caller-owned scheduler and mutation resources until the returned restorer succeeds. */
	yieldCallerForWait?(callerAgentId: string): () => boolean | undefined;
	/**
	 * Wake a wait that is blocked on restoring the caller's write reservation. Reservation release
	 * is a separate subsystem from subscribeStateChanges; this is that subsystem's event, not a poll.
	 */
	subscribeReservationAvailability?(listener: () => void): () => void;
	warn?(message: string): void;
	/** Current foreground submission epoch, or undefined when none is held. Read once, at genuine
	 * mailbox-turn creation (gated on `prepareAgentTurn`'s own `created` signal), to stamp the new
	 * attempt's owner epoch via `noteLaneOwnerEpoch` -- mirrors
	 * `WorkerDelegationControllerDeps.getCurrentSubmissionEpoch`. */
	getCurrentSubmissionEpoch?(): number | undefined;
	/** Mirrors `WorkerNotificationCoordinator.noteLaneOwnerEpoch` -- called only when
	 * `prepareAgentTurn` reports `created: true`, never for a replayed control message returning an
	 * attempt that may predate the current process. */
	noteLaneOwnerEpoch?(laneId: string, ownerEpoch: number): void;
}

type QueuedPeerMessage = ReturnType<WorkerAgentMailbox["enqueueWithReceipt"]>;

const MAX_BROADCAST_ERROR_CHARS = 512;

/**
 * Independent bound on how long a blocked restore may wait for a reservation-availability event,
 * deliberately NOT derived from the caller's own (possibly very short, e.g. test-only 1ms) wait
 * timeoutMs: the original wait already finished (satisfied or timed out) by the time restoration
 * starts. This is a watchdog, not a poll — retries are driven by subscribeReservationAvailability.
 * Mirrors the documented 300s absolute ceiling used elsewhere in this method.
 */
const WORKER_WAIT_RESTORE_MAX_MS = 300_000;

export function buildWorkerTerminalHandoffContent(args: {
	childAgentId: string;
	record: Pick<LaneRecord, "laneId" | "status" | "reasonCode">;
	outputArtifact?: ArtifactContract;
	claim?: {
		summary?: string;
		status?: string;
		changedFiles?: readonly string[];
		blockers?: readonly string[];
	};
}): string {
	const sanitize = (value: string): string => value.replace(/[\r\n]+/g, " ").slice(0, 120);
	return [
		"Worker terminal handoff",
		`childAgentId=${args.childAgentId}`,
		`laneId=${args.record.laneId}`,
		`status=${args.record.status}`,
		...(args.record.reasonCode ? [`reasonCode=${args.record.reasonCode}`] : []),
		...(args.outputArtifact
			? [
					`fullOutput=${args.outputArtifact.uri}${args.outputArtifact.sizeBytes === undefined ? "" : ` (${args.outputArtifact.sizeBytes} bytes)`}`,
				]
			: []),
		...(args.claim?.summary ? [`claimStatus=${args.claim.status || args.record.status}`] : []),
		...(args.claim?.summary ? [`claimSummary=${sanitize(args.claim.summary)}`] : []),
		...(args.claim?.changedFiles && args.claim.changedFiles.length > 0
			? [`changedFiles=${args.claim.changedFiles.join(", ")}`]
			: []),
		...(args.claim?.blockers && args.claim.blockers.length > 0
			? [`blockers=${args.claim.blockers.map((b) => sanitize(b)).join("; ")}`]
			: []),
		"CAVEMAN MODE - MANDATORY: terminal handoff means worker state was retained. Read the full transcript, verify the claim, then continue or replan within the admitted grant. Do not call this lost state or harness failure.",
		"MANDATORY: read every transcript page before judging this result.",
		`Start with delegate action="transcript" agentId="${args.childAgentId}" cursor=0.`,
		"Entries complete only after pagination ends. omittedMessages means whole entries were left out of that page. While nextCursor exists, call transcript again with cursor=nextCursor. Stop only when nextCursor is absent.",
		...(args.record.reasonCode === "worker_blocked"
			? [
					"worker_blocked means the durable claim has blockers; it does not mean worker state or transcript was lost.",
				]
			: []),
		...(args.record.status === "budget_exhausted"
			? [
					"CAVEMAN MODE - MANDATORY: budget_exhausted means an admitted limit ended work, not harness failure. Terminal reasonCode is authoritative; never replace it with earlier transcript errors. Read evidence, then replan only within remaining authority.",
				]
			: []),
		...(args.record.reasonCode === "completion_error" ? [WORKER_COMPLETION_ERROR_CAVEMAN_GUIDANCE] : []),
	].join("\n");
}

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
	private readonly conversations: WorkerConversationStore;
	private readonly reconcilingTaskBearingAgentIds = new Set<string>();
	private readonly taskBearingContinuationAgentIds = new Set<string>();
	private readonly sessionRootMailbox: SessionRootMailbox;
	private readonly sessionRootAddress: string;
	private readonly sessionRootReconciliationFailures = new Map<string, string>();
	private readonly workerReplyReconciliationFailures = new Map<string, string>();

	constructor(options: WorkerAgentControlCoordinatorOptions) {
		this.options = options;
		this.conversations = options.conversationStore ?? new WorkerConversationStore();
		this.sessionRootAddress = sessionRootAddress(options.parentSessionId);
		this.sessionRootMailbox = new SessionRootMailbox({
			agentDir: options.agentDir,
			parentSessionId: options.parentSessionId,
		});
	}

	getProcessOwnerId(): string {
		return this.options.processOwnerId;
	}

	listWorkerAgents(scope: WorkerAgentControlScope = {}): WorkerAgentView[] {
		this.requireControl();
		const snapshot = this.options.getLifecycle().getTaskRuntimeSnapshot();
		if (scope.callerAgentId) {
			const callerAgentId = scope.callerAgentId.trim();
			if (!callerAgentId || !snapshot.agents[callerAgentId]) {
				throw new Error(`Unknown logical worker agent '${callerAgentId}'.`);
			}
		}
		const latestAttempts = this.latestAttemptsByAgent(snapshot);
		const agents = Object.values(snapshot.agents);
		return agents
			.sort((left, right) => left.depth - right.depth || left.createdAt.localeCompare(right.createdAt))
			.map((agent) =>
				this.workerAgentView(
					agent,
					this.projectAgentActivity(agent, latestAttempts.get(agent.agentId)),
					scope.callerAgentId,
				),
			);
	}

	getWorkerTaskSessionView(): ReturnType<WorkerAgentControlPort["getWorkerTaskSessionView"]> {
		this.requireControl();
		return projectWorkerTaskSessionView(this.options.getLifecycle().getTaskRuntimeSnapshot());
	}

	/** Snapshot-only activity projection. Unlike waitForWorkerAgent, this never yields scheduler capacity. */
	getWorkerAgentActivity(agentId: string, scope: WorkerAgentControlScope = {}): WorkerAgentActivity {
		this.requireControl();
		const canonicalAgentId = agentId.trim();
		if (!canonicalAgentId) throw new Error("Logical worker agent id is required.");
		const agent = this.options.getLifecycle().getAgent(canonicalAgentId);
		if (!agent) return "unknown";
		this.requireSessionPeer(canonicalAgentId, scope);
		return this.activityForAgent(agent);
	}

	readWorkerAgentTranscript(
		agentId: string,
		options: WorkerAgentTranscriptOptions = {},
	): ReturnType<WorkerAgentControlPort["readWorkerAgentTranscript"]> {
		this.requireControl();
		const agent = this.requireControllableAgent(agentId, options);
		const cursor = options.cursor ?? 0;
		const maxMessages = options.maxMessages ?? 16;
		if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError("Worker transcript cursor is invalid.");
		if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES) {
			throw new TypeError(
				`Worker transcript page size must be from 1 through ${MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES} messages.`,
			);
		}
		const page = this.conversations
			.open({
				agentDir: this.options.agentDir,
				resumeContext: agent.resumeContext,
				expectedLogicalAgentId: agent.agentId,
			})
			.getRawTranscriptPage({
				cursor,
				maxMessages,
				...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
			});
		return {
			agentId: agent.agentId,
			...page,
		};
	}

	sendWorkerAgentMessage(
		agentId: string,
		message: string,
		options: WorkerAgentMessageOptions = {},
	): { messageId: string; queued: true } {
		this.requireControl();
		this.rejectGenericReplyOptions(options);
		const agent = this.requireSessionPeer(agentId, { callerAgentId: options.senderAgentId });
		this.assertAgentAcceptsNewMessages(agent, options.idempotencyKey);
		const queued = this.enqueuePeerMessage(agent, "follow_up", message, options);
		this.notifyStateChangedBestEffort();
		return { messageId: queued.messageId, queued: true };
	}

	broadcastWorkerAgentMessage(
		agentIds: readonly string[],
		message: string,
		options: WorkerAgentBroadcastOptions,
	): WorkerAgentBroadcastResult {
		this.requireControl();
		const canonicalAgentIds = this.canonicalAgentIdSet(agentIds, "Worker broadcast");
		const recipients = canonicalAgentIds.map((agentId) => ({
			agentId,
			idempotencyKey: workerAgentBroadcastTargetIdempotencyKey(options.idempotencyKey, agentId),
		}));
		const senderAgentId = options.senderAgentId ? this.requireKnownAgent(options.senderAgentId).agentId : undefined;
		let created = false;
		const results = recipients.map(({ agentId, idempotencyKey }) => {
			try {
				const target = this.requireSessionPeer(agentId, { callerAgentId: senderAgentId });
				this.assertAgentAcceptsNewMessages(target, idempotencyKey);
				const messageOptions = senderAgentId
					? {
							senderAgentId,
							...(options.threadId !== undefined ? { threadId: options.threadId } : {}),
							...(options.expectReply === true ? { expectReply: true } : {}),
							idempotencyKey,
						}
					: this.sessionRootMessageOptions({
							...(options.threadId !== undefined ? { threadId: options.threadId } : {}),
							...(options.expectReply === true ? { expectReply: true } : {}),
							idempotencyKey,
						});
				const queued = this.enqueuePeerMessage(target, "follow_up", message, messageOptions);
				created ||= queued.status === "retained" && queued.created;
				return {
					agentId,
					accepted: true as const,
					queued: true as const,
					replayed: queued.status === "completed_replay" || !queued.created,
					messageId: queued.messageId,
				};
			} catch (error) {
				return {
					agentId,
					accepted: false as const,
					error: (error instanceof Error ? error.message : String(error)).slice(0, MAX_BROADCAST_ERROR_CHARS),
				};
			}
		});
		if (created) this.notifyStateChangedBestEffort();
		return { results };
	}

	followUpWorkerAgent(
		agentId: string,
		message: string,
		options: WorkerAgentMessageOptions = {},
	): { started: boolean; steering: boolean; messageId: string; record?: LaneRecord; skipReason?: string } {
		this.requireControl();
		const agent = this.requireControllableAgent(agentId, { callerAgentId: options.senderAgentId });
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
		const agent = this.requireControllableAgent(canonicalAgentId, options);
		const dependsOnTaskIds = normalizeWorkerAgentDependencyTaskIds(options.dependsOnTaskIds);
		if (options.idempotencyKey !== undefined) {
			const replay = this.replayWorkerAgentTask(agent, message, options.idempotencyKey, dependsOnTaskIds);
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
			dependsOnTaskIds,
		);
	}

	private replayWorkerAgentTask(
		agent: AgentBindingContract,
		message: string,
		idempotencyKey: string,
		dependsOnTaskIds: readonly string[],
	): { started: boolean; steering: false; messageId: string; record?: LaneRecord; skipReason?: string } | undefined {
		this.assertIdempotencyTarget(agent.agentId, idempotencyKey);
		const messageId = workerAgentMessageId(this.options.parentSessionId, idempotencyKey);
		const mailbox = this.getMailbox(agent.agentId);
		const correlatedAttempt = this.controlMessageAttemptById(agent.agentId, messageId);
		if (correlatedAttempt) {
			if (correlatedAttempt.dispatch.instructions !== message.trim()) {
				throw new Error("Worker control idempotency identity conflicts with its durable dispatch.");
			}
			this.assertAttemptDependencyIdentity(correlatedAttempt, dependsOnTaskIds);
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
			task: {
				kind: "agent_turn",
				...(dependsOnTaskIds.length > 0 ? { dependsOnTaskIds } : {}),
			},
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
		dependsOnTaskIds: readonly string[] = [],
	): { started: boolean; steering: false; messageId: string; record?: LaneRecord; skipReason?: string } {
		if (!this.isAcceptedControlReplay(agent.agentId, options.idempotencyKey)) {
			const headroomSkipReason = this.options.taskStartHeadroomSkipReason?.(agent);
			if (headroomSkipReason)
				return { started: false, steering: false, messageId: "", skipReason: headroomSkipReason };
			const skipReason = this.reusableTaskAdmissionSkipReason(agent.agentId);
			if (skipReason) return { started: false, steering: false, messageId: "", skipReason };
		}
		const queued = this.enqueuePeerMessage(agent, "follow_up", message, options, {
			kind: "agent_turn",
			...(dependsOnTaskIds.length > 0 ? { dependsOnTaskIds } : {}),
		});
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

	private assertAttemptDependencyIdentity(attempt: AttemptRuntimeState, dependsOnTaskIds: readonly string[]): void {
		const snapshot = this.options.getLifecycle().getTaskRuntimeSnapshot() as Partial<
			ReturnType<WorkerLifecycle["getTaskRuntimeSnapshot"]>
		>;
		const durableDependencies = snapshot.tasks?.[attempt.taskId]?.task.dependsOn;
		if (!durableDependencies) {
			if (dependsOnTaskIds.length > 0) {
				throw new Error("Worker control idempotency dependency projection is missing.");
			}
			return;
		}
		if (
			durableDependencies.length !== dependsOnTaskIds.length ||
			durableDependencies.some((dependencyId, index) => dependencyId !== dependsOnTaskIds[index])
		) {
			throw new Error("Worker control idempotency identity conflicts with its durable task dependencies.");
		}
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
		if (typeof projected.content !== "string") {
			throw new Error("Worker control transcript projection is not textual.");
		}
		const reconciliation = conversation.reconcileWorkerControlMessage(
			{ messageId, content: projected.content },
			projected,
			appendIfMissing,
		);
		return { messageId, delivered: reconciliation.delivered };
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
		try {
			const request = this.options.recoveredRequest(attempt);
			this.options.scheduler.enqueue(record, request, true, request.verificationOfTaskId !== undefined);
		} catch (error) {
			return {
				started: false,
				record,
				skipReason: error instanceof Error ? error.message : String(error),
			};
		}
		try {
			this.options.scheduler.drain();
		} catch (error) {
			return {
				started: true,
				record,
				skipReason: `worker_resume_recovery_pending:${error instanceof Error ? error.message : String(error)}`,
			};
		}
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

	retireWorkerAgent(agentId: string, scope: WorkerAgentControlScope = {}): WorkerAgentRetireResult {
		this.requireControl();
		let target = this.requireControllableAgent(agentId, scope);
		if (target.status === "retired") {
			return { agent: this.workerAgentView(target), retired: true, replayed: true };
		}
		const activity = this.activityForAgent(target);
		if (activity !== "idle") {
			throw new Error(`Logical worker agent '${target.agentId}' cannot retire while ${activity}.`);
		}
		const mailbox = this.getMailbox(target.agentId);
		if (mailbox.pendingTaskBearing().length > 0) {
			this.reconcileTaskBearingMailbox(target.agentId);
			target = this.requireControllableAgent(target.agentId, scope);
		}
		this.reconcileWorkerReplyOutboxesBestEffort();
		const pendingMessages = mailbox.pending();
		if (pendingMessages.length > 0) {
			throw new Error(
				`Logical worker agent '${target.agentId}' has ${pendingMessages.length} pending control message${pendingMessages.length === 1 ? "" : "s"}.`,
			);
		}
		const unresolvedReplyCount = mailbox.awaitingReplies().length + mailbox.listReplyAcknowledgements().length;
		if (unresolvedReplyCount > 0) {
			throw new Error(
				`Logical worker agent '${target.agentId}' has ${unresolvedReplyCount} unresolved reply obligation${unresolvedReplyCount === 1 ? "" : "s"}.`,
			);
		}
		const retired = this.options.getLifecycle().retireAgent(target.agentId);
		this.notifyStateChangedBestEffort();
		return { agent: this.workerAgentView(retired), retired: true, replayed: false };
	}

	/** Event-driven wait: durable projection plus one shared state notification, never output polling. */
	waitForWorkerAgent(
		agentId: string,
		timeoutMs = 30_000,
		scope: WorkerAgentControlScope = {},
	): Promise<{ status: WorkerAgentActivity; timedOut: boolean }> {
		return this.waitForWorkerAgents([agentId], "all", timeoutMs, scope).then((result) => ({
			status: result.statuses[0]?.status ?? "unknown",
			timedOut: result.timedOut,
		}));
	}

	/** One event-driven wait set with one shared caller-capacity lease; never per-agent promise polling. */
	waitForWorkerAgents(
		agentIds: readonly string[],
		mode: WorkerAgentWaitMode,
		timeoutMs = 30_000,
		scope: WorkerAgentControlScope = {},
	): ReturnType<WorkerAgentControlPort["waitForWorkerAgents"]> {
		this.requireControl();
		if (mode !== "any" && mode !== "all") throw new TypeError("Worker wait mode must be 'any' or 'all'.");
		const canonicalAgentIds = this.canonicalAgentIdSet(agentIds, "Worker wait");
		const baselineSnapshot = this.options.getLifecycle().getTaskRuntimeSnapshot();
		let callerAgentId: string | undefined;
		if (scope.callerAgentId) {
			callerAgentId = scope.callerAgentId.trim();
			if (!callerAgentId || !baselineSnapshot.agents[callerAgentId]) {
				throw new Error(`Unknown logical worker agent '${callerAgentId}'.`);
			}
		}
		const boundedTimeoutMs = Number.isFinite(timeoutMs)
			? Math.max(1, Math.min(Math.floor(timeoutMs), 300_000))
			: 30_000;
		const statusesFromSnapshot = (snapshot: TaskRuntimeProjection) => {
			const latestAttempts = this.latestAttemptsByAgent(snapshot);
			return canonicalAgentIds.map((agentId) => {
				const agent = snapshot.agents[agentId];
				return {
					agentId,
					status: agent
						? this.projectAgentActivity(agent, latestAttempts.get(agent.agentId))
						: ("unknown" as const),
				};
			});
		};
		const currentStatuses = () => statusesFromSnapshot(this.options.getLifecycle().getTaskRuntimeSnapshot());
		const baselineStatuses = statusesFromSnapshot(baselineSnapshot);
		const baselineByAgentId = new Map(baselineStatuses.map(({ agentId, status }) => [agentId, status]));
		const updatedAgentIds = new Set<string>();
		const recordUpdates = (statuses: typeof baselineStatuses) => {
			for (const { agentId, status } of statuses) {
				if (baselineByAgentId.get(agentId) !== status) updatedAgentIds.add(agentId);
			}
		};
		const waitSatisfied = (statuses: typeof baselineStatuses) => {
			return mode === "any"
				? statuses.some(({ status }) => status !== "active")
				: statuses.every(({ status }) => status !== "active");
		};
		const result = (statuses: typeof baselineStatuses, timedOut: boolean) => ({
			statuses,
			updatedAgentIds: canonicalAgentIds.filter((agentId) => updatedAgentIds.has(agentId)),
			timedOut,
		});
		if (waitSatisfied(baselineStatuses)) return Promise.resolve(result(baselineStatuses, false));
		if (callerAgentId) {
			const activeAgentIds = new Set(
				baselineStatuses.filter(({ status }) => status === "active").map(({ agentId }) => agentId),
			);
			if (activeAgentIds.has(callerAgentId)) {
				throw new Error(
					`Worker wait would deadlock: logical worker '${callerAgentId}' cannot wait for itself. Finish the caller task instead.`,
				);
			}
		}
		return new Promise((resolve, reject) => {
			let settled = false;
			let completionTimedOut: boolean | undefined;
			let failure: unknown;
			let hasFailure = false;
			let yieldInitialized = callerAgentId === undefined;
			let restoreYield: (() => boolean | undefined) | undefined;
			let unsubscribeState = (): void => undefined;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			// A blocked restore (another lane still holds the caller's write reservation) is a
			// live-lock, not a terminal failure or success. subscribeStateChanges is not that
			// wakeup — reservation release is. subscribeReservationAvailability is the event;
			// restoreDeadlineTimer is only the watchdog if that event never arrives.
			let unsubscribeReservation = (): void => undefined;
			let restoreDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
			let restoreRetryDeadline: number | undefined;
			const cleanup = () => {
				unsubscribeState();
				unsubscribeReservation();
				if (timeout) clearTimeout(timeout);
				if (restoreDeadlineTimer) clearTimeout(restoreDeadlineTimer);
			};
			const restoreCaller = (): boolean => {
				if (!restoreYield) return true;
				const restored = restoreYield();
				if (restored === false) return false;
				restoreYield = undefined;
				return true;
			};
			const settle = () => {
				if (settled || !yieldInitialized) return;
				const statuses = currentStatuses();
				recordUpdates(statuses);
				if (!hasFailure && completionTimedOut === undefined) {
					if (!waitSatisfied(statuses)) return;
					completionTimedOut = false;
					if (timeout) {
						clearTimeout(timeout);
						timeout = undefined;
					}
				}
				try {
					if (!restoreCaller()) {
						restoreRetryDeadline ??= Date.now() + WORKER_WAIT_RESTORE_MAX_MS;
						const remainingMs = restoreRetryDeadline - Date.now();
						if (remainingMs <= 0) {
							failure = new Error(
								"Worker wait completed but could not restore the caller's write reservation within the retry bound; another lane continues to hold it.",
							);
							hasFailure = true;
						} else {
							if (!restoreDeadlineTimer) {
								restoreDeadlineTimer = setTimeout(settle, remainingMs);
								if (typeof restoreDeadlineTimer === "object" && "unref" in restoreDeadlineTimer) {
									restoreDeadlineTimer.unref();
								}
							}
							return;
						}
					}
				} catch (error) {
					failure = error;
					hasFailure = true;
				}
				settled = true;
				cleanup();
				if (hasFailure) reject(failure);
				else resolve(result(statuses, completionTimedOut ?? false));
			};
			unsubscribeState = this.subscribeStateChanges(settle);
			if (this.options.subscribeReservationAvailability) {
				unsubscribeReservation = this.options.subscribeReservationAvailability(settle);
			}
			timeout = setTimeout(() => {
				if (settled) return;
				timeout = undefined;
				if (completionTimedOut === undefined) completionTimedOut = true;
				settle();
			}, boundedTimeoutMs);
			if (typeof timeout === "object" && "unref" in timeout) timeout.unref();
			try {
				let yielded = false;
				if (callerAgentId && this.options.yieldCallerForWait) {
					restoreYield = this.options.yieldCallerForWait(callerAgentId);
					yielded = restoreYield !== undefined;
				}
				if (!yielded && callerAgentId) {
					const statuses = currentStatuses();
					const activeAgentIds = new Set(
						statuses.filter(({ status }) => status === "active").map(({ agentId }) => agentId),
					);
					const blockedAgentIdSet = new Set(
						this.options.waitBlockedByCaller?.(callerAgentId, canonicalAgentIds) ?? [],
					);
					const blockedAgentIds = canonicalAgentIds.filter(
						(agentId) => activeAgentIds.has(agentId) && blockedAgentIdSet.has(agentId),
					);
					if (blockedAgentIds.length > 0) {
						hasFailure = true;
						failure = new Error(
							`Worker wait would deadlock: ${blockedAgentIds.join(", ")} ${blockedAgentIds.length === 1 ? "is" : "are"} blocked by the caller's write reservation.`,
						);
					}
				}
				yieldInitialized = true;
			} catch (error) {
				yieldInitialized = true;
				hasFailure = true;
				failure = error;
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
		const delivered = conversation.findDeliveredWorkerControlMessageIds(
			pending.map((message) => {
				const projected = this.mailboxMessage(message);
				if (typeof projected.content !== "string") {
					throw new Error("Worker control transcript projection is not textual.");
				}
				return { messageId: message.messageId, content: projected.content };
			}),
		);
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
		const snapshot = this.options.getWorkerClaimSnapshot?.(args.record.laneId);
		const outputArtifact = workerTerminalOutputArtifact(this.options.getWorkerResult?.(args.record.laneId));
		const content = buildWorkerTerminalHandoffContent({
			...args,
			...(outputArtifact ? { outputArtifact } : {}),
			...(snapshot?.claim
				? {
						claim: {
							summary: snapshot.claim.summary,
							status: snapshot.claim.status,
							changedFiles: snapshot.claim.changedFiles,
							blockers: snapshot.claim.blockers,
						},
					}
				: {}),
		});
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
				const reuseSkipReason = this.reusableTaskAdmissionSkipReason(agent.agentId);
				if (reuseSkipReason) {
					this.reconcileControlTranscript(agent, message, true);
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
					const prepared = this.options.getLifecycle().prepareAgentTurn({
						agentId: agent.agentId,
						instructions: message.content,
						controlMessageId: message.messageId,
						...(message.task?.kind === "agent_turn" && message.task.dependsOnTaskIds
							? { dependsOnTaskIds: message.task.dependsOnTaskIds }
							: {}),
					});
					// `created` is the ledger's own decision, not a reconstruction of it -- a replayed
					// control message (e.g. a mailbox message redelivered after a resume) returns an
					// attempt that may predate the current process, and must never be re-stamped with
					// this process's epoch.
					if (prepared.created) {
						const ownerEpoch = this.options.getCurrentSubmissionEpoch?.();
						if (ownerEpoch !== undefined) this.options.noteLaneOwnerEpoch?.(prepared.record.laneId, ownerEpoch);
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

	private canonicalAgentIdSet(agentIds: readonly string[], label: string): string[] {
		if (!Array.isArray(agentIds) || agentIds.length < 1 || agentIds.length > MAX_ORCHESTRATION_COLLECTION_LENGTH) {
			throw new TypeError(
				`${label} agent ids must contain from 1 through ${MAX_ORCHESTRATION_COLLECTION_LENGTH} entries.`,
			);
		}
		const canonicalAgentIds: string[] = [];
		const seenAgentIds = new Set<string>();
		for (const agentId of agentIds) {
			if (typeof agentId !== "string") throw new TypeError("Logical worker agent id is required.");
			const canonicalAgentId = agentId.trim();
			if (!canonicalAgentId) throw new TypeError("Logical worker agent id is required.");
			if (canonicalAgentId.length > MAX_ORCHESTRATION_IDENTIFIER_LENGTH) {
				throw new TypeError(`Logical worker agent id exceeds ${MAX_ORCHESTRATION_IDENTIFIER_LENGTH} characters.`);
			}
			if (seenAgentIds.has(canonicalAgentId)) continue;
			seenAgentIds.add(canonicalAgentId);
			canonicalAgentIds.push(canonicalAgentId);
		}
		return canonicalAgentIds;
	}

	private requireKnownAgent(agentId: string): AgentBindingContract {
		const normalized = agentId.trim();
		if (!normalized) throw new Error("Logical worker agent id is required.");
		const agent = this.options.getLifecycle().getAgent(normalized);
		if (!agent) throw new Error(`Unknown logical worker agent '${normalized}'.`);
		return agent;
	}

	private requireSessionPeer(agentId: string, scope: WorkerAgentControlScope): AgentBindingContract {
		const target = this.requireKnownAgent(agentId);
		if (scope.callerAgentId) this.requireKnownAgent(scope.callerAgentId);
		return target;
	}

	private agentIsInCallerSubtree(target: AgentBindingContract, callerAgentId: string): boolean {
		const caller = this.options.getLifecycle().getAgent(callerAgentId);
		if (!caller) return false;
		let cursor: AgentBindingContract | undefined = target;
		const visited = new Set<string>();
		while (cursor && !visited.has(cursor.agentId)) {
			if (cursor.agentId === caller.agentId) return true;
			visited.add(cursor.agentId);
			cursor = cursor.parentAgentId ? this.options.getLifecycle().getAgent(cursor.parentAgentId) : undefined;
		}
		return false;
	}

	private requireControllableAgent(agentId: string, scope: WorkerAgentControlScope): AgentBindingContract {
		const target = this.requireSessionPeer(agentId, scope);
		if (!scope.callerAgentId) return target;
		if (this.agentIsInCallerSubtree(target, scope.callerAgentId)) return target;
		throw new Error(`Logical worker agent '${target.agentId}' is outside its control subtree.`);
	}

	private latestAgentAttempt(agent: AgentBindingContract): AttemptRuntimeState | undefined {
		const lifecycle = this.options.getLifecycle();
		const latest = lifecycle.getLatestAgentAttempt?.(agent.agentId);
		if (latest) return latest;
		return agent.activeAttemptId ? lifecycle.getTaskRuntimeSnapshot().attempts[agent.activeAttemptId] : undefined;
	}

	private latestAttemptsByAgent(snapshot: TaskRuntimeProjection): Map<string, AttemptRuntimeState> {
		return latestAgentAttemptsByDurableOrder(snapshot);
	}

	private activityForAgent(agent: AgentBindingContract): WorkerAgentActivity {
		return this.projectAgentActivity(agent, this.latestAgentAttempt(agent));
	}

	private projectAgentActivity(
		agent: AgentBindingContract,
		attempt: AttemptRuntimeState | undefined,
	): WorkerAgentActivity {
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

	private isAcceptedControlReplay(agentId: string, idempotencyKey: string | undefined): boolean {
		if (idempotencyKey === undefined) return false;
		const messageId = workerAgentMessageId(this.options.parentSessionId, idempotencyKey);
		const mailbox = this.getMailbox(agentId);
		return mailbox.getMessage(messageId) !== undefined || mailbox.hasControlReplayReceipt(messageId);
	}

	private reusableTaskAdmissionSkipReason(agentId: string): string | undefined {
		const admission = evaluateReusableWorkerTaskAdmission(
			this.options.getLifecycle().getTaskRuntimeSnapshot(),
			agentId,
		);
		return admission.ok ? undefined : admission.reasonCode;
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

	private workerAgentView(
		agent: AgentBindingContract,
		activity: WorkerAgentActivity = this.activityForAgent(agent),
		callerAgentId?: string,
	): WorkerAgentView {
		return {
			agentId: agent.agentId,
			...(agent.parentAgentId ? { parentAgentId: agent.parentAgentId } : {}),
			rootAgentId: agent.rootAgentId,
			depth: agent.depth,
			role: agent.role,
			...(agent.resumeContext.modelRef ? { modelRef: agent.resumeContext.modelRef } : {}),
			status: agent.status,
			activity,
			controllable: !callerAgentId || this.agentIsInCallerSubtree(agent, callerAgentId),
			createdAt: agent.createdAt,
			updatedAt: agent.updatedAt,
		};
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
