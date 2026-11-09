import { isDeepStrictEqual } from "node:util";
import type { UserMessage } from "@caupulican/pi-ai";
import type { AgentHaltRequest } from "../../kernel/index.ts";
import type { TurnOriginRecord } from "../../kernel/turn-origin-stamp.ts";
import { workerControlOf } from "../../kernel/worker-control-stamp.ts";
import type { WorkerDelegationRunOutcome } from "../agent-session-contracts.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import { HostEventError } from "../events/host-event-contract.ts";
import {
	type HostEventControlScope,
	type HostEventPage,
	type HostEventQuery,
	type HostEventSubscriptionChange,
	type HostEventSubscriptionView,
	hostEventSubscriptionView,
	readHostEventPage,
} from "../events/host-event-control.ts";
import { assertHostEventWorkerScope } from "../events/host-event-reducer.ts";
import type { HostEventDelivery } from "../events/host-event-state.ts";
import type { GoalState } from "../goals/goal-state.ts";
import { agentBasisTurnOrigin, agentTurnBasis } from "../orchestration/agent-turn-basis.ts";
import { conversationTurnOrigin } from "../orchestration/attempt-agent-identity.ts";
import { latestAgentAttemptsByDurableOrder } from "../orchestration/attempt-ordering.ts";
import {
	type AgentBindingContract,
	MAX_ORCHESTRATION_COLLECTION_LENGTH,
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	type WorkerResultContract,
} from "../orchestration/contracts.ts";
import { isLeaderDelegationObjectiveId } from "../orchestration/delegation-ledger.ts";
import type { SpecialistContextClaim } from "../orchestration/specialist-context-ownership.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import { assertWorkerReceiptAdmission } from "../orchestration/worker-receipt-origin.ts";
import { type RuntimeWorkLease, runtimeGenerationAdmission } from "../runtime-generation-admission.ts";
import { DEFAULT_WORKER_DELEGATION_HALT_REPORT_DEADLINE_MS } from "../settings/settings-rules.ts";
import type { TimerPort } from "../util/timer-port.ts";
import { recordDiscardedObligations } from "./obligation-ledger.ts";
import {
	SessionRootMailbox,
	type SessionRootReply,
	type SessionRootReplyQuery,
	type SessionRootReplyWaitOptions,
	type SessionRootReplyWaitResult,
	sessionRootAddress,
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
	WorkerControlIdentityConflictError,
	workerAgentBroadcastTargetIdempotencyKey,
	workerAgentMessageId,
} from "./worker-agent-control.ts";
import { rejectGenericReplyOptions } from "./worker-agent-message-options.ts";
import { WORKER_WAIT_DEFAULT_MS, WorkerAgentWaiter } from "./worker-agent-wait.ts";
import {
	type MandatoryTranscriptControlInput,
	mailboxMessage,
	WorkerControlTranscript,
} from "./worker-control-transcript.ts";
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
	type WorkerDispositionAdvice,
	workerHostVerdictView,
} from "./worker-disposition.ts";
import { evaluateReusableWorkerTaskAdmission } from "./worker-fleet-limits.ts";
import { normalizeWorkerHaltReason, WorkerLaneHalts } from "./worker-halt.ts";
import { type HostEventConsumingExecution, WorkerHostEventTransport } from "./worker-host-event-transport.ts";
import { attemptAwaitsParent, attemptVerification, selectedWorkerAttempt } from "./worker-lane-projection.ts";
import type { WorkerLifecycle } from "./worker-lifecycle.ts";
import { type QueuedPeerMessage, WorkerReplyRouting } from "./worker-reply-routing.ts";
import { isWorkerTaskPrompt } from "./worker-runner.ts";
import { specialistReleaseSkipReason } from "./worker-specialization-match.ts";
import { type TaskBearingReconciliation, WorkerTaskReconciler } from "./worker-task-reconciliation.ts";
import { projectWorkerTaskSessionView } from "./worker-task-view.ts";
import { buildWorkerTerminalHandoffContent } from "./worker-terminal-handoff-content.ts";
import { workerTerminalOutputArtifact } from "./worker-terminal-output-artifact.ts";

