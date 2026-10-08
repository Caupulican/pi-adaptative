import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { UserMessage } from "@caupulican/pi-ai";
import type { AgentHaltRequest, AgentMessage } from "../../kernel/index.ts";
import type { WorkerDelegationRunOutcome } from "../agent-session-contracts.ts";
import type { WorkerHostVerdict } from "../autonomy/contracts.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { GoalState } from "../goals/goal-state.ts";
import { latestAgentAttemptsByDurableOrder } from "../orchestration/attempt-ordering.ts";
import {
	type AgentBindingContract,
	type ArtifactContract,
	MAX_ORCHESTRATION_COLLECTION_LENGTH,
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	type WorkerResultContract,
} from "../orchestration/contracts.ts";
import type { SpecialistContextClaim } from "../orchestration/specialist-context-ownership.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { terminalAttemptStatus } from "../orchestration/task-runtime-state.ts";
import { DEFAULT_WORKER_DELEGATION_HALT_REPORT_DEADLINE_MS } from "../settings/settings-rules.ts";
import { recordDiscardedObligations } from "./obligation-ledger.ts";
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
	normalizeWorkerAgentNewTaskCorrelation,
	type SessionRootWorkerAgentMessageOptions,
	type WorkerAgentActivity,
	type WorkerAgentBroadcastOptions,
	type WorkerAgentBroadcastResult,
	type WorkerAgentControlPort,
	type WorkerAgentControlScope,
	type WorkerAgentLaneResolution,
	WorkerAgentMailbox,
	type WorkerAgentMailboxResourceSnapshot,
	type WorkerAgentMessage,
	type WorkerAgentMessageOptions,
	type WorkerAgentNewTaskCorrelation,
	type WorkerAgentReplyResult,
	type WorkerAgentRetireOptions,
	type WorkerAgentRetireResult,
	type WorkerAgentTaskMetadata,
	type WorkerAgentTaskStartOptions,
	type WorkerAgentTranscriptOptions,
	type WorkerAgentView,
	type WorkerAgentWaitMode,
	WorkerControlDeadLetteredError,
	workerAgentBroadcastTargetIdempotencyKey,
	workerAgentMessageId,
} from "./worker-agent-control.ts";
import { fenceWorkerClaimValues, workerClaimSettlementLines } from "./worker-claim.ts";
import {
	MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES,
	type WorkerConversation,
	WorkerConversationStore,
} from "./worker-conversation-store.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";
import { formatWorkerDispatchWait, type WorkerDispatchScheduler } from "./worker-dispatch-scheduler.ts";
import {
	deriveClaimOnlyWorkerDisposition,
	deriveWorkerDispositionFromProjections,
	describeWorkerDisposition,
	describeWorkerHostVerdict,
	WORKER_DISPOSITION_ADVICE_NOTE,
	type WorkerDispositionAdvice,
	workerDispositionGuidance,
	workerHostVerdictView,
} from "./worker-disposition.ts";
import { evaluateReusableWorkerTaskAdmission } from "./worker-fleet-limits.ts";
import { normalizeWorkerHaltReason, WorkerLaneHalts } from "./worker-halt.ts";
import { attemptVerification } from "./worker-lane-projection.ts";
import type { WorkerLifecycle } from "./worker-lifecycle.ts";
import { isWorkerTaskPrompt } from "./worker-runner.ts";
import { projectWorkerTaskSessionView } from "./worker-task-view.ts";
import { WORKER_COMPLETION_ERROR_CAVEMAN_GUIDANCE } from "./worker-terminal-handoff-coordinator.ts";
import { workerTerminalOutputArtifact } from "./worker-terminal-output-artifact.ts";

export interface WorkerAgentControlCoordinatorOptions {
	agentDir: string;
	parentSessionId: string;
	processOwnerId: string;
	/** Controller-owned composition dependency; standalone coordinators receive a private default. */
	conversationStore?: WorkerConversationStore;
	getConversationClaim?(agent: AgentBindingContract): SpecialistContextClaim | undefined;
	peekConversationClaim?(agent: AgentBindingContract): SpecialistContextClaim | undefined;
	withConversationAdmission?<T>(agent: AgentBindingContract, operation: () => T): T;
	isControlAvailable(): boolean;
	getLifecycle(): WorkerLifecycle;
	recoveredRequest(attempt: AttemptRuntimeState): WorkerDelegationRequest;
	run(request: WorkerDelegationRequest, record: LaneRecord): Promise<WorkerDelegationRunOutcome>;
	scheduler: Pick<WorkerDispatchScheduler, "enqueue" | "track" | "drain" | "dropQueued"> &
		Partial<Pick<WorkerDispatchScheduler, "getWaitState">>;
	statusChanged(): void;
	/** The claim of this exact task and terminal generation; missing proof never adopts an older claim. */
	getWorkerClaimSnapshot?(taskId: string, attemptId: string): WorkerClaimSnapshotPayload | undefined;
	/** The goal state the recommended disposition reads; absent leaves uncovered requirements unknown. */
	getGoalState?(): Pick<GoalState, "requirements"> | undefined;
	/** Exact attempt result for a terminal delivery, never a newer result selected by its task. */
	getWorkerResult?(attemptId: string): Pick<WorkerResultContract, "artifacts"> | undefined;
	abortLane(laneId: string, reasonCode: string): void;
	cancelLane(laneId: string, reasonCode: string): LaneRecord | undefined;
	taskStartHeadroomSkipReason?(agent: AgentBindingContract): string | undefined;
	/**
	 * False while the specialist's last execution still holds resources -- its tool surface has not
	 * finished disposing. Durable idleness is not evidence of release, so every acceptance path
	 * consults this owner before admitting new work onto the same context.
	 */
	isSpecialistSettled?(agentId: string): boolean;
	waitBlockedByCaller?(callerAgentId: string, targetAgentIds: readonly string[]): readonly string[];
	/** Yield caller-owned scheduler and mutation resources until the returned restorer succeeds. */
	yieldCallerForWait?(callerAgentId: string): (() => boolean | undefined) | undefined;
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
	/** How long an interrupted worker gets to reach a request boundary and report. */
	haltReportDeadlineMs?(): number;
}

