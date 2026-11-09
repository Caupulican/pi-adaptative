/**
 * Execution-plane coordinator for goal continuation, research, managed lanes, worker delegation,
 * and model fitness.
 *
 * Coordination state is owned by focused controllers. This coordinator retains one AgentSession
 * composition seam and a shared lane read model. Everything it needs
 * — the session manager, settings, model registry, live model, capability envelope, the goal
 * continuation LOOP, the isolated-completion primitive, spawned-usage accounting, and the telemetry
 * sink — is reached through narrow deps accessors rather than the whole AgentSession.
 *
 * Drive-loop boundary (deliberate): the idle triggers ({@link scheduleGoalAutoContinueFromIdle},
 * {@link scheduleResearchLaneFromIdle}) are invoked from the session's prompt tail as one-line
 * delegations; goal auto-continue itself only ever asks the session to `continueGoalLoop`, so this
 * controller never touches `prompt()`, the last-assistant-message, retry, or streaming state.
 */

import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import type { Api, AssistantMessage, Model } from "@caupulican/pi-ai";
import { resolveModelThinkingLevel } from "@caupulican/pi-ai/models";
import { harnessLog } from "../kernel/harness-log.ts";
import type { AgentMessage } from "../kernel/types.ts";
import { workerControlOf } from "../kernel/worker-control-stamp.ts";
import { orchestrationEventStoreDir } from "./agent-paths.ts";
import type {
	GoalContinuationLoopOptions,
	GoalContinuationLoopResult,
	PromptOptions,
	ResearchLaneRunOutcome,
	WorkerDelegationRunOutcome,
} from "./agent-session-contracts.ts";
import { isLaneTerminalStatus, type LaneRecord, LaneTracker } from "./autonomy/lane-tracker.ts";
import { appendLaneRecordSnapshot, getLatestLaneRecordSnapshots } from "./autonomy/session-lane-record.ts";
import {
	type AutonomyStatusSources,
	readSessionAutonomyStatus,
	type SessionAutonomyStatus,
} from "./autonomy-status/autonomy-status.ts";
import type { BackgroundLaneControllerDeps, RunningAttemptWaitOutcome } from "./background-lane-deps.ts";
import {
	type AwayChannelStatus,
	awayChannels,
	readAwayChannelCharges,
	readAwayChannelStatus,
} from "./channels/away-channels.ts";
import { DEFAULT_OWNER_QUOTA_MAX_USED_PERCENT } from "./channels/channel-policy.ts";
import { createChannelReplyToolDefinition } from "./channels/channel-reply-tool.ts";
import { SessionChannels } from "./channels/session-channels.ts";
import { sessionSemanticUsageOf } from "./cost/semantic-usage-delivery.ts";
import { deliverSpawnedUsageReceipt } from "./cost/spawned-usage-receipt.ts";
import {
	type BotCreationRequest,
	type CreatedBotView,
	MAX_BOTS_PER_LEADER,
	mayNotCreateBotsText,
} from "./delegation/bot-creation.ts";
import { type BotDaemonLaunchResult, launchDetachedBotDaemon } from "./delegation/bot-daemon-launch.ts";
import { describeLegacyDaemonRetirement, retireLegacyBotDaemons } from "./delegation/bot-daemon-legacy.ts";
import type { BotMessageDirectory, BotOwnedStartOutcome } from "./delegation/bot-message-contract.ts";
import { createBotMessageDirectory } from "./delegation/bot-message-directory.ts";
import { displayNameFor, suggestBotId } from "./delegation/bot-naming.ts";
import type { BotOperatorMessageOptions } from "./delegation/bot-operator-message-options.ts";
import { BotRuntimeBindings, type BotRuntimeContext, keyedBotRuntimeId } from "./delegation/bot-runtime-bindings.ts";
import { DAEMON_STALE_MS, isOlderDaemonBuild, OWN_DAEMON_BUILD } from "./delegation/bot-team-routine-helpers.ts";
import {
	createForegroundTranscriptWrites,
	type ForegroundTranscriptWriteDeps,
	type ForegroundTranscriptWrites,
	importRecordedParentWrites,
} from "./delegation/foreground-parent-writes.ts";
import { LeaderController } from "./delegation/leader-controller.ts";
import { leaderBotViewOf } from "./delegation/leader-delegation.ts";
import { type DelegationRecord, readDelegations } from "./delegation/leader-delegation-ledger.ts";
import { type LeaderRow, leaderRows } from "./delegation/leader-view.ts";
import { ManagedLaneController } from "./delegation/managed-lane-controller.ts";
import { type ManagedLaneView, projectManagedLaneViews } from "./delegation/managed-lane-views.ts";
import type { ParentWriteOrigin } from "./delegation/parent-execution-context.ts";
import {
	BOT_MEMORY_BLOCK_SEPARATOR,
	type BotOperatorMessageDispatchResult,
	type BotTeamChange,
	botChatOperatorText,
	botReplyText,
	normalizeBotOrTeamId,
	normalizeBotSoul,
	type PersistentBotDaemonStatus,
	type PersistentBotRecord,
	PersistentBotTeamStore,
	type PersistentBotView,
	type PersistentTeamMemberDelivery,
	type PersistentTeamMessage,
	type PersistentTeamRecord,
	RESERVED_BOT_CREATOR_IDS,
	type TeamOperatorMessageDispatchResult,
	teamIncarnation,
	type UpsertPersistentBotInput,
	type UpsertPersistentTeamInput,
} from "./delegation/persistent-bot-team-store.ts";
import {
	openSessionOrchestrationCore,
	type SessionOrchestrationCore,
} from "./delegation/session-orchestration-core.ts";
import type {
	SessionRootReply,
	SessionRootReplyQuery,
	SessionRootReplyWaitOptions,
	SessionRootReplyWaitResult,
} from "./delegation/session-root-mailbox.ts";
import { getWorkerClaimSnapshots, readWorkerClaimSnapshotForAttempt } from "./delegation/session-worker-claim.ts";
import { type TerminalRoute, type TerminalRouteOwner, TerminalRouting } from "./delegation/terminal-routing.ts";
import type {
	SessionRootWorkerAgentMessageOptions,
	WorkerAgentActivity,
	WorkerAgentBroadcastOptions,
	WorkerAgentBroadcastResult,
	WorkerAgentControlPort,
	WorkerAgentControlScope,
	WorkerAgentLaneResolution,
	WorkerAgentMessageOptions,
	WorkerAgentReplyResult,
	WorkerAgentRetireOptions,
	WorkerAgentRetireResult,
	WorkerAgentTaskStartOptions,
	WorkerAgentTranscriptOptions,
	WorkerAgentView,
	WorkerAgentWaitMode,
	WorkerAgentWaitResult,
	WorkerGrantSummary,
} from "./delegation/worker-agent-control.ts";
import { boundWorkerWaitTimeoutMs } from "./delegation/worker-agent-control-coordinator.ts";
import { stepDownThinkingLevel } from "./delegation/worker-authority-resolver.ts";
import { WorkerConversationStore } from "./delegation/worker-conversation-store.ts";
import { WorkerDelegationController } from "./delegation/worker-delegation-controller.ts";
import type { WorkerDelegationRequest } from "./delegation/worker-delegation-request.ts";
import { deriveFanoutGroups, type FanoutGroupReport } from "./delegation/worker-fanout.ts";
import { WorkerLaneIsolation } from "./delegation/worker-lane-isolation.ts";
import { isManagedWorkerAttempt, projectWorkerAttemptLaneRecord } from "./delegation/worker-lane-projection.ts";
import type { ManagedLaneBinding, WorkerLifecycle } from "./delegation/worker-lifecycle.ts";
import { contractGrantsChildren } from "./delegation/worker-nested-start.ts";
import { WorkerNotificationCoordinator } from "./delegation/worker-notification-coordinator.ts";
import { WorkerReceiptDelivery } from "./delegation/worker-receipt-delivery.ts";
import { captureWorkerReceiptOrigin } from "./delegation/worker-receipt-origin.ts";
import { SUBMIT_REPORT_TOOL_NAME, workerReportClaimText } from "./delegation/worker-report.ts";
import { WorkerUsageReceiptDelivery } from "./delegation/worker-usage-receipt-delivery.ts";
import type { HostEventConnectionView } from "./events/host-event-contract.ts";
import type {
	HostEventControlPort,
	HostEventControlScope,
	HostEventQuery,
	HostEventSubscriptionChange,
} from "./events/host-event-control.ts";
import { HostEventSessionController } from "./events/host-event-session-controller.ts";
import type { ManagedLaneEvent } from "./extensions/managed-lane-records.ts";
import type { ToolDefinition } from "./extensions/types.ts";
import { subscriptionAllowancePort } from "./fleet/capacity/allowance-room.ts";
import { GoalAutoContinueController } from "./goals/goal-auto-continue-controller.ts";
import type { GoalAutoContinueHold, GoalAutoContinueState } from "./goals/goal-auto-continue-state.ts";
import type { GoalRuntimeSnapshot } from "./goals/goal-runtime-snapshot.ts";
import type { GoalState } from "./goals/goal-state.ts";
import {
	CONTINUOUS_CHAT_WORK_REPORT_CUSTOM_TYPE,
	type ContinuousChatWorkReportEntry,
} from "./memory/continuous-chat-ingest.ts";
import { blockedKnowledgeHandoff, type HandoffKnowledgePort } from "./memory/knowledge-projection.ts";
import { resolveCliModel } from "./model-resolver.ts";
import type { StoredFitnessReport } from "./models/fitness-store.ts";
import { IndependentObserverSet } from "./observer-dispatch.ts";
import type { OrchestrationDelegationLimits, WorkerResultContract } from "./orchestration/contracts.ts";
import { OrchestrationEventStore } from "./orchestration/event-store.ts";
import { OrchestrationRetentionController } from "./orchestration/retention-controller.ts";
import type { RetentionPassDeps } from "./orchestration/retention-pass.ts";
import type {
	TaskProfileCreateInput,
	TaskProfileCreateResult,
	TaskProfileInspection,
} from "./orchestration/task-profile-writer.ts";
import type { TaskRuntimeProjection } from "./orchestration/task-runtime.ts";
import { readTaskRuntimeProjection } from "./orchestration/task-runtime-reader.ts";
import { isOrchestrationThinkingLevel } from "./orchestration/thinking-level-guard.ts";
import { botStartModelStance } from "./orchestration/worker-model-pins.ts";
import type { WorkerReceiptOrigin } from "./orchestration/worker-receipt-origin.ts";
import { createSteerAwareWait, ownerSteerWake } from "./pending-input-queue-controller.ts";
import { PlanExecutor } from "./plan/plan-executor.ts";
import type { PlanExecutorPort } from "./plan/plan-executor-port.ts";
import { ActAheadController } from "./proactivity/act-ahead-controller.ts";
import type { CiFailureEvidenceReader } from "./proactivity/act-ahead-record.ts";
import {
	MAX_TURN_WAKES_HOLD,
	type ParentWakeDelivery,
	ProactivityController,
	type ProactivityDailyState,
	type ProactivityFeedbackView,
	parentTurnWakes,
	rollingDayWindow,
} from "./proactivity/proactivity-controller.ts";
import { observeReviewGauge } from "./proof/review-gauge.ts";
import { isEmergencyStopEngaged, subscribeEmergencyStop } from "./provider-admission/emergency-stop.ts";
import {
	createSubscriptionAllowanceReader,
	type SubscriptionAllowanceReader,
} from "./provider-admission/subscription-allowance.ts";
import { RemoteHubController } from "./remote/hub-controller.ts";
import { finishedPlacedJobReferences } from "./remote/job-store.ts";
import { withLinkPolicy } from "./remote/link-policy.ts";
import { PlacedJobTerminalAcks } from "./remote/placed-job-terminal-acks.ts";
import { LaneModelResolver } from "./research/lane-model-resolver.ts";
import type { ModelFitnessReport } from "./research/model-fitness.ts";
import { ModelFitnessController } from "./research/model-fitness-controller.ts";
import { ResearchLaneController } from "./research/research-lane-controller.ts";
import { AwayService } from "./routines/away-service.ts";
import { RoutineIntake, type RoutineIntakeStatus } from "./routines/routine-intake.ts";
import {
	isCarriedRoutineCompletion,
	ROUTINE_RESULT_WAKES_HOLD,
	routineParentInput,
} from "./routines/routine-parent-input.ts";
import {
	RoutineSchedulerController,
	routineCiWorkflowPaths,
	routineEventAnchor,
	routineGithubInterests,
	routineHostEventFeed,
	routineWorkerRequest,
} from "./routines/routine-scheduler-controller.ts";
import { RoutineSessionController } from "./routines/routine-session-controller.ts";
import { parseRoutineToolInput, type RoutineToolView } from "./routines/routine-tool.ts";
import { RoutineWatchMonitor } from "./routines/routine-watch-monitor.ts";
import { RoutineWorkerExecutor } from "./routines/routine-worker-executor.ts";
import { WatchAdmission } from "./routines/watch-admission.ts";
import { WatchSampler } from "./routines/watch-evaluators.ts";
import { boundedRedactedDiagnosticText } from "./security/secret-text.ts";
import { getSessionRole } from "./session-role.ts";
import { getActiveSessionBranchEntries, isSessionAppendAnchorCurrent } from "./session-snapshot.ts";
import { createBotToolDefinition } from "./tools/bot.ts";
import { createPlanToolDefinition } from "./tools/plan.ts";
import { isMissingFileError } from "./util/atomic-file.ts";
import { alarmAt, type WallAlarm } from "./util/timer-port.ts";
import { type SteerDecision, type WaitStatusEvent, type WakeSource, waitFor } from "./util/wait.ts";
import type { WorktreeSyncEngineDeps } from "./worktree-sync/git-engine.ts";
import { WorktreeLaneLifecycle } from "./worktree-sync/lane-lifecycle.ts";
import { buildWorktreeSyncEngineDeps } from "./worktree-sync/runtime.ts";

/** Slack after a lease's last renewal is due, so a daemon renewing right at the limit is not mistaken for a dead one. */
const DAEMON_RECHECK_MARGIN_MS = 2_000;
/** Backoff of the re-ensure after a daemon that could not be brought up. */
const DAEMON_RECHECK_BASE_BACKOFF_MS = 15_000;
const DAEMON_RECHECK_MAX_BACKOFF_MS = 600_000;

export type { SessionChannelsView } from "./channels/session-channels.ts";
export { clampLaneMaxUsd } from "./research/lane-model-resolver.ts";

/** The channels served away, by name and directory: what the daemon's start depends on besides the routines. */
function awayChannelsKey(settings: Parameters<typeof awayChannels>[0]): string {
	return awayChannels(settings)
		.map((channel) => `${channel.name}:${channel.cwd}`)
		.join(",");
}

export class BackgroundLaneController implements WorkerAgentControlPort {
	/** Live lane registry — the real source for AutonomyStatusSnapshot.activeLaneCount. */
	private readonly _laneTracker = new LaneTracker({ onChange: () => this._laneRecordsChanged() });
	/** The session's registered channel providers, their admission and reply routing. */
	readonly channels: SessionChannels;
	private readonly _laneRecordListeners = new Set<(records: readonly LaneRecord[]) => void>();
	private _laneRecordsNotifyQueued = false;
	/** The projected bot roster, dropped by every input change. */
	private _botViews:
		| { defaultModelRef: string; delegateActive: boolean; bindings: object; views: PersistentBotView[] }
		| undefined;
	/** The live managed lanes of the roster, dropped with every lane record change. */
	private _managedLaneViews: ManagedLaneView[] | undefined;
	private _unsubscribeLaneRecordStore: (() => void) | undefined;
	/** Host-event state and source readiness observers; attached to the runtime once the lifecycle exists. */
	private readonly _hostEventStateListeners = new Set<() => void>();
	private _unsubscribeHostEventState: (() => void) | undefined;
	private readonly _laneModels: LaneModelResolver;
	private readonly _goalAutoContinue: GoalAutoContinueController;
	private readonly _research: ResearchLaneController;
	private readonly _proactivity: ProactivityController;
	/** Acting ahead on the checkout's failing CI; built on first use, started with the session's inputs. */
	private _actAhead: ActAheadController | undefined;
	/** The running CI source's failure-evidence reader, offered by the host. */
	private _ciFailureEvidence: CiFailureEvidenceReader | undefined;
	/** How the last CI event for this session reached the parent: a wake or carried past the wake bound. */
	private _lastEventDelivery: ParentWakeDelivery | undefined;
	/** Host event bindings of this session not yet fenced or closed; each keeps its running sources' connections. */
	private readonly _hostEventSessions = new Set<HostEventSessionController>();
	private readonly _fitness: ModelFitnessController;
	/** Lazily materialized only when managed-lane state is queried or reported. */
	private _managedLanes: ManagedLaneController | undefined;
	/** Leaf already scanned with no persisted active managed lane. A new leaf rescans. */
	private _managedLaneAbsenceLeafId: string | null | undefined;
	private _botTeamStore: PersistentBotTeamStore | undefined;
	private _routines:
		| {
				scheduler: RoutineSchedulerController;
				session: RoutineSessionController;
				intake: RoutineIntake;
				watches: RoutineWatchMonitor;
		  }
		| undefined;
	private routinesStarted = false;
	private _channelsHostedByDaemon = false;
	/** The routine revision the daemon was last ensured for: a save moves it, the store's other writes do not. */
	private _daemonRevision: number | undefined;
	/** The last reason the daemon could not be started by itself, reported once until it changes. */
	private _daemonStartFailure: string | undefined;
	/** The lease token of the daemon this runtime last launched: one it never replaces for its build. */
	private _launchedDaemonToken: string | undefined;
	/** The one alarm that re-ensures the daemon when the lease this session last saw would no longer be held. */
	private _daemonRecheck: WallAlarm | undefined;
	/** Consecutive ensures that could not bring the daemon up: the backoff of the next re-ensure. */
	private _daemonEnsureFailures = 0;
	/** The channels served away (name and directory) the daemon was last ensured for: a settings change naming others ensures it again. */
	private _awayChannelsKey: string | undefined;
	private _unsubscribeAwayChannelSettings: (() => void) | undefined;
	private _awayService: AwayService | undefined;
	private readonly botBindings: BotRuntimeBindings;
	/** Includes queued callers: configuration cannot pass a start that has not published its runtime yet. */
	private readonly botDispatches = new Map<string, Promise<void>>();
	/** Lazily materialized so a UAC surface without `delegate` allocates no worker runtime state. */
	private _workers: WorkerDelegationController | undefined;
	/** One durable lifecycle shared by every worker execution adapter. */
	private _workerLifecycle: WorkerLifecycle | undefined;
	/** The lifecycle's durable event store: every attempt transition commits through it. */
	private _orchestrationStore: OrchestrationEventStore | undefined;
	/** The store and lifecycle as the session opens them, before (or without) the worker composition. */
	private _orchestrationCore: SessionOrchestrationCore | undefined;
	/** Settles each unresolved running-attempt wait when the session is disposed. */
	private readonly _runningAttemptWaits = new Set<() => void>();
	/** Durable usage delivery shares the lifecycle's event store, independently of terminal handoffs. */
	private _workerUsage: WorkerUsageReceiptDelivery | undefined;
	private _workerReceipts: WorkerReceiptDelivery | undefined;
	private _transcriptWrites: ForegroundTranscriptWrites | undefined;
	/** Attempts whose recorded parent writes have not landed in this transcript yet; their terminal notices wait. */
	private _parentWriteHolds: ReadonlySet<string> = new Set();
	/** Shared terminal outbox for managed and in-process workers; lazy under UAC omission. */
	private _workerNotifications: WorkerNotificationCoordinator | undefined;
	private readonly _continuationListeners = new IndependentObserverSet<() => void>();
	private readonly deps: BackgroundLaneControllerDeps;