export { boundWorkerWaitTimeoutMs } from "./worker-agent-wait.ts";
export { buildWorkerTerminalHandoffContent };

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
	/**
	 * Present on a host that runs only part of its parent's work (a parent opened away): whether this host runs an
	 * attempt of this agent, so it reconciles the agent's inactive host-event transport. Everything else is judged per
	 * message by `runsControlMessage`.
	 */
	runsAgent?(agentId: string): boolean;
	/**
	 * Present with `runsAgent`: whether this host owns this control message. A turn, a reply to it and a root reply to it
	 * are judged by the request message, since its attempt exists only once the turn is taken. Every other turn, each
	 * turn queued behind one, every other reply and every message another turn would read stays durable and pending for
	 * the parent; a task for an agent with such a turn pending is deferred as busy instead of queued behind it.
	 */
	runsControlMessage?(messageId: string): boolean;
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
	/**
	 * Why an unsettled specialist whose run ended still holds its resources, when a failed release is the reason:
	 * `retained` is retried by the host, `abandoned` stays until the session ends. The cause is one bounded line.
	 */
	specialistReleaseHold?(
		agentId: string,
	): { readonly kind: "retained" | "abandoned"; readonly cause: string } | undefined;
	waitBlockedByCaller?(callerAgentId: string, targetAgentIds: readonly string[]): readonly string[];
	/** Yield caller-owned scheduler and mutation resources until the returned restorer succeeds. */
	yieldCallerForWait?(callerAgentId: string): (() => boolean | undefined) | undefined;
	/**
	 * Wake a wait that is blocked on restoring the caller's write reservation. Reservation release
	 * is a separate subsystem from subscribeStateChanges; this is that subsystem's event, not a poll.
	 */
	subscribeReservationAvailability?(listener: () => void): () => void;
	/**
	 * The `worker-wait` port: the bound of a delegate wait and the watchdog of its blocked reservation restore, with the
	 * clock that restore deadline is measured on. Defaults to the system timers.
	 */
	timers?: TimerPort;
	warn?(message: string): void;
	/** Current foreground submission epoch, or undefined when none is held. Read once, at genuine
	 * mailbox-turn creation (gated on `prepareAgentTurn`'s own `created` signal), to stamp the new
	 * attempt's owner epoch via `noteAttemptOwnerEpoch` -- mirrors
	 * `WorkerDelegationControllerDeps.getCurrentSubmissionEpoch`. */
	getCurrentSubmissionEpoch?(): number | undefined;
	captureReceiptOrigin?(): WorkerReceiptOrigin;
	/** The origin of the root's run in progress: a message the root writes now carries its third party's words. */
	getRunTurnOrigin?(): TurnOriginRecord | undefined;
	/** Mirrors `WorkerNotificationCoordinator.noteAttemptOwnerEpoch` -- called only when
	 * `prepareAgentTurn` reports `created: true`, never for a replayed control message returning an
	 * attempt that may predate the current process. */
	noteAttemptOwnerEpoch?(attemptId: string, ownerEpoch: number): void;
	/** How long an interrupted worker gets to reach a request boundary and report. */
	haltReportDeadlineMs?(): number;
}

export interface WorkerAgentControlResourceSnapshot {
	readonly stateListenerCount: number;
	readonly reconcilingTaskBearingCount: number;
	readonly scheduledReconciliationCount: number;
	readonly loadedMailboxes: readonly WorkerAgentMailboxResourceSnapshot[];
}

const MAX_BROADCAST_ERROR_CHARS = 512;

/** Attempt statuses whose task has not reached a terminal outcome. */
const LIVE_ATTEMPT_STATUSES: ReadonlySet<string> = new Set(["queued", "leased", "running", "suspended"]);