type QueuedPeerMessage = ReturnType<WorkerAgentMailbox["enqueueWithReceipt"]>;

export interface WorkerAgentControlResourceSnapshot {
	readonly stateListenerCount: number;
	readonly reconcilingTaskBearingCount: number;
	readonly scheduledReconciliationCount: number;
	readonly loadedMailboxes: readonly WorkerAgentMailboxResourceSnapshot[];
}

const MAX_BROADCAST_ERROR_CHARS = 512;

/** Attempt statuses whose task has not reached a terminal outcome. */
const LIVE_ATTEMPT_STATUSES: ReadonlySet<string> = new Set(["queued", "leased", "running", "suspended"]);

/**
 * Independent bound on how long a blocked restore may wait for a reservation-availability event,
 * deliberately NOT derived from the caller's own (possibly very short, e.g. test-only 1ms) wait
 * timeoutMs: the original wait already finished (satisfied or timed out) by the time restoration
 * starts. This is a watchdog, not a poll — retries are driven by subscribeReservationAvailability.
 * Mirrors the documented 300s absolute ceiling used elsewhere in this method.
 */
const WORKER_WAIT_RESTORE_MAX_MS = 300_000;

const WORKER_WAIT_DEFAULT_MS = 30_000;

/** The bounded duration of one worker wait: whole milliseconds in [1, 300s]; non-finite input waits the default. */
export function boundWorkerWaitTimeoutMs(timeoutMs: number): number {
	return Number.isFinite(timeoutMs) ? Math.max(1, Math.min(Math.floor(timeoutMs), 300_000)) : WORKER_WAIT_DEFAULT_MS;
}