	/** Emit a warning without ever throwing — used from disposal-adjacent persistence where a
	 * listener failure (or a bare test double missing `emit`) must never block or crash cleanup. */
	private _safeWarn(message: string): void {
		try {
			this.deps.emit({ type: "warning", message });
		} catch {
			// Dispose must never throw.
		}
	}

	private _recordWorkerTerminal(record: LaneRecord, durableNotificationId: string): void {
		this._getWorkerNotificationCoordinator().recordTerminal(record, durableNotificationId);
	}

	constructor(deps: BackgroundLaneControllerDeps) {
		this.deps = deps;
		this.channels = new SessionChannels({
			getAgentDir: () => deps.getAgentDir(),
			getSessionManager: () => deps.getSessionManager(),
			getChannelPolicies: () => withLinkPolicy(deps.getSettingsManager().getChannelPolicies(), deps.getAgentDir()),
			subscribeSettings: (listener) => deps.getSettingsManager().subscribeChanges(listener),
			subscribeForegroundActivity: (listener) => deps.subscribeForegroundActivity(listener),
			sendUserMessage: (text, options) => deps.sendUserMessage(text, options),
			...(deps.ownerChannel ? { ownerDelivery: deps.ownerChannel } : {}),
			ownerControl: () => deps.ownerChannel?.control(),
			isEmergencyStopEngaged: () => isEmergencyStopEngaged(deps.getAgentDir()),
			subscribeEmergencyStop: (listener) => subscribeEmergencyStop(deps.getAgentDir(), listener),
			observeNotice: (kind, read, onLost) => deps.observeHarnessNotice?.(kind, read, onLost) ?? false,
			warn: (message) => this._safeWarn(message),
			isDisposed: () => deps.isDisposed(),
			isChildSession: () => deps.isChildSession(),
			refreshTools: () => deps.refreshToolRegistry(),
			timers: deps.getTimers().port("channel-poll"),
			wakeTimers: deps.getTimers().port("channel-expiry"),
		});
		this.botBindings = new BotRuntimeBindings(() => deps.getSessionManager());
		this._laneModels = new LaneModelResolver(deps);
		this._research = new ResearchLaneController(
			{ ...deps, onContinuationActivity: () => this._notifyContinuationActivity() },
			this._laneTracker,
			this._laneModels,
		);
		this._proactivity = new ProactivityController(
			{
				...deps,
				timers: deps.getTimers().port("proactivity"),
				getSystemOneEngine: () => deps.systemOne.recordingSemanticEngine(),
			},
			this._laneModels,
		);
		this._fitness = new ModelFitnessController(deps, this._laneModels);
		this._goalAutoContinue = new GoalAutoContinueController({
			isDisposed: deps.isDisposed,
			isGoalToolActive: deps.isGoalToolActive,
			getSettingsManager: deps.getSettingsManager,
			getGoalRuntimeSnapshot: deps.getGoalRuntimeSnapshot,
			hasInFlightLaneForGoal: (goalId) => this._hasInFlightLaneForGoal(goalId),
			continueGoalLoop: deps.continueGoalLoop,
			isForegroundBusy: deps.isForegroundBusy,
			waitForForegroundIdle: deps.waitForForegroundIdle,
			markGoalToolUnavailable: deps.markGoalToolUnavailable,
			emit: deps.emit,
			onContinuationActivity: () => this._notifyContinuationActivity(),
			timers: deps.getTimers().port("goal-continuation"),
		});
		queueMicrotask(() => this.signalWorkerReceiptDelivery());
	}

	/** The model a fresh worker would run on now (see WorkerDelegationController.previewWorkerModel). */
	previewWorkerModel(): Model<Api> | undefined {
		return this._getWorkerController().previewWorkerModel();
	}

	/**
	 * The owner-memory port extensions hand knowledge from: a grant to a lane with no profile of its own (an
	 * externally managed member) follows the `delegate` worker rule, checked at the grant and again at delivery.
	 */
	handoffKnowledge(memory: HandoffKnowledgePort): HandoffKnowledgePort {
		const workerReadsKnowledge = () => this._getWorkerController().previewWorkerReadsKnowledge();
		return {
			getHandoffPersonaGuidance: () => memory.getHandoffPersonaGuidance(),
			projectKnowledgeForHandoff: (references, maxBytes) => {
				const projection = memory.projectKnowledgeForHandoff(references, maxBytes);
				if (projection.blocked || projection.references.length === 0) return projection;
				if (!workerReadsKnowledge()) return blockedKnowledgeHandoff("worker_knowledge_capability_required");
				return { ...projection, isCurrent: () => projection.isCurrent() && workerReadsKnowledge() };
			},
		};
	}

	/** A worker agent's durable chat, for the ICM worker log; undefined when no such agent exists. */
	openWorkerTranscript(agentId: string) {
		return this._getWorkerController().openWorkerTranscript(agentId);
	}

	/** Capture immutable transcript provenance without constructing a worker runtime or opening its files. */
	workerTranscriptReference(record: Pick<LaneRecord, "laneId" | "attemptId">): string | undefined {
		const binding = this.nativeWorkerForRecord(record)?.binding;
		return binding
			? WorkerConversationStore.transcriptReferenceForBinding(
					this.deps.getAgentDir(),
					this.deps.getSessionId(),
					binding,
				)
			: undefined;
	}

	/** The session-writer half of the foreground parent write port; built once, on first worker use. */
	private _getTranscriptWrites(): ForegroundTranscriptWrites {
		if (this._transcriptWrites) return this._transcriptWrites;
		const deps: ForegroundTranscriptWriteDeps = {
			getSessionManager: () => this.deps.getSessionManager(),
			getAgentDir: () => this.deps.getAgentDir(),
			saveWorkerClaimSnapshot: (claim, request, options) =>
				this.deps.saveWorkerClaimSnapshot(claim, request, options),
			warn: (message) => this._safeWarn(message),
		};
		const { notifyParentSession, reportWorkerTerminal } = this.deps;
		if (notifyParentSession) deps.notifyParentSession = notifyParentSession;
		if (reportWorkerTerminal) deps.reportWorkerTerminal = reportWorkerTerminal;
		this._transcriptWrites = createForegroundTranscriptWrites(deps);
		return this._transcriptWrites;
	}

	/**
	 * Land every write another host recorded for this parent, in record order. Returns the attempts still holding
	 * writes; their terminal notices wait so a claim never lands after the completion it explains. A foreground-only
	 * session records none, so this finds nothing.
	 */
	private _importParentWrites(lifecycle: WorkerLifecycle): ReadonlySet<string> {
		return importRecordedParentWrites(
			lifecycle.ledger.runtime,
			this._getTranscriptWrites().importParentWrite,
			(message) => this._safeWarn(message),
		);
	}

	/** Whether a plain worker could start now (and why not), for the session-start readiness check. */
	probeWorkerReadiness(): ReturnType<WorkerDelegationController["probeWorkerReadiness"]> {
		return this._getWorkerController().probeWorkerReadiness();
	}

	private _allowance: SubscriptionAllowanceReader | undefined;
	private readonly _terminalRouting = new TerminalRouting();

	/** Claims a durable terminal for a structured owner (plan executor, leader controller); see `terminal-routing.ts`. */
	registerTerminalRoute(owner: TerminalRouteOwner, route: TerminalRoute): () => void {
		return this._terminalRouting.register(owner, route);
	}

	private _getWorkerController(): WorkerDelegationController {
		if (this._workers) return this._workers;
		this._workers = new WorkerDelegationController(
			{
				...this.deps,
				...this._getTranscriptWrites(),
				createBotMessageDirectory: (sender, attempt) => this.createBotMessageDirectory(sender, attempt),
				// The worker's model decides the account the fleet's allowance term reads, not the foreground's.
				fleetAllowance: subscriptionAllowancePort(
					() =>
						(this._allowance ??= createSubscriptionAllowanceReader({
							getRegistry: () => this.deps.getModelRegistry(),
							getModel: () => this.deps.getModel(),
						})),
				),
			},
			this._getWorkerNotificationCoordinator(),
			this._getWorkerLifecycle(),
			new WorkerLaneIsolation(this._worktreeLaneHostDeps()),
		);
		// The fleet exists now: a joined machine's room reaches it, so a plan node or a placed job can name that machine.
		this._remoteHub?.jobs?.attachFleet(this._workers.getFleet());
		return this._workers;
	}

	/** Worktree lane deps for this session; `gated` applies the sync gate to the engine deps (the managed-lane lifecycle). */
	private _worktreeLaneHostDeps(gated = false) {
		return {
			engineDeps: (cwd?: string) => this._worktreeEngineDeps(cwd, gated),
			isolateByDefault: () => this.deps.getSettingsManager().getWorktreeSyncSettings().enabled,
			notifyParent: (text: string, origin?: ParentWriteOrigin) =>
				this.deps.notifyParentSession?.("worktree-sync-notice", text, origin),
			warn: (message: string) => this._safeWarn(message),
		};
	}

	/** Engine deps rooted at `cwd` (the session's directory when omitted); undefined when sync is disabled and `gated`. */
	private _worktreeEngineDeps(cwd?: string, gated = true): WorktreeSyncEngineDeps | undefined {
		if (gated && !this.deps.getSettingsManager().getWorktreeSyncSettings().enabled) return undefined;
		return buildWorktreeSyncEngineDeps({
			cwd: cwd ?? this.deps.getCwd(),
			agentDir: this.deps.getAgentDir(),
			settingsManager: this.deps.getSettingsManager(),
			sessionId: this.deps.getSessionId(),
			integrationBranch: () => this.deps.localCommitBranch?.() || undefined,
			ports: this.deps.getWorktreeSyncEnginePorts(),
		});
	}

	/** The session's store and durable lifecycle, opened once; the retention pass reads it without the worker composition. */
	private _getOrchestrationCore(): SessionOrchestrationCore {
		this._orchestrationCore ??= openSessionOrchestrationCore({
			agentDir: this.deps.getAgentDir(),
			sessionId: this.deps.getSessionId(),
			timers: this.deps.getTimers(),
		});
		return this._orchestrationCore;
	}

	private _getWorkerLifecycle(): WorkerLifecycle {
		if (this._workerLifecycle) return this._workerLifecycle;
		const parentSessionId = this.deps.getSessionId();
		const { store, lifecycle } = this._getOrchestrationCore();
		this._workerLifecycle = lifecycle;
		this._orchestrationStore = store;
		this._unsubscribeLaneRecordStore = store.subscribe(() => this._laneRecordsChanged());
		// Readiness can change without a ledger commit (an identical re-seal in a new process), so observers follow both.
		this._unsubscribeHostEventState = lifecycle.ledger.runtime.hostEvents.subscribe(() => {
			for (const listener of [...this._hostEventStateListeners]) listener();
		});
		this._workerUsage = new WorkerUsageReceiptDelivery({
			parentSessionId,
			runtime: lifecycle.ledger.runtime,
			subscribe: (listener) => store.subscribe(listener),
			deliver: (usage, options) =>
				deliverSpawnedUsageReceipt(this.deps.getSessionManager(), this.deps, usage, options),
			isDisposed: () => Boolean(this.deps.isDisposed?.()),
			warn: (message) => this._safeWarn(message),
		});
		this._workerReceipts = new WorkerReceiptDelivery({
			agentDir: this.deps.getAgentDir(),
			runtime: lifecycle.ledger.runtime,
			getSessionManager: () => this.deps.getSessionManager(),
			subscribe: (listener) => store.subscribe(listener),
			isDisposed: () => Boolean(this.deps.isDisposed()),
			warn: (message) => this._safeWarn(message),
		});
		this._parentWriteHolds = this._importParentWrites(lifecycle);
		// A delegation's leader turns are its own input: the claim must stand before the outbox replays, and the controller
		// adopts every open delegation the last process left once the replay is done.
		if (!this.deps.isChildSession()) {
			this._composePlanExecutor(lifecycle, store);
			const leaders = this._getLeaders();
			this._leaderRouteOff ??= this.registerTerminalRoute("leader_controller", (record) =>
				leaders.claimsTerminal(record),
			);
			// A worker that runs a job a peer placed here reports to that peer through the job runner, never to this session's chat.
			if (!this._jobRouteOff)
				this._jobRouteOff = this.registerTerminalRoute("job_runner", (record) =>
					this._placedJobAcks.routeOwns(record.attemptId),
				);
			queueMicrotask(() => {
				if (!this.deps.isDisposed()) leaders.start();
			});
		}
		this._replayPendingTerminals(lifecycle, () => true);
		return lifecycle;
	}

	/** Replay the durable terminal outbox, except attempts whose recorded parent writes have not landed yet. */
	private _replayPendingTerminals(
		lifecycle: WorkerLifecycle,
		include: (attemptId: string | undefined) => boolean,
	): void {
		for (const notification of lifecycle.getPendingTerminalNotifications()) {
			const attemptId = notification.record.attemptId;
			if (attemptId !== undefined && this._parentWriteHolds.has(attemptId)) continue;
			if (!include(attemptId)) continue;
			this._getWorkerNotificationCoordinator().recordTerminal(notification.record, notification.notificationId);
		}
	}

	private _getWorkerNotificationCoordinator(): WorkerNotificationCoordinator {
		// Terminal observation is driven by exact lane IDs in the wait result, never by the presence
		// of a live waiter at terminal-record time.
		this._workerNotifications ??= new WorkerNotificationCoordinator({
			timers: this.deps.getTimers().port("worker-notification"),
			getWorkerRecords: () => this._workerLifecycle?.getAllRecords() ?? [],
			ensureDurableNotification: (record) => this._ensureDurableNotification(record),
			emitStatus: (status) => {
				try {
					this.deps.emit({
						type: "delegate_workers",
						...status,
						terminalSinceFlush: [...status.terminalSinceFlush],
					});
				} catch {
					// A partial integration must not crash the event-driven terminal outbox.
				}
			},
			deliveryOwner: (record, notificationId) => {
				const notification = this._getWorkerLifecycle().getTaskRuntimeSnapshot().notifications[notificationId];
				if (!notification) throw new Error("Worker notification is absent from the durable outbox.");
				if (notification.status === "delivered") return "acknowledged";
				// A plan- or delegation-owned terminal is that owner's input; its outbox entry stays pending until it acknowledges.
				if (this._terminalRouting.route(record)) return "separate";
				// An acting-ahead worker's completion is that episode's own input; it never wakes the owner.
				if (
					!this.deps.isChildSession() &&
					this._getActAhead().ownsNotification(record, this._getWorkerLifecycle().getTaskRuntimeSnapshot())
				)
					return "separate";
				if (this.deps.canRunRoutines?.() === false) return "coordinator";
				this.getBotTeamStore();
				if (!this._routines) throw new Error("Routine notification owner is unavailable.");
				return this._routines.scheduler.ownsNotification(record) ? "separate" : "coordinator";
			},
			notify: (records) => this.deps.notifyWorkerTerminalHandoff(records),
			warn: (message) => this._safeWarn(message),
			markDurableDelivered: (notificationIds) => this._workerLifecycle?.markNotificationsDelivered(notificationIds),
		});
		return this._workerNotifications;
	}

	/** Resolve one native generation, never the lane's newer attempt or a same-named managed process. */
	private nativeWorkerForRecord(record: Pick<LaneRecord, "laneId" | "attemptId">) {
		const snapshot = this._workerLifecycle?.getTaskRuntimeSnapshot();
		const attempt = record.attemptId === undefined ? undefined : snapshot?.attempts[record.attemptId];
		if (!attempt || attempt.taskId !== record.laneId || isManagedWorkerAttempt(attempt)) return undefined;
		return { attempt, binding: attempt.agentId ? snapshot?.agents[attempt.agentId] : undefined };
	}

	/** Display the exact generation's native agent, or retain the lane label when no native identity exists. */
	workerAgentIdForRecord(record: Pick<LaneRecord, "laneId" | "attemptId">): string {
		const attempt = this.nativeWorkerForRecord(record)?.attempt;
		return attempt?.agentId ?? attempt?.dispatch.logicalLaneId ?? record.laneId;
	}

	/**
	 * Acknowledges the terminal of these worker lanes once the job runner has reported their end to the placing machine, so
	 * the foreground never hears a placed job's worker finish. A lane with no terminal yet is left as it is.
	 */
	acknowledgePlacedJobTerminals(references: readonly string[]): void {
		this._placedJobAcks.acknowledge(references);
	}

	/** Acknowledge the captured generations only, without reselecting a task or interpreting a display name. */
	observeWorkerAttemptTerminals(attemptIds: readonly string[]): void {
		const snapshot = this._workerLifecycle?.getTaskRuntimeSnapshot();
		if (snapshot) this._observeExactAttemptTerminals(snapshot, [...new Set(attemptIds)]);
	}

	observeWorkerTerminalRecords(records: readonly LaneRecord[]): void {
		const terminal = records.filter((record) => isLaneTerminalStatus(record.status));
		if (terminal.length > 0) this._getWorkerNotificationCoordinator().observeTerminals(terminal);
	}

	/**
	 * Backfills a durable notification for every record about to be flushed, through the SAME
	 * durable notification store `_getWorkerLifecycle()` already replays from on construction
	 * (`getPendingTerminalNotifications()` / `markNotificationsDelivered()`) -- not a new
	 * persistence subsystem. `WorkerLifecycle.getTerminalNotification()` is idempotent (it reuses
	 * an existing durable entry for the same laneId/attemptId or creates exactly one), so calling
	 * it for a record that already has a durable notification is a safe no-op. Without this, a
	 * "transient:<laneId>:<completedAt>" record (recorded without a durableNotificationId — e.g.
	 * because no attempt was resolvable at record time) has no trace in the durable ledger at all:
	 * if it's still stuck behind an unresolved notify() when the process restarts, the replay on
	 * the next construction can only find what was durably enqueued, so it would be lost instead of
	 * replayed.
	 */
	private _ensureDurableNotification(record: Pick<LaneRecord, "laneId" | "attemptId">): string | undefined {
		// A record that names its generation binds to that generation's outbox entry, never the lane's latest.
		return record.attemptId !== undefined
			? this._workerLifecycle?.getAttemptTerminalNotification(record.attemptId)?.notificationId
			: this._workerLifecycle?.getTerminalNotification(record.laneId)?.notificationId;
	}

	private _getManagedLaneController(): ManagedLaneController {
		this._managedLanes ??= new ManagedLaneController(
			this.deps,
			this._getWorkerLifecycle(),
			(record, notificationId) => this._recordWorkerTerminal(record, notificationId),
			(message) => this._safeWarn(message),
			(attemptId, ownerEpoch) =>
				this._getWorkerNotificationCoordinator().noteAttemptOwnerEpoch(attemptId, ownerEpoch),
			new WorktreeLaneLifecycle(this._worktreeLaneHostDeps(true)),
		);
		return this._managedLanes;
	}

	private _hydrateManagedLanes(): void {
		if (this._managedLanes) {
			this._managedLanes.ensureHydrated();
			return;
		}
		const session = this.deps.getSessionManager();
		const leafId = typeof session.getLeafId === "function" ? session.getLeafId() : undefined;
		if (leafId !== undefined && this._managedLaneAbsenceLeafId === leafId) return;
		const hasPersistedActiveManagedLane = getLatestLaneRecordSnapshots(getActiveSessionBranchEntries(session)).some(
			(record) => record.type === "managed-worker" && (record.status === "queued" || record.status === "running"),
		);
		if (hasPersistedActiveManagedLane) {
			this._getManagedLaneController().ensureHydrated();
			return;
		}
		if (leafId !== undefined) this._managedLaneAbsenceLeafId = leafId;
	}

	subscribeLaneRecords(listener: (records: readonly LaneRecord[]) => void): () => void {
		this._laneRecordListeners.add(listener);
		return () => void this._laneRecordListeners.delete(listener);
	}

	private _cachedLaneRecords?: LaneRecord[];