/** Mailbox identity and user content are kept separate from their transcript presentation. */
export interface WorkerMailboxConversationMessage {
	messageId: string;
	instructions: string;
	message: UserMessage;
	/** The third party's words the sender carried (`WorkerAgentMessage.turnOrigin`); admission records them. */
	turnOrigin?: TurnOriginRecord;
}

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
	private readonly hostEventTransport: WorkerHostEventTransport;
	private readonly runtimeWaiters = new Map<string, () => void>();
	private disposed = false;
	private readonly transcript: WorkerControlTranscript;
	private readonly replyRouting: WorkerReplyRouting;
	private readonly taskReconciler: WorkerTaskReconciler;
	private readonly agentWaiter: WorkerAgentWaiter;

	constructor(options: WorkerAgentControlCoordinatorOptions) {
		this.options = options;
		this.conversations = options.conversationStore ?? new WorkerConversationStore();
		this.sessionRootAddress = sessionRootAddress(options.parentSessionId);
		this.sessionRootMailbox = new SessionRootMailbox({
			agentDir: options.agentDir,
			parentSessionId: options.parentSessionId,
		});
		this.hostEventTransport = new WorkerHostEventTransport({
			agentDir: options.agentDir,
			conversations: this.conversations,
			lifecycle: () => options.getLifecycle(),
			mailbox: (agentId) => this.getMailbox(agentId),
			claim: (agent) => options.getConversationClaim?.(agent),
			admit: (agent, operation) =>
				options.withConversationAdmission ? options.withConversationAdmission(agent, operation) : operation(),
			resume: (agentId) => this.resumeWorkerAgent(agentId).started,
			available: () => !this.disposed && options.isControlAvailable(),
			warn: (message) => {
				try {
					options.warn?.(message);
				} catch {
					// Diagnostics are observers; the unsettled binding and its physical copy remain the retry source.
				}
			},
		});

		this.transcript = new WorkerControlTranscript({
			options: this.options,
			conversations: this.conversations,
			activityForAgent: (agent) => this.activityForAgent(agent),
		});
		this.replyRouting = new WorkerReplyRouting({
			options: this.options,
			sessionRootAddress: this.sessionRootAddress,
			sessionRootMailbox: this.sessionRootMailbox,
			sessionRootReconciliationFailures: this.sessionRootReconciliationFailures,
			workerReplyReconciliationFailures: this.workerReplyReconciliationFailures,
			transcript: this.transcript,
			getMailbox: (agentId) => this.getMailbox(agentId),
			requireKnownAgent: (agentId) => this.requireKnownAgent(agentId),
			activityForAgent: (agent) => this.activityForAgent(agent),
			senderTurnOrigin: (senderAgentId, attemptId) => this.senderTurnOrigin(senderAgentId, attemptId),
			assertIdempotencyTarget: (targetAgentId, idempotencyKey) =>
				this.assertIdempotencyTarget(targetAgentId, idempotencyKey),
			notifyStateChangedBestEffort: () => this.notifyStateChangedBestEffort(),
			reconcileTaskBearingMailbox: (agentId, expectedMessageId) =>
				this.reconcileTaskBearingMailbox(agentId, expectedMessageId),
			replyReconciliationAgents: () => this.replyReconciliationAgents(),
		});
		this.taskReconciler = new WorkerTaskReconciler({
			options: this.options,
			sessionRootAddress: this.sessionRootAddress,
			conversations: this.conversations,
			transcript: this.transcript,
			reconcilingTaskBearingAgentIds: this.reconcilingTaskBearingAgentIds,
			taskBearingContinuationAgentIds: this.taskBearingContinuationAgentIds,
			runtimeWaiters: this.runtimeWaiters,
			isDisposed: () => this.disposed,
			getMailbox: (agentId) => this.getMailbox(agentId),
			activityForAgent: (agent) => this.activityForAgent(agent),
			senderTurnOrigin: (senderAgentId, attemptId) => this.senderTurnOrigin(senderAgentId, attemptId),
			notifyStateChangedBestEffort: () => this.notifyStateChangedBestEffort(),
			acknowledgeDeliveredMailboxMessage: (agentId, messageId) =>
				this.acknowledgeDeliveredMailboxMessage(agentId, messageId),
			beginWorkerReplyAcknowledgement: (target, reply) =>
				this.replyRouting.beginWorkerReplyAcknowledgement(target, reply),
			controlMessageAttempt: (agentId, message) => this.controlMessageAttempt(agentId, message),
			cleanupPendingSkipReason: (agentId) => this.cleanupPendingSkipReason(agentId),
			reusableTaskAdmissionSkipReason: (agentId) => this.reusableTaskAdmissionSkipReason(agentId),
		});
		this.agentWaiter = new WorkerAgentWaiter({
			options: this.options,
			subscribeStateChanges: (listener) => this.subscribeStateChanges(listener),
			projectAgentActivity: (agent, attempt) => this.projectAgentActivity(agent, attempt),
			latestAttemptsByAgent: (snapshot) => this.latestAttemptsByAgent(snapshot),
		});
	}

	readHostEvents(query: HostEventQuery, scope: HostEventControlScope = {}): HostEventPage {
		this.requireControl();
		const runtime = this.options.getLifecycle().ledger.runtime;
		const snapshot = runtime.getSnapshot();
		const caller = this.hostEventCaller(snapshot, scope);
		return readHostEventPage(snapshot, query, caller?.taskId, (sourceId) =>
			runtime.hostEvents.isSourceReady(sourceId),
		);
	}

	changeHostEventSubscriptions(
		input: HostEventSubscriptionChange,
		scope: HostEventControlScope = {},
	): HostEventSubscriptionView {
		this.requireControl();
		const runtime = this.options.getLifecycle().ledger.runtime;
		const caller = this.hostEventCaller(runtime.getSnapshot(), scope);
		if (caller && caller.taskId !== input.taskId)
			throw new HostEventError("authority", "A worker may change only its current task subscriptions.");
		runtime.hostEvents.replaceSubscriptions(
			input.taskId,
			input.expectedRevision,
			input.subscriptions,
			caller ? { agentId: caller.agentId!, ...scope.execution! } : undefined,
		);
		return hostEventSubscriptionView(runtime.getSnapshot(), input.taskId);
	}

	private hostEventCaller(
		snapshot: TaskRuntimeProjection,
		scope: HostEventControlScope,
	): AttemptRuntimeState | undefined {
		if (scope.callerAgentId === undefined) return undefined;
		if (!scope.execution)
			throw new HostEventError(
				"authority",
				"Host event controls require the worker's current live task and execution lease.",
			);
		return assertHostEventWorkerScope(snapshot, { agentId: scope.callerAgentId, ...scope.execution }, Date.now());
	}

	async deliverHostEvent(
		delivery: HostEventDelivery,
		signal: AbortSignal,
	): Promise<"queued" | "dormant" | "unavailable"> {
		return this.hostEventTransport.deliver(delivery, signal);
	}

	reconcileHostEventDelivery(delivery: HostEventDelivery): void {
		this.hostEventTransport.reconcileDelivery(delivery);
	}

	/**
	 * Called synchronously after fitness/abort admission. Ordinary controls retain their next boundary;
	 * copies bound to another execution of this agent are settled, never appended by this run.
	 */
	consumeHostEventMessages(
		agentId: string,
		execution: HostEventConsumingExecution,
		conversation: WorkerConversation,
		candidates: readonly WorkerMailboxConversationMessage[],
	): WorkerMailboxConversationMessage[] {
		const events = candidates.filter(({ message }) => workerControlOf(message)?.k === "host_event");
		const accepted = events.filter(({ message }) =>
			this.hostEventTransport.consume(agentId, execution, conversation, message),
		);
		const admitted = accepted.length
			? accepted
			: candidates.filter(({ message }) => workerControlOf(message)?.k !== "host_event");
		// A steer or follow-up carrying a third party's words taints the running attempt before the model reads it.
		const thirdParty = admitted.find((candidate) => candidate.turnOrigin?.thirdParty)?.turnOrigin;
		if (thirdParty)
			this.options
				.getLifecycle()
				.ledger.runtime.recordAttemptThirdPartyWords(
					execution.attemptId,
					execution.leaseId,
					execution.fencingToken,
					thirdParty,
				);
		return admitted;
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
		rejectGenericReplyOptions(options);
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

	/** Message an existing session peer without acquiring its lifecycle controls. */
	messageWorkerPeer(
		agentId: string,
		message: string,
		options: WorkerAgentMessageOptions & { senderAgentId: string },
	): ReturnType<WorkerAgentControlPort["followUpWorkerAgent"]> {
		this.requireControl();
		const agent = this.requireSessionPeer(agentId, { callerAgentId: options.senderAgentId });
		if (agent.agentId === options.senderAgentId) throw new Error("A worker cannot message itself.");
		this.assertAgentAcceptsNewMessages(agent, options.idempotencyKey);
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

	replyToWorkerAgentMessage(
		sourceAgentId: string,
		message: string,
		replyToMessageId: string,
		authorizeRequest?: (request: Pick<WorkerAgentMessage, "senderAgentId" | "threadId">) => void,
	): WorkerAgentReplyResult {
		this.requireControl();
		const source = this.requireKnownAgent(sourceAgentId);
		const sourceMailbox = this.getMailbox(source.agentId);
		const request = sourceMailbox.getMessage(replyToMessageId);
		if (authorizeRequest) {
			if (!request) throw new Error("Reply group provenance is no longer available.");
			authorizeRequest(request);
		}
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
			this.replyRouting.reconcileCompletedWorkerReplyAcknowledgement(
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
		if (!request || request.deliveredAt === undefined || request.expectReply !== true) {
			throw new Error("Worker reply does not reference a delivered reply-expected message.");
		}
		if (!request.senderAgentId) throw new Error("Worker reply request has no routable requester.");
		if (request.senderAgentId === this.sessionRootAddress) {
			return this.replyRouting.routeWorkerReplyToSessionRoot(source, sourceMailbox, request, message);
		}
		const target = this.requireKnownAgent(request.senderAgentId);
		if (target.status === "retired" && activeAcknowledgementId === undefined) {
			throw new Error(`Logical worker agent '${target.agentId}' is retired.`);
		}
		return this.replyRouting.routeWorkerReplyToAgent(target, source.agentId, request, message);
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
			this.replyRouting.reconcileWorkerReplyOutboxesBestEffort();
			this.notifyStateChangedBestEffort();
		}
		return acknowledged;
	}

	private reconcileSessionRootSurface(): void {
		this.reconcileSessionRootReplies();
		this.replyRouting.reconcileWorkerReplyOutboxesBestEffort();
	}

	private followUpAcceptedAgent(
		agent: AgentBindingContract,
		message: string,
		options: WorkerAgentMessageOptions,
	): { started: boolean; steering: boolean; messageId: string; record?: LaneRecord; skipReason?: string } {
		rejectGenericReplyOptions(options);
		if (this.activityForAgent(agent) === "active") {
			// A delegation's words wait for a turn of their own, filed under that delegation: a steer would be absorbed into
			// the live turn, which was filed under whatever started it.
			const delegated =
				options.delegationObjectiveId !== undefined ||
				this.senderDelegationObjectiveId(options.senderAgentId) !== undefined;
			const queued = this.enqueuePeerMessage(agent, delegated ? "follow_up" : "steer", message, options, {
				kind: "agent_turn",
			});
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
			return { started: false, steering: !delegated, messageId: queued.messageId };
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
						...(options.newTask.knowledgeReferences
							? { knowledgeReferences: options.newTask.knowledgeReferences }
							: {}),
						...(options.newTask.subscriptions ? { subscriptions: options.newTask.subscriptions } : {}),
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
			if (replay) return replay.record ? { ...replay, record: this.withQueuedWaitReason(replay.record) } : replay;
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
			return {
				started: false,
				steering: false,
				messageId: "",
				skipReason: this.cleanupPendingSkipReason(agent.agentId),
			};
		}
		// A turn this host does not own (the parent's) is pending first on this agent: the agent is the parent's until that
		// turn runs, so nothing is queued behind it here.
		const runsControlMessage = this.options.runsControlMessage;
		if (
			runsControlMessage &&
			this.getMailbox(agent.agentId)
				.pendingTaskBearing()
				.some((pending) => !runsControlMessage(pending.messageId))
		) {
			return { started: false, steering: false, messageId: "", skipReason: "worker_specialist_busy" };
		}
		return this.startIdleAgentTask(
			agent,
			message,
			options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey },
			dependsOnTaskIds,
			newTask,
			options.newTask?.goal,
			true,
			options.receiptOrigin,
		);
	}

	/**
	 * The reason an idle, unsettled specialist takes no turn yet: the failed release that holds it, named with its
	 * cause, or plain disposal still in progress.
	 */
	private cleanupPendingSkipReason(agentId: string): string {
		const hold = this.options.specialistReleaseHold?.(agentId);
		return hold ? specialistReleaseSkipReason(hold.kind, agentId, hold.cause) : "worker_cleanup_pending";
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
				throw new WorkerControlIdentityConflictError(
					"Worker control idempotency identity conflicts with its durable dispatch.",
				);
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
		requireRuntimeAdmission = false,
		receiptOrigin?: WorkerReceiptOrigin,
	): { started: boolean; steering: false; messageId: string; record?: LaneRecord; skipReason?: string } {
		const reader = runtimeGenerationAdmission(this.options.agentDir).tryAdmitWork({
			kind: "worker-control",
			label: agent.agentId,
		});
		if (!reader && requireRuntimeAdmission) {
			return { started: false, steering: false, messageId: "", skipReason: "runtime_generation_replacement" };
		}
		try {
			if (!this.isAcceptedControlReplay(agent.agentId, options.idempotencyKey)) {
				const headroomSkipReason = reader ? this.options.taskStartHeadroomSkipReason?.(agent) : undefined;
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
				receiptOrigin,
			);
			if (queued.status === "completed_replay") {
				return {
					started: false,
					steering: false,
					messageId: queued.messageId,
					skipReason: "worker_message_already_finalized",
				};
			}
			const reconciliation = this.reconcileTaskBearingMailbox(agent.agentId, queued.messageId, reader);
			this.notifyStateChangedBestEffort();
			return {
				started: reconciliation.started,
				steering: false,
				messageId: queued.messageId,
				...(reconciliation.record ? { record: this.withQueuedWaitReason(reconciliation.record) } : {}),
				...(reconciliation.skipReason ? { skipReason: reconciliation.skipReason } : {}),
			};
		} finally {
			reader?.release();
		}
	}

	/**
	 * The durable record never carries the scheduler's process-local wait state; a record handed back for a
	 * turn the scheduler still queues says why it has not started, as a fresh lane's record does.
	 */
	private withQueuedWaitReason(record: LaneRecord): LaneRecord {
		if (record.status !== "queued" && record.status !== "running") return record;
		const waitState = this.options.scheduler.getWaitState?.(record.laneId);
		return waitState ? { ...record, waitReason: formatWorkerDispatchWait(waitState) } : record;
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
			isDeepStrictEqual([...attempt.dispatch.resourcePointerIds], [...(newTask.resourcePointerIds ?? [])]) &&
			isDeepStrictEqual(attempt.dispatch.knowledgeReferences ?? [], newTask.knowledgeReferences ?? []) &&
			isDeepStrictEqual(attempt.dispatch.subscriptions ?? [], newTask.subscriptions ?? [])
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
			throw new WorkerControlIdentityConflictError(
				"Worker control idempotency identity conflicts with its durable task dependencies.",
			);
		}
	}

	/**
	 * The delegation a bot's words belong to: the delegation its own running turn is filed under, when a delegation started
	 * that turn. The session root and an idle or unknown sender have none.
	 */
	private senderDelegationObjectiveId(senderAgentId: string | undefined): string | undefined {
		if (!senderAgentId || senderAgentId === this.sessionRootAddress) return undefined;
		const snapshot = this.options.getLifecycle().getTaskRuntimeSnapshot();
		const activeAttemptId = snapshot.agents[senderAgentId]?.activeAttemptId;
		const attempt = activeAttemptId === undefined ? undefined : snapshot.attempts[activeAttemptId];
		const objectiveId = attempt ? snapshot.tasks[attempt.taskId]?.task.objectiveId : undefined;
		return objectiveId !== undefined && isLeaderDelegationObjectiveId(objectiveId) ? objectiveId : undefined;
	}

	/** The delegation a finished attempt was filed under, when a delegation started it; undefined for session work. */
	private delegationOfAttempt(attemptId: string | undefined): string | undefined {
		if (attemptId === undefined) return undefined;
		const snapshot = this.options.getLifecycle().getTaskRuntimeSnapshot();
		const attempt = snapshot.attempts[attemptId];
		const objectiveId = attempt ? snapshot.tasks[attempt.taskId]?.task.objectiveId : undefined;
		return objectiveId !== undefined && isLeaderDelegationObjectiveId(objectiveId) ? objectiveId : undefined;
	}

	private sessionRootMessageOptions(options: SessionRootWorkerAgentMessageOptions): WorkerAgentMessageOptions {
		const leader = options.fromLeader === undefined ? undefined : this.requireKnownAgent(options.fromLeader).agentId;
		return {
			senderAgentId: leader ?? this.sessionRootAddress,
			// A leader's words are written by the root session's host, so they are admitted under the root's live origin.
			...(leader === undefined ? {} : { receiptOrigin: this.options.captureReceiptOrigin?.() }),
			...(options.threadId !== undefined ? { threadId: options.threadId } : {}),
			...(options.expectReply === true ? { expectReply: true } : {}),
			...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
			...(options.delegationObjectiveId !== undefined
				? { delegationObjectiveId: options.delegationObjectiveId }
				: {}),
		};
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

	reconcileSessionRootReplies(): void {
		this.replyRouting.reconcileSessionRootReplies();
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
					try {
						this.options.cancelLane(laneId, "interrupt_report_deadline");
					} catch (error) {
						// This runs on a timer, where a throw escapes as an uncaught exception that no owner can
						// act on. The abort above was already signalled; report why the durable cancel did not commit.
						this.options.warn?.(
							`Worker ${laneId} halt deadline cancellation failed after its abort: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
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
	 * A terminal task can outlive its reusable agent's assignment. Settle only the cancelled
	 * attempt still selected by both owners, including when terminal publication is replayed.
	 */
	settleCancelledWorkerSteers(record: LaneRecord): void {
		if (record.type !== "worker" || record.status !== "canceled" || !record.attemptId) return;
		const attemptId = record.attemptId;
		const currentAgent = (): AgentBindingContract | undefined => {
			const snapshot = this.options.getLifecycle().getTaskRuntimeSnapshot();
			const attempt = snapshot.attempts[attemptId];
			if (
				attempt?.status !== "cancelled" ||
				attempt.taskId !== record.laneId ||
				selectedWorkerAttempt(snapshot, record.laneId)?.attemptId !== attempt.attemptId
			)
				return undefined;
			const agentId = attempt.agentId ?? attempt.dispatch.logicalLaneId;
			const agent = agentId ? snapshot.agents[agentId] : undefined;
			if (
				!agent ||
				(record.agentId !== undefined && record.agentId !== agent.agentId) ||
				this.latestAttemptsByAgent(snapshot).get(agent.agentId)?.attemptId !== attempt.attemptId
			)
				return undefined;
			return agent;
		};
		const agent = currentAgent();
		if (!agent || this.getMailbox(agent.agentId).pendingOrdinarySteers().length === 0) return;
		const settle = () => {
			const current = currentAgent();
			if (current)
				this.deadLetterUndeliveredSteers(
					current,
					record.reasonCode ?? "worker_cancelled",
					() => currentAgent() !== undefined,
				);
		};
		if (this.options.withConversationAdmission) this.options.withConversationAdmission(agent, settle);
		else settle();
	}

	/**
	 * Fail every ordinary steer the cancelled task never received. A steer that carries a reply
	 * obligation is kept: its reply is owed regardless of the task it was addressed to.
	 */
	private deadLetterUndeliveredSteers(
		agent: AgentBindingContract,
		reasonCode: string,
		isCurrent?: () => boolean,
	): void {
		const mailbox = this.getMailbox(agent.agentId);
		for (const message of mailbox.pendingTaskBearing()) {
			if (isCurrent && !isCurrent()) return;
			if (message.kind !== "steer") continue;
			if (this.taskReconciler.reconcileTaskBearingTranscriptDelivery(agent, message)) continue;
			if (isCurrent && !isCurrent()) return;
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
		const conversation = this.conversations.open({
			agentDir: this.options.agentDir,
			resumeContext: agent.resumeContext,
			expectedLogicalAgentId: agent.contextOrigin?.logicalAgentId ?? agent.agentId,
		});
		// The attempt's own boundary bounds the search: nothing before it belongs to this lane.
		const latest = conversation.latestAttemptAssistantText();
		if (latest.versioned) return latest.text;
		const messages = conversation.getRawTranscript();
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]!;
			if (message.role === "user") {
				// A conversation without attempt boundaries bounds the search by the attempt's task prompt.
				const text =
					typeof message.content === "string"
						? message.content
						: message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("");
				// comms-legacy-decoder: a conversation written before attempt boundaries existed marks its attempt only by the task prompt's TASK frame.
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
		this.replyRouting.reconcileWorkerReplyOutboxesBestEffort();
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
		if (pendingMessages.length > 0) this.replyRouting.reconcileWorkerReplyOutboxesBestEffort();
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
		signal?: AbortSignal,
	): ReturnType<WorkerAgentControlPort["waitForWorkerAgent"]> {
		return this.waitForWorkerAgents([agentId], "all", timeoutMs, scope, signal).then((result) => ({
			status: result.statuses[0]?.status ?? "unknown",
			timedOut: result.timedOut,
			...(result.terminalLaneIds ? { terminalLaneIds: result.terminalLaneIds } : {}),
			...(result.terminalAttemptIds ? { terminalAttemptIds: result.terminalAttemptIds } : {}),
			...(result.foregroundHeldAgentIds ? { foregroundHeld: true } : {}),
		}));
	}

	/** Wait for nonactive workers, including idle resource release, with one shared caller-capacity lease. */
	waitForWorkerAgents(
		agentIds: readonly string[],
		mode: WorkerAgentWaitMode,
		timeoutMs = WORKER_WAIT_DEFAULT_MS,
		scope: WorkerAgentControlScope = {},
		signal?: AbortSignal,
	): ReturnType<WorkerAgentControlPort["waitForWorkerAgents"]> {
		this.requireControl();
		if (mode !== "any" && mode !== "all") throw new TypeError("Worker wait mode must be 'any' or 'all'.");
		const canonicalAgentIds = this.canonicalAgentIdSet(agentIds, "Worker wait");
		return this.agentWaiter.waitForAgents(canonicalAgentIds, mode, timeoutMs, scope, signal);
	}

	/** Read mailbox items at a safe boundary and reconcile the narrow append-before-ack crash window. */
	mailboxMessagesForConversation(
		agentId: string,
		conversation: WorkerConversation,
		includeFollowUp: boolean,
	): WorkerMailboxConversationMessage[] {
		const mailbox = this.getMailbox(agentId);
		const runsControlMessage = this.options.runsControlMessage;
		// A host running part of its parent's work reads host events and the messages it owns; the rest stays pending.
		const admitted = (message: WorkerAgentMessage) =>
			!runsControlMessage || message.task?.kind === "host_event" || runsControlMessage(message.messageId);
		const pending = mailbox.pending().filter(admitted);
		if (pending.length === 0) return [];
		const delivered = conversation.findDeliveredWorkerControlMessageIds(
			pending
				.filter((message) => message.task?.kind !== "host_event")
				.map((message) => {
					const projected = mailboxMessage(message);
					if (typeof projected.content !== "string") {
						throw new Error("Worker control transcript projection is not textual.");
					}
					return { messageId: message.messageId, content: projected.content };
				}),
		);
		for (const messageId of delivered) this.acknowledgeDeliveredMailboxMessage(agentId, messageId);
		return mailbox
			.pending()
			.filter(admitted)
			.filter((message) => message.task?.kind === "host_event" || message.kind === "steer" || includeFollowUp)
			.map((message) => ({
				messageId: message.messageId,
				instructions: message.content,
				message: mailboxMessage(message),
				...(message.turnOrigin ? { turnOrigin: message.turnOrigin } : {}),
			}));
	}

	/** Acknowledge only after the exact child transcript message has been durably appended. */
	acknowledgeMailboxMessage(agentId: string, message: { role: string; content: unknown }): void {
		if (message.role !== "user") return;
		const control = workerControlOf(message);
		if (control !== undefined) {
			if (control.k === "host_event")
				throw new HostEventError(
					"authority",
					"Host event acknowledgement requires its canonical consumed receipt.",
				);
			if (control.k !== "task") this.acknowledgeDeliveredMailboxMessage(agentId, control.id);
			return;
		}
		if (typeof message.content !== "string") return;
		// comms-legacy-decoder: a message appended without its typed identity (a transcript written before the identity existed) names its mailbox message only in the rendered header.
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
		this.replyRouting.reconcileWorkerReplyOutboxes(agents);
		for (const agent of agents) {
			if (this.options.runsAgent?.(agent.agentId) !== false) this.reconcileInactiveHostEvents(agent);
			this.reconcileTaskBearingMailbox(agent.agentId);
		}
	}

	private reconcileInactiveHostEvents(agent: AgentBindingContract): void {
		try {
			this.hostEventTransport.reconcileInactive(agent.agentId);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			try {
				this.options.warn?.(`Worker host-event transport reconciliation failed for ${agent.agentId}: ${reason}`);
			} catch {
				// Diagnostics are observers; the unsettled binding and its physical copy remain the retry source.
			}
		}
	}

	/** Every agent: each turn and reply on it is judged by its own request message (`runsControlMessage`). */
	private replyReconciliationAgents(): AgentBindingContract[] {
		return Object.values(this.options.getLifecycle().getTaskRuntimeSnapshot().agents).sort(
			(left, right) => left.createdAt.localeCompare(right.createdAt) || left.agentId.localeCompare(right.agentId),
		);
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
							...(snapshot.claim.parentReviewRequired ? { parentReviewRequired: true } : {}),
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
		const transcriptReplay = this.transcript.reconcileMandatoryControlTranscript(parent, transcriptInput, false);
		if (transcriptReplay.delivered) {
			this.notifyStateChangedBestEffort();
			return { messageId: transcriptReplay.messageId, started: false, accepted: true };
		}
		if (parent.status === "retired") {
			const messageId = this.transcript.deliverMandatoryControlToRetiredTranscript(parent, transcriptInput);
			this.notifyStateChangedBestEffort();
			return {
				messageId,
				started: false,
				accepted: true,
				skipReason: "terminal_handoff_retired_target_transcript_delivery",
			};
		}
		const receiptOrigin = this.options.getLifecycle().getTaskRuntimeSnapshot().attempts[args.terminalAttemptId]
			?.dispatch.receiptOrigin;
		const turnOrigin = this.senderTurnOrigin(args.childAgentId, args.terminalAttemptId);
		// A nested child's handoff belongs to the goal it ran for: the leader's turn that reports it is that goal's turn, not
		// the session's, and a steer would be absorbed into a turn that may not be the goal's.
		const delegationObjectiveId = this.delegationOfAttempt(args.terminalAttemptId);
		const queued = this.getMailbox(parent.agentId).enqueueWithReceipt({
			kind: active && delegationObjectiveId === undefined ? "steer" : "follow_up",
			content,
			senderAgentId: args.childAgentId,
			idempotencyKey,
			task: { kind: "terminal_handoff", sourceAttemptId: args.terminalAttemptId },
			...(receiptOrigin ? { receiptOrigin } : {}),
			...(turnOrigin ? { turnOrigin } : {}),
			...(delegationObjectiveId ? { delegationObjectiveId } : {}),
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

	private reconcileTaskBearingMailbox(
		agentId: string,
		expectedMessageId?: string,
		runtimeLease?: RuntimeWorkLease,
	): TaskBearingReconciliation {
		return this.taskReconciler.reconcileTaskBearingMailbox(agentId, expectedMessageId, runtimeLease);
	}

	/** Stop deferred admissions; durable mailbox intent remains available to the next session owner. */
	dispose(): void {
		this.disposed = true;
		for (const unsubscribe of this.runtimeWaiters.values()) unsubscribe();
		this.runtimeWaiters.clear();
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

	/**
	 * The third party's words a sender carries as it writes: the root's run in progress, or the worker's own attempt
	 * (`attemptId` when the caller names it, else its active or latest one). `undefined` when only the owner's words
	 * reached the sender.
	 */
	private senderTurnOrigin(senderAgentId: string | undefined, attemptId?: string): TurnOriginRecord | undefined {
		let origin: TurnOriginRecord | undefined;
		if (!senderAgentId || senderAgentId === this.sessionRootAddress) origin = this.options.getRunTurnOrigin?.();
		else {
			const snapshot = this.options.getLifecycle().getTaskRuntimeSnapshot();
			const agent = snapshot.agents[senderAgentId];
			const namedAttemptId = attemptId ?? agent?.activeAttemptId;
			if (namedAttemptId !== undefined) {
				const attempt = snapshot.attempts[namedAttemptId];
				origin = attempt ? conversationTurnOrigin(snapshot, attempt) : undefined;
			} else if (agent) {
				// The latest turn, which retention may have released: the origin its binding carries stands in for it.
				const turn = agentTurnBasis(snapshot, agent.agentId);
				origin = turn ? agentBasisTurnOrigin(snapshot, agent.agentId, turn) : undefined;
			}
		}
		return origin?.thirdParty ? origin : undefined;
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
		this.hostEventTransport.reconcileInactive(agentId);
		return this.getMailbox(agentId).withQuiescentMailbox(release);
	}

	/** End only this closed owner's cached view after its exact context is durably handed off. */
	handoffSettledContext(
		agentId: string,
		claim: SpecialistContextClaim,
		publish: (assertSettled: () => void) => void,
	): void {
		// Do not load a mailbox: an admission that never loaded one has no local view to retire.
		const mailbox = this.mailboxes.get(agentId);
		const assertSettled = (): void => {
			if (
				!this.disposed ||
				this.mailboxes.get(agentId) !== mailbox ||
				this.reconcilingTaskBearingAgentIds.has(agentId) ||
				this.taskBearingContinuationAgentIds.has(agentId) ||
				this.runtimeWaiters.has(agentId) ||
				(mailbox &&
					(!isDeepStrictEqual(mailbox.getProjectClaim(), claim) ||
						mailbox.getResourceSnapshot().listenerCount !== 0))
			)
				throw new Error(`Worker ${agentId} mailbox handoff still has local ownership or observers.`);
		};
		assertSettled();
		// The publisher rechecks this guard under its mailbox/transcript locks before the durable write.
		publish(assertSettled);
		assertSettled();
		if (mailbox) this.mailboxes.delete(agentId);
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

	hasPendingControlMessages(agentId: string): boolean {
		this.requireControl();
		return this.getMailbox(agentId).pending().length > 0;
	}

	hasPendingDelegatedMessage(delegationObjectiveId: string): boolean {
		this.requireControl();
		return this.agentIdsWithPendingDelegatedMessage(delegationObjectiveId).length > 0;
	}

	/** Starts, now the delegation runs again, the messages it filed while it was paused. */
	reconcileDelegatedMessages(delegationObjectiveId: string): void {
		this.requireControl();
		for (const agentId of this.agentIdsWithPendingDelegatedMessage(delegationObjectiveId))
			this.reconcileTaskBearingMailbox(agentId);
	}

	private agentIdsWithPendingDelegatedMessage(delegationObjectiveId: string): string[] {
		return Object.keys(this.options.getLifecycle().getTaskRuntimeSnapshot().agents).filter((agentId) =>
			this.getMailbox(agentId)
				.pending()
				.some((message) => message.delegationObjectiveId === delegationObjectiveId),
		);
	}

	/** Worker execution and physical-release events; subscribers own their lifetime. */
	subscribeStateChanges(listener: () => void): () => void {
		this.stateListeners.add(listener);
		return () => this.stateListeners.delete(listener);
	}

	private acknowledgeDeliveredMailboxMessage(agentId: string, messageId: string): void {
		const mailbox = this.getMailbox(agentId);
		const controlMessage = mailbox.getMessage(messageId);
		if (controlMessage) {
			const target = this.requireKnownAgent(agentId);
			const sourceMailbox = this.replyRouting.beginWorkerReplyAcknowledgement(target, controlMessage, true);
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

	private enqueuePeerMessage(
		target: AgentBindingContract,
		kind: "steer" | "follow_up",
		content: string,
		options: WorkerAgentMessageOptions,
		task?: WorkerAgentTaskMetadata,
		onAdmitted?: () => void,
		admittedOrigin?: WorkerReceiptOrigin,
	): QueuedPeerMessage {
		if (options.idempotencyKey !== undefined) {
			this.assertIdempotencyTarget(target.agentId, options.idempotencyKey);
		}
		const replayId =
			options.idempotencyKey === undefined
				? undefined
				: workerAgentMessageId(this.options.parentSessionId, options.idempotencyKey);
		// Observation only: this view may predate the claim that admission acquires below, so it never mutates.
		const observer = replayId === undefined ? undefined : this.getMailbox(target.agentId);
		const replay =
			replayId !== undefined &&
			observer !== undefined &&
			(observer.getMessage(replayId) !== undefined || observer.hasControlReplayReceipt(replayId));
		const sender = options.senderAgentId;
		const snapshot = this.options.getLifecycle().getTaskRuntimeSnapshot();
		const activeSender =
			sender && sender !== this.sessionRootAddress ? snapshot.agents[sender]?.activeAttemptId : undefined;
		const { delegationObjectiveId: requestedDelegation, receiptOrigin: hostOrigin, ...peerOptions } = options;
		const receiptOrigin = replay
			? undefined
			: (admittedOrigin ??
				hostOrigin ??
				(sender && sender !== this.sessionRootAddress
					? activeSender
						? snapshot.attempts[activeSender]?.dispatch.receiptOrigin
						: undefined
					: this.options.captureReceiptOrigin?.()));
		// The sender's third party's words travel with what it writes; a replay keeps the stored message's.
		const turnOrigin = replay ? undefined : this.senderTurnOrigin(sender);
		// The delegation the words belong to: the root's host-only tag, else the delegation the sender's own turn is filed
		// under, so a leader's bots' turns stay that delegation's. A replay keeps the stored message's.
		const delegationObjectiveId = replay
			? undefined
			: (requestedDelegation ?? this.senderDelegationObjectiveId(sender));
		const enqueue = () => {
			assertWorkerReceiptAdmission(receiptOrigin);
			// Resolved inside admission: the mailbox mutation must carry the claim admission just acquired.
			return this.getMailbox(target.agentId).enqueueWithReceipt({
				kind,
				content,
				...peerOptions,
				...(receiptOrigin ? { receiptOrigin } : {}),
				...(turnOrigin ? { turnOrigin } : {}),
				...(delegationObjectiveId ? { delegationObjectiveId } : {}),
				...(task ? { task } : {}),
				...(onAdmitted ? { onAdmitted } : {}),
			});
		};
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
			...(attempt ? { attemptId: attempt.attemptId, dispatch: attempt.status } : {}),
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
			attempt !== undefined &&
			attemptAwaitsParent(this.options.getLifecycle().getTaskRuntimeSnapshot(), attempt)
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
}
