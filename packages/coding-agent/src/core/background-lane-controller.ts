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

import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import type { Api, Model } from "@caupulican/pi-ai";
import { resolveModelThinkingLevel } from "@caupulican/pi-ai/models";
import { harnessLog } from "../kernel/harness-log.ts";
import type { AgentMessage } from "../kernel/types.ts";
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
	awayChannelsKey,
	readAwayChannelCharges,
	readAwayChannelStatus,
} from "./channels/away-channels.ts";
import { DEFAULT_OWNER_QUOTA_MAX_USED_PERCENT } from "./channels/channel-policy.ts";
import { createChannelReplyToolDefinition } from "./channels/channel-reply-tool.ts";
import { SessionChannels } from "./channels/session-channels.ts";
import { deliverSpawnedUsageReceipt } from "./cost/spawned-usage-receipt.ts";
import { BotChatTranscript } from "./delegation/bot-chat-transcript.ts";
import {
	type BotCreationRequest,
	botToolListEntry,
	type CreatedBotView,
	MAX_BOTS_PER_LEADER,
} from "./delegation/bot-creation.ts";
import { type BotDaemonLaunchResult, launchDetachedBotDaemon } from "./delegation/bot-daemon-launch.ts";
import { type BotDaemonStopResult, stopDetachedBotDaemon } from "./delegation/bot-daemon-stop.ts";
import { BotLifecycleController } from "./delegation/bot-lifecycle-controller.ts";
import type { BotMessageDirectory } from "./delegation/bot-message-contract.ts";
import { displayNameFor } from "./delegation/bot-naming.ts";
import { BotOperatorDispatch } from "./delegation/bot-operator-dispatch.ts";
import type { BotOperatorMessageOptions } from "./delegation/bot-operator-message-options.ts";
import { BotRuntimeBindings } from "./delegation/bot-runtime-bindings.ts";
import { DAEMON_STALE_MS, isOlderDaemonBuild, OWN_DAEMON_BUILD } from "./delegation/bot-team-routine-helpers.ts";
import { subscribeBotTeamUpdates } from "./delegation/bot-team-updates.ts";
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
	type BotOperatorMessageDispatchResult,
	type BotTeamChange,
	type PersistentBotDaemonStatus,
	type PersistentBotRecord,
	PersistentBotTeamStore,
	type PersistentBotView,
	type PersistentTeamRecord,
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
import { readWorkerClaimSnapshotForAttempt } from "./delegation/session-worker-claim.ts";
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
import { WorkerAttemptWaits } from "./delegation/worker-attempt-waits.ts";
import { stepDownThinkingLevel } from "./delegation/worker-authority-resolver.ts";
import { WorkerConversationStore } from "./delegation/worker-conversation-store.ts";
import { WorkerDelegationController } from "./delegation/worker-delegation-controller.ts";
import type { WorkerDelegationRequest } from "./delegation/worker-delegation-request.ts";
import { deriveFanoutGroups, type FanoutGroupReport } from "./delegation/worker-fanout.ts";
import { WorkerLaneIsolation } from "./delegation/worker-lane-isolation.ts";
import { isManagedWorkerAttempt } from "./delegation/worker-lane-projection.ts";
import type { ManagedLaneBinding, WorkerLifecycle } from "./delegation/worker-lifecycle.ts";
import { contractGrantsChildren } from "./delegation/worker-nested-start.ts";
import { WorkerNotificationCoordinator } from "./delegation/worker-notification-coordinator.ts";
import { WorkerReceiptDelivery } from "./delegation/worker-receipt-delivery.ts";
import { captureWorkerReceiptOrigin } from "./delegation/worker-receipt-origin.ts";
import { WorkerTerminalReport } from "./delegation/worker-terminal-report.ts";
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
import { ownerSteerWake } from "./pending-input-queue-controller.ts";
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
	createSessionAllowanceReader,
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
import type { RoutineIntakeStatus } from "./routines/routine-intake.ts";
import { type RoutineRuntime, RoutineRuntimeAssembly } from "./routines/routine-runtime-assembly.ts";
import { routineGithubInterests, routineHostEventFeed } from "./routines/routine-scheduler-controller.ts";
import { parseRoutineToolInput, type RoutineToolView } from "./routines/routine-tool.ts";
import { getSessionRole } from "./session-role.ts";
import { joinShutdownOperations } from "./session-shutdown.ts";
import { getActiveSessionBranchEntries } from "./session-snapshot.ts";
import { createBotToolDefinition } from "./tools/bot.ts";
import { createPlanToolDefinition } from "./tools/plan.ts";
import { isMissingFileError } from "./util/atomic-file.ts";
import { alarmAt, type WallAlarm } from "./util/timer-port.ts";
import type { WaitStatusEvent } from "./util/wait.ts";
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
	private _routines: RoutineRuntime | undefined;
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
	/** Lazily materialized so a UAC surface without `delegate` allocates no worker runtime state. */
	private _workers: WorkerDelegationController | undefined;
	/** One durable lifecycle shared by every worker execution adapter. */
	private _workerLifecycle: WorkerLifecycle | undefined;
	/** The lifecycle's durable event store: every attempt transition commits through it. */
	private _orchestrationStore: OrchestrationEventStore | undefined;
	/** The store and lifecycle as the session opens them, before (or without) the worker composition. */
	private _orchestrationCore: SessionOrchestrationCore | undefined;
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
	/** The delegated owners of the bot chat, the operator dispatch, the bot lifecycle, the attempt waits and the routine runtime. */
	private readonly _botChat: BotChatTranscript;
	private readonly _botDispatch: BotOperatorDispatch;
	private readonly _botLifecycle: BotLifecycleController;
	private readonly _attemptWaits: WorkerAttemptWaits;
	private readonly _routineAssembly: RoutineRuntimeAssembly;
	private readonly _terminalReports: WorkerTerminalReport;

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
		this.botBindings = new BotRuntimeBindings(
			() => deps.getSessionManager(),
			() => this.getBotTeamStore(),
		);
		this._botChat = new BotChatTranscript(this.botBindings, {
			getBotTeamStore: () => this.getBotTeamStore(),
			getRemoteHub: () => this.getRemoteHub(),
			openWorkerTranscript: (agentId) => this.openWorkerTranscript(agentId),
			getLaneRecords: () => this.getLaneRecords(),
		});
		this._botDispatch = new BotOperatorDispatch(deps, this.botBindings, {
			getBotTeamStore: () => this.getBotTeamStore(),
			getRemoteHub: () => this.getRemoteHub(),
			invalidateBotViews: () => {
				this._botViews = undefined;
			},
			listWorkerAgents: () => this.listWorkerAgents(),
			resolveModelSpec: (rawModel) => this.resolveModelSpec(rawModel),
			getLaneRecords: () => this.getLaneRecords(),
			sendSessionRootWorkerAgentMessage: (agentId, message, options) =>
				this.sendSessionRootWorkerAgentMessage(agentId, message, options),
			followUpSessionRootWorkerAgent: (agentId, message, options) =>
				this.followUpSessionRootWorkerAgent(agentId, message, options),
			noteOwnerDirectAttempt: (attemptId) =>
				this._getWorkerNotificationCoordinator().noteOwnerDirectAttempt(attemptId),
			startWorkerDelegation: (request, signal) => this.startWorkerDelegation(request, signal),
			leaderDelegationLimits: () => this.leaderDelegationLimits(),
			getWorkerAttemptResult: (attemptId) => this.getWorkerAttemptResult(attemptId),
			cancelWorkerAgent: (agentId, reasonCode, scope) => this.cancelWorkerAgent(agentId, reasonCode, scope),
		});
		this._botLifecycle = new BotLifecycleController(deps, this.botBindings, {
			getBotTeamStore: () => this.getBotTeamStore(),
			invalidateBotViews: () => {
				this._botViews = undefined;
			},
			hasWorkerState: () => this._hasWorkerState(),
			listWorkerAgents: () => this.listWorkerAgents(),
			interruptWorkerAgent: (agentId, scope, options) => this.interruptWorkerAgent(agentId, scope, options),
			retireWorkerAgent: (agentId, scope, options) => this.retireWorkerAgent(agentId, scope, options),
			assertBotDispatchIdle: (agentId) => this.assertBotDispatchIdle(agentId),
			resolveModelSpec: (rawModel) => this.resolveModelSpec(rawModel),
			getLeaders: () => this.getLeaders(),
			leaderDelegations: () => this.leaderDelegations(),
			workerLifecycle: () => this._getWorkerLifecycle(),
			workerController: () => this._getWorkerController(),
		});
		this._attemptWaits = new WorkerAttemptWaits(deps, {
			workerController: () => this._getWorkerController(),
			loadedWorkerLifecycle: () => this._workerLifecycle,
			loadedOrchestrationStore: () => this._orchestrationStore,
			observeWorkerAttemptTerminals: (attemptIds) => this.observeWorkerAttemptTerminals(attemptIds),
			observeWorkerTerminalRecords: (records) => this.observeWorkerTerminalRecords(records),
			warn: (message) => this._safeWarn(message),
		});
		this._routineAssembly = new RoutineRuntimeAssembly(deps, {
			workerController: () => this._getWorkerController(),
			workerLifecycle: () => this._getWorkerLifecycle(),
			parentWriteHolds: () => this._parentWriteHolds,
			landRecordedParentWrites: (lifecycle) => this._landRecordedParentWrites(lifecycle),
			hostEventFeed: () => this._hostEventFeed(),
			subscribeStateChanges: (listener) => this.subscribeStateChanges(listener),
			subscribeOrchestrationStore: (listener) => this.subscribeOrchestrationStore(listener),
			sendOperatorMessageToBot: (agentId, message) => this.sendOperatorMessageToBot(agentId, message),
			sendOperatorMessageToTeam: (teamId, message) => this.sendOperatorMessageToTeam(teamId, message),
			resolveLaneModel: (configuredPattern) => this.resolveLaneModel(configuredPattern),
			warn: (message) => this._safeWarn(message),
		});
		this._terminalReports = new WorkerTerminalReport(deps, this.botBindings, {
			getBotTeamStore: () => this.getBotTeamStore(),
			workerTranscriptReference: (record) => this.workerTranscriptReference(record),
		});
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

	private _getAllowance(): SubscriptionAllowanceReader {
		if (!this._allowance) this._allowance = createSessionAllowanceReader(this.deps);
		return this._allowance;
	}

	/** Claims a durable terminal for a structured owner (plan executor, leader controller); see `terminal-routing.ts`. */
	registerTerminalRoute(owner: TerminalRouteOwner, route: TerminalRoute): () => void {
		return this._terminalRouting.register(owner, route);
	}

	/** The worker agent control of a surface that may delegate; any other surface has none to reach. */
	private _agentControl() {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		return this._getWorkerController().getAgentControl();
	}

	private _getWorkerController(): WorkerDelegationController {
		if (this._workers) return this._workers;
		this._workers = new WorkerDelegationController(
			{
				...this.deps,
				...this._getTranscriptWrites(),
				createBotMessageDirectory: (sender, attempt) => this.createBotMessageDirectory(sender, attempt),
				// The worker's model decides the account the fleet's allowance term reads, not the foreground's.
				fleetAllowance: subscriptionAllowancePort(() => this._getAllowance()),
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
		if (snapshot) this._attemptWaits.observeExactAttemptTerminals(snapshot, [...new Set(attemptIds)]);
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
		const nowMs = this.deps.getTimers().port("routines").now();
		return routineGithubInterests(this.getBotTeamStore().listRoutines(), this.deps.getSessionId(), nowMs);
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

	private _getHostEventControl(): HostEventControlPort {
		const control = this._agentControl();
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
				const nowMs = this.deps.getTimers().port("proactivity").now();
				const day = await this.deps.aggregateUsageWindow(rollingDayWindow(nowMs));
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
		this._runTeardownStep("settle running-attempt waits", () => this._attemptWaits.settleAll());
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
		let routineShutdown = Promise.resolve();
		this._runTeardownStep("stop routine runtime", () => {
			routineShutdown = this._routines?.stop() ?? Promise.resolve();
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
		return joinShutdownOperations([workerShutdown, routineShutdown, actAheadShutdown, awayServiceShutdown], () =>
			this._workerLifecycle?.closeSession(),
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
		return this._agentControl().listWorkerAgents(scope);
	}

	getWorkerTaskSessionView(): ReturnType<WorkerAgentControlPort["getWorkerTaskSessionView"]> {
		return this._agentControl().getWorkerTaskSessionView();
	}

	getWorkerAgentActivity(agentId: string, scope?: WorkerAgentControlScope): WorkerAgentActivity {
		return this._agentControl().getWorkerAgentActivity(agentId, scope);
	}

	readWorkerAgentTranscript(
		agentId: string,
		options?: WorkerAgentTranscriptOptions,
	): ReturnType<WorkerAgentControlPort["readWorkerAgentTranscript"]> {
		return this._agentControl().readWorkerAgentTranscript(agentId, options);
	}

	sendWorkerAgentMessage(
		agentId: string,
		message: string,
		options?: WorkerAgentMessageOptions,
	): { messageId: string; queued: true } {
		return this._agentControl().sendWorkerAgentMessage(agentId, message, options);
	}

	followUpWorkerAgent(
		agentId: string,
		message: string,
		options?: WorkerAgentMessageOptions,
	): { started: boolean; steering: boolean; messageId: string; record?: LaneRecord; skipReason?: string } {
		return this._agentControl().followUpWorkerAgent(agentId, message, options);
	}

	sendSessionRootWorkerAgentMessage(
		agentId: string,
		message: string,
		options?: SessionRootWorkerAgentMessageOptions,
	): { messageId: string; queued: true } {
		return this._agentControl().sendSessionRootWorkerAgentMessage(agentId, message, options);
	}

	followUpSessionRootWorkerAgent(
		agentId: string,
		message: string,
		options?: SessionRootWorkerAgentMessageOptions,
	): { started: boolean; steering: boolean; messageId: string; record?: LaneRecord; skipReason?: string } {
		return this._agentControl().followUpSessionRootWorkerAgent(agentId, message, options);
	}

	replyToWorkerAgentMessage(sourceAgentId: string, message: string, replyToMessageId: string): WorkerAgentReplyResult {
		return this._agentControl().replyToWorkerAgentMessage(sourceAgentId, message, replyToMessageId);
	}

	listSessionRootReplies(query?: SessionRootReplyQuery): SessionRootReply[] {
		return this._agentControl().listSessionRootReplies(query);
	}

	waitForSessionRootReplies(options?: SessionRootReplyWaitOptions): Promise<SessionRootReplyWaitResult> {
		const control = this._agentControl();
		// An owner steer ends the wait so the root reads it at once instead of after the bound.
		const report = (event: WaitStatusEvent) => this.deps.emit(event);
		const wake = ownerSteerWake(this.deps.getSessionManager().getSessionId(), report);
		const steer = { mode: "end", wake } as const;
		return control.waitForSessionRootReplies({ ...options, steer, report });
	}

	acknowledgeSessionRootReply(messageId: string, ackToken: string): boolean {
		return this._agentControl().acknowledgeSessionRootReply(messageId, ackToken);
	}

	reconcileSessionRootReplies(): void {
		this._agentControl().reconcileSessionRootReplies();
	}

	startWorkerAgentTask(
		agentId: string,
		message: string,
		options?: WorkerAgentTaskStartOptions,
	): ReturnType<WorkerAgentControlPort["startWorkerAgentTask"]> {
		return this._agentControl().startWorkerAgentTask(agentId, message, options);
	}

	interruptWorkerAgent(
		agentId: string,
		scope?: WorkerAgentControlScope,
		options?: { message?: string; force?: boolean },
	): ReturnType<WorkerAgentControlPort["interruptWorkerAgent"]> {
		return this._agentControl().interruptWorkerAgent(agentId, scope, options);
	}

	resumeWorkerAgent(
		agentId: string,
		scope?: WorkerAgentControlScope,
	): { started: boolean; record?: LaneRecord; skipReason?: string; waitReason?: string } {
		return this._agentControl().resumeWorkerAgent(agentId, scope);
	}

	cancelWorkerAgent(agentId: string, reasonCode?: string, scope?: WorkerAgentControlScope): LaneRecord | undefined {
		return this._agentControl().cancelWorkerAgent(agentId, reasonCode, scope);
	}

	retireWorkerAgent(
		agentId: string,
		scope?: WorkerAgentControlScope,
		options?: WorkerAgentRetireOptions,
	): WorkerAgentRetireResult {
		const control = this._agentControl();
		const retired = options
			? control.retireWorkerAgent(agentId, scope, options)
			: control.retireWorkerAgent(agentId, scope);
		// The retirement is the event that frees the worker's worktree lane, when it had one.
		if (!retired.replayed) this._getWorkerController().releaseRetiredAgentLane(agentId);
		return retired;
	}

	resolveWorkerAgentLane(agentId: string, scope?: WorkerAgentControlScope): WorkerAgentLaneResolution | undefined {
		return this._agentControl().resolveWorkerAgentLane?.(agentId, scope);
	}

	readWorkerAgentLastText(agentId: string, laneId: string, scope?: WorkerAgentControlScope): string | undefined {
		return this._agentControl().readWorkerAgentLastText?.(agentId, laneId, scope);
	}

	async waitForWorkerAgent(
		agentId: string,
		timeoutMs?: number,
		scope?: WorkerAgentControlScope,
		signal?: AbortSignal,
	): ReturnType<WorkerAgentControlPort["waitForWorkerAgent"]> {
		return this._attemptWaits.withWorkerWait(scope, signal, (control, waitSignal) =>
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
		return this._attemptWaits.withWorkerWait(scope, signal, (control, waitSignal) =>
			control.waitForWorkerAgents(agentIds, mode, timeoutMs, scope, waitSignal),
		);
	}

	waitForRunningAttempts(
		attemptIds: readonly string[],
		options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
	): Promise<RunningAttemptWaitOutcome> {
		return this._attemptWaits.waitForRunningAttempts(attemptIds, options);
	}

	broadcastWorkerAgentMessage(
		agentIds: readonly string[],
		message: string,
		options: WorkerAgentBroadcastOptions,
	): WorkerAgentBroadcastResult {
		return this._agentControl().broadcastWorkerAgentMessage(agentIds, message, options);
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

	private _ensureRoutineScheduler(): void {
		if (this._routines || !this._botTeamStore || this.deps.isDisposed() || this.deps.canRunRoutines?.() === false)
			return;
		const routines = this._routineAssembly.assemble(this._botTeamStore);
		this._routines = routines;
		if (this.routinesStarted) {
			routines.scheduler.start();
			routines.intake.start();
			routines.watches.start();
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
			aggregateDay: () =>
				this.deps.aggregateUsageWindow(rollingDayWindow(this.deps.getTimers().port("proactivity").now())),
			evidence: () => this._ciFailureEvidence,
			observeNotice: (kind, read) => this.deps.observeHarnessNotice?.(kind, read) ?? false,
			warn: (message) => this._safeWarn(message),
			now: () => this.deps.getTimers().port("proactivity").now(),
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
		const nowMs = this.deps.getTimers().port("routines").now();
		const getEdgeGrants = this.deps.getEdgeGrants;
		return readSessionAutonomyStatus({
			nowMs,
			sessionId: this.deps.getSessionId(),
			childSession: this.deps.isChildSession(),
			sessionManager: this.deps.getSessionManager(),
			settings: this.deps.getSettingsManager(),
			usageWindow: () =>
				this.deps.aggregateUsageWindow(rollingDayWindow(this.deps.getTimers().port("proactivity").now())),
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
	 * Stops the detached daemon and reports what the stop did: the lease it renews is released, and earlier-generation
	 * daemons are retired as on start, signalling only an identity proven on this host (see `bot-daemon-stop.ts`).
	 */
	stopPersistentBotDaemon(): BotDaemonStopResult {
		return stopDetachedBotDaemon(this.getBotTeamStore(), this.deps.getTimers().port("routines"));
	}

	private createBotMessageDirectory(sender: string, attemptId: string): BotMessageDirectory {
		return this._botLifecycle.createBotMessageDirectory(sender, attemptId);
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

	/** The bot a worker runtime belongs to, as the store names it; undefined for a delegate worker, a managed lane or a group thread. */
	botOfRuntime(runtime: string): { agentId: string; displayName?: string } | undefined {
		return this.botBindings.botOf(runtime);
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
		return subscribeBotTeamUpdates(
			{
				store: (notify) => this.getBotTeamStore().subscribe(notify),
				lanes: (notify) => this.subscribeLaneRecords(notify),
				remote: (notify) => this.getRemoteHub().subscribe(notify),
				alias: (agentId) => this.botBindings.alias(agentId),
			},
			listener,
		);
	}

	listPersistentTeams(): PersistentTeamRecord[] {
		return this.getBotTeamStore().listTeams();
	}

	getPersistentTeam(teamId: string): PersistentTeamRecord | undefined {
		return this.getBotTeamStore().getTeam(teamId);
	}

	upsertPersistentBot(rawInput: UpsertPersistentBotInput): PersistentBotRecord {
		return this._botLifecycle.upsertPersistentBot(rawInput);
	}

	createBotFor(
		creator: { readonly kind: "root" } | { readonly kind: "leader"; readonly agentId: string },
		request: BotCreationRequest,
		options?: { readonly goalLeader?: boolean },
	): CreatedBotView {
		return this._botLifecycle.createBotFor(creator, request, options);
	}

	private _remoteHub: RemoteHubController | undefined;

	/** This session's hub: the machines joined to it, shown as bots with a remote mark. */
	getRemoteHub(): RemoteHubController {
		if (!this._remoteHub) {
			this._remoteHub = new RemoteHubController({
				agentDir: this.deps.getAgentDir(),
				getStore: () => this.getBotTeamStore(),
				timers: this.deps.getTimers().port("orchestration"),
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
			this._remoteHub.subscribe(() => {
				this._botViews = undefined;
			});
		}
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
			list: () => this.getBotTeamStore().listBots({ includeRetired: true }).map(botToolListEntry),
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
			retireWorker: (agentId) => void this.retireWorkerAgent(agentId),
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
		const reader = this._getAllowance();
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
			directBotOf: (runtime) => this.botOfRuntime(runtime)?.agentId,
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
		return this._botLifecycle.retirePersistentBot(agentId);
	}

	stopPersistentBot(agentId: string): { stopped: boolean; detail: string } {
		return this._botLifecycle.stopPersistentBot(agentId);
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

	readBotChatMessages(agentId: string, teamId?: string): AgentMessage[] {
		return this._botChat.readBotChatMessages(agentId, teamId);
	}

	readTeamChatMessages(teamId: string): AgentMessage[] {
		return this._botChat.readTeamChatMessages(teamId);
	}

	subscribeOrchestrationStore(listener: () => void): () => void {
		if (this._orchestrationStore) {
			return this._orchestrationStore.subscribe(listener);
		}
		return this.subscribeLaneRecords(() => listener());
	}

	sendOperatorMessageToBot(
		agentId: string,
		message: string,
		options?: BotOperatorMessageOptions & { teamId?: string; teamIncarnationId?: string },
	): Promise<BotOperatorMessageDispatchResult> {
		return this._botDispatch.sendOperatorMessageToBot(agentId, message, options);
	}

	private assertBotDispatchIdle(agentId: string): void {
		this._botDispatch.assertBotDispatchIdle(agentId);
	}

	sendOperatorMessageToTeam(teamIdRaw: string, message: string): Promise<TeamOperatorMessageDispatchResult> {
		return this._botDispatch.sendOperatorMessageToTeam(teamIdRaw, message);
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
		this._terminalReports.persist(name, terminal);
	}
}