	private _laneRecordsChanged(): void {
		this._botViews = undefined;
		this._managedLaneViews = undefined;
		this._cachedLaneRecords = undefined;
		this._leaderRows = undefined;
		if (this._laneRecordListeners.size === 0 || this._laneRecordsNotifyQueued) return;
		this._laneRecordsNotifyQueued = true;
		queueMicrotask(() => {
			this._laneRecordsNotifyQueued = false;
			if (this._laneRecordListeners.size === 0) return;
			let records: LaneRecord[];
			try {
				records = this.getLaneRecords();
			} catch (error) {
				this._safeWarn(`Lane records could not be read: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
			for (const listener of [...this._laneRecordListeners]) {
				try {
					listener(records);
				} catch {
					this._safeWarn("Lane record observer failed.");
				}
			}
		});
	}

	/** Live lane records tracked by this process (running and terminal). */
	getLaneRecords(): LaneRecord[] {
		this._hydrateManagedLanes();
		if (this._cachedLaneRecords !== undefined) {
			return this._cachedLaneRecords.map((r) => ({ ...r }));
		}
		const workerRecords = this._workers
			? this._workers.getRecords()
			: this.deps.isDelegateToolActive?.() && this._hasWorkerState()
				? this._getWorkerController().getRecords()
				: [];
		const records = [
			...this._laneTracker.getRecords(),
			...workerRecords,
			...(this._workerLifecycle?.getManagedRecords() ?? []),
		];
		this._cachedLaneRecords = records;
		return records.map((r) => ({ ...r }));
	}

	/** Worker resources of the worker controller this session has already loaded. Never constructs one: undefined means none was loaded. */
	getWorkerResourceSnapshot(): ReturnType<WorkerDelegationController["getResourceSnapshot"]> | undefined {
		return this._workers?.getResourceSnapshot();
	}

	getTaskRuntimeSnapshot(): TaskRuntimeProjection | undefined {
		return this._workerLifecycle?.getTaskRuntimeSnapshot();
	}

	getHostEventSubjects() {
		return this._workerLifecycle?.ledger.runtime.hostEvents.subscribedSubjects() ?? [];
	}

	/** What this session's GitHub routines ask its CI source to collect; changes with the routine store. */
	getGithubInterests() {
		return routineGithubInterests(this.getBotTeamStore().listRoutines(), this.deps.getSessionId(), Date.now());
	}

	subscribeRoutineDefinitions(listener: () => void): () => void {
		return this.getBotTeamStore().subscribe(listener);
	}

	readHostEvents(query: HostEventQuery, scope?: HostEventControlScope) {
		return this._getHostEventControl().readHostEvents(query, scope);
	}

	changeHostEventSubscriptions(input: HostEventSubscriptionChange, scope?: HostEventControlScope) {
		return this._getHostEventControl().changeHostEventSubscriptions(input, scope);
	}

	/**
	 * A guard captured now that throws `message` once the session's branch moved, the session was replaced or disposed, or
	 * `stillValid` no longer holds: what a routine origin or an intake decision is checked against before it is saved.
	 */
	private sessionBranchGuard(message: string, stillValid: () => boolean = () => true): () => void {
		const manager = this.deps.getSessionManager();
		const assertBranch = manager.captureBranchContext();
		return () => {
			assertBranch();
			if (this.deps.isDisposed() || this.deps.getSessionManager() !== manager || !stillValid())
				throw new Error(message);
		};
	}

	private _getHostEventControl(): HostEventControlPort {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		const control = this._getWorkerController().getAgentControl();
		if (!control.readHostEvents || !control.changeHostEventSubscriptions)
			throw new Error("Host event control is unavailable.");
		return control as HostEventControlPort;
	}

	/** Runtime resources own this binding's lifetime; every accepted event uses the shared task ledger. */
	openHostEventSession(signal: AbortSignal): HostEventSessionController {
		const manager = this.deps.getSessionManager();
		const sessionId = manager.getSessionId();
		const sessionFile = manager.getSessionFile();
		const assertCurrent = () => {
			signal.throwIfAborted();
			if (
				this.deps.isDisposed() ||
				this.deps.getSessionManager() !== manager ||
				manager.getSessionId() !== sessionId ||
				manager.getSessionFile() !== sessionFile
			)
				throw new Error("Host events belong to a retired session.");
		};
		assertCurrent();
		const controller = new HostEventSessionController({
			runtime: this._getWorkerLifecycle().ledger.runtime,
			agentDir: this.deps.getAgentDir(),
			sessionId,
			signal,
			assertCurrent,
			captureOrigin: () => captureWorkerReceiptOrigin(manager, assertCurrent),
			canDeliver: () => !this.deps.isDisposed() && this.deps.getSettingsManager().getProactivitySettings().enabled,
			subscribeContext: (listener) => this.deps.subscribeForegroundActivity(listener),
			subscribeSettings: (listener) => this.deps.getSettingsManager().subscribeChanges(listener),
			admitRootDelivery: async (deliveryId) => {
				// A replay must repeat the saved metadata, so a saved delivery is never measured again.
				const saved = manager.getParentInput(deliveryId);
				if (saved) return { mode: saved.metadata.mode };
				const day = await this.deps.aggregateUsageWindow(rollingDayWindow(Date.now()));
				return parentTurnWakes(day) >= this.deps.getSettingsManager().getProactivitySettings().maxTurnWakesPerDay
					? { mode: "next-owner-turn", hold: MAX_TURN_WAKES_HOLD }
					: { mode: "turn" };
			},
			rootDelivered: (delivery) => {
				this._lastEventDelivery = delivery;
			},
			deliverParent: (input, options) => this.deps.deliverNotes(input, options),
			heldParentInputs: () =>
				manager.getPendingParentInputs("next-owner-turn").map((input) => input.metadata.deliveryId),
			skipParentInput: (deliveryId, reason) => manager.skipPendingParentInput(deliveryId, reason),
			deliverTask: async (delivery, active) => {
				const control = this._getWorkerController().getAgentControl();
				return control.deliverHostEvent ? control.deliverHostEvent(delivery, active) : "unavailable";
			},
			reconcileTask: (delivery) => {
				const control = this._getWorkerController().getAgentControl();
				if (!control.reconcileHostEventDelivery) throw new Error("Host event reconciliation is unavailable.");
				control.reconcileHostEventDelivery(delivery);
			},
			observeNotice: (kind, read) => this.deps.observeHarnessNotice?.(kind, read),
			warn: (message) => this._safeWarn(message),
			retired: (retired) => this._hostEventSessions.delete(retired),
		});
		this._hostEventSessions.add(controller);
		return controller;
	}

	/** Read-only: the connections the running host event sources of this session's open bindings last reported. */
	readHostEventConnections(): readonly HostEventConnectionView[] {
		return [...this._hostEventSessions].flatMap((session) => session.connections());
	}

	getWorkerResult(laneId: string): WorkerResultContract | undefined {
		return this._workerLifecycle?.getResult(laneId);
	}

	/** Fan-out groups read from the durable ledger; zero-load when delegation was never materialized. */
	getWorkerFanoutGroups(): FanoutGroupReport[] {
		if (this._workers) return this._workers.getFanoutGroups();
		const snapshot = this._workerLifecycle?.getTaskRuntimeSnapshot();
		return snapshot ? deriveFanoutGroups(snapshot) : [];
	}

	/** The result of one exact attempt (generation), never a later generation of the same lane. */
	getWorkerAttemptResult(attemptId: string): WorkerResultContract | undefined {
		return this._workerLifecycle?.getTaskRuntimeSnapshot().attempts[attemptId]?.result;
	}

	/** Reconcile only when delegation has already been materialized; UAC omission stays zero-load. */
	synchronizeGoalState(goal: GoalState): void {
		this._workers?.synchronizeGoalState(goal);
		this._planExecutor?.noteGoalChanged();
	}

	/**
	 * Resolve a tracked managed-lane dispatch. The caller's stable id is also the canonical durable
	 * lane id, so this is an existence check rather than an id translation.
	 */
	resolveManagedLaneId(callerLaneId: string): string | undefined {
		return this._getManagedLaneController().resolve(callerLaneId);
	}

	/** Live count of active lanes — the real source for AutonomyStatusSnapshot.activeLaneCount. */
	getActiveLaneCount(): number {
		return this.getLaneRecords().filter((record) => record.status === "queued" || record.status === "running").length;
	}

	/** Belt-and-braces guard: whether ANY queued/running lane is tagged with this goalId. */
	private _hasInFlightLaneForGoal(goalId: string): boolean {
		return this.getLaneRecords().some(
			(record) => record.goalId === goalId && (record.status === "queued" || record.status === "running"),
		);
	}

	/** Delegate the out-of-process dispatch/terminal claim to its single lifecycle owner. */
	recordManagedLane(event: ManagedLaneEvent): LaneRecord | undefined {
		return this._getManagedLaneController().record(event);
	}

	/** The durable attempts of every managed lane, by lane id: id, turn, dispatch authorization and whether each has ended. */
	managedLaneBindings(): ReadonlyMap<string, ManagedLaneBinding> {
		return this._getWorkerLifecycle().getManagedBindings();
	}

	/** Why the last idle research-lane evaluation skipped, for /autonomy diagnostics. */
	getLastResearchLaneSkipReason(): string | undefined {
		return this._research.getLastSkipReason();
	}

	/**
	 * Abort in-flight research and delegate worker disposal to its single owning controller.
	 *
	 * This synchronous body is the LAST provably-safe write window for canceled/in-flight work.
	 * `dispose()` (agent-session.ts) has already set the session's own disposed flag but has not yet
	 * returned — no successor session (e.g. a `/reload` adoption) can exist yet, so an append here
	 * cannot interleave with one; a post-await continuation resuming AFTER this method returns must
	 * not append (see the disposed branch in `runWorkerDelegationOnce`). Persist FIRST, then
	 * complete-in-memory, so a throw from one lane's persist cannot skip another's; each persist gets
	 * its own try/catch — dispose must never throw.
	 */
	abortInFlightLanes(): Promise<void> {
		let workerShutdown = Promise.resolve();
		this._runTeardownStep("dispose goal auto-continue", () => this._goalAutoContinue.dispose());
		this._runTeardownStep("abort research lanes", () => this._research.abort());
		this._runTeardownStep("stop retention", () => this._retention?.clearTimer());
		this._runTeardownStep("abort proactive review", () => this._proactivity.abort());
		this._runTeardownStep("abort model-fitness lanes", () => this._fitness.abort());
		for (const record of this._laneTracker.getRecords()) {
			if (record.status !== "queued" && record.status !== "running") continue;
			if (record.type === "managed-worker") continue;
			const canceled = this._laneTracker.complete(record.laneId, {
				status: "canceled",
				reasonCode: "session_disposed",
			});
			if (!canceled) continue;
			try {
				appendLaneRecordSnapshot(this.deps.getSessionManager(), canceled);
			} catch (error) {
				this._safeWarn(
					`Failed to persist canceled lane record ${canceled.laneId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		this._runTeardownStep("close the remote hub", () => void this._remoteHub?.stop());
		this._runTeardownStep("release managed lanes", () => this._managedLanes?.release());
		this._runTeardownStep("settle running-attempt waits", () => {
			for (const settle of [...this._runningAttemptWaits]) settle();
		});
		this._runTeardownStep("abort worker delegation", () => {
			workerShutdown = this._workers?.abort() ?? Promise.resolve();
		});
		this._runTeardownStep("dispose worker usage delivery", () => this._workerUsage?.dispose());
		this._runTeardownStep("dispose worker receipt delivery", () => this._workerReceipts?.dispose());
		this._runTeardownStep("dispose worker notifications", () => this._workerNotifications?.dispose());
		this._runTeardownStep("dispose the plan executor", () => {
			this._planRouteOff?.();
			this._planRouteOff = undefined;
			this._planExecutor?.dispose();
		});
		this._runTeardownStep("dispose the leader controller", () => {
			this._leaderRouteOff?.();
			this._leaderRouteOff = undefined;
			this._leaders?.dispose();
		});
		this._runTeardownStep("stop routine watches", () => this._routines?.watches.dispose());
		let routineShutdown = Promise.resolve();
		this._runTeardownStep("stop routine scheduler", () => {
			routineShutdown = this._routines?.scheduler.close() ?? Promise.resolve();
		});
		let intakeShutdown = Promise.resolve();
		this._runTeardownStep("stop routine intake", () => {
			intakeShutdown = this._routines?.intake.stop() ?? Promise.resolve();
		});
		let actAheadShutdown = Promise.resolve();
		this._runTeardownStep("stop acting ahead", () => {
			actAheadShutdown = this._actAhead?.close() ?? Promise.resolve();
		});
		let awayServiceShutdown = Promise.resolve();
		this._runTeardownStep("stop the always-on install", () => {
			awayServiceShutdown = this._awayService?.close() ?? Promise.resolve();
		});
		const unsubscribeAwayChannelSettings = this._unsubscribeAwayChannelSettings;
		this._unsubscribeAwayChannelSettings = undefined;
		this._runTeardownStep("unsubscribe away channel settings", () => unsubscribeAwayChannelSettings?.());
		this._runTeardownStep("stop the daemon lease re-ensure", () => this._armDaemonRecheck(undefined));
		this._runTeardownStep("dispose bot and team store", () => this._botTeamStore?.dispose());
		const unsubscribeLaneRecordStore = this._unsubscribeLaneRecordStore;
		this._unsubscribeLaneRecordStore = undefined;
		this._runTeardownStep("unsubscribe lane records", () => unsubscribeLaneRecordStore?.());
		const unsubscribeHostEventState = this._unsubscribeHostEventState;
		this._unsubscribeHostEventState = undefined;
		this._runTeardownStep("unsubscribe host event state", () => {
			unsubscribeHostEventState?.();
			this._hostEventStateListeners.clear();
		});
		// Disposal completes only after the routine and intake passes and their deliveries joined, not merely after they
		// were told to stop: intake awaits every notice it starts, and stopping aborts a notice still waiting to be saved.
		return Promise.all([workerShutdown, routineShutdown, intakeShutdown, actAheadShutdown, awayServiceShutdown]).then(
			() => undefined,
		);
	}

	private _runTeardownStep(label: string, step: () => void): void {
		try {
			step();
		} catch (error) {
			this._safeWarn(`Failed to ${label}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	clearGoalAutoContinueTimer(): void {
		this._goalAutoContinue.clearTimer();
	}

	scheduleGoalAutoContinueFromIdle(options?: PromptOptions): void {
		this._goalAutoContinue.scheduleFromIdle(options);
	}

	describeGoalAutoContinue(snapshot: GoalRuntimeSnapshot): GoalAutoContinueState {
		return this._goalAutoContinue.describeState(snapshot);
	}

	goalAutoContinueHold(): GoalAutoContinueHold | undefined {
		return this._goalAutoContinue.hold();
	}

	reconcileGoalContinuationToolAvailability(resumeGoalToolAvailable?: () => boolean): void {
		this._goalAutoContinue.reconcileToolAvailability(resumeGoalToolAvailable);
	}

	/**
	 * Single-flight entry point for EVERY goal-continuation loop invocation — idle autosteer
	 * ({@link _runScheduledGoalAutoContinue}) AND the manual `/goal start` / `/goal-continue`
	 * commands (reached through `AgentSession.continueGoalLoop`). Both paths ultimately submit
	 * continuation prompts through the session's single `prompt()` path, so two loops racing throws
	 * "Agent is already processing" from whichever submits second. `_isGoalAutoContinuing` is the
	 * ONE owner of that mutex; `deps.continueGoalLoop` (the raw {@link GoalLoopController} loop)
	 * must never be called directly outside this method, or the guard is bypassed.
	 */
	async continueGoalLoopExclusive(options: GoalContinuationLoopOptions): Promise<GoalContinuationLoopResult> {
		return this._goalAutoContinue.continueExclusive(options);
	}

	clearResearchLaneTimer(): void {
		this._research.clearTimer();
		this._proactivity.clearTimer();
		this._retention?.clearTimer();
	}

	/**
	 * True while EITHER idle lane has a continuation armed or running. The session's settled check
	 * consults this so a debounce timer armed moments earlier suppresses the notification.
	 */
	hasPendingIdleContinuation(): boolean {
		return this._goalAutoContinue.hasPendingContinuation() || this._research.hasPendingContinuation();
	}

	subscribeIdleContinuationActivity(listener: () => void): () => void {
		return this._continuationListeners.subscribe(listener);
	}

	private _notifyContinuationActivity(): void {
		this._continuationListeners.notify(
			(listener) => listener(),
			() => this._safeWarn("Idle continuation activity observer failed."),
		);
	}

	scheduleResearchLaneFromIdle(): void {
		this._research.scheduleFromIdle();
		this._proactivity.scheduleFromIdle();
		this._getRetention().scheduleFromIdle();
		// The review gauge informs only: past the owner's threshold one notice says results pile up; nothing is held.
		observeReviewGauge({
			observeHarnessNotice: (kind, read) => this.deps.observeHarnessNotice?.(kind, read),
			getBranch: () => this.deps.getSessionManager().getBranch(),
			getNoticeAt: () => this.deps.getSettingsManager().getReviewWaitingNoticeAt(),
		});
	}

	/** One proactive review now, past the idle timer; every other gate still applies. */
	runProactiveReviewOnce() {
		return this._proactivity.runOnce();
	}

	getLastProactivitySkipReason(): string | undefined {
		return this._proactivity.getLastSkipReason();
	}

	/** The proactive topics the owner's replies set aside, each with when it ends; read-only. */
	getProactivityFeedbackState(): ProactivityFeedbackView {
		return this._proactivity.getFeedbackState();
	}

	getProactivityDailyState(): ProactivityDailyState {
		const daily = this._proactivity.getDailyState();
		return this._lastEventDelivery ? { ...daily, lastEventDelivery: this._lastEventDelivery } : daily;
	}

	resolveLaneModel(configuredPattern: string | undefined): Model<Api> | undefined {
		return this._laneModels.resolveModel(configuredPattern);
	}

	getOrchestrationProfileCatalog(): Array<{ profileId: string; role: string; description: string }> {
		return this._getWorkerController().getProfileCatalog();
	}

	inspectTaskProfileOptions(): TaskProfileInspection {
		return this._getWorkerController().inspectTaskProfileOptions();
	}

	createTaskProfile(input: TaskProfileCreateInput): TaskProfileCreateResult {
		return this._getWorkerController().createTaskProfile(input);
	}

	/**
	 * Run one bounded, read-only research pass and persist its results: evidence bundle snapshot,
	 * terminal lane record, and spawned-usage cost report (single-hop invariant, idempotent on the
	 * lane's reportId). Explicit calls (e.g. `/autonomy research`) express user intent and bypass the
	 * enabled/mode/dedupe gates the idle scheduler enforces; budget and capability gates always apply.
	 */
	async runResearchLaneOnce(request?: {
		query?: string;
		context?: string;
		goalId?: string;
	}): Promise<ResearchLaneRunOutcome> {
		return this._research.runOnce(request);
	}
	/** Start a durable leaf worker with inherited, preset, or model-selected authority. */
	startWorkerDelegation(
		request: WorkerDelegationRequest,
		signal?: AbortSignal,
	): Promise<{ started: false; skipReason: string } | { started: true; record: LaneRecord }> {
		return this._getWorkerController().start(request, signal);
	}

	/** Effective grant of a lane's selected attempt, read from the durable execution contract. */
	describeWorkerGrant(laneId: string): WorkerGrantSummary | undefined {
		return this._getWorkerController().getWorkerGrant(laneId);
	}

	/** Durable logical-worker controls. Each checks UAC before materializing worker state. */
	subscribeStateChanges(listener: () => void): () => void {
		return this._getWorkerController().getAgentControl().subscribeStateChanges(listener);
	}

	hasPendingDelegatedMessage(delegationObjectiveId: string): boolean {
		return this._getWorkerController().getAgentControl().hasPendingDelegatedMessage(delegationObjectiveId);
	}

	hasPendingControlMessages(agentId: string): boolean {
		return this._getWorkerController().getAgentControl().hasPendingControlMessages(agentId);
	}

	reconcileDelegatedMessages(delegationObjectiveId: string): void {
		this._getWorkerController().getAgentControl().reconcileDelegatedMessages(delegationObjectiveId);
	}

	listWorkerAgents(scope?: WorkerAgentControlScope): ReturnType<WorkerAgentControlPort["listWorkerAgents"]> {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		return this._getWorkerController().getAgentControl().listWorkerAgents(scope);
	}

	getWorkerTaskSessionView(): ReturnType<WorkerAgentControlPort["getWorkerTaskSessionView"]> {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		return this._getWorkerController().getAgentControl().getWorkerTaskSessionView();
	}

	getWorkerAgentActivity(agentId: string, scope?: WorkerAgentControlScope): WorkerAgentActivity {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		return this._getWorkerController().getAgentControl().getWorkerAgentActivity(agentId, scope);
	}

	readWorkerAgentTranscript(
		agentId: string,
		options?: WorkerAgentTranscriptOptions,
	): ReturnType<WorkerAgentControlPort["readWorkerAgentTranscript"]> {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		return this._getWorkerController().getAgentControl().readWorkerAgentTranscript(agentId, options);
	}

	sendWorkerAgentMessage(
		agentId: string,
		message: string,
		options?: WorkerAgentMessageOptions,
	): { messageId: string; queued: true } {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		return this._getWorkerController().getAgentControl().sendWorkerAgentMessage(agentId, message, options);
	}

	followUpWorkerAgent(
		agentId: string,
		message: string,
		options?: WorkerAgentMessageOptions,
	): { started: boolean; steering: boolean; messageId: string; record?: LaneRecord; skipReason?: string } {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		return this._getWorkerController().getAgentControl().followUpWorkerAgent(agentId, message, options);
	}

	sendSessionRootWorkerAgentMessage(
		agentId: string,
		message: string,
		options?: SessionRootWorkerAgentMessageOptions,
	): { messageId: string; queued: true } {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		return this._getWorkerController().getAgentControl().sendSessionRootWorkerAgentMessage(agentId, message, options);
	}

	followUpSessionRootWorkerAgent(
		agentId: string,
		message: string,
		options?: SessionRootWorkerAgentMessageOptions,
	): { started: boolean; steering: boolean; messageId: string; record?: LaneRecord; skipReason?: string } {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		return this._getWorkerController().getAgentControl().followUpSessionRootWorkerAgent(agentId, message, options);
	}

	replyToWorkerAgentMessage(sourceAgentId: string, message: string, replyToMessageId: string): WorkerAgentReplyResult {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		return this._getWorkerController()
			.getAgentControl()
			.replyToWorkerAgentMessage(sourceAgentId, message, replyToMessageId);
	}

	listSessionRootReplies(query?: SessionRootReplyQuery): SessionRootReply[] {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		return this._getWorkerController().getAgentControl().listSessionRootReplies(query);
	}

	waitForSessionRootReplies(options?: SessionRootReplyWaitOptions): Promise<SessionRootReplyWaitResult> {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		// An owner steer ends the wait so the root reads it at once instead of after the bound.
		const report = (event: WaitStatusEvent) => this.deps.emit(event);
		const wake = ownerSteerWake(this.deps.getSessionManager().getSessionId(), report);
		const steer = { mode: "end", wake } as const;
		const control = this._getWorkerController().getAgentControl();
		return control.waitForSessionRootReplies({ ...options, steer, report });
	}

	acknowledgeSessionRootReply(messageId: string, ackToken: string): boolean {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		return this._getWorkerController().getAgentControl().acknowledgeSessionRootReply(messageId, ackToken);
	}

	reconcileSessionRootReplies(): void {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		this._getWorkerController().getAgentControl().reconcileSessionRootReplies();
	}

	startWorkerAgentTask(
		agentId: string,
		message: string,
		options?: WorkerAgentTaskStartOptions,
	): ReturnType<WorkerAgentControlPort["startWorkerAgentTask"]> {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		return this._getWorkerController().getAgentControl().startWorkerAgentTask(agentId, message, options);
	}

	interruptWorkerAgent(
		agentId: string,
		scope?: WorkerAgentControlScope,
		options?: { message?: string; force?: boolean },
	): ReturnType<WorkerAgentControlPort["interruptWorkerAgent"]> {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		return this._getWorkerController().getAgentControl().interruptWorkerAgent(agentId, scope, options);
	}

	resumeWorkerAgent(
		agentId: string,
		scope?: WorkerAgentControlScope,
	): { started: boolean; record?: LaneRecord; skipReason?: string; waitReason?: string } {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		return this._getWorkerController().getAgentControl().resumeWorkerAgent(agentId, scope);
	}

	cancelWorkerAgent(agentId: string, reasonCode?: string, scope?: WorkerAgentControlScope): LaneRecord | undefined {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		return this._getWorkerController().getAgentControl().cancelWorkerAgent(agentId, reasonCode, scope);
	}

	retireWorkerAgent(
		agentId: string,
		scope?: WorkerAgentControlScope,
		options?: WorkerAgentRetireOptions,
	): WorkerAgentRetireResult {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		const workers = this._getWorkerController();
		const control = workers.getAgentControl();
		const retired = options
			? control.retireWorkerAgent(agentId, scope, options)
			: control.retireWorkerAgent(agentId, scope);
		// The retirement is the event that frees the worker's worktree lane, when it had one.
		if (!retired.replayed) workers.releaseRetiredAgentLane(agentId);
		return retired;
	}

	resolveWorkerAgentLane(agentId: string, scope?: WorkerAgentControlScope): WorkerAgentLaneResolution | undefined {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		return this._getWorkerController().getAgentControl().resolveWorkerAgentLane?.(agentId, scope);
	}

	readWorkerAgentLastText(agentId: string, laneId: string, scope?: WorkerAgentControlScope): string | undefined {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		return this._getWorkerController().getAgentControl().readWorkerAgentLastText?.(agentId, laneId, scope);
	}

	/**
	 * The root's wait signal: an owner steer aborts it, and `finalize` returns that steer's admission decision. A worker
	 * caller has no owner steer (only the session root reads the owner's queue), so its wait passes its signal through.
	 */
	private _createWorkerWaitSignal(
		scope: WorkerAgentControlScope | undefined,
		signal: AbortSignal | undefined,
	): { readonly signal: AbortSignal | undefined; readonly finalize: () => Promise<SteerDecision | undefined> } {
		if (scope?.callerAgentId) {
			return { signal, finalize: () => Promise.resolve(undefined) };
		}
		const report = (event: WaitStatusEvent) => this.deps.emit(event);
		return createSteerAwareWait(this.deps.getSessionManager().getSessionId(), signal, report);
	}

	private async _withWorkerWait<T extends { terminalAttemptIds?: readonly string[]; steered?: SteerDecision }>(
		scope: WorkerAgentControlScope | undefined,
		signal: AbortSignal | undefined,
		run: (control: WorkerAgentControlPort, waitSignal: AbortSignal | undefined) => Promise<T>,
	): Promise<T> {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		const control = this._getWorkerController().getAgentControl();
		const waitSignal = this._createWorkerWaitSignal(scope, signal);
		let result: T;
		try {
			result = await run(control, waitSignal.signal);
			this.observeWorkerAttemptTerminals(result.terminalAttemptIds ?? []);
		} catch (error) {
			await waitSignal.finalize();
			throw error;
		}
		// A steer ended the wait: the result says so, so it never reads as a wait that simply returned.
		const steered = await waitSignal.finalize();
		return steered === undefined ? result : { ...result, steered };
	}

	async waitForWorkerAgent(
		agentId: string,
		timeoutMs?: number,
		scope?: WorkerAgentControlScope,
		signal?: AbortSignal,
	): ReturnType<WorkerAgentControlPort["waitForWorkerAgent"]> {
		return this._withWorkerWait(scope, signal, (control, waitSignal) =>
			control.waitForWorkerAgent(agentId, timeoutMs, scope, waitSignal),
		);
	}

	async waitForWorkerAgents(
		agentIds: readonly string[],
		mode: WorkerAgentWaitMode,
		timeoutMs?: number,
		scope?: WorkerAgentControlScope,
		signal?: AbortSignal,
	): Promise<WorkerAgentWaitResult> {
		return this._withWorkerWait(scope, signal, (control, waitSignal) =>
			control.waitForWorkerAgents(agentIds, mode, timeoutMs, scope, waitSignal),
		);
	}

	/**
	 * Event-driven wait on exact attempts, of in-process and managed workers alike: it settles as soon
	 * as any captured attempt leaves "running", woken by the durable orchestration store's commit
	 * events. A captured attempt missing from the runtime is an error, never completion. An abort rejects
	 * with the signal's reason; the bound and session disposal settle without observing anything.
	 */
	async waitForRunningAttempts(
		attemptIds: readonly string[],
		options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
	): Promise<RunningAttemptWaitOutcome> {
		const { signal } = options;
		if (signal?.aborted) throw signal.reason;
		const captured = [...new Set(attemptIds)];
		if (captured.length === 0) throw new Error("A running-attempt wait needs at least one attempt.");
		if (this.deps.isDisposed()) return { kind: "disposed" };
		const lifecycle = this._workerLifecycle;
		const store = this._orchestrationStore;
		if (!lifecycle || !store) {
			throw new Error(`Running attempts ${captured.join(", ")} are unknown: this session has no worker runtime.`);
		}
		const terminal: WakeSource<{ readonly snapshot: TaskRuntimeProjection; readonly changed: string[] }> = {
			id: "attempt.terminal",
			// A commit notifies before the runtime adopts it: read the projection after the commit returns.
			subscribe: (onWake) => {
				let queued = false;
				return store.subscribe(() => {
					if (queued) return;
					queued = true;
					queueMicrotask(() => {
						queued = false;
						onWake();
					});
				});
			},
			check: () => {
				const snapshot = lifecycle.getTaskRuntimeSnapshot();
				const missing = captured.filter((attemptId) => !snapshot.attempts[attemptId]);
				if (missing.length > 0) {
					throw new Error(`Running attempts ${missing.join(", ")} are not in the task runtime.`);
				}
				const changed = captured.filter((attemptId) => snapshot.attempts[attemptId]?.status !== "running");
				return changed.length > 0 ? { kind: "satisfied", value: { snapshot, changed } } : undefined;
			},
		};
		const { end, value } = await waitFor({
			id: "objective.running_attempts",
			wake: [terminal],
			signal,
			steer: {
				mode: "exempt",
				reason: "the objective loop holds no foreground lease while it waits, so owner input runs its own turn",
			},
			bound: { kind: "deadline", ms: boundWorkerWaitTimeoutMs(options.timeoutMs) },
			disposed: {
				isDisposed: () => this.deps.isDisposed(),
				subscribe: (onDispose) => {
					this._runningAttemptWaits.add(onDispose);
					return () => this._runningAttemptWaits.delete(onDispose);
				},
			},
			report: (event) => this.deps.emit(event),
		});
		if (end.kind === "satisfied" && value) {
			this._observeExactAttemptTerminals(value.snapshot, value.changed);
			return { kind: "changed", attemptIds: value.changed };
		}
		if (end.kind === "timed_out") return { kind: "timed_out" };
		if (end.kind === "disposed") return { kind: "disposed" };
		if (end.kind === "aborted") throw signal?.reason;
		throw new Error(`The running-attempt wait ended ${end.kind}.`);
	}

	/** Observe terminals of exactly these attempts, never a newer generation of the same lane. */
	private _observeExactAttemptTerminals(snapshot: TaskRuntimeProjection, attemptIds: readonly string[]): void {
		try {
			this.observeWorkerTerminalRecords(
				attemptIds.flatMap((attemptId) => {
					const record = projectWorkerAttemptLaneRecord(snapshot, attemptId);
					return record ? [record] : [];
				}),
			);
		} catch (error) {
			this._safeWarn(
				`Worker terminal observation failed after a running-attempt wait: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	broadcastWorkerAgentMessage(
		agentIds: readonly string[],
		message: string,
		options: WorkerAgentBroadcastOptions,
	): WorkerAgentBroadcastResult {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		return this._getWorkerController().getAgentControl().broadcastWorkerAgentMessage(agentIds, message, options);
	}

	/** Run one worker immediately; used by focused integrations and tests. */
	async runWorkerDelegationOnce(
		request: WorkerDelegationRequest,
		onStarted?: (record: LaneRecord) => void,
		existingRecord?: LaneRecord,
	): Promise<WorkerDelegationRunOutcome> {
		return this._getWorkerController().runOnce(request, onStarted, existingRecord);
	}
	/**
	 * Probe a candidate model against the subagent contracts (research/worker/judge/search/
	 * tool-call surfaces) via {@link runModelFitnessProbe}. The model must resolve and
	 * authenticate; every probe call runs as an isolated completion on that model, and probe
	 * spend is reported through spawned-usage accounting.
	 */
	async runModelFitness(args: {
		model: string;
		trials?: number;
		/** LLM tool-call id, present only via the model_fitness tool path — see model-fitness.ts. */
		toolCallId?: string;
	}): Promise<{ started: true; model: string; report: ModelFitnessReport } | { started: false; skipReason: string }> {
		return this._fitness.run(args);
	}

	/** Start every capacity-eligible queued worker at the owner session's foreground-idle boundary. */
	drainQueuedWorkerDelegations(): void {
		this._workerUsage?.signal();
		this.signalWorkerReceiptDelivery();
		if (this.deps.isDelegateToolActive?.()) this._getWorkerController().drain();
	}

	/** Recover existing obligations even when the current tool surface cannot start new workers. */
	signalWorkerReceiptDelivery(): void {
		if (this.deps.isDisposed()) return;
		if (!this._workerLifecycle) {
			try {
				const existing = lstatSync(orchestrationEventStoreDir(this.deps.getAgentDir(), this.deps.getSessionId()));
				if (!existing.isDirectory()) throw new Error("Worker orchestration storage is not a directory.");
				this._getWorkerLifecycle();
			} catch (error) {
				if (!isMissingFileError(error))
					this._safeWarn(
						`Worker receipt recovery unavailable: ${error instanceof Error ? error.message : String(error)}`,
					);
				return;
			}
		} else if (this._parentWriteHolds.size > 0) {
			// Writes that could not land before (no persisted transcript yet, a busy lock) are retried here.
			this._landRecordedParentWrites(this._workerLifecycle);
		}
		this._workerReceipts?.signal();
	}

	/** Lands the writes other hosts recorded for this parent, then offers the terminal notices held behind them. */
	private _landRecordedParentWrites(lifecycle: WorkerLifecycle): void {
		const held = this._parentWriteHolds;
		this._parentWriteHolds = this._importParentWrites(lifecycle);
		this._replayPendingTerminals(lifecycle, (attemptId) => attemptId !== undefined && held.has(attemptId));
	}

	/** Fitness reports persisted for THIS host (measured evidence for architect/profile decisions). */
	getStoredFitnessReports(): StoredFitnessReport[] {
		return this._fitness.getStoredReports();
	}

	getBotTeamStore(): PersistentBotTeamStore {
		if (!this._botTeamStore) {
			this._botTeamStore = new PersistentBotTeamStore(this.deps.getAgentDir(), (message) => this._safeWarn(message));
			this._botTeamStore.subscribe(() => {
				this._botViews = undefined;
				// A leader's row names it by its display name: a rename or a retirement changes the rows, not the delegation.
				this._leaderRows = undefined;
				// A routine saved by this session or any other process brings the daemon up if nothing runs it.
				if (this.routinesStarted && this._botTeamStore?.getRoutineRevision() !== this._daemonRevision)
					this._ensureBotDaemon();
				// A routine run away commits its occurrence after recording its parent writes; this store's change is the
				// cross-process signal, so an open parent lands those writes now, before its scheduler (subscribed after
				// this listener) delivers the run's result.
				const lifecycle = this._workerLifecycle;
				if (!lifecycle || this.deps.isDisposed()) return;
				try {
					this._landRecordedParentWrites(lifecycle);
				} catch (error) {
					this._safeWarn(
						`Parent writes recorded away could not be read: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			});
			this._ensureRoutineScheduler();
		}
		return this._botTeamStore;
	}

	/** The parent input still carrying an earlier result of this routine, quiet or held, to the owner's next turn. */
	private findCarriedRoutineResult(routineId: string, cause: "quiet" | "held"): { entryId: string } | undefined {
		const manager = this.deps.getSessionManager();
		const carried = manager
			.getPendingParentInputs("next-owner-turn")
			.find((input) => isCarriedRoutineCompletion(manager.getEntry(input.entryId), routineId, cause));
		return carried ? { entryId: carried.entryId } : undefined;
	}

	private _ensureRoutineScheduler(): void {
		if (this._routines || !this._botTeamStore || this.deps.isDisposed() || this.deps.canRunRoutines?.() === false)
			return;
		const store = this._botTeamStore;
		const parentSessionId = this.deps.getSessionId();
		const canUseOrigin = (origin: WorkerReceiptOrigin): boolean => {
			const manager = this.deps.getSessionManager();
			return (
				origin.sessionId === manager.getSessionId() &&
				(origin.sessionFile === undefined || origin.sessionFile === manager.getSessionFile()) &&
				isSessionAppendAnchorCurrent(manager, origin) &&
				manager.isEntryPersisted(origin.leafId)
			);
		};
		const worker = new RoutineWorkerExecutor({
			getSnapshot: () => {
				this._getWorkerController();
				return this._getWorkerLifecycle().getTaskRuntimeSnapshot();
			},
			start: (input, signal) => this._getWorkerController().startSavedIntent(input, signal),
		});
		const scheduler = new RoutineSchedulerController({
			store,
			worker,
			parentSessionId,
			owner: randomUUID(),
			timers: this.deps.getTimers().port("routines"),
			isDisposed: () => this.deps.isDisposed(),
			canDispatch: () => this.deps.isDelegateToolActive(),
			getReceiptOrigin: () => captureWorkerReceiptOrigin(this.deps.getSessionManager()),
			canUseOrigin,
			captureOriginGuard: (origin) =>
				this.sessionBranchGuard("Routine origin is not on the current durable parent branch.", () =>
					canUseOrigin(origin),
				),
			subscribeContext: (listener) => this.deps.subscribeForegroundActivity(listener),
			subscribeExecution: (listener) => this.subscribeOrchestrationStore(listener),
			hostEvents: this._hostEventFeed(),
			subscribeCapacity: (listener) => this.subscribeStateChanges(listener),
			delivery: {
				deliver: async (delivery) => {
					const { occurrence } = delivery;
					const intent = occurrence.definition.executionSnapshot?.savedIntent;
					// A run away recorded its claims for this parent; they explain its result, so they land first, and the
					// result waits while one cannot land yet. A run of this session wrote its claims itself.
					if (occurrence.executor === "away" && occurrence.dispatchKey && intent) {
						const attemptIds = worker.notificationAttemptIds(
							routineWorkerRequest(occurrence, intent, occurrence.dispatchKey),
						);
						this._landRecordedParentWrites(this._getWorkerLifecycle());
						for (const attemptId of attemptIds)
							if (this._parentWriteHolds.has(attemptId))
								throw new Error("Routine result is waiting for the claims its run recorded away to land.");
					}
					const input = routineParentInput(delivery);
					// Quiet results and expiry notices already ride with the owner's next turn and never count as wakes.
					if (input.mode === "next-owner-turn") return this.deps.deliverParentInput(input);
					const manager = this.deps.getSessionManager();
					// A replay repeats the saved mode, so a saved delivery is never measured again.
					const saved = manager.getParentInput(input.deliveryId);
					let held = saved !== undefined && saved.metadata.mode === "next-owner-turn";
					if (!saved) {
						const day = await this.deps.aggregateUsageWindow(rollingDayWindow(Date.now()));
						const bound = this.deps.getSettingsManager().getRoutinesSettings().maxResultWakesPerDay;
						held = day.routineResultTurnWakes >= bound;
						if (held) {
							this.deps.observeHarnessNotice?.("routine-result-wakes", () => ({
								reason: ROUTINE_RESULT_WAKES_HOLD,
								text: `Routine results started ${bound} parent turns in the last 24 hours, the routines.maxResultWakesPerDay bound; later results wait for the owner's next turn until the day has room. Raising the setting lets more start turns.`,
							}));
							// One held result of a routine is carried at a time; later ones are recorded against it.
							const carried = this.findCarriedRoutineResult(delivery.occurrence.routineId, "held");
							if (carried) return carried;
						} else this.deps.observeHarnessNotice?.("routine-result-wakes", () => "clear");
					}
					return this.deps.deliverParentInput(held ? routineParentInput(delivery, true) : input);
				},
				findCarriedQuietResult: (routineId) => this.findCarriedRoutineResult(routineId, "quiet"),
				acknowledgeWorkerNotification: (occurrence) => {
					if (occurrence.target.kind !== "session" || !occurrence.dispatchKey) return;
					const intent = occurrence.definition.executionSnapshot?.savedIntent;
					if (!intent) return;
					const attemptIds = worker.notificationAttemptIds(
						routineWorkerRequest(occurrence, intent, occurrence.dispatchKey),
					);
					const lifecycle = this._getWorkerLifecycle();
					const ids: string[] = [];
					for (const attemptId of attemptIds) {
						const notification = lifecycle.getAttemptTerminalNotification(attemptId);
						if (!notification) throw new Error("Routine completion is waiting for its native terminal receipt.");
						if (notification.status === "pending") ids.push(notification.notificationId);
					}
					lifecycle.markNotificationsDelivered(ids);
				},
				noticeRoutineState: (kind, routineId, notice) =>
					this.deps.observeHarnessNotice?.(kind, () => ({ scope: routineId, state: notice ?? "clear" })),
			},
			dispatchMessage: async (occurrence) => {
				if (occurrence.target.kind === "bot") {
					const result = await this.sendOperatorMessageToBot(
						occurrence.target.agentId,
						occurrence.definition.prompt,
					);
					return `Prompt accepted by bot ${occurrence.target.agentId} (${result.mode}); worker completion is tracked separately.`;
				}
				if (occurrence.target.kind === "team") {
					const result = await this.sendOperatorMessageToTeam(
						occurrence.target.teamId,
						occurrence.definition.prompt,
					);
					return `Prompt accepted for ${result.deliveries.length} team deliveries; worker completion is tracked separately.`;
				}
				throw new Error("Session routines require the native worker executor.");
			},
			warn: (message) => this._safeWarn(message),
		});
		// One admission serves a watch when it is saved and at every evaluation, so a saved watch never runs with more
		// authority than the session has now.
		const watchAdmission = new WatchAdmission({
			getCwd: () => this.deps.getCwd(),
			getAgentDir: () => this.deps.getAgentDir(),
			getCapabilityEnvelope: () => this.deps.getCapabilityEnvelope(),
			getCredentialExposureBoundary: () => this.deps.getCredentialExposureBoundary?.(),
			getEdgeGrants: () => this.deps.getEdgeGrants?.() ?? [],
			getEdgeMode: () => this.deps.getSettingsManager().getEdgeSettings().mode,
			getDenyCommands: () => this.deps.getSettingsManager().getEdgeSettings().deny,
		});
		const routineTimers = this.deps.getTimers().port("routines");
		const watches = new RoutineWatchMonitor({
			store,
			sampler: new WatchSampler({
				admission: watchAdmission,
				agentDir: () => this.deps.getAgentDir(),
				now: () => routineTimers.now(),
			}),
			parentSessionId,
			timers: routineTimers,
			agentDir: () => this.deps.getAgentDir(),
			isDisposed: () => this.deps.isDisposed(),
			warn: (message) => this._safeWarn(message),
		});
		const session = new RoutineSessionController({
			store,
			scheduler,
			parentSessionId,
			admitWatch: (condition) => watchAdmission.admit(condition),
			capture: (request, signal) => this._getWorkerController().captureSavedIntent(request, signal),
			invocationKey: (callId) => this.deps.getToolInvocationKey(callId, "routine"),
			eventAnchor: () => routineEventAnchor(this._getWorkerLifecycle().getTaskRuntimeSnapshot()),
			ownerTurnSources: () => this.deps.getOwnerEvidence().currentTurnSources(),
			now: () => this.deps.getTimers().port("routines").now(),
			isDisposed: () => this.deps.isDisposed(),
		});
		const intake = new RoutineIntake({
			parentSessionId,
			store,
			routines: session,
			evidence: this.deps.getOwnerEvidence(),
			time: this.deps.getTimers().port("routine-intake"),
			hostInactiveReason: () => {
				const manager = this.deps.getSessionManager();
				if (!manager.isPersisted() || !manager.getSessionFile()) return "ephemeral_session";
				return this.deps.getSettingsManager().getRoutinesSettings().automaticIntake ? undefined : "disabled";
			},
			model: () => this._laneModels.resolveModel(undefined),
			systemOne: () => this.deps.systemOne.recordingSemanticEngine(),
			usageOwner: () => sessionSemanticUsageOf(this.deps.getSessionManager()),
			maxEstimatedUsd: () => this.deps.getCapabilityEnvelope()?.maxEstimatedUsd,
			isForegroundBusy: () => this.deps.isForegroundBusy(),
			subscribeActivity: (listener) => this.deps.subscribeForegroundActivity(listener),
			captureOrigin: () => captureWorkerReceiptOrigin(this.deps.getSessionManager()),
			captureBranchGuard: () =>
				this.sessionBranchGuard("Routine intake session changed before its decision was saved."),
			deliver: (notice, signal) => this.deps.deliverNotes(notice, { signal }),
			isDelivered: (deliveryId) => this.deps.getSessionManager().getParentInput(deliveryId) !== undefined,
			observeHarnessNotice: (kind, read) => this.deps.observeHarnessNotice?.(kind, read),
			runIsolatedCompletion: (options) => this.deps.runIsolatedCompletion(options),
			ciWorkflowPaths: () => {
				const lifecycle = this._getWorkerLifecycle();
				const events = lifecycle.ledger.runtime.hostEvents;
				return routineCiWorkflowPaths(lifecycle.getTaskRuntimeSnapshot(), (sourceId) =>
					events.isSourceReady(sourceId),
				);
			},
			warn: (message) => this._safeWarn(message),
		});
		this._routines = { scheduler, session, intake, watches };
		if (this.routinesStarted) {
			scheduler.start();
			intake.start();
			watches.start();
		}
	}

	/**
	 * The bot daemon's channel host serves this session's channels (`hostedChannels: "daemon"`, set before the inputs
	 * start): the session starts no channel, takes no hold, and never launches or reconciles the daemon.
	 */
	hostChannelsInDaemon(): void {
		this._channelsHostedByDaemon = true;
	}

	/**
	 * The hands-off inputs a root session starts once it binds: persistent routines, the registered channels and acting
	 * ahead on the checkout's failing CI.
	 */
	startSessionInputs(): void {
		this.startPersistentRoutines();
		if (!this.deps.isChildSession())
			void this.getRemoteHub()
				.start()
				.then((problem) => {
					if (problem) this._safeWarn(problem);
				});
		if (!this._channelsHostedByDaemon) this.channels.start();
		if (!this.deps.isDisposed() && !this.deps.isChildSession()) this._getActAhead().start();
		if (!this.deps.isChildSession() && this._hasWorkerState()) this._getRetention().scheduleFromIdle();
	}

	/** The host's CI source offers its failure evidence while it runs; the returned function withdraws it. */
	provideCiFailureEvidence(reader: CiFailureEvidenceReader): () => void {
		this._ciFailureEvidence = reader;
		return () => {
			if (this._ciFailureEvidence === reader) this._ciFailureEvidence = undefined;
		};
	}

	/** Accepted host events as routine facts, and their change signal: what routines and acting ahead follow. */
	private _hostEventFeed() {
		return {
			feed: () => {
				const lifecycle = this._getWorkerLifecycle();
				const events = lifecycle.ledger.runtime.hostEvents;
				return routineHostEventFeed(lifecycle.getTaskRuntimeSnapshot(), (sourceId) =>
					events.isSourceReady(sourceId),
				);
			},
			subscribe: (listener: () => void) => {
				this._hostEventStateListeners.add(listener);
				return () => this._hostEventStateListeners.delete(listener);
			},
		};
	}

	private _getActAhead(): ActAheadController {
		this._actAhead ??= new ActAheadController({
			getSessionManager: () => this.deps.getSessionManager(),
			isChildSession: () => this.deps.isChildSession(),
			isDisposed: () => this.deps.isDisposed(),
			canDispatch: () => this.deps.isDelegateToolActive(),
			isForegroundBusy: () => this.deps.isForegroundBusy(),
			subscribeForegroundActivity: (listener) => this.deps.subscribeForegroundActivity(listener),
			settings: () => this.deps.getSettingsManager().getActAheadSettings(),
			// Acting ahead never builds the worker ledger to look for a failure: host events exist only once a host-event
			// session built it, and an unfinished episode builds it through `workers` to finish.
			hostEvents: {
				feed: () => (this._workerLifecycle ? this._hostEventFeed().feed() : { events: [], replayGaps: "" }),
				subscribe: this._hostEventFeed().subscribe,
			},
			workers: {
				contextForDirectory: (cwd, signal) => this._getWorkerController().contextForDirectory(cwd, signal),
				start: (request, signal) => this.startWorkerDelegation(request, signal),
				snapshot: () => this._getWorkerLifecycle().getTaskRuntimeSnapshot(),
				// Before the ledger exists this follows lane-record changes, which its store's commits raise once it does.
				subscribe: (listener) => this.subscribeOrchestrationStore(listener),
				terminalNotification: (attemptId) => this._getWorkerLifecycle().getAttemptTerminalNotification(attemptId),
				acknowledge: (notificationIds) => this._getWorkerLifecycle().markNotificationsDelivered(notificationIds),
			},
			engineDeps: (cwd) => this._worktreeEngineDeps(cwd),
			cwd: () => this.deps.getCwd(),
			sessionId: () => this.deps.getSessionId(),
			aggregateDay: () => this.deps.aggregateUsageWindow(rollingDayWindow(Date.now())),
			evidence: () => this._ciFailureEvidence,
			observeNotice: (kind, read) => this.deps.observeHarnessNotice?.(kind, read) ?? false,
			warn: (message) => this._safeWarn(message),
			now: () => Date.now(),
		});
		return this._actAhead;
	}

	/** The owner's release of channel reply drafts; offered only while a channel has an explicit policy and this session serves its channels. */
	private createChannelReplyToolDefinition(): ToolDefinition | undefined {
		return !this.deps.isChildSession() && !this._channelsHostedByDaemon && this.channels.hasExplicitPolicy()
			? createChannelReplyToolDefinition(this.channels)
			: undefined;
	}

	startPersistentRoutines(): void {
		if (this.deps.isDisposed() || this.deps.canRunRoutines?.() === false) return;
		this.routinesStarted = true;
		this.getBotTeamStore();
		this._routines?.scheduler.start();
		this._routines?.intake.start();
		this._routines?.watches.start();
		this._ensureBotDaemon();
		this._unsubscribeAwayChannelSettings ??= this.deps.getSettingsManager().subscribeChanges(() => {
			if (awayChannelsKey(this.deps.getSettingsManager()) !== this._awayChannelsKey) this._ensureBotDaemon();
		});
	}

	/**
	 * Brings the detached daemon up by itself, with no command: at session start and on every routine save, while an
	 * enabled routine or a channel served away (`channels.<name>.awayCwd`) exists and no daemon holds the lease, or the
	 * one holding it is of an older build (an upgrade replaces it; one of the same or a newer build is left alone). The
	 * claim is idempotent across sessions and processes, so only one start launches. A worker process never starts one.
	 * A reason the daemon cannot start is reported once. The same points apply `routines.away.autostart` (see
	 * `away-service.ts`), for the same work.
	 *
	 * Every ensure that finds away work arms one alarm at the instant the lease it saw (or its fresh claim) stops being
	 * held; the alarm runs this again (without the always-on reconcile), so a daemon that died mid-session is relaunched
	 * by that expiry instead of waiting for a save or settings change. A failed ensure backs off on the same alarm.
	 */
	private _ensureBotDaemon(fromAlarm = false): void {
		const store = this._botTeamStore;
		if (!store || this.deps.isDisposed() || getSessionRole() === "worker" || this._channelsHostedByDaemon) return;
		this._daemonRevision = store.getRoutineRevision();
		const clock = this.deps.getTimers().port("routines");
		let failure: string | undefined;
		// Enabled routines and channels served away: either keeps the daemon, and the always-on service, wanted.
		let awayWork = 0;
		// When the lease this ensure leaves behind stops being held; absent when nothing is read.
		let leaseHeldUntil: number | undefined;
		try {
			const status = store.getDaemonStatus(clock.now());
			const lastRenewedAt = status.lastHeartbeatAt ?? (status.startedAt ? Date.parse(status.startedAt) : Number.NaN);
			if (status.running && Number.isFinite(lastRenewedAt)) leaseHeldUntil = lastRenewedAt + DAEMON_STALE_MS;
			this._awayChannelsKey = awayChannelsKey(this.deps.getSettingsManager());
			awayWork = status.activeRoutines + awayChannels(this.deps.getSettingsManager()).length;
			// A daemon of an older build is replaced (an upgrade), unless this runtime launched it: then the pi on disk is
			// older than this session, and a relaunch would run the same build again.
			const ownLaunch =
				this._launchedDaemonToken !== undefined && store.daemonLeaseBelongsTo(this._launchedDaemonToken);
			const replace = status.running && !ownLaunch && isOlderDaemonBuild(status.build, OWN_DAEMON_BUILD);
			// A current always-on install is restarted through its manager, so the new build runs supervised; when that
			// fails (reported once), or without one, the daemon is launched detached.
			const fallback = (reason: string) => {
				this._safeWarn(`${reason} The daemon is started detached instead.`);
				const started = this.startPersistentBotDaemon();
				if (!started.started && !started.held) this._safeWarn(started.detail);
			};
			if (awayWork > 0 && (!status.running || (replace && !this.getAwayService().replaceDaemon(fallback)))) {
				const started = this.startPersistentBotDaemon();
				if (!started.started && !started.held) failure = started.detail;
				// A claimed lease is held from its claim until its daemon's first renewal is due.
				else leaseHeldUntil = clock.now() + DAEMON_STALE_MS;
			}
		} catch (error) {
			failure = `Detached bot daemon could not be started: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (failure !== undefined && failure !== this._daemonStartFailure) this._safeWarn(failure);
		this._daemonStartFailure = failure;
		this._armDaemonRecheck(
			awayWork > 0 ? this._nextDaemonCheckAt(clock.now(), failure !== undefined, leaseHeldUntil) : undefined,
		);
		if (fromAlarm) return;
		try {
			if (!this.deps.isChildSession()) this.getAwayService().reconcile(awayWork);
		} catch (error) {
			this._safeWarn(
				`Always-on routines could not be checked: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** The instant to re-ensure the daemon: when its lease stops being held, or after a backoff when it could not be brought up. */
	private _nextDaemonCheckAt(nowMs: number, failed: boolean, leaseHeldUntil: number | undefined): number {
		this._daemonEnsureFailures = failed ? this._daemonEnsureFailures + 1 : 0;
		if (failed || leaseHeldUntil === undefined)
			return (
				nowMs +
				Math.min(
					DAEMON_RECHECK_MAX_BACKOFF_MS,
					DAEMON_RECHECK_BASE_BACKOFF_MS * 2 ** Math.min(this._daemonEnsureFailures, 16),
				)
			);
		return leaseHeldUntil + DAEMON_RECHECK_MARGIN_MS;
	}

	private _armDaemonRecheck(atMs: number | undefined): void {
		this._daemonRecheck?.stop();
		this._daemonRecheck = undefined;
		if (atMs === undefined || this.deps.isDisposed()) return;
		this._daemonRecheck = alarmAt(this.deps.getTimers().port("routines"), atMs, () => {
			this._daemonRecheck = undefined;
			harnessLog.info("bots", "the bot daemon lease expiry re-ensured the daemon", {
				failures: this._daemonEnsureFailures,
			});
			this._ensureBotDaemon(true);
		});
	}

	/** The channels the daemon serves while no session is open: who serves each now and its drafts (filesystem reads). */
	readAwayChannelStatus(): AwayChannelStatus[] {
		return readAwayChannelStatus(this.deps.getAgentDir(), this.deps.getSettingsManager(), this.deps.getSessionId());
	}

	/** The always-on service of this agent directory: its hands-off reconcile, explicit commands and inspection. */
	getAwayService(): AwayService {
		this._awayService ??= new AwayService({
			store: () => this.getBotTeamStore(),
			projectDir: () => this.deps.getCwd(),
			clock: this.deps.getTimers().port("routines"),
			autostart: () => this.deps.getSettingsManager().getRoutineAwayAutostart(),
			observeNotice: (read) => this.deps.observeHarnessNotice?.("routine-away-service", read) ?? false,
			warn: (message) => this._safeWarn(message),
		});
		return this._awayService;
	}

	/** Automatic routine intake of this session; undefined where routines do not run (a child session). */
	getRoutineIntakeStatus(): RoutineIntakeStatus | undefined {
		this.getBotTeamStore();
		return this._routines?.intake.status();
	}

	private createRoutineToolDefinition(): ToolDefinition | undefined {
		this.getBotTeamStore();
		return this._routines?.session.tool;
	}

	/**
	 * Saves a routine for this session without the model tool: the tool's validation, saved worker authority capture
	 * and event anchor, owned by the same session controller. The embedding host calls it on its own authority, so it
	 * needs no owner-opened turn and marks no owner words as answered.
	 */
	async createRoutine(
		spec: Parameters<typeof parseRoutineToolInput>[0],
		signal?: AbortSignal,
	): Promise<RoutineToolView> {
		this.getBotTeamStore();
		if (!this._routines) throw new Error("Routines are unavailable in this session.");
		return this._routines.session.createForHost(parseRoutineToolInput(spec), signal);
	}

	async tickPersistentRoutines(routineIdFilter?: string): Promise<{ dispatched: string[]; failed: string[] }> {
		this.getBotTeamStore();
		if (!this._routines) return { dispatched: [], failed: [] };
		if (routineIdFilter) this._routines.scheduler.run(routineIdFilter, undefined, randomUUID());
		return this._routines.scheduler.tick();
	}

	getPersistentBotDaemonStatus(): PersistentBotDaemonStatus {
		const store = this.getBotTeamStore();
		store.reload();
		return store.getDaemonStatus(this.deps.getTimers().port("routines").now());
	}

	/**
	 * The session's automatic work at this instant (`autonomy-status/autonomy-status.ts`), read from the owners this
	 * controller has loaded and the session's own: an owner that is not loaded is reported unavailable, never built.
	 */
	readAutonomyStatus(
		foregroundRun: AutonomyStatusSources["foregroundRun"],
		harnessNotices: AutonomyStatusSources["harnessNotices"],
		memory: AutonomyStatusSources["memory"],
	): Promise<SessionAutonomyStatus> {
		const nowMs = Date.now();
		const getEdgeGrants = this.deps.getEdgeGrants;
		return readSessionAutonomyStatus({
			nowMs,
			sessionId: this.deps.getSessionId(),
			childSession: this.deps.isChildSession(),
			sessionManager: this.deps.getSessionManager(),
			settings: this.deps.getSettingsManager(),
			usageWindow: () => this.deps.aggregateUsageWindow(rollingDayWindow(nowMs)),
			routineStore: this._botTeamStore,
			routineIntake: this._routines?.intake.status(),
			hostEventLedger: this.getTaskRuntimeSnapshot(),
			hostEventConnections: () => this.readHostEventConnections(),
			goalContinuation: () =>
				this._goalAutoContinue.describeState(
					this.deps.getGoalRuntimeSnapshot({
						maxStallTurns: this.deps.getSettingsManager().getAutonomySettings().maxStallTurns,
					}),
				),
			goalState: () => this.deps.getGoalStateSnapshot(),
			proactivity: {
				daily: this.getProactivityDailyState(),
				lastSkipReason: this.getLastProactivitySkipReason(),
				setAside: () => this.getProactivityFeedbackState().suppressed,
			},
			channelStates: () => this.channels.getStates(),
			channelJournals: () => this.channels.readJournalSummaries(),
			awayChannelCharges: (maxUsdPerRun, nowMs) =>
				readAwayChannelCharges(this.deps.getAgentDir(), maxUsdPerRun, nowMs),
			awayChannels: () => this.readAwayChannelStatus(),
			awayService: this._botTeamStore ? () => this.getAwayService().inspect() : undefined,
			harnessNotices,
			memory,
			standingGrants: getEdgeGrants ? () => getEdgeGrants(true) : undefined,
			foregroundRun,
			systemOne: this.deps.systemOne,
		});
	}

	/**
	 * Starts the detached bot daemon (see `bot-daemon-launch.ts`). `held`: another daemon already holds the lease. A
	 * previous daemon that ended on an error is reported once, by the start that replaces it.
	 */
	startPersistentBotDaemon(): BotDaemonLaunchResult {
		const launch = launchDetachedBotDaemon({
			store: this.getBotTeamStore(),
			clock: this.deps.getTimers().port("routines"),
			cwd: this.deps.getCwd(),
			warn: (message) => this._safeWarn(message),
		});
		if (launch.token !== undefined) this._launchedDaemonToken = launch.token;
		return launch;
	}

	/**
	 * Stops the detached daemon by releasing its lease; the daemon exits when it observes the release. No signal is
	 * sent to it: a pid in the lease may belong to an unrelated process by now, while the lease token is the daemon's
	 * own. Earlier-generation daemons are then retired as on start, signalling only an identity proven on this host.
	 */
	stopPersistentBotDaemon(): { stopped: boolean; detail: string } {
		const store = this.getBotTeamStore();
		store.reload();
		const released = store.releaseDaemonLease(undefined, this.deps.getTimers().port("routines").now());
		const retirement = retireLegacyBotDaemons(store);
		const legacy = describeLegacyDaemonRetirement(retirement);
		const legacyStopped = retirement.releasedTokenDaemon?.held === true || retirement.sweep.signalled.length > 0;
		if (released.released && released.held) {
			return {
				stopped: true,
				detail: `Released the detached bot daemon's lease${released.pid !== undefined ? ` (pid ${released.pid})` : ""}; it exits as soon as it observes the release.${legacy ? ` ${legacy}` : ""}`,
			};
		}
		const current = released.released
			? "Detached bot daemon is not running; its stale lease was released."
			: "Detached bot daemon is not running.";
		return { stopped: legacyStopped, detail: legacy ? `${current} ${legacy}` : current };
	}

	/**
	 * A leader's send to one of its own bots that has no live runtime: the bot starts as the leader's child under the goal
	 * running now, and is held to that goal's envelope (its providers; its write paths only when the goal grants them). A
	 * live bot, or a bot the leader did not make, is left to the ordinary mailbox send.
	 */
	private async startOwnedBotAsChild(
		leaderAgentId: string,
		leaderAlias: string,
		alias: string,
		message: string,
		invocationId: string,
	): Promise<BotOwnedStartOutcome> {
		const store = this.getBotTeamStore();
		const bot = store.getBot(alias);
		if (!bot || bot.retired || bot.remote === true || bot.createdBy !== leaderAlias) return { handled: false };
		const runtime = this.botBindings.runtime(alias);
		if (this.listWorkerAgents().some((agent) => agent.agentId === runtime && agent.status !== "retired"))
			return { handled: false };
		const goal = this.getLeaders().currentFor(leaderAlias);
		if (goal?.state !== "running")
			return {
				handled: true,
				accepted: false,
				detail: `${leaderAlias} has no goal running, so ${alias} is not started.`,
			};
		const leaderContract = this._getWorkerLifecycle().getAgentTurnDispatch(leaderAgentId)?.executionContract;
		if (!contractGrantsChildren(leaderContract))
			return {
				handled: true,
				accepted: false,
				detail: `${leaderAlias} cannot start bots yet: its running worker was started before it could lead, and it restarts once its goal ends and nothing is waiting for it.`,
			};
		const envelope = goal.charter.envelope;
		if (envelope.models.providers !== undefined && !envelope.models.providers.includes(bot.provider))
			return {
				handled: true,
				accepted: false,
				detail: `${alias} runs on ${bot.provider}, which this goal may not use.`,
			};
		const writable = bot.canWrite === true && envelope.leaderMayWrite && envelope.writePaths.length > 0;
		// Named by the invocation: a repeated call names the same runtime, and the admission's replay key starts nothing new.
		const preferredAgentId = `bot-${createHash("sha256")
			.update(`leader-owned-start\0${invocationId}\0${alias}`)
			.digest("hex")
			.slice(0, 32)}`;
		const memoryCtx = store.composeBotUnifiedMemoryContext(alias);
		const instructions =
			memoryCtx.promptBlock.length > 0 ? `${message}${BOT_MEMORY_BLOCK_SEPARATOR}${memoryCtx.promptBlock}` : message;
		const stance = botStartModelStance(this.deps.getSettingsManager().getWorkerModelPinPolicy(), bot);
		const outcome = await this._getWorkerController().admitNested({
			parentAgentId: leaderAgentId,
			delegationObjectiveId: goal.objectiveId,
			instructions,
			...(writable ? { writePaths: [...envelope.writePaths] } : {}),
			messageReplayKey: `leader-owned-start:${invocationId}:${alias}`,
			bot: {
				...stance.flags,
				...(bot.soul ? { botSoul: bot.soul } : {}),
				...(bot.profileId ? { profileId: bot.profileId } : {}),
				preferredAgentId,
				authority: {
					...(stance.ownModel ? { model: { provider: bot.provider, modelId: bot.modelId } } : {}),
					...(bot.createdBy === "owner" ? { modelChosenBy: "owner" as const } : {}),
					readOnly: !writable,
					...(stance.ownModel && isOrchestrationThinkingLevel(bot.thinkingLevel)
						? { thinkingLevel: bot.thinkingLevel }
						: {}),
				},
			},
		});
		if (!outcome.started)
			return { handled: true, accepted: false, detail: `${alias} was not started: ${outcome.skipReason}.` };
		// The alias is bound to the runtime only once that runtime exists, so a refused start leaves no binding behind.
		this.botBindings.bind(alias, preferredAgentId);
		return {
			handled: true,
			accepted: true,
			detail: `${alias} started under ${leaderAlias}; its answer reaches your next turn.`,
		};
	}

	private createBotMessageDirectory(sender: string, attemptId: string): BotMessageDirectory {
		return createBotMessageDirectory(
			{
				getSessionManager: () => this.deps.getSessionManager(),
				isDisposed: () => this.deps.isDisposed(),
				botBindings: this.botBindings,
				getBotTeamStore: () => this.getBotTeamStore(),
				invalidateBotViews: () => {
					this._botViews = undefined;
				},
				listWorkerAgents: () => this.listWorkerAgents(),
				createBotFor: (creator, request) => this.createBotFor(creator, request),
				getLeaders: () => this.getLeaders(),
				leaderDelegations: () => this.leaderDelegations(),
				startOwnedBotAsChild: (leaderAgentId, leaderAlias, alias, message, invocationId) =>
					this.startOwnedBotAsChild(leaderAgentId, leaderAlias, alias, message, invocationId),
			},
			sender,
			attemptId,
		);
	}

	/** True once this session has a worker runtime or a persisted orchestration store: only then can workers or managed lanes exist. */
	private _hasWorkerState(): boolean {
		if (this._workers || this._workerLifecycle) return true;
		try {
			return lstatSync(orchestrationEventStoreDir(this.deps.getAgentDir(), this.deps.getSessionId())).isDirectory();
		} catch {
			return false;
		}
	}

	/**
	 * The bot roster. The TUI reads it on every render frame, so it is projected once and served until an input reports a
	 * change: a bot-store save, a lane-tracker change or an orchestration event drops it (see `_laneRecordsChanged`).
	 * Reading it never constructs the worker runtime for a session that has no worker state.
	 */
	listPersistentBots(defaultModelRef = this.getRootModelLabel(), teamId?: string): PersistentBotView[] {
		const delegateActive = this.deps.isDelegateToolActive();
		const bindings = this.botBindings.revision();
		const cached = teamId ? undefined : this._botViews;
		const team = teamId ? this.getBotTeamStore().getTeam(teamId) : undefined;
		const inContext = (runtime: string) => {
			const context = this.botBindings.generationContext(runtime);
			return (
				context.teamId === teamId &&
				(!teamId || context.teamIncarnationId === (team ? teamIncarnation(team) : undefined))
			);
		};
		if (
			cached &&
			cached.defaultModelRef === defaultModelRef &&
			cached.delegateActive === delegateActive &&
			cached.bindings === bindings
		) {
			return [...cached.views];
		}
		const hasWorkerState = this._hasWorkerState();
		let liveAgents: WorkerAgentView[] = [];
		if (hasWorkerState && delegateActive) {
			try {
				liveAgents = this.listWorkerAgents();
			} catch {
				liveAgents = [];
			}
		}
		const laneRecords = this._rosterLaneRecords();
		const projected = this.getBotTeamStore().projectBotViews(
			liveAgents
				.filter((agent) => inContext(agent.agentId))
				.flatMap((agent) => {
					const alias = this.botBindings.alias(agent.agentId);
					return alias ? [{ ...agent, agentId: alias }] : [];
				}),
			laneRecords
				.filter((record) => inContext(record.agentId ?? record.laneId))
				.flatMap((record) => {
					const alias = this.botBindings.alias(record.agentId ?? record.laneId);
					return alias ? [{ ...record, agentId: alias }] : [];
				}),
			defaultModelRef,
			teamId === undefined,
		);
		// A machine joined over the link speaks from facts (connected, its jobs, its room); a local bot's state comes from its lanes.
		const views = projected.map((view) =>
			view.remote && view.state !== "retired" ? { ...view, ...this.getRemoteHub().rosterWords(view.agentId) } : view,
		);
		if (!teamId) this._botViews = { defaultModelRef, delegateActive, bindings, views };
		return teamId ? views.filter((view) => team?.memberAgentIds.includes(view.agentId)) : [...views];
	}

	/**
	 * The live managed lanes (collaboration agents and other externally hosted workers), apart from the bot roster:
	 * they are not bots and have no chat. Served until a lane record changes.
	 */
	listManagedLanes(): ManagedLaneView[] {
		this._managedLaneViews ??= projectManagedLaneViews(this._rosterLaneRecords());
		// A placed job's words come from the job store and the fleet, which change without a lane record: described per call.
		return this._managedLaneViews.map((view) => this._remoteHub?.describeLane(view) ?? view);
	}

	/** The lane records the roster projections read; reading them never constructs the worker runtime. */
	private _rosterLaneRecords(): LaneRecord[] {
		if (this._hasWorkerState()) return this.getLaneRecords();
		this._hydrateManagedLanes();
		return this._laneTracker.getRecords();
	}

	/**
	 * The model a bot or team member runs on. With no reference it runs on the foreground model. A reference resolves
	 * through the registry's resolver, authenticated models first; one the registry cannot resolve is an error, never a
	 * guessed provider.
	 */
	resolveModelSpec(rawModel?: string): { provider: string; modelId: string; thinkingLevel?: string } {
		const fgThinking = this.deps.getForegroundThinkingLevel
			? String(this.deps.getForegroundThinkingLevel())
			: undefined;

		const reference = rawModel?.trim();
		if (!reference) {
			// A bot with no model named runs on what a worker would (the owner's worker profile, else the subscription-routed
			// efficient model), not on the session's own, usually the dearest, model.
			const current = this.previewWorkerModel() ?? this.deps.getModel();
			if (!current) throw new Error("No model is selected: give the model as <provider>/<model>.");
			const level =
				fgThinking !== undefined && isOrchestrationThinkingLevel(fgThinking)
					? resolveModelThinkingLevel(current, stepDownThinkingLevel(fgThinking))
					: fgThinking;
			return { provider: current.provider, modelId: current.id, thinkingLevel: level };
		}
		const registry = this.deps.getModelRegistry();
		const authenticated = resolveCliModel({
			cliModel: reference,
			modelRegistry: {
				find: (provider, modelId) => registry.find(provider, modelId),
				getAll: () => registry.getAvailable(),
				getAvailable: () => registry.getAvailable(),
				hasConfiguredAuth: (model) => registry.hasConfiguredAuth(model),
			},
		});
		const resolved = authenticated.model
			? authenticated
			: resolveCliModel({ cliModel: reference, modelRegistry: registry });
		if (!resolved.model) throw new Error(resolved.error ?? `Model "${reference}" not found.`);
		return {
			provider: resolved.model.provider,
			modelId: resolved.model.id,
			thinkingLevel: resolved.thinkingLevel ?? resolved.model.defaultThinkingLevel ?? fgThinking,
		};
	}

	getRootModelLabel(): string {
		const m = this.deps.getModel();
		return m ? `${m.provider}/${m.id}` : "no-model";
	}

	/**
	 * Store changes and lane changes: an open bot chat follows both, so it refreshes when a bot starts, finishes, fails or
	 * takes a turn. A lane change names only the agents whose record differs from the last one this subscription saw, so an
	 * event for another agent wakes nobody.
	 */
	subscribeBotTeamUpdates(listener: (change: BotTeamChange) => void): () => void {
		const offStore = this.getBotTeamStore().subscribe(() => listener("all"));
		const seen = new Map<string, string>();
		const offLanes = this.subscribeLaneRecords((records) => {
			const changed: string[] = [];
			for (const record of records) {
				const agentId = record.agentId ?? record.laneId;
				// A turn adds cost, a start or finish changes status or time: each moves this signature.
				const signature = JSON.stringify([
					record.status,
					record.attemptId,
					record.costUsd,
					record.startedAt,
					record.completedAt,
					record.reasonCode,
					record.label,
				]);
				if (seen.get(agentId) === signature) continue;
				seen.set(agentId, signature);
				const alias = this.botBindings.alias(agentId);
				if (alias) changed.push(alias);
			}
			if (changed.length > 0) listener(changed);
		});
		return () => {
			offStore();
			offLanes();
		};
	}

	listPersistentTeams(): PersistentTeamRecord[] {
		return this.getBotTeamStore().listTeams();
	}

	getPersistentTeam(teamId: string): PersistentTeamRecord | undefined {
		return this.getBotTeamStore().getTeam(teamId);
	}

	upsertPersistentBot(rawInput: UpsertPersistentBotInput): PersistentBotRecord {
		const store = this.getBotTeamStore();
		const agentId = normalizeBotOrTeamId(rawInput.agentId, "agentId");
		// Judge the soul before the grant guard: an invalid soul is the error to show, whatever the bot is doing.
		const input = rawInput.soul === undefined ? rawInput : { ...rawInput, soul: normalizeBotSoul(rawInput.soul) };
		this.assertBotDispatchIdle(agentId);
		store.reload();
		const existing = store.getBot(agentId);
		const bindingFields = [
			"provider",
			"modelId",
			"thinkingLevel",
			"profileId",
			"canWrite",
			"soul",
			"leader",
		] as const;
		const bindingChanged =
			existing &&
			bindingFields.some((field) => {
				const value = input[field];
				if (value === undefined) return false;
				const previous = existing[field];
				const next = typeof value === "string" ? value.trim() || undefined : value;
				return next !== (typeof previous === "string" ? previous.trim() || undefined : previous);
			});
		if (
			bindingChanged &&
			this._hasWorkerState() &&
			this.listWorkerAgents().some(
				(agent) => this.botBindings.runtimes(agentId).includes(agent.agentId) && agent.status !== "retired",
			)
		)
			throw new Error(
				`Retire bot ${input.agentId} (/bot retire ${input.agentId}) before changing its model, profile, permissions, soul or leadership: its live worker keeps the grant and soul it started with, and only a new worker generation gets the new ones.`,
			);
		if (input.leader !== undefined)
			harnessLog.info("bots", input.leader ? "a bot was made a leader" : "a bot stopped being a leader", {
				agentId,
			});
		return store.upsertBot({ ...input, agentId });
	}

	/**
	 * Creates a bot on the authority of the orchestrator or of a leader (the owner's `/bot new` is the third way). A leader
	 * cannot make a standing leader, grants write access only when it can write itself, and has a bound on the bots it keeps.
	 * A goal leader (`bot lead` without agentId, appointed by the orchestrator or by a leader) is created a leader, for its one goal.
	 */
	createBotFor(
		creator: { readonly kind: "root" } | { readonly kind: "leader"; readonly agentId: string },
		request: BotCreationRequest,
		options?: { readonly goalLeader?: boolean },
	): CreatedBotView {
		const store = this.getBotTeamStore();
		store.reload();
		const agentId = normalizeBotOrTeamId(
			request.agentId ??
				suggestBotId(
					request.description ?? request.soul,
					new Set([
						...RESERVED_BOT_CREATOR_IDS,
						...store.listBots({ includeRetired: true }).map((bot) => bot.agentId),
					]),
				),
			"agentId",
		);
		let createdBy = "root";
		let mayWrite = true;
		if (creator.kind === "leader") {
			const leader = store.getBot(creator.agentId);
			if (leader?.leader !== true || leader.retired === true)
				throw new Error(
					mayNotCreateBotsText(
						store
							.listBots()
							.filter((bot) => bot.leader === true)
							.map((bot) => bot.agentId),
					),
				);
			createdBy = leader.agentId;
			mayWrite = leader.canWrite === true;
		}
		if (request.canWrite === true && !mayWrite)
			throw new Error(`${createdBy} cannot give a bot write access: it has none itself.`);
		const soul = request.soul === undefined ? undefined : normalizeBotSoul(request.soul);
		const spec = this.resolveModelSpec(request.model);
		const thinkingLevel = request.thinkingLevel ?? spec.thinkingLevel;
		const bot = store.createBotIfAbsent(
			{
				agentId,
				displayName: displayNameFor(agentId),
				provider: spec.provider,
				modelId: spec.modelId,
				...(thinkingLevel ? { thinkingLevel } : {}),
				...(soul ? { soul } : {}),
				...(request.description ? { description: request.description } : {}),
				canWrite: request.canWrite === true,
				leader: options?.goalLeader === true,
				createdBy,
			},
			creator.kind === "leader" ? { createdBy, max: MAX_BOTS_PER_LEADER } : undefined,
		);
		harnessLog.info("bots", "a bot was created", () => ({
			agentId: bot.agentId,
			by: createdBy,
			model: `${bot.provider}/${bot.modelId}`,
			canWrite: bot.canWrite === true,
			goalLeader: bot.leader === true,
		}));
		return {
			agentId: bot.agentId,
			modelRef: `${bot.provider}/${bot.modelId}`,
			canWrite: bot.canWrite === true,
			createdBy,
		};
	}

	private _remoteHub: RemoteHubController | undefined;

	/** This session's hub: the machines joined to it, shown as bots with a remote mark. */
	getRemoteHub(): RemoteHubController {
		this._remoteHub ??= new RemoteHubController({
			agentDir: this.deps.getAgentDir(),
			getStore: () => this.getBotTeamStore(),
			// A machine arriving or leaving touches its bot, so the roster follows the same way it follows any bot save.
			changed: (machine) => this.getBotTeamStore().upsertBot({ agentId: machine }),
			// Remote work placement runs a placed job through this session's own worker start path and records the jobs
			// it places as managed lanes; nothing here is read until the owner linked this machine.
			jobs: {
				session: this,
				sessionId: () => this.deps.getSessionId(),
				cwd: () => this.deps.getCwd(),
				models: () => this.deps.getModelRegistry().getAvailable(),
				usesSubscription: (model) => this.deps.getModelRegistry().isUsingOAuth(model),
				// A job another process ended is settled here too: each session holds its own worker terminals.
				onJobsChanged: () =>
					this.acknowledgePlacedJobTerminals(finishedPlacedJobReferences(this.deps.getAgentDir())),
			},
		});
		// A hub made after the fleet exists gives it the room at once; one made before gets it when the fleet is built.
		if (this._workers) this._remoteHub.jobs?.attachFleet(this._workers.getFleet());
		return this._remoteHub;
	}

	/** The orchestrator's tool for bots on the fly. */
	private createBotToolDefinition(): ToolDefinition {
		return createBotToolDefinition({
			ask: async (agentId, message) => {
				await this.sendOperatorMessageToBot(agentId, message, {
					fromRoot: true,
					delegationObjectiveId: this.runningDelegationOf(agentId),
				});
			},
			create: (request) => this.createBotFor({ kind: "root" }, request),
			lead: (request) => this.getLeaders().delegate(request),
			list: () =>
				this.getBotTeamStore()
					.listBots({ includeRetired: true })
					.map((bot) => ({
						agentId: bot.agentId,
						modelRef: `${bot.provider}/${bot.modelId}`,
						leader: bot.leader === true,
						retired: bot.retired === true,
						...(bot.createdBy ? { createdBy: bot.createdBy } : {}),
					})),
		});
	}

	/** The plan executor the root's `plan` tool reaches; composed with the worker runtime of a root session. */
	private _planExecutor: PlanExecutor | undefined;
	private _planRouteOff: (() => void) | undefined;
	private readonly _planChangeListeners = new Set<() => void>();

	/** Fires when a plan's visible state changes, so the owner's panel and status redraw while the root is idle. */
	subscribePlanChanges(listener: () => void): () => void {
		this._planChangeListeners.add(listener);
		return () => void this._planChangeListeners.delete(listener);
	}

	/**
	 * Every root-only lane tool, the one list the runtime builder offers: routine, bot, channel reply and plan. A child
	 * session gets none, and a lane whose tool is not open (no routine store, no channel policy) is left out.
	 */
	createBackgroundLaneTools(): ToolDefinition[] {
		if (this.deps.isChildSession()) return [];
		return [
			this.createRoutineToolDefinition(),
			this.createBotToolDefinition(),
			this.createChannelReplyToolDefinition(),
			this.createPlanToolDefinition(),
		].filter((definition): definition is ToolDefinition => definition !== undefined);
	}

	private createPlanToolDefinition(): ToolDefinition {
		return createPlanToolDefinition(() => this._getPlanExecutor());
	}

	/** The root's plan executor; reaching it builds the worker runtime that composes it. */
	private _getPlanExecutor(): PlanExecutorPort | undefined {
		if (this.deps.isChildSession() || this.deps.isDisposed()) return undefined;
		this._getWorkerLifecycle();
		return this._planExecutor;
	}

	/**
	 * Composes the plan executor over the worker runtime. Its terminal claim stands before the outbox replays (plan-step
	 * terminals are the executor's input), and its first drain is the restart recovery of every open plan.
	 */
	private _composePlanExecutor(lifecycle: WorkerLifecycle, store: OrchestrationEventStore): void {
		if (this._planExecutor) return;
		const executor = new PlanExecutor({
			runtime: () => lifecycle.ledger.runtime,
			subscribeStore: (listener) => store.subscribe(listener),
			fleet: () => this._getWorkerController().getFleet(),
			engine: () => this.deps.systemOne.semanticDecisionEngine(),
			goal: () => this.deps.getGoalStateSnapshot(),
			sessionId: () => this.deps.getSessionId(),
			agentDir: () => this.deps.getAgentDir(),
			rootEntries: () => this.deps.getSessionManager().getBranch(),
			// The claim an attempt holds: its outbox write while it is pending, else the transcript's saved claim.
			workerClaim: (taskId, attemptId) =>
				readWorkerClaimSnapshotForAttempt(
					this.deps.getSessionManager().getBranch(),
					lifecycle.ledger.runtime.getSnapshot().attempts[attemptId]?.parentWrites,
					taskId,
					attemptId,
				)?.claim,
			captureOrigin: () => captureWorkerReceiptOrigin(this.deps.getSessionManager()),
			deliver: (delivery, signal) => this.deps.deliverNotes(delivery, { signal }),
			isDelivered: (deliveryId) => this.deps.getSessionManager().getParentInput(deliveryId) !== undefined,
			acknowledge: (notificationIds) => lifecycle.markNotificationsDelivered(notificationIds),
			planChanged: () => {
				for (const listener of this._planChangeListeners) listener();
				this._goalAutoContinue.wakePlanWait();
			},
			timers: () => this.deps.getTimers().port("orchestration"),
			lanes: () => this._worktreeLaneHostDeps(),
			landGate: () => this.deps.getSettingsManager().getWorktreeSyncSettings(),
		});
		this._planExecutor = executor;
		this._planRouteOff = this.registerTerminalRoute("plan_executor", (record) => executor.ownsTask(record.laneId));
		queueMicrotask(() => {
			if (!this.deps.isDisposed()) executor.start();
		});
	}

	private _leaders: LeaderController | undefined;
	private _retention?: OrchestrationRetentionController;
	private _leaderRouteOff: (() => void) | undefined;
	private _jobRouteOff: (() => void) | undefined;
	private readonly _placedJobAcks = new PlacedJobTerminalAcks({
		lifecycle: () => this._workerLifecycle,
		agentDir: () => this.deps.getAgentDir(),
		isDisposed: () => this.deps.isDisposed(),
	});
	private _leaderRows: LeaderRow[] | undefined;

	/** The root's delegations to leaders; building it builds the worker runtime, which registers its terminal claim. */
	getLeaders(): LeaderController {
		if (this.deps.isChildSession()) throw new Error("Only the orchestrator hands goals to leaders.");
		this._getWorkerLifecycle();
		return this._getLeaders();
	}

	/**
	 * Every delegation to a leader, read without building the worker runtime: a session that never had orchestration
	 * state has none, and a session with state reads its store. Actions go through `getLeaders()`, which builds the runtime.
	 */
	leaderDelegations(): DelegationRecord[] {
		if (this._leaders) return this._leaders.snapshot();
		if (this.deps.isChildSession()) return [];
		const snapshot =
			this._workerLifecycle?.getTaskRuntimeSnapshot() ??
			(this._hasWorkerState()
				? readTaskRuntimeProjection(
						new OrchestrationEventStore({
							agentDir: this.deps.getAgentDir(),
							sessionId: this.deps.getSessionId(),
						}),
					)
				: undefined);
		return snapshot ? readDelegations(snapshot) : [];
	}

	/**
	 * A leader's fleet subtree is keyed on its runtime's agent id, the `parentAgentId` its children are admitted under. A
	 * standing or orchestrator-appointed leader is top-level, so its share sits in the root subtree (`""`); a leader a leader
	 * handed a goal to sits under that leader's share.
	 */
	private openLeaderSubtree(alias: string, parentAlias?: string): void {
		this._getWorkerController()
			.getFleet()
			.openShare({
				subtreeId: this.botBindings.runtime(alias),
				parentSubtreeId: parentAlias === undefined ? "" : this.botBindings.runtime(parentAlias),
				weight: 1,
			});
	}

	/**
	 * A standing leader's runtime started before the bot could lead has a leaf contract, which is fixed for that runtime's
	 * life. When it is idle it is retired here, so its next start is granted the leader limits. It is left alone while busy,
	 * and while any message waits for it: retiring would discard that message, so the restart waits for the next idle moment.
	 */
	private restartLeaderRuntimeIfLeaf(alias: string): void {
		const runtimes = new Set(this.botBindings.runtimes(alias));
		const live = this.listWorkerAgents().filter((agent) => runtimes.has(agent.agentId) && agent.status !== "retired");
		if (live.length === 0 || live.some((agent) => agent.activity !== "idle")) return;
		const control = this._getWorkerController().getAgentControl();
		if (live.some((agent) => control.hasPendingControlMessages(agent.agentId))) return;
		const first = live[0];
		if (
			!first ||
			contractGrantsChildren(this._getWorkerLifecycle().getAgentTurnDispatch(first.agentId)?.executionContract)
		)
			return;
		for (const agent of live) this.retireWorkerAgent(agent.agentId, undefined);
	}

	private closeLeaderSubtree(alias: string, reasonCode: string): void {
		this._getWorkerController().getFleet().closeShare(this.botBindings.runtime(alias), reasonCode);
	}

	/**
	 * The delegation limits a standing leader's runtime is granted: its children are its owned bots, nested up to
	 * `leaders.maxDepth` levels, and the host ceilings still apply where the runtime is started.
	 */
	private leaderDelegationLimits(): OrchestrationDelegationLimits {
		const maxDepth = this.deps.getSettingsManager().getLeaderSettings().maxDepth;
		return {
			maxDepth,
			maxChildrenPerAgent: MAX_BOTS_PER_LEADER,
			maxNestedAgentsPerSession: MAX_BOTS_PER_LEADER * maxDepth,
		};
	}

	/**
	 * Whether a subscription login one of these bots runs on has no allowance left in its usage window: the same reading the
	 * owner channel and the cost guard use, taken on each bot's own model.
	 */
	private subscriptionExhaustedFor(aliases: readonly string[]): boolean {
		const registry = this.deps.getModelRegistry();
		this._allowance ??= createSubscriptionAllowanceReader({
			getRegistry: () => this.deps.getModelRegistry(),
			getModel: () => this.deps.getModel(),
		});
		const reader = this._allowance;
		return aliases.some((alias) => {
			const bot = this.getBotTeamStore().getBot(alias);
			const model = bot ? registry.find(bot.provider, bot.modelId) : undefined;
			return model !== undefined && reader.read(DEFAULT_OWNER_QUOTA_MAX_USED_PERCENT, model).kind === "exhausted";
		});
	}

	/** The delegation a leader is running right now: the orchestrator's words to that leader are that goal's input. */
	private runningDelegationOf(alias: string): string | undefined {
		if (this.deps.isChildSession()) return undefined;
		const record = this.getLeaders().currentFor(alias);
		return record?.state === "running" ? record.objectiveId : undefined;
	}

	/**
	 * The Leaders rows of the Orchestration panel. Served until an orchestration commit or a bot-store change drops them;
	 * reading the rows never builds the worker runtime.
	 */
	listLeaderRows(): LeaderRow[] {
		this._leaderRows ??= leaderRows(this.leaderDelegations(), (alias) => {
			const bot = this.getBotTeamStore().getBot(alias);
			return bot?.displayName ?? displayNameFor(alias);
		});
		return [...this._leaderRows];
	}

	private _getLeaders(): LeaderController {
		if (this._leaders) return this._leaders;
		const store = () => this.getBotTeamStore();
		this._leaders = new LeaderController({
			runtime: () => this._getWorkerLifecycle().ledger.runtime,
			snapshot: () => this._getWorkerLifecycle().getTaskRuntimeSnapshot(),
			subscribe: (listener) => this.subscribeOrchestrationStore(listener),
			bots: () => store().listBots({ includeRetired: true }).map(leaderBotViewOf),
			createGoalLeader: (request, appointer) =>
				this.createBotFor(appointer ?? { kind: "root" }, request, { goalLeader: true }),
			directBotOf: (runtime) => {
				const context = this.botBindings.generationContext(runtime);
				return context.teamId === undefined && store().getBot(context.agentId) ? context.agentId : undefined;
			},
			runtimesOf: (alias) => this.botBindings.runtimes(alias),
			workers: () => this.listWorkerAgents(),
			send: async (alias, text, delegationObjectiveId, options) => {
				await this.sendOperatorMessageToBot(alias, text, {
					fromRoot: true,
					delegationObjectiveId,
					idempotencyKey: options?.idempotencyKey,
					fromLeader: options?.fromLeader,
				});
			},
			stop: (alias) => void this.stopPersistentBot(alias),
			retire: (alias) => this.retirePersistentBot(alias),
			acknowledge: (notificationIds) => this._getWorkerLifecycle().markNotificationsDelivered(notificationIds),
			deliver: (input) => this.deps.deliverParentInput(input),
			origin: () => captureWorkerReceiptOrigin(this.deps.getSessionManager()),
			hasDelivered: (deliveryId) => this.deps.getSessionManager().getParentInput(deliveryId) !== undefined,
			maxDepth: () => this.deps.getSettingsManager().getLeaderSettings().maxDepth,
			subscriptionExhausted: (aliases) => this.subscriptionExhaustedFor(aliases),
			isMeteredAttempt: (attempt) => this._workers?.attemptIsMetered(attempt) ?? true,
			hasPendingDelegatedMessage: (objectiveId) => this.hasPendingDelegatedMessage(objectiveId),
			openSubtree: (alias, parentAlias) => this.openLeaderSubtree(alias, parentAlias),
			restartLeaderRuntimeIfLeaf: (alias) => this.restartLeaderRuntimeIfLeaf(alias),
			closeSubtree: (alias, reasonCode) => this.closeLeaderSubtree(alias, reasonCode),
			reconcileDelegatedMessages: (objectiveId) => this.reconcileDelegatedMessages(objectiveId),
			now: () => this.deps.getTimers().port("orchestration").now(),
			timers: this.deps.getTimers().port("leaders"),
		});
		this._leaders.subscribe(() => {
			this._leaderRows = undefined;
		});
		return this._leaders;
	}

	/** The idle release of closed orchestration work: built once, and it reads the worker runtime only when a pass runs. */
	private _getRetention(): OrchestrationRetentionController {
		this._retention ??= new OrchestrationRetentionController({
			timers: this.deps.getTimers().port("retention"),
			isDisposed: () => this.deps.isDisposed(),
			isChildSession: () => this.deps.isChildSession(),
			isForegroundBusy: () => this.deps.isForegroundBusy(),
			hasWorkerState: () => this._hasWorkerState(),
			closedObjectiveDays: () =>
				this.deps.getSettingsManager().getOrchestrationRetentionSettings().closedObjectiveDays,
			capacity: () =>
				this._hasWorkerState()
					? this._getOrchestrationCore().lifecycle.ledger.runtime.getProjectionCapacity()
					: undefined,
			pass: () => this._retentionPassDeps(),
			observeNotice: (read) => this.deps.observeHarnessNotice?.("orchestration-capacity", read),
			warn: (message) => this._safeWarn(message),
		});
		return this._retention;
	}

	private _retentionPassDeps(): Omit<RetentionPassDeps, "warn"> {
		return {
			runtime: () => this._getOrchestrationCore().lifecycle.ledger.runtime,
			store: () => this._getOrchestrationCore().store,
			sessionId: this.deps.getSessionId(),
			agentDir: this.deps.getAgentDir(),
			closedObjectiveDays: () =>
				this.deps.getSettingsManager().getOrchestrationRetentionSettings().closedObjectiveDays,
			now: () => this.deps.getTimers().port("orchestration").now(),
			hasDelivered: (deliveryId) => this.deps.getSessionManager().getParentInput(deliveryId) !== undefined,
			currentGoalId: () => this.deps.getGoalStateSnapshot()?.goalId,
		};
	}

	retirePersistentBot(agentId: string): { retired: boolean; detail: string } {
		try {
			agentId = normalizeBotOrTeamId(agentId, "agentId");
			// Retiring a leader mid-goal would orphan its goal and its bots: the goal is cancelled first.
			if (this._hasWorkerState() && !this.deps.isChildSession() && this.getLeaders().leadsOpenDelegation(agentId))
				throw new Error(`Bot ${agentId} leads an open goal; cancel it first (/lead cancel ${agentId}).`);
			this.assertBotDispatchIdle(agentId);
			const runtimes = new Set(this.botBindings.runtimes(agentId));
			const workers = this._hasWorkerState()
				? this.listWorkerAgents().filter((agent) => runtimes.has(agent.agentId))
				: [];
			if (workers.some((agent) => agent.status !== "retired" && agent.activity !== "idle"))
				throw new Error(`Bot ${agentId} still has active group or direct work.`);
			for (const worker of workers) this.retireWorkerAgent(worker.agentId, undefined, { discardPending: true });
			const hasWorker = workers.length > 0;
			const bot = this.getBotTeamStore().retireBot(agentId);
			return {
				retired: hasWorker || bot !== undefined,
				detail: hasWorker || bot ? `Bot ${agentId} retired.` : `Bot ${agentId} does not exist.`,
			};
		} catch (error) {
			return { retired: false, detail: error instanceof Error ? error.message : String(error) };
		}
	}

	stopPersistentBot(agentId: string): { stopped: boolean; detail: string } {
		try {
			agentId = normalizeBotOrTeamId(agentId, "agentId");
			const runtimes = new Set(this.botBindings.runtimes(agentId));
			// Stopping a leader stops the bots it owns: their work was its work.
			const ownedRuntimes = new Set(
				this.getBotTeamStore()
					.listBots()
					.filter((bot) => bot.createdBy === agentId)
					.flatMap((bot) => this.botBindings.runtimes(bot.agentId)),
			);
			const agents = this.listWorkerAgents();
			const results = agents
				.filter((agent) => runtimes.has(agent.agentId))
				.map((agent) => this.interruptWorkerAgent(agent.agentId, undefined, { force: false }));
			const owned = agents
				.filter(
					(agent) => ownedRuntimes.has(agent.agentId) && agent.status !== "retired" && agent.activity !== "idle",
				)
				.map((agent) => this.interruptWorkerAgent(agent.agentId, undefined, { force: false }))
				.filter((result) => result.interrupted).length;
			const res = results.find((result) => result.interrupted) ?? results[0] ?? { interrupted: false };
			const ownedText = owned > 0 ? ` and ${owned} of its bots` : "";
			return {
				stopped: res.interrupted || owned > 0,
				detail: res.interrupted
					? `Stopped ${agentId}${ownedText} (${res.mode ?? "halt"}).`
					: owned > 0
						? `Stopped ${owned} of ${agentId}'s bots; ${agentId} itself was not running.`
						: (res.reason ?? `${agentId} is not running.`),
			};
		} catch (error) {
			return {
				stopped: false,
				detail: error instanceof Error ? error.message : `${agentId} is not running.`,
			};
		}
	}

	upsertPersistentTeam(input: UpsertPersistentTeamInput): PersistentTeamRecord {
		return this.getBotTeamStore().upsertTeam(input);
	}

	setPersistentTeamMembers(teamId: string, memberAgentIds: readonly string[]): PersistentTeamRecord {
		return this.getBotTeamStore().setTeamMembers(teamId, memberAgentIds);
	}

	deletePersistentTeam(teamId: string): boolean {
		return this.getBotTeamStore().deleteTeam(teamId);
	}

	private createSyntheticBotSummaryMessage(bot: PersistentBotRecord | undefined, summary: string): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: `[Prior turn summary]: ${summary}` }],
			api: "anthropic-messages",
			provider: bot?.provider ?? "anthropic",
			model: bot?.modelId ?? "claude-haiku-5-5",
			usage: {
				totalTokens: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			stopReason: "stop",
			timestamp: bot?.lastMessageAt ?? Date.now(),
		};
	}

	readBotChatMessages(agentId: string, teamId?: string): AgentMessage[] {
		const normId = normalizeBotOrTeamId(agentId, "agentId");
		if (this.getBotTeamStore().getBot(normId)?.remote) return this.getRemoteHub().chat(normId);
		const team = teamId ? this.getBotTeamStore().getTeam(teamId) : undefined;
		const runtime = this.botBindings.runtime(normId, teamId, team ? teamIncarnation(team) : undefined);
		let conv = this.openWorkerTranscript(runtime);
		const bot = this.getBotTeamStore().getBot(normId);
		if (!teamId && !conv && bot?.lastTranscriptRef) {
			conv = this.openWorkerTranscript(bot.lastTranscriptRef);
		}
		if (conv) {
			const msgs = conv.getProviderContext().messages;
			const filtered = msgs.filter((msg) => {
				if (msg.role !== "user") return true;
				let text = "";
				if (typeof msg.content === "string") {
					text = msg.content;
				} else if (Array.isArray(msg.content)) {
					text = msg.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
				}
				const trimmed = text.trimStart();
				const isSyntheticBirth =
					(trimmed.startsWith("<chat>\n") || trimmed.startsWith("<chat>")) &&
					(trimmed.includes("The view") || trimmed.includes("id+n|"));
				return !isSyntheticBirth;
			});
			if (filtered.length > 0) {
				const shown: AgentMessage[] = [];
				for (const msg of filtered) {
					if (msg.role === "assistant") {
						// A bot that answers through `submit_report` said its summary: the chat shows those words, not the call.
						shown.push({
							...msg,
							content: msg.content.map((part) => {
								if (part.type === "text") return { ...part, text: botReplyText(part.text) };
								if (part.type === "toolCall" && part.name === SUBMIT_REPORT_TOOL_NAME) {
									const summary: unknown = part.arguments.summary;
									return { type: "text" as const, text: typeof summary === "string" ? summary : "" };
								}
								return part;
							}),
						});
						continue;
					}
					if (msg.role === "toolResult" && msg.toolName === SUBMIT_REPORT_TOOL_NAME) continue;
					if (msg.role !== "user") {
						shown.push(msg);
						continue;
					}
					const text = botChatOperatorText(msg, workerControlOf(msg));
					// A follow-up reaches the bot twice, as its wake task and as its mailbox message: one line in the chat.
					const previous = shown.at(-1);
					if (previous?.role === "user" && previous.timestamp !== undefined && msg.timestamp !== undefined) {
						const previousText =
							typeof previous.content === "string"
								? previous.content
								: previous.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
						if (previousText === text) continue;
					}
					shown.push({ ...msg, content: [{ type: "text", text }] });
				}
				return shown;
			}
		}

		const store = this.getBotTeamStore();
		const memberTeamIds = teamId ? [teamId] : [];
		const relevantTeamMessages = memberTeamIds.flatMap((tId) =>
			store.listTeamMessages(tId).filter((m) => m.targetAgentIds.includes(normId)),
		);
		const laneRecords = this.getLaneRecords().filter((r) => r.agentId === runtime || r.laneId === runtime);

		if (relevantTeamMessages.length === 0 && laneRecords.length === 0) {
			return !teamId && bot?.lastSummary ? [this.createSyntheticBotSummaryMessage(bot, bot.lastSummary)] : [];
		}

		const fallbackMessages: AgentMessage[] = [];
		for (const record of laneRecords) {
			const label = record.label;
			if (label) {
				fallbackMessages.push({
					role: "user",
					content: [{ type: "text", text: label }],
					timestamp: record.startedAt ? new Date(record.startedAt).getTime() : Date.now(),
				});
			}
			if (record.status !== "running" && record.status !== "queued") {
				fallbackMessages.push({
					role: "custom",
					customType: "bot-lane-status",
					content: `[${normId}] ${record.reasonCode ?? `Task ${record.status}`}`,
					display: true,
					timestamp: record.completedAt ? new Date(record.completedAt).getTime() : Date.now(),
				});
			}
		}
		for (const tm of relevantTeamMessages) {
			fallbackMessages.push({
				role: "user",
				content: [{ type: "text", text: `[Team ${tm.teamId}] ${tm.text}` }],
				timestamp: tm.timestamp,
			});
		}
		if (!teamId && fallbackMessages.length === 0 && bot?.lastSummary) {
			fallbackMessages.push(this.createSyntheticBotSummaryMessage(bot, bot.lastSummary));
		}
		fallbackMessages.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
		return fallbackMessages;
	}

	readTeamChatMessages(teamId: string): AgentMessage[] {
		const store = this.getBotTeamStore();
		const teamMessages = store.listTeamMessages(teamId);
		const result: AgentMessage[] = [];

		for (const msg of teamMessages) {
			// One shape for every speaker: the text as written, and who spoke to whom as fields the chat view draws.
			result.push({
				role: "custom",
				customType: "team-message",
				content: msg.text,
				display: true,
				details: {
					teamId,
					from:
						msg.sender.kind === "bot" ? { kind: "bot", agentId: msg.sender.agentId } : { kind: msg.sender.kind },
					to: [...msg.targetAgentIds],
				},
				timestamp: msg.timestamp,
			});
		}

		result.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
		return result;
	}

	subscribeOrchestrationStore(listener: () => void): () => void {
		if (this._orchestrationStore) {
			return this._orchestrationStore.subscribe(listener);
		}
		return this.subscribeLaneRecords(() => listener());
	}

	async sendOperatorMessageToBot(
		agentId: string,
		message: string,
		options?: BotOperatorMessageOptions & { teamId?: string; teamIncarnationId?: string },
	): Promise<BotOperatorMessageDispatchResult> {
		const normId = normalizeBotOrTeamId(agentId, "agentId");
		const manager = this.deps.getSessionManager();
		const teamId = options?.teamId ? normalizeBotOrTeamId(options.teamId, "teamId") : undefined;
		const team = teamId ? this.getBotTeamStore().getTeam(teamId) : undefined;
		if (
			teamId &&
			(!team?.memberAgentIds.includes(normId) ||
				(options?.teamIncarnationId && options.teamIncarnationId !== teamIncarnation(team)))
		)
			throw new Error("Bot is not a member of the selected group generation.");
		const context: BotRuntimeContext = {
			agentId: normId,
			...(team ? { teamId: team.teamId, teamIncarnationId: teamIncarnation(team) } : {}),
		};
		const assertBranchContext = manager.captureBranchContext();
		const assertBranch = () => {
			if (this.deps.isDisposed()) throw new Error("Cannot dispatch a bot message after session disposal.");
			if (this.deps.getSessionManager() !== manager) throw new Error("Bot message belongs to a previous session.");
			assertBranchContext();
		};
		const key = JSON.stringify([manager.getSessionId(), normId, context.teamId, context.teamIncarnationId]);
		const previous = this.botDispatches.get(key) ?? Promise.resolve();
		const result = previous.then(() => {
			assertBranch();
			return this.dispatchOperatorMessageToBot(context, message, options, assertBranch);
		});
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		this.botDispatches.set(key, settled);
		void settled.then(() => {
			if (this.botDispatches.get(key) === settled) this.botDispatches.delete(key);
		});
		return result;
	}

	private assertBotDispatchIdle(agentId: string): void {
		const sessionId = this.deps.getSessionManager().getSessionId();
		if (
			[...this.botDispatches.keys()].some((key) => {
				const [parent, alias] = JSON.parse(key);
				return parent === sessionId && alias === agentId;
			})
		)
			throw new Error(
				`Bot ${agentId} has a pending message dispatch; wait for it before editing or retiring the bot.`,
			);
	}

	private async dispatchOperatorMessageToBot(
		context: BotRuntimeContext,
		message: string,
		options: BotOperatorMessageOptions | undefined,
		assertCurrentBranch: () => void,
	): Promise<BotOperatorMessageDispatchResult> {
		const { agentId: normId, teamId, teamIncarnationId } = context;
		const store = this.getBotTeamStore();
		if (teamId) {
			if (store.reload(true)) this._botViews = undefined;
			const team = store.getTeam(teamId);
			if (!team || teamIncarnation(team) !== teamIncarnationId || !team.memberAgentIds.includes(normId))
				throw new Error("Bot membership or selected group changed before dispatch.");
		}
		if (store.getBot(normId)?.remote) {
			// A machine joined over the link answers on its own; nothing here starts a worker for it.
			const hub = this.getRemoteHub();
			// The orchestrator's turn is a lane, so its end notifies the asker; the owner's own words stay chat.
			const messageId =
				options?.fromRoot || options?.answerInSession ? await hub.ask(normId, message) : hub.send(normId, message);
			return { agentId: normId, mode: "queued", messageId, modelRef: "link/remote" };
		}
		const runtime = this.botBindings.runtime(normId, teamId, teamIncarnationId);
		let liveAgents: WorkerAgentView[] = [];
		try {
			liveAgents = this.listWorkerAgents();
		} catch {
			liveAgents = [];
		}
		let bot = store.ensureBotForDispatch(normId, () =>
			this.resolveModelSpec(liveAgents.find((agent) => agent.agentId === runtime)?.modelRef),
		);

		const requestedMode = options?.mode ?? "follow_up";

		const existingAgent = liveAgents.find((a) => a.agentId === runtime && a.status !== "retired");

		const memoryCtx = store.composeBotUnifiedMemoryContext(normId, teamId, teamIncarnationId);
		const messageOptions = {
			...(teamId ? { threadId: `team:${teamId}:${teamIncarnationId}` } : {}),
			...(options?.delegationObjectiveId ? { delegationObjectiveId: options.delegationObjectiveId } : {}),
			...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
			...(options?.fromLeader ? { fromLeader: this.botBindings.runtime(options.fromLeader) } : {}),
		};

		if (existingAgent && (requestedMode === "follow_up" || requestedMode === "queue")) {
			// The bot received its memory block when it started and edits its blackboards directly; repeating the
			// block in every operator message would bloat its transcript and the chat the operator reads.
			const modelRef = existingAgent.modelRef ?? `${bot.provider}/${bot.modelId}`;
			if (requestedMode === "queue") {
				const res = this.sendSessionRootWorkerAgentMessage(runtime, message, messageOptions);
				return { agentId: normId, mode: "queued", messageId: res.messageId, modelRef };
			}
			const res = this.followUpSessionRootWorkerAgent(runtime, message, messageOptions);
			if (res.record?.attemptId && !options?.fromRoot)
				this._getWorkerNotificationCoordinator().noteOwnerDirectAttempt(res.record.attemptId);
			return {
				agentId: normId,
				mode: res.steering ? "steered" : res.started ? "followed_up" : "queued",
				messageId: res.messageId,
				laneId: res.record?.laneId,
				modelRef,
			};
		}

		if (bot.retired) {
			bot = store.upsertBot({ agentId: normId, retired: false });
		}
		// Use the current record returned by the locked mutation, including another parent's edits.
		const spec = { provider: bot.provider, modelId: bot.modelId };

		// Fresh worker start with preferredAgentId so lane and worker identity match the persistent bot
		// The memory block follows the task: the lane label, the roster line and the chat open on what the operator sent.
		const fullInstructions =
			memoryCtx.promptBlock.length > 0 ? `${message}${BOT_MEMORY_BLOCK_SEPARATOR}${memoryCtx.promptBlock}` : message;

		const activeIds = Array.from(
			new Set(
				this.getLaneRecords()
					.filter((r) => r.status === "running" || r.status === "queued")
					.map((r) => r.agentId ?? r.laneId)
					.filter((id): id is string => typeof id === "string" && id.length > 0 && id !== normId),
			),
		);

		const preferredAgentId =
			options?.idempotencyKey === undefined
				? `bot-${randomUUID()}`
				: keyedBotRuntimeId(normId, options.idempotencyKey);
		// Publish the context before execution: recovery never has to guess a group's origin from its name.
		assertCurrentBranch();
		this.botBindings.bind(normId, preferredAgentId, teamId, teamIncarnationId);
		const stance = botStartModelStance(this.deps.getSettingsManager().getWorkerModelPinPolicy(), bot);
		const started = await this.startWorkerDelegation({
			...stance.flags,
			instructions: fullInstructions,
			// The soul is admitted into the worker's contract, so every turn of this worker generation carries it.
			...(bot.soul ? { botSoul: bot.soul } : {}),
			...(bot.profileId ? { profileId: bot.profileId } : {}),
			authority: {
				...(stance.ownModel ? { model: { provider: spec.provider, modelId: spec.modelId } } : {}),
				// The owner's own choice of this bot's model is honoured as given; a root's or a leader's is held to the subscription rule.
				...(bot.createdBy === "owner" ? { modelChosenBy: "owner" as const } : {}),
				// A chat bot answers in plain text, which only a read-only worker may do; a write-capable one reports in the claim envelope.
				readOnly: bot.canWrite !== true,
				...(stance.ownModel && isOrchestrationThinkingLevel(bot.thinkingLevel)
					? { thinkingLevel: bot.thinkingLevel }
					: {}),
			},
			preferredAgentId,
			// A leader's brief to a bot that has no live worker starts it under the delegation, not the foreground goal.
			...(options?.delegationObjectiveId ? { delegationObjectiveId: options.delegationObjectiveId } : {}),
			...(options?.idempotencyKey ? { messageReplayKey: options.idempotencyKey } : {}),
			// A standing leader's runtime is granted the children it may start (`admitNested`); any other bot is a leaf.
			...(bot.leader === true ? { delegationLimits: this.leaderDelegationLimits() } : {}),
			...(activeIds.length > 0
				? {
						parallelWork: {
							independentOf: activeIds,
							justification: `Direct operator chat with persistent bot ${normId}`,
						},
					}
				: {}),
		});

		if (!started.started) {
			throw new Error(`Failed to start persistent bot agent "${normId}": ${started.skipReason ?? "unknown error"}`);
		}
		const startedAgentId = started.record.agentId ?? started.record.laneId;
		if (started.record.attemptId && !options?.fromRoot)
			this._getWorkerNotificationCoordinator().noteOwnerDirectAttempt(started.record.attemptId);
		try {
			assertCurrentBranch();
			if (startedAgentId !== preferredAgentId) throw new Error("Bot start returned a different runtime identity.");
			if (teamId) {
				if (store.reload(true)) this._botViews = undefined;
				const current = store.getTeam(teamId);
				if (!current || teamIncarnation(current) !== teamIncarnationId || !current.memberAgentIds.includes(normId))
					throw new Error("Bot membership or selected group changed while starting.");
			}
		} catch (bindingError) {
			try {
				const current = this.listWorkerAgents().find((agent) => agent.agentId === startedAgentId);
				if (!started.record.attemptId || current?.attemptId !== started.record.attemptId)
					throw new Error("The started attempt is no longer current; later work was not cancelled.");
				if (!this.getWorkerAttemptResult(started.record.attemptId)) {
					const cancelled = this.cancelWorkerAgent(startedAgentId, "bot_binding_publication_failed");
					if (cancelled?.attemptId !== started.record.attemptId)
						throw new Error("Cancellation did not confirm the exact started attempt.");
				}
			} catch (cleanupError) {
				throw new AggregateError(
					[bindingError, cleanupError],
					`Bot ${normId} binding failed for ${startedAgentId}/${started.record.attemptId ?? "unknown"}; cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
				);
			}
			throw new Error(
				`Bot ${normId} binding failed for ${startedAgentId}/${started.record.attemptId}; its started work was cancelled or already terminal: ${bindingError instanceof Error ? bindingError.message : String(bindingError)}`,
				{ cause: bindingError },
			);
		}
		this._botViews = undefined;

		return {
			mode: "started",
			agentId: normId,
			laneId: started.record.laneId,
			modelRef: started.record.modelRef ?? `${spec.provider}/${spec.modelId}`,
			messageId: `bot-msg-${Date.now()}`,
		};
	}

	async sendOperatorMessageToTeam(teamIdRaw: string, message: string): Promise<TeamOperatorMessageDispatchResult> {
		const manager = this.deps.getSessionManager();
		const assertBranch = manager.captureBranchContext();
		const assertContext = () => {
			if (this.deps.isDisposed() || this.deps.getSessionManager() !== manager)
				throw new Error("Group message belongs to a previous session.");
			assertBranch();
		};
		assertContext();
		const teamId = normalizeBotOrTeamId(teamIdRaw, "teamId");
		const store = this.getBotTeamStore();
		const team = store.getTeam(teamId);
		if (!team) {
			throw new Error(`Cannot send message to nonexistent team "${teamId}". Create the team first.`);
		}

		const members = team.memberAgentIds;
		if (members.length === 0) {
			throw new Error(`Team "${teamId}" has no members to receive messages.`);
		}

		store.ensureTeamMemoryFile(teamId);
		const timestamp = Date.now();
		const messageId = `team-msg-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
		const deliveries: PersistentTeamMemberDelivery[] = [];

		const trimmedMessage = message.trim();
		let targetAgentIds: string[] = [];
		let contentForBots = trimmedMessage;

		if (trimmedMessage.startsWith("@")) {
			const spaceIdx = trimmedMessage.indexOf(" ");
			const targetRaw = (spaceIdx === -1 ? trimmedMessage.slice(1) : trimmedMessage.slice(1, spaceIdx)).replace(
				/[:,;]+$/,
				"",
			);
			const matched = members.find((m) => m.toLowerCase() === targetRaw.toLowerCase());
			if (matched) {
				targetAgentIds = [matched];
				contentForBots = spaceIdx === -1 ? "" : trimmedMessage.slice(spaceIdx + 1).trim();
			} else throw new Error(`Bot ${targetRaw} is not a member of group ${teamId}.`);
		}

		const targets = targetAgentIds.length > 0 ? targetAgentIds : members;

		for (const memberId of targets) {
			assertContext();
			try {
				const botResult = await this.sendOperatorMessageToBot(memberId, contentForBots, {
					teamId,
					teamIncarnationId: teamIncarnation(team),
				});
				assertContext();
				deliveries.push({
					agentId: memberId,
					outcome: botResult.mode === "started" ? "started" : botResult.mode === "queued" ? "queued" : "steering",
					messageId: botResult.messageId,
				});
			} catch (err) {
				assertContext();
				deliveries.push({
					agentId: memberId,
					outcome: "failed",
					detail: err instanceof Error ? err.message : String(err),
				});
			}
		}

		const teamMsg: PersistentTeamMessage = {
			messageId,
			teamId,
			sender: { kind: "operator" },
			text: message,
			timestamp,
			targetAgentIds: [...targets],
			deliveries,
		};
		assertContext();
		store.appendScopedTeamMessage(teamMsg, teamIncarnation(team));

		return {
			teamId,
			message: teamMsg,
			deliveries,
		};
	}

	persistWorkerTerminalReport(
		name: string,
		terminal: {
			laneId: string;
			attemptId?: string;
			status: string;
			completedAt?: string;
			reasonCode?: string;
			reasonDetail?: string;
		},
	): void {
		const entries = this.deps.getSessionManager().getEntries();
		const claim =
			terminal.attemptId === undefined
				? undefined
				: getWorkerClaimSnapshots(entries).find((candidate) => candidate.terminalAttemptId === terminal.attemptId);
		const claimId = terminal.attemptId ?? `lane:${terminal.laneId}:${terminal.completedAt ?? ""}:${terminal.status}`;
		if (
			entries.some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === CONTINUOUS_CHAT_WORK_REPORT_CUSTOM_TYPE &&
					(entry.data as { claimId?: unknown } | undefined)?.claimId === claimId,
			)
		) {
			return;
		}
		const reason = terminal.reasonCode ? ` (${terminal.reasonCode})` : "";
		const detail = terminal.reasonDetail ? boundedRedactedDiagnosticText(terminal.reasonDetail) : undefined;
		const transcriptReference = this.workerTranscriptReference(terminal);
		const report: ContinuousChatWorkReportEntry = {
			version: 1,
			name,
			claimId,
			text: claim
				? workerReportClaimText(claim)
				: `Terminal status ${terminal.status}${reason}.${detail ? ` Diagnostic: ${detail}` : ""}`,
			timestamp: Date.now(),
			...(transcriptReference ? { transcriptReference } : {}),
		};
		this.deps.getSessionManager().appendCustomEntry(CONTINUOUS_CHAT_WORK_REPORT_CUSTOM_TYPE, report);
		try {
			const context = this.botBindings.generationContext(name);
			const alias = context.agentId;
			if (!context.teamId && !this.botBindings.alias(name)) return;
			this.getBotTeamStore().recordBotTurnOutcome({
				agentId: alias,
				...(context.teamId ? { teamId: context.teamId, teamIncarnationId: context.teamIncarnationId } : {}),
				summary: report.text,
				transcriptRef: transcriptReference,
				timestamp: report.timestamp,
			});
		} catch {
			// Outcome recording is advisory; must not fail terminal report persistence
		}
	}
}