export function buildWorkerTerminalHandoffContent(args: {
	childAgentId: string;
	record: Pick<LaneRecord, "laneId" | "status" | "reasonCode">;
	outputArtifact?: ArtifactContract;
	claim?: {
		summary?: string;
		status?: string;
		changedFiles?: readonly string[];
		blockers?: readonly string[];
		inconclusive?: readonly string[];
		systemOneSettled?: readonly string[];
		ownerFollowUp?: string;
	};
	/** The host's judgment of the claim against the receipts; absent on a legacy claim. */
	hostVerdict?: WorkerHostVerdict;
	/** Advice for the receiving agent; the root decides. */
	recommendedDisposition?: WorkerDispositionAdvice;
}): string {
	const sanitize = (value: string): string => value.replace(/[\r\n]+/g, " ").slice(0, 120);
	// This content is stored and replayed against a durable mailbox record, so the fence nonce is fixed per
	// child and lane rather than random. A literal nonce inside worker text is still neutralized.
	const source = `worker-claim:${args.record.laneId}`;
	const nonce = createHash("sha256")
		.update(`worker-terminal-handoff\0${args.childAgentId}\0${args.record.laneId}`)
		.digest("hex")
		.slice(0, 32);
	const fence = (values: readonly string[]): string => fenceWorkerClaimValues(values, sanitize, source, nonce);
	return [
		"Worker terminal handoff",
		`childAgentId=${args.childAgentId}`,
		`laneId=${args.record.laneId}`,
		`status=${args.record.status}`,
		...(args.record.reasonCode ? [`reasonCode=${sanitize(args.record.reasonCode).replace(/[^\w.:,-]/g, "_")}`] : []),
		...(args.outputArtifact
			? [
					`fullOutput=${args.outputArtifact.uri}${args.outputArtifact.sizeBytes === undefined ? "" : ` (${args.outputArtifact.sizeBytes} bytes)`}`,
				]
			: []),
		...(args.claim?.summary ? [`claimStatus=${args.claim.status || args.record.status}`] : []),
		...(args.claim?.summary ? [`claimSummary (untrusted worker evidence):\n${fence([args.claim.summary])}`] : []),
		...(args.claim?.changedFiles && args.claim.changedFiles.length > 0
			? [`changedFiles (untrusted worker evidence):\n${fence(args.claim.changedFiles)}`]
			: []),
		...(args.claim?.blockers && args.claim.blockers.length > 0
			? [`blockers (untrusted worker evidence):\n${fence(args.claim.blockers)}`]
			: []),
		...(args.claim ? workerClaimSettlementLines(args.claim, sanitize, source, nonce) : []),
		...(args.hostVerdict ? [describeWorkerHostVerdict(args.hostVerdict)] : []),
		...(args.recommendedDisposition
			? [
					describeWorkerDisposition(args.recommendedDisposition),
					`${WORKER_DISPOSITION_ADVICE_NOTE} Next step: ${workerDispositionGuidance(args.recommendedDisposition, args.hostVerdict)}.`,
				]
			: []),
		"CAVEMAN MODE - MANDATORY: terminal handoff means worker state was retained. Read the full transcript, verify the claim, then continue or replan within the admitted grant. Do not call this lost state or harness failure.",
		"MANDATORY: read every transcript page before judging this result.",
		`Start with delegate action="transcript" agentId="${args.childAgentId}" cursor=0.`,
		"Entries complete only after pagination ends. omittedMessages means whole entries were left out of that page. While nextCursor exists, call transcript again with cursor=nextCursor. Stop only when nextCursor is absent.",
		...(args.record.reasonCode === "worker_blocked"
			? [
					"worker_blocked means the durable claim has blockers; it does not mean worker state or transcript was lost.",
					`The worker is idle and waiting on you: answer its blocker or redirect it with delegate action="follow_up" agentId="${args.childAgentId}"; it keeps its transcript. list marks it awaitingParent until a newer task starts.`,
				]
			: []),
		...(args.record.status === "budget_exhausted"
			? [
					"CAVEMAN MODE - MANDATORY: budget_exhausted means an admitted limit ended work, not harness failure. Terminal reasonCode is authoritative; never replace it with earlier transcript errors. Read evidence, then replan only within remaining authority.",
				]
			: []),
		...(args.record.reasonCode === "worker_interrupted"
			? [
					"worker_interrupted means you stopped this worker and the claim above is its own report. Its state and transcript are retained: continue it with delegate follow_up on the same agentId, or retire it.",
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
	private readonly laneHalts = new WorkerLaneHalts();

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

	/** Observe only already-loaded mailbox owners; no getMailbox, reconciliation or admission. */
	getResourceSnapshot(): WorkerAgentControlResourceSnapshot {
		return {
			stateListenerCount: this.stateListeners.size,
			reconcilingTaskBearingCount: this.reconcilingTaskBearingAgentIds.size,
			scheduledReconciliationCount: this.taskBearingContinuationAgentIds.size,
			loadedMailboxes: [...this.mailboxes.values()].map((mailbox) => mailbox.getResourceSnapshot()),
		};
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
			.map((agent) => {
				const attempt = latestAttempts.get(agent.agentId);
				return this.workerAgentView(
					agent,
					this.projectAgentActivity(agent, attempt),
					scope.callerAgentId,
					attempt ?? null,
				);
			});
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
				expectedLogicalAgentId: agent.contextOrigin?.logicalAgentId ?? agent.agentId,
			})
			.getRawTranscriptPage({
				projection: "inspection",
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
		// Bounded ids only: what rides the durable mailbox must survive a restart without carrying a
		// copy of the goal state, whose own durable objective is admitted below before the message is.
		const newTask = normalizeWorkerAgentNewTaskCorrelation(
			options.newTask === undefined
				? undefined
				: {
						...(options.newTask.goal ? { goalId: options.newTask.goal.goalId } : {}),
						...(options.newTask.controlForkMode ? { controlForkMode: options.newTask.controlForkMode } : {}),
						...(options.newTask.requirementIds ? { requirementIds: options.newTask.requirementIds } : {}),
						...(options.newTask.acceptanceCriterionIds
							? { acceptanceCriterionIds: options.newTask.acceptanceCriterionIds }
							: {}),
						...(options.newTask.resourcePointerIds
							? { resourcePointerIds: options.newTask.resourcePointerIds }
							: {}),
					},
		);
		if (options.idempotencyKey !== undefined) {
			const messageId = workerAgentMessageId(this.options.parentSessionId, options.idempotencyKey);
			const admittedOwner = this.admittedSpecialistForControlMessage(messageId);
			if (admittedOwner && admittedOwner !== agent.agentId) {
				// This caller turn already admitted work on another specialist; re-aiming it here would
				// silently start different work under a receipt that means something else. No message id
				// is returned: nothing was accepted into THIS specialist's mailbox.
				return {
					started: false,
					steering: false,
					messageId: "",
					skipReason: "worker_task_replay_target_conflict",
				};
			}
			const replay = this.replayWorkerAgentTask(agent, message, options.idempotencyKey, dependsOnTaskIds, newTask);
			if (replay) return replay;
		}
		const activity = this.activityForAgent(agent);
		if (activity !== "idle") {
			return { started: false, steering: false, messageId: "", skipReason: `worker_${activity}` };
		}
		if (agent.status !== "registered") {
			return { started: false, steering: false, messageId: "", skipReason: `agent_${agent.status}` };
		}
		// Durable idleness is not release: the previous execution may still be disposing its tools.
		if (this.options.isSpecialistSettled?.(agent.agentId) === false) {
			return { started: false, steering: false, messageId: "", skipReason: "worker_cleanup_pending" };
		}
		return this.startIdleAgentTask(
			agent,
			message,
			options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey },
			dependsOnTaskIds,
			newTask,
			options.newTask?.goal,
		);
	}

	private replayWorkerAgentTask(
		agent: AgentBindingContract,
		message: string,
		idempotencyKey: string,
		dependsOnTaskIds: readonly string[],
		newTask?: WorkerAgentNewTaskCorrelation,
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
			// A replay that re-files the same instructions under a different goal -- or that changes its
			// mind between new work and continuation -- is different work, and the ledger would reject
			// it. Report that rather than handing back the original start as if the caller's
			// correlation had been honoured.
			if (
				!this.hasMatchingReceiptIntent(agent.agentId, messageId, message, dependsOnTaskIds, newTask) ||
				!this.hasMatchingNewTaskCorrelation(correlatedAttempt, newTask)
			) {
				return {
					started: false,
					steering: false,
					messageId,
					skipReason: "worker_task_new_task_correlation_conflict",
				};
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
			task: {
				kind: "agent_turn",
				...(dependsOnTaskIds.length > 0 ? { dependsOnTaskIds } : {}),
				...(newTask ? { newTask } : {}),
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
		newTask?: WorkerAgentNewTaskCorrelation,
		newTaskGoal?: GoalState,
	): { started: boolean; steering: false; messageId: string; record?: LaneRecord; skipReason?: string } {
		if (!this.isAcceptedControlReplay(agent.agentId, options.idempotencyKey)) {
			const headroomSkipReason = this.options.taskStartHeadroomSkipReason?.(agent);
			if (headroomSkipReason)
				return { started: false, steering: false, messageId: "", skipReason: headroomSkipReason };
			const skipReason = this.reusableTaskAdmissionSkipReason(agent.agentId);
			if (skipReason) return { started: false, steering: false, messageId: "", skipReason };
		}
		const queued = this.enqueuePeerMessage(
			agent,
			"follow_up",
			message,
			options,
			{
				kind: "agent_turn",
				...(dependsOnTaskIds.length > 0 ? { dependsOnTaskIds } : {}),
				...(newTask ? { newTask } : {}),
			},
			// The goal's acceptance criteria are durable orchestration state that an accepted message
			// needs on recovery, so they are still written BEFORE the message. The mailbox calls this
			// only once it has ruled out every deterministic refusal (bounds, replay identity, pending
			// capacity, encoded-byte admission), so a refused start no longer leaves a new objective.
			newTaskGoal ? () => this.options.getLifecycle().synchronizeGoalState(newTaskGoal) : undefined,
		);
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

	/**
	 * Did this receipt originally declare the same intent? New work and continuation are different
	 * requests for the same text, so the discriminator belongs to the receipt's identity: the durable
	 * mailbox message records what was admitted, and a replay that changed its mind is not a replay.
	 */
	private hasMatchingReceiptIntent(
		agentId: string,
		messageId: string,
		message: string,
		dependsOnTaskIds: readonly string[],
		newTask: WorkerAgentNewTaskCorrelation | undefined,
	): boolean {
		// The mailbox owns replay-intent normalization: it answers from the retained message when it
		// has one, and from that message's durable replay receipt once bounded retention pruned the
		// body. `undefined` means it holds no evidence either way, and unproven is not equal.
		return (
			this.getMailbox(agentId).matchesControlIntent(messageId, {
				content: message,
				task: {
					kind: "agent_turn",
					...(dependsOnTaskIds.length > 0 ? { dependsOnTaskIds } : {}),
					...(newTask ? { newTask } : {}),
				},
			}) === true
		);
	}

	/** Does a durable attempt already carry exactly the correlation this start is asking for? */
	private hasMatchingNewTaskCorrelation(
		attempt: AttemptRuntimeState,
		newTask: WorkerAgentNewTaskCorrelation | undefined,
	): boolean {
		if (!newTask) return true;
		const task = this.options.getLifecycle().getTask(attempt.taskId)?.task;
		if (!task) return false;
		const objectiveId = newTask.goalId ? `goal:${newTask.goalId}` : `session:${this.options.parentSessionId}`;
		return (
			task.objectiveId === objectiveId &&
			attempt.dispatch.controlForkMode === newTask.controlForkMode &&
			isDeepStrictEqual([...(attempt.dispatch.requirementIds ?? [])], [...(newTask.requirementIds ?? [])]) &&
			isDeepStrictEqual([...task.acceptanceCriterionIds], [...(newTask.acceptanceCriterionIds ?? [])]) &&
			// The selected resources are part of the same declaration; a different selection is
			// different work even when goal and requirements match.
			isDeepStrictEqual([...attempt.dispatch.resourcePointerIds], [...(newTask.resourcePointerIds ?? [])])
		);
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
			expectedLogicalAgentId: target.contextOrigin?.logicalAgentId ?? target.agentId,
			...(appendIfMissing ? { projectClaim: this.options.getConversationClaim?.(target) } : {}),
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

	/**
	 * Stop a running worker and make it report. The default is a halt: the worker finishes the request
	 * boundary it is at, is told the parent stopped it, and spends one tool-free request on its own
	 * report, which reaches the parent through the ordinary terminal handoff. A worker that does not
	 * reach that boundary within the deadline is cancelled, and the cancellation is what the parent is
	 * told. `force` keeps the old behavior: suspend and abort at once, nothing is reported, and the
	 * parent resumes the same task.
	 */
	interruptWorkerAgent(
		agentId: string,
		scope: WorkerAgentControlScope = {},
		options: { message?: string; force?: boolean } = {},
	): { interrupted: boolean; mode?: "halt" | "suspend"; reason?: string } {
		const { agent, attempt } = this.controlledAgentAttempt(agentId, scope);
		if (!attempt || (attempt.status !== "running" && attempt.status !== "leased")) {
			return { interrupted: false, reason: "agent_not_running" };
		}
		try {
			if (options.force) {
				this.options.getLifecycle().suspendAgent(attempt.taskId, agent.agentId, this.options.processOwnerId);
				this.options.abortLane(attempt.taskId, "agent_interrupted");
				this.signalStateChanged();
				return { interrupted: true, mode: "suspend" };
			}
			const laneId = attempt.taskId;
			const requested = this.laneHalts.request(
				laneId,
				normalizeWorkerHaltReason(options.message),
				this.options.haltReportDeadlineMs?.() ?? DEFAULT_WORKER_DELEGATION_HALT_REPORT_DEADLINE_MS,
				() => {
					// The worker is inside something that outlived the deadline. Its state is retained; the
					// parent hears about the cancellation through the same terminal handoff.
					this.options.abortLane(laneId, "interrupt_report_deadline");
					this.options.cancelLane(laneId, "interrupt_report_deadline");
				},
			);
			if (!requested) return { interrupted: true, mode: "halt", reason: "halt_already_requested" };
			return { interrupted: true, mode: "halt" };
		} catch (error) {
			return { interrupted: false, reason: error instanceof Error ? error.message : String(error) };
		}
	}

	/** The loop's poll: hands over this lane's halt exactly once. */
	takeLaneHalt(laneId: string): AgentHaltRequest | undefined {
		return this.laneHalts.take(laneId);
	}

	/** Set once the loop has acted on the lane's halt, with the reason the parent gave. */
	deliveredLaneHalt(laneId: string): { reason: string | undefined } | undefined {
		return this.laneHalts.deliveredReason(laneId);
	}

	/** The lane's run is over, however it ended: a halt it never reached is moot. */
	clearLaneHalt(laneId: string): void {
		this.laneHalts.clear(laneId);
	}

	resumeWorkerAgent(
		agentId: string,
		scope: WorkerAgentControlScope = {},
	): { started: boolean; record?: LaneRecord; skipReason?: string; waitReason?: string } {
		const { attempt } = this.controlledAgentAttempt(agentId, scope);
		if (attempt?.status !== "suspended") return { started: false, skipReason: "agent_not_suspended" };
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
		// The scheduler holds the resume when it cannot start yet; say why instead of reporting a run.
		const waitState = this.options.scheduler.getWaitState?.(record.laneId);
		return { started: true, record, ...(waitState ? { waitReason: formatWorkerDispatchWait(waitState) } : {}) };
	}

	cancelWorkerAgent(
		agentId: string,
		reasonCode = "agent_cancelled",
		scope: WorkerAgentControlScope = {},
	): LaneRecord | undefined {
		const { agent, attempt } = this.controlledAgentAttempt(agentId, scope);
		if (!attempt) return undefined;
		// Steers were addressed to the task being cancelled. They settle with it, before the terminal
		// record publishes: publishing reconciles the mailbox, and an undelivered steer would otherwise
		// start as a brand-new turn the owner just cancelled.
		if (LIVE_ATTEMPT_STATUSES.has(attempt.status)) this.deadLetterUndeliveredSteers(agent, reasonCode);
		this.options.abortLane(attempt.taskId, reasonCode);
		const record = this.options.cancelLane(attempt.taskId, reasonCode);
		this.signalStateChanged();
		return record;
	}

	/**
	 * Fail every ordinary steer the cancelled task never received. A steer that carries a reply
	 * obligation is kept: its reply is owed regardless of the task it was addressed to.
	 */
	private deadLetterUndeliveredSteers(agent: AgentBindingContract, reasonCode: string): void {
		const mailbox = this.getMailbox(agent.agentId);
		for (const message of mailbox.pendingTaskBearing()) {
			if (message.kind !== "steer") continue;
			if (this.reconcileTaskBearingTranscriptDelivery(agent, message)) continue;
			mailbox.deadLetterOrdinaryTask(
				message.messageId,
				`worker_task_cancelled:${reasonCode}`.slice(0, MAX_BROADCAST_ERROR_CHARS),
			);
		}
	}

	resolveWorkerAgentLane(agentId: string, scope: WorkerAgentControlScope = {}): WorkerAgentLaneResolution | undefined {
		const { attempt } = this.controlledAgentAttempt(agentId, scope);
		return attempt ? { laneId: attempt.taskId, status: attempt.status } : undefined;
	}

	readWorkerAgentLastText(agentId: string, laneId: string, scope: WorkerAgentControlScope = {}): string | undefined {
		this.requireControl();
		const { attempt } = this.controlledAgentAttempt(agentId, scope);
		// An older lane's words are not this lane's: only the agent's latest task is read.
		if (attempt?.taskId !== laneId) return undefined;
		const agent = this.requireControllableAgent(agentId, scope);
		const messages = this.conversations
			.open({
				agentDir: this.options.agentDir,
				resumeContext: agent.resumeContext,
				expectedLogicalAgentId: agent.contextOrigin?.logicalAgentId ?? agent.agentId,
			})
			.getRawTranscript();
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]!;
			if (message.role === "user") {
				// The attempt's own task prompt bounds the search: nothing before it belongs to this lane.
				const text =
					typeof message.content === "string"
						? message.content
						: message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("");
				if (isWorkerTaskPrompt(text)) return undefined;
				continue;
			}
			if (message.role !== "assistant") continue;
			const text = message.content
				.flatMap((content) => (content.type === "text" ? [content.text] : []))
				.join("")
				.trim();
			if (text) return text;
		}
		return undefined;
	}

	retireWorkerAgent(
		agentId: string,
		scope: WorkerAgentControlScope = {},
		options: WorkerAgentRetireOptions = {},
	): WorkerAgentRetireResult {
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
			if (!options.discardPending) {
				// Name what would be lost; the caller decides with force.
				const listed = pendingMessages
					.slice(0, 5)
					.map((message) => `${message.messageId} (${message.kind}, ${message.content.length} chars)`)
					.join(", ");
				const more = pendingMessages.length > 5 ? `, +${pendingMessages.length - 5} more` : "";
				throw new Error(
					`Logical worker agent '${target.agentId}' has ${pendingMessages.length} pending control message${pendingMessages.length === 1 ? "" : "s"}: ${listed}${more}. Deliver them (resume or follow_up) or retire with force: true to discard them.`,
				);
			}
			// The owner chose to discard these. Each is recorded first (bounded, attributed, content head) in the
			// obligation ledger the retention sweep also uses. An unwritable ledger never blocks the owner's
			// retire: the discard proceeds and the same bounded evidence goes to the warning channel instead.
			mailbox.deadLetterPending("retired_with_force", (discarded) => {
				try {
					recordDiscardedObligations({
						agentDir: this.options.agentDir,
						parentSessionId: this.options.parentSessionId,
						kind: "forced_retire",
						agentId: target.agentId,
						reason: "retired_with_force",
						settled: discarded,
					});
				} catch (error) {
					const heads = discarded
						.slice(0, 4)
						.map((item) => `${item.messageId}: ${item.contentHead.slice(0, 60)}`)
						.join(" | ");
					this.options.warn?.(
						`Forced retire of ${target.agentId} discarded ${discarded.length} pending message(s) but could not write the obligation ledger (${error instanceof Error ? error.message : String(error)}): ${heads}`,
					);
				}
			});
		}
		// Replies other workers sent to this one were just dead-lettered; their sources' open acknowledgements
		// are settled now, after the mailbox lock scope ended, instead of waiting for a later event.
		if (pendingMessages.length > 0) this.reconcileWorkerReplyOutboxesBestEffort();
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
		timeoutMs = WORKER_WAIT_DEFAULT_MS,
		scope: WorkerAgentControlScope = {},
	): ReturnType<WorkerAgentControlPort["waitForWorkerAgent"]> {
		return this.waitForWorkerAgents([agentId], "all", timeoutMs, scope).then((result) => ({
			status: result.statuses[0]?.status ?? "unknown",
			timedOut: result.timedOut,
			...(result.terminalLaneIds ? { terminalLaneIds: result.terminalLaneIds } : {}),
			...(result.foregroundHeldAgentIds ? { foregroundHeld: true } : {}),
		}));
	}

	/** One event-driven wait set with one shared caller-capacity lease; never per-agent promise polling. */
	waitForWorkerAgents(
		agentIds: readonly string[],
		mode: WorkerAgentWaitMode,
		timeoutMs = WORKER_WAIT_DEFAULT_MS,
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
		const boundedTimeoutMs = boundWorkerWaitTimeoutMs(timeoutMs);
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
		const currentSnapshot = () => this.options.getLifecycle().getTaskRuntimeSnapshot();
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
		const result = (statuses: typeof baselineStatuses, timedOut: boolean, snapshot: TaskRuntimeProjection) => {
			const latestAttempts = this.latestAttemptsByAgent(snapshot);
			const statusByAgentId = new Map(statuses.map(({ agentId, status }) => [agentId, status]));
			return {
				statuses,
				updatedAgentIds: canonicalAgentIds.filter((agentId) => updatedAgentIds.has(agentId)),
				timedOut,
				terminalLaneIds: canonicalAgentIds.flatMap((agentId) => {
					const attempt = latestAttempts.get(agentId);
					return statusByAgentId.get(agentId) === "idle" && attempt && terminalAttemptStatus(attempt.status)
						? [attempt.taskId]
						: [];
				}),
			};
		};
		if (waitSatisfied(baselineStatuses)) return Promise.resolve(result(baselineStatuses, false, baselineSnapshot));
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
		// A root wait on a worker the scheduler holds for the foreground turn can never be satisfied inside
		// this turn: the hold lifts only when the turn ends, and a model waiting through it burns its own
		// turn. Return at once and say so. Workers waiting on a sibling keep the ordinary wait.
		if (callerAgentId === undefined && scope.returnWhenForegroundHeld === true) {
			const latestAttempts = this.latestAttemptsByAgent(baselineSnapshot);
			const activeIds = baselineStatuses.filter(({ status }) => status === "active").map(({ agentId }) => agentId);
			const heldIds = activeIds.filter((agentId) => {
				const attempt = latestAttempts.get(agentId);
				return (
					attempt !== undefined && this.options.scheduler.getWaitState?.(attempt.taskId)?.reason === "foreground"
				);
			});
			if (heldIds.length > 0 && (mode === "all" || heldIds.length === activeIds.length)) {
				return Promise.resolve({
					...result(baselineStatuses, false, baselineSnapshot),
					foregroundHeldAgentIds: heldIds,
				});
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
				const snapshot = currentSnapshot();
				const statuses = statusesFromSnapshot(snapshot);
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
				else resolve(result(statuses, completionTimedOut ?? false, snapshot));
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
					const statuses = statusesFromSnapshot(currentSnapshot());
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
		const snapshot = this.options.getWorkerClaimSnapshot?.(args.record.laneId, args.terminalAttemptId);
		const outputArtifact = workerTerminalOutputArtifact(this.options.getWorkerResult?.(args.terminalAttemptId));
		const content = buildWorkerTerminalHandoffContent({
			...args,
			...(outputArtifact ? { outputArtifact } : {}),
			...(snapshot?.claim?.hostVerdict ? { hostVerdict: snapshot.claim.hostVerdict } : {}),
			...(snapshot?.claim ? { recommendedDisposition: deriveClaimOnlyWorkerDisposition(snapshot.claim) } : {}),
			...(snapshot?.claim
				? {
						claim: {
							summary: snapshot.claim.summary,
							status: snapshot.claim.status,
							changedFiles: snapshot.claim.changedFiles,
							blockers: snapshot.claim.blockers,
							...(snapshot.claim.inconclusive ? { inconclusive: snapshot.claim.inconclusive } : {}),
							...(snapshot.claim.systemOneSettled ? { systemOneSettled: snapshot.claim.systemOneSettled } : {}),
							...(snapshot.claim.ownerFollowUp ? { ownerFollowUp: snapshot.claim.ownerFollowUp } : {}),
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
				if (this.options.isSpecialistSettled?.(agent.agentId) === false) {
					// The pending turn stays pending: reconciliation runs again when the execution that
					// still owns this context signals its state change after disposal.
					return { started: false, skipReason: "worker_cleanup_pending" };
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
					const newTask = message.task?.kind === "agent_turn" ? message.task.newTask : undefined;
					const prepared = this.options.getLifecycle().prepareAgentTurn({
						agentId: agent.agentId,
						instructions: message.content,
						controlMessageId: message.messageId,
						...(message.task?.kind === "agent_turn" && message.task.dependsOnTaskIds
							? { dependsOnTaskIds: message.task.dependsOnTaskIds }
							: {}),
						// The persisted declaration of new work, read back from the mailbox: the process that
						// enqueued it may be long gone, and no caller repeats it after a restart.
						...(newTask
							? {
									...(newTask.goalId ? { goalId: newTask.goalId } : {}),
									...(newTask.controlForkMode ? { controlForkMode: newTask.controlForkMode } : {}),
									taskContext: {
										...(newTask.requirementIds ? { requirementIds: newTask.requirementIds } : {}),
										...(newTask.acceptanceCriterionIds
											? { acceptanceCriterionIds: newTask.acceptanceCriterionIds }
											: {}),
										...(newTask.resourcePointerIds ? { resourcePointerIds: newTask.resourcePointerIds } : {}),
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

	/**
	 * The specialist a caller turn already admitted work on, whichever entrance admitted it. One
	 * durable control-message identity owns exactly one task, so a later start that names a DIFFERENT
	 * specialist under the same identity is a different request, not a replay of this one.
	 */
	private admittedSpecialistForControlMessage(messageId: string): string | undefined {
		for (const attempt of Object.values(this.options.getLifecycle().getTaskRuntimeSnapshot().attempts)) {
			if (attempt.dispatch.controlMessageId !== messageId) continue;
			const owner = attempt.agentId ?? attempt.dispatch.logicalLaneId;
			if (owner) return owner;
		}
		return undefined;
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
				expectedLogicalAgentId: agent.contextOrigin?.logicalAgentId ?? agent.agentId,
				projectClaim: this.options.getConversationClaim?.(agent),
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

	private latestAttemptsByAgent(snapshot: TaskRuntimeProjection): ReadonlyMap<string, AttemptRuntimeState> {
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
		const agent = this.options.getLifecycle().getAgent(agentId);
		const projectClaim = agent ? this.options.peekConversationClaim?.(agent) : undefined;
		let mailbox = this.mailboxes.get(agentId);
		if (!mailbox || !isDeepStrictEqual(mailbox.getProjectClaim(), projectClaim)) {
			mailbox = new WorkerAgentMailbox({
				agentDir: this.options.agentDir,
				parentSessionId: this.options.parentSessionId,
				agentId,
				projectClaim,
			});
			this.mailboxes.set(agentId, mailbox);
		}
		return mailbox;
	}

	releaseQuiescentContext(agentId: string, release: () => void): boolean {
		return this.getMailbox(agentId).withQuiescentMailbox(release);
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

	private enqueuePeerMessage(
		target: AgentBindingContract,
		kind: "steer" | "follow_up",
		content: string,
		options: WorkerAgentMessageOptions,
		task?: WorkerAgentTaskMetadata,
		onAdmitted?: () => void,
	): QueuedPeerMessage {
		if (options.idempotencyKey !== undefined) {
			this.assertIdempotencyTarget(target.agentId, options.idempotencyKey);
		}
		const enqueue = () =>
			this.getMailbox(target.agentId).enqueueWithReceipt({
				kind,
				content,
				...options,
				...(task ? { task } : {}),
				...(onAdmitted ? { onAdmitted } : {}),
			});
		return this.options.withConversationAdmission
			? this.options.withConversationAdmission(target, enqueue)
			: enqueue();
	}

	private workerAgentView(
		agent: AgentBindingContract,
		activity: WorkerAgentActivity = this.activityForAgent(agent),
		callerAgentId?: string,
		/** `null` = the caller already resolved the latest attempt and found none; omit to resolve here. */
		resolvedAttempt?: AttemptRuntimeState | null,
	): WorkerAgentView {
		const attempt = resolvedAttempt === undefined ? this.latestAgentAttempt(agent) : (resolvedAttempt ?? undefined);
		// `activity` folds queued into active for control flow. The view still owes the parent the
		// durable dispatch status and, for a queued attempt, the reason it has not started.
		// A suspended attempt waiting in the queue to resume (a retry, or a resume held for the foreground)
		// has a wait state too.
		const waitState =
			attempt?.status === "queued" || attempt?.status === "suspended"
				? this.options.scheduler.getWaitState?.(attempt.taskId)
				: undefined;
		// The reconciled independent verification of this exact generation, when its result asked for one.
		const verification =
			attempt?.result?.nextAction === "independent_verification_required"
				? attemptVerification(this.options.getLifecycle().getTaskRuntimeSnapshot(), attempt)
				: undefined;
		const endedTask =
			activity === "idle" && agent.status === "registered" && attempt?.result
				? this.projectEndedTask(attempt)
				: undefined;
		return {
			agentId: agent.agentId,
			...(agent.parentAgentId ? { parentAgentId: agent.parentAgentId } : {}),
			rootAgentId: agent.rootAgentId,
			depth: agent.depth,
			role: agent.role,
			...(agent.resumeContext.modelRef ? { modelRef: agent.resumeContext.modelRef } : {}),
			status: agent.status,
			activity,
			...(attempt ? { dispatch: attempt.status } : {}),
			...(waitState ? { waitReason: formatWorkerDispatchWait(waitState) } : {}),
			...(attempt?.result
				? {
						lastResult: verification
							? {
									status: verification.verdict === "accepted" ? "completed" : "failed",
									reasonCode: verification.reasonCode,
								}
							: { status: attempt.result.status, reasonCode: attempt.result.reasonCode },
					}
				: {}),
			// A rejected or inconclusive independent verification settles the generation as needing the
			// parent exactly as a blocked claim does; only an accepted one releases it.
			...(activity === "idle" &&
			agent.status === "registered" &&
			(attempt?.result?.nextAction === "parent_review" ||
				(verification !== undefined && verification.verdict !== "accepted"))
				? { awaitingParent: true as const }
				: {}),
			...(endedTask
				? {
						...(endedTask.hostVerdict ? { hostVerdict: endedTask.hostVerdict } : {}),
						recommendedDisposition: endedTask.advice,
					}
				: {}),
			controllable: !callerAgentId || this.agentIsInCallerSubtree(agent, callerAgentId),
			createdAt: agent.createdAt,
			updatedAt: agent.updatedAt,
		};
	}

	/** The host verdict and advice for the claim an idle worker's latest task ended with; none without a claim. */
	private projectEndedTask(
		attempt: AttemptRuntimeState,
	): { hostVerdict?: ReturnType<typeof workerHostVerdictView>; advice: WorkerDispositionAdvice } | undefined {
		const laneId = attempt.taskId;
		const claim = this.options.getWorkerClaimSnapshot?.(laneId, attempt.attemptId)?.claim;
		if (!claim) return undefined;
		const advice = deriveWorkerDispositionFromProjections({
			claim,
			snapshot: this.options.getLifecycle().getTaskRuntimeSnapshot(),
			goal: this.options.getGoalState?.(),
			laneId,
			attemptId: attempt.attemptId,
		});
		return { ...(claim.hostVerdict ? { hostVerdict: workerHostVerdictView(claim.hostVerdict) } : {}), advice };
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
