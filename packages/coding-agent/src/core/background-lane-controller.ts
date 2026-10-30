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

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import type { Api, AssistantMessage, Model } from "@caupulican/pi-ai";
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
import { deliverSpawnedUsageReceipt } from "./cost/spawned-usage-receipt.ts";
import type { BotMessageDirectory } from "./delegation/bot-message-contract.ts";
import { BotRuntimeBindings, type BotRuntimeContext } from "./delegation/bot-runtime-bindings.ts";
import { ManagedLaneController, type ManagedLaneControllerDeps } from "./delegation/managed-lane-controller.ts";
import {
	BOT_MEMORY_BLOCK_SEPARATOR,
	type BotOperatorMessageDispatchResult,
	type BotTeamChange,
	botReplyText,
	normalizeBotOrTeamId,
	operatorTextOf,
	type PersistentBotDaemonStatus,
	type PersistentBotRecord,
	PersistentBotTeamStore,
	type PersistentBotView,
	type PersistentTeamMemberDelivery,
	type PersistentTeamMessage,
	type PersistentTeamRecord,
	type TeamOperatorMessageDispatchResult,
	teamIncarnation,
	type UpsertPersistentBotInput,
	type UpsertPersistentTeamInput,
} from "./delegation/persistent-bot-team-store.ts";
import type {
	SessionRootReply,
	SessionRootReplyQuery,
	SessionRootReplyWaitOptions,
	SessionRootReplyWaitResult,
} from "./delegation/session-root-mailbox.ts";
import { sessionRootAddress } from "./delegation/session-root-mailbox.ts";
import { getWorkerClaimSnapshots } from "./delegation/session-worker-claim.ts";
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
import { WorkerConversationStore } from "./delegation/worker-conversation-store.ts";
import {
	WorkerDelegationController,
	type WorkerDelegationControllerDeps,
} from "./delegation/worker-delegation-controller.ts";
import type { WorkerDelegationRequest } from "./delegation/worker-delegation-request.ts";
import { deriveFanoutGroups, type FanoutGroupReport } from "./delegation/worker-fanout.ts";
import { WorkerLaneIsolation } from "./delegation/worker-lane-isolation.ts";
import { isManagedWorkerAttempt, projectWorkerAttemptLaneRecord } from "./delegation/worker-lane-projection.ts";
import { WorkerLifecycle } from "./delegation/worker-lifecycle.ts";
import { WorkerNotificationCoordinator } from "./delegation/worker-notification-coordinator.ts";
import { WorkerReceiptDelivery } from "./delegation/worker-receipt-delivery.ts";
import { workerReportClaimText } from "./delegation/worker-report.ts";
import { WorkerUsageReceiptDelivery } from "./delegation/worker-usage-receipt-delivery.ts";
import type { ManagedLaneEvent } from "./extensions/managed-lane-records.ts";
import { GoalAutoContinueController } from "./goals/goal-auto-continue-controller.ts";
import type { GoalRuntimeSnapshot, GoalRuntimeSnapshotSettings } from "./goals/goal-runtime-snapshot.ts";
import type { GoalState } from "./goals/goal-state.ts";
import {
	CONTINUOUS_CHAT_WORK_REPORT_CUSTOM_TYPE,
	type ContinuousChatWorkReportEntry,
} from "./memory/continuous-chat-ingest.ts";
import type { ModelCapabilityProfile } from "./model-capability.ts";
import { resolveCliModel } from "./model-resolver.ts";
import type { StoredFitnessReport } from "./models/fitness-store.ts";
import { IndependentObserverSet } from "./observer-dispatch.ts";
import type { OrchestrationThinkingLevel, WorkerResultContract } from "./orchestration/contracts.ts";
import { OrchestrationEventStore } from "./orchestration/event-store.ts";
import type {
	TaskProfileCreateInput,
	TaskProfileCreateResult,
	TaskProfileInspection,
} from "./orchestration/task-profile-writer.ts";
import type { TaskRuntimeProjection } from "./orchestration/task-runtime.ts";
import { createSteerAwareWait, ownerSteerWake } from "./pending-input-queue-controller.ts";
import { LaneModelResolver, type LaneModelResolverDeps } from "./research/lane-model-resolver.ts";
import type { ModelFitnessReport } from "./research/model-fitness.ts";
import { ModelFitnessController, type ModelFitnessControllerDeps } from "./research/model-fitness-controller.ts";
import { ResearchLaneController, type ResearchLaneControllerDeps } from "./research/research-lane-controller.ts";
import { boundedRedactedDiagnosticText } from "./security/secret-text.ts";
import { getActiveSessionBranchEntries } from "./session-snapshot.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { isMissingFileError } from "./util/atomic-file.ts";
import { type SteerDecision, type WaitStatusEvent, type WakeSource, waitFor } from "./util/wait.ts";
import type { WorktreeSyncEngineDeps } from "./worktree-sync/git-engine.ts";
import { WorktreeLaneLifecycle } from "./worktree-sync/lane-lifecycle.ts";
import { buildWorktreeSyncEngineDeps, type WorktreeSyncEnginePorts } from "./worktree-sync/runtime.ts";

export { clampLaneMaxUsd } from "./research/lane-model-resolver.ts";

export interface BackgroundLaneControllerDeps
	extends WorkerDelegationControllerDeps,
		ResearchLaneControllerDeps,
		ModelFitnessControllerDeps,
		LaneModelResolverDeps,
		Pick<ManagedLaneControllerDeps, "recordUnsettledForOwner"> {
	/** The full settings manager: this coordinator hands it to every lane, each of which reads only its own port. */
	getSettingsManager(): SettingsManager;
	/** Host-supplied worktree-sync engine ports, forwarded into every engine-deps build. */
	getWorktreeSyncEnginePorts(): WorktreeSyncEnginePorts | undefined;
	/** True iff the active surface can terminalize a goal through `goal` or `update_goal`.
	 * Explicit tool/profile exclusion and the worker-role ceiling still disable continuation. */
	isGoalToolActive(): boolean;
	/** Capability profile of the SESSION model (gates background lanes, scales continuation budgets). */
	getModelCapabilityProfile(): ModelCapabilityProfile;
	/** Continuation gate + goal state for the idle autosteer scheduler. */
	getGoalRuntimeSnapshot(settings: GoalRuntimeSnapshotSettings): GoalRuntimeSnapshot;
	/** Drive-loop boundary: the session's bounded goal-continuation loop (owns `prompt()`, not us). */
	continueGoalLoop(options: GoalContinuationLoopOptions): Promise<GoalContinuationLoopResult>;
	/** True while the session owns a foreground prompt/retry/follow-up run. */
	isForegroundBusy(): boolean;
	/** Resolve only after the complete foreground retry/follow-up run releases the session. */
	waitForForegroundIdle(): Promise<void>;
	/** Persist an explicit stopped state when the selected surface cannot drive the active goal. */
	markGoalToolUnavailable(): void;
	/** Tell the parent session that a closed worker's worktree lane was kept because it holds work. */
	notifyWorktreeLane?(text: string): void;
	/** Thinking level of the active session model. */
	getThinkingLevel?(): OrchestrationThinkingLevel;
}

/** How one bounded wait on exact running attempts ended. */
export type RunningAttemptWaitOutcome =
	/** These captured attempts left "running"; the terminal ones were observed. */
	| { readonly kind: "changed"; readonly attemptIds: readonly string[] }
	/** The bound elapsed with every captured attempt still running; nothing was observed. */
	| { readonly kind: "timed_out" }
	/** The session was disposed first; nothing about the attempts is implied or observed. */
	| { readonly kind: "disposed" };

export class BackgroundLaneController implements WorkerAgentControlPort {
	/** Live lane registry — the real source for AutonomyStatusSnapshot.activeLaneCount. */
	private readonly _laneTracker = new LaneTracker({ onChange: () => this._laneRecordsChanged() });
	private readonly _laneRecordListeners = new Set<(records: readonly LaneRecord[]) => void>();
	private _laneRecordsNotifyQueued = false;
	/** The projected bot roster, dropped by every input change. */
	private _botViews:
		| { defaultModelRef: string; delegateActive: boolean; bindings: object; views: PersistentBotView[] }
		| undefined;
	private _unsubscribeLaneRecordStore: (() => void) | undefined;
	private readonly _laneModels: LaneModelResolver;
	private readonly _goalAutoContinue: GoalAutoContinueController;
	private readonly _research: ResearchLaneController;
	private readonly _fitness: ModelFitnessController;
	/** Lazily materialized only when managed-lane state is queried or reported. */
	private _managedLanes: ManagedLaneController | undefined;
	/** Leaf already scanned with no persisted active managed lane. A new leaf rescans. */
	private _managedLaneAbsenceLeafId: string | null | undefined;
	private _botTeamStore: PersistentBotTeamStore | undefined;
	private _routineSchedulerTimer: ReturnType<typeof setInterval> | undefined;
	private _routineTickInFlight = false;
	private readonly botBindings: BotRuntimeBindings;
	/** Includes queued callers: configuration cannot pass a start that has not published its runtime yet. */
	private readonly botDispatches = new Map<string, Promise<void>>();
	/** Lazily materialized so a UAC surface without `delegate` allocates no worker runtime state. */
	private _workers: WorkerDelegationController | undefined;
	/** One durable lifecycle shared by every worker execution adapter. */
	private _workerLifecycle: WorkerLifecycle | undefined;
	/** The lifecycle's durable event store: every attempt transition commits through it. */
	private _orchestrationStore: OrchestrationEventStore | undefined;
	/** Settles each unresolved running-attempt wait when the session is disposed. */
	private readonly _runningAttemptWaits = new Set<() => void>();
	/** Durable usage delivery shares the lifecycle's event store, independently of terminal handoffs. */
	private _workerUsage: WorkerUsageReceiptDelivery | undefined;
	private _workerReceipts: WorkerReceiptDelivery | undefined;
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
		this.botBindings = new BotRuntimeBindings(() => deps.getSessionManager());
		this._laneModels = new LaneModelResolver(deps);
		this._research = new ResearchLaneController(
			{ ...deps, onContinuationActivity: () => this._notifyContinuationActivity() },
			this._laneTracker,
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

	private _getWorkerController(): WorkerDelegationController {
		this._workers ??= new WorkerDelegationController(
			{
				...this.deps,
				createBotMessageDirectory: (sender, attempt) => this.createBotMessageDirectory(sender, attempt),
			},
			this._getWorkerNotificationCoordinator(),
			this._getWorkerLifecycle(),
			new WorkerLaneIsolation(this._worktreeLaneHostDeps()),
		);
		return this._workers;
	}

	/** What the worktree lane lifecycles need from this session: engine deps, a way to tell the parent, a warning sink. */
	private _worktreeLaneHostDeps() {
		return {
			engineDeps: (cwd?: string) => this._worktreeEngineDeps(cwd),
			notifyParent: (text: string) => this.deps.notifyWorktreeLane?.(text),
			warn: (message: string) => this._safeWarn(message),
		};
	}

	/** Worktree-sync engine deps rooted at `cwd` (the session's directory when omitted); undefined when disabled. */
	private _worktreeEngineDeps(cwd?: string): WorktreeSyncEngineDeps | undefined {
		const settingsManager = this.deps.getSettingsManager();
		if (!settingsManager.getWorktreeSyncSettings().enabled) return undefined;
		return buildWorktreeSyncEngineDeps({
			cwd: cwd ?? this.deps.getCwd(),
			agentDir: this.deps.getAgentDir(),
			settingsManager,
			sessionId: this.deps.getSessionId(),
			integrationBranch: () => this.deps.localCommitBranch?.() || undefined,
			ports: this.deps.getWorktreeSyncEnginePorts(),
		});
	}

	private _getWorkerLifecycle(): WorkerLifecycle {
		if (this._workerLifecycle) return this._workerLifecycle;
		const parentSessionId = this.deps.getSessionId();
		// The retry ladder persists its deadline on the orchestration clock; the runtime rechecks it on the same clock, and the
		// store stamps every event on it too, because the reducer compares a start's event time with that deadline.
		const timers = this.deps.getTimers();
		const orchestrationClock = timers.port("orchestration");
		const store = new OrchestrationEventStore({
			agentDir: this.deps.getAgentDir(),
			sessionId: parentSessionId,
			now: () => new Date(orchestrationClock.now()).toISOString(),
			sleepSync: (delayMs) => timers.sleepSync(delayMs),
		});
		const lifecycle = new WorkerLifecycle({
			agentDir: this.deps.getAgentDir(),
			sessionId: parentSessionId,
			store,
			now: () => orchestrationClock.now(),
		});
		this._workerLifecycle = lifecycle;
		this._orchestrationStore = store;
		this._unsubscribeLaneRecordStore = store.subscribe(() => this._laneRecordsChanged());
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
		for (const notification of lifecycle.getPendingTerminalNotifications()) {
			this._getWorkerNotificationCoordinator().recordTerminal(notification.record, notification.notificationId);
		}
		return lifecycle;
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
			new WorktreeLaneLifecycle(this._worktreeLaneHostDeps()),
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
			(record) => record.type === "tmux-worker" && (record.status === "queued" || record.status === "running"),
		);
		if (hasPersistedActiveManagedLane) {
			this._getManagedLaneController().ensureHydrated();
			return;
		}
		if (leafId !== undefined) this._managedLaneAbsenceLeafId = leafId;
	}

	subscribeLaneRecords(listener: (records: readonly LaneRecord[]) => void): () => void {
		this._laneRecordListeners.add(listener);
		return () => {
			this._laneRecordListeners.delete(listener);
		};
	}

	private _cachedLaneRecords?: LaneRecord[];

	private _laneRecordsChanged(): void {
		this._botViews = undefined;
		this._cachedLaneRecords = undefined;
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
		this._runTeardownStep("abort model-fitness lanes", () => this._fitness.abort());
		for (const record of this._laneTracker.getRecords()) {
			if (record.status !== "queued" && record.status !== "running") continue;
			if (record.type === "tmux-worker") continue;
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
		this._runTeardownStep("stop bot routine scheduler", () => {
			if (this._routineSchedulerTimer) {
				clearInterval(this._routineSchedulerTimer);
				this._routineSchedulerTimer = undefined;
			}
		});
		this._runTeardownStep("dispose bot and team store", () => this._botTeamStore?.dispose());
		const unsubscribeLaneRecordStore = this._unsubscribeLaneRecordStore;
		this._unsubscribeLaneRecordStore = undefined;
		this._runTeardownStep("unsubscribe lane records", () => unsubscribeLaneRecordStore?.());
		return workerShutdown;
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
		}
		this._workerReceipts?.signal();
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
			});
			this._ensureRoutineScheduler();
		}
		return this._botTeamStore;
	}

	private _ensureRoutineScheduler(): void {
		if (this._routineSchedulerTimer || this.deps.isDisposed()) return;
		this._routineSchedulerTimer = setInterval(() => {
			if (this.deps.isDisposed()) {
				if (this._routineSchedulerTimer) {
					clearInterval(this._routineSchedulerTimer);
					this._routineSchedulerTimer = undefined;
				}
				return;
			}
			void this.tickPersistentRoutines();
		}, 15_000);
		this._routineSchedulerTimer.unref?.();
	}

	async tickPersistentRoutines(routineIdFilter?: string): Promise<{ dispatched: string[]; failed: string[] }> {
		if (this._routineTickInFlight || this.deps.isDisposed()) {
			return { dispatched: [], failed: [] };
		}
		this._routineTickInFlight = true;
		const dispatched: string[] = [];
		const failed: string[] = [];
		try {
			const store = this.getBotTeamStore();
			store.reload();
			const due = store.claimDueRoutines(Date.now(), routineIdFilter);
			for (const routine of due) {
				const routinePrompt = `[Scheduled routine ${routine.routineId}]: ${routine.prompt}`;
				try {
					if (routine.target.kind === "bot") {
						const res = await this.sendOperatorMessageToBot(routine.target.agentId, routinePrompt);
						store.completeRoutineRun(
							routine.routineId,
							res.mode === "queued" ? "queued" : "succeeded",
							`Dispatched to bot ${routine.target.agentId} (${res.mode}).`,
						);
					} else {
						const res = await this.sendOperatorMessageToTeam(routine.target.teamId, routinePrompt);
						store.completeRoutineRun(
							routine.routineId,
							"succeeded",
							`Dispatched to team ${routine.target.teamId} (${res.deliveries.length} deliveries).`,
						);
					}
					dispatched.push(routine.routineId);
				} catch (error) {
					const errMsg = error instanceof Error ? error.message : String(error);
					store.completeRoutineRun(routine.routineId, "failed", errMsg);
					failed.push(`${routine.routineId}: ${errMsg}`);
				}
			}
			return { dispatched, failed };
		} finally {
			this._routineTickInFlight = false;
		}
	}

	getPersistentBotDaemonStatus(): PersistentBotDaemonStatus {
		const store = this.getBotTeamStore();
		store.reload();
		return store.getDaemonStatus();
	}

	startPersistentBotDaemon(): { started: boolean; pid?: number; detail: string } {
		const store = this.getBotTeamStore();
		store.reload();
		const current = store.getDaemonStatus();
		if (current.running && current.pid) {
			return {
				started: false,
				pid: current.pid,
				detail: `Detached bot daemon is already running (pid ${current.pid}, ${current.activeRoutines} active routines).`,
			};
		}
		const storeFile = store.getStoreFilePath();
		const daemonScript = [
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			`const storeFile = ${JSON.stringify(storeFile)};`,
			'const leaseFile = path.join(path.dirname(storeFile), "bot-daemon-lease.json");',
			"const startedAt = new Date().toISOString();",
			"function writeHeartbeat(lastTickAt) {",
			"  try {",
			"    fs.mkdirSync(path.dirname(leaseFile), { recursive: true });",
			"    fs.writeFileSync(leaseFile, JSON.stringify({ pid: process.pid, startedAt, lastHeartbeatAt: Date.now(), ...(lastTickAt ? { lastTickAt } : {}) }, null, 2));",
			"  } catch {}",
			"}",
			"function tickStore() {",
			"  const now = Date.now();",
			"  writeHeartbeat(now);",
			"  try {",
			"    if (!fs.existsSync(storeFile)) return;",
			'    const data = JSON.parse(fs.readFileSync(storeFile, "utf8"));',
			"    if (!data || !Array.isArray(data.routines)) return;",
			"    let mutated = false;",
			"    for (const r of data.routines) {",
			"      if (!r || !r.enabled || typeof r.nextRunAt !== 'number' || r.nextRunAt > now) continue;",
			"      r.lastRunAt = now;",
			"      r.nextRunAt = now + Math.max(10000, Number(r.intervalMs) || 60000);",
			"      r.lastStatus = 'queued';",
			"      r.lastSummary = '[Daemon ' + new Date(now).toISOString() + '] Routine queued across TUI session: ' + String(r.prompt || '').slice(0, 160);",
			"      r.updatedAt = new Date(now).toISOString();",
			"      if (r.target && r.target.kind === 'bot' && Array.isArray(data.bots)) {",
			"        const bot = data.bots.find((b) => b && b.agentId === r.target.agentId);",
			"        if (bot) { bot.lastMessageAt = now; bot.lastSummary = r.lastSummary; bot.updatedAt = r.updatedAt; }",
			"      } else if (r.target && r.target.kind === 'team' && data.teamMessages && typeof data.teamMessages === 'object') {",
			"        const tid = r.target.teamId;",
			"        const list = Array.isArray(data.teamMessages[tid]) ? data.teamMessages[tid] : (data.teamMessages[tid] = []);",
			"        list.push({ messageId: 'daemon-' + r.routineId + '-' + now, teamId: tid, sender: { kind: 'brain' }, text: '[Scheduled routine ' + r.routineId + ']: ' + r.prompt, timestamp: now, targetAgentIds: [], deliveries: [] });",
			"        if (Array.isArray(data.teams)) {",
			"          const team = data.teams.find((t) => t && t.teamId === tid);",
			"          if (team) { team.lastMessageAt = now; team.updatedAt = r.updatedAt; }",
			"        }",
			"      }",
			"      mutated = true;",
			"    }",
			"    if (mutated) fs.writeFileSync(storeFile, JSON.stringify(data, null, 2));",
			"  } catch {}",
			"}",
			"tickStore();",
			"const timer = setInterval(tickStore, 10000);",
			'process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });',
		].join("\n");
		const runtimeBin = process.execPath;
		const child = spawn(runtimeBin, ["-e", daemonScript], {
			detached: true,
			stdio: "ignore",
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		});
		child.unref();
		const pid = child.pid;
		if (!pid) {
			return { started: false, detail: "Failed to spawn detached bot daemon process." };
		}
		store.writeDaemonLease({ pid, startedAt: new Date().toISOString(), lastTickAt: Date.now() });
		return {
			started: true,
			pid,
			detail: `Started detached bot daemon (pid ${pid}) watching ${storeFile} across TUI restarts.`,
		};
	}

	stopPersistentBotDaemon(): { stopped: boolean; detail: string } {
		const store = this.getBotTeamStore();
		const status = store.getDaemonStatus();
		if (status.running && status.pid) {
			try {
				process.kill(status.pid, "SIGTERM");
			} catch {
				// Process already exited.
			}
			store.releaseDaemonLease(status.pid);
			return { stopped: true, detail: `Stopped detached bot daemon (pid ${status.pid}).` };
		}
		store.releaseDaemonLease();
		return { stopped: false, detail: "Detached bot daemon is not running." };
	}

	private createBotMessageDirectory(sender: string, attemptId: string): BotMessageDirectory {
		const manager = this.deps.getSessionManager();
		const assertBranch = manager.captureBranchContext();
		const context = this.botBindings.generationContext(sender);
		const sourceAlias = context.agentId;
		const thread = context.teamId ? `team:${context.teamId}:${context.teamIncarnationId}` : undefined;
		const store = this.getBotTeamStore();
		const refresh = () => {
			if (store.reload(true)) this._botViews = undefined;
		};
		refresh();
		const admittedMembers = new Set(context.teamId ? (store.getTeam(context.teamId)?.memberAgentIds ?? []) : []);
		const requireGroup = (teamId?: string) => {
			refresh();
			if (teamId !== undefined && teamId !== context.teamId)
				throw new Error("This bot conversation is not admitted to the requested group.");
			if (!context.teamId) return undefined;
			const team = store.getTeam(context.teamId);
			if (
				!team ||
				teamIncarnation(team) !== context.teamIncarnationId ||
				!team.memberAgentIds.includes(sourceAlias) ||
				!admittedMembers.has(sourceAlias)
			)
				throw new Error("This bot's group membership was removed or replaced.");
			return team;
		};
		const assertCurrent = () => {
			if (this.deps.isDisposed() || this.deps.getSessionManager() !== manager)
				throw new Error("Bot messaging session is no longer current.");
			assertBranch();
			const source = this.listWorkerAgents().find((agent) => agent.agentId === sender);
			if (source?.attemptId !== attemptId || source.dispatch !== "running")
				throw new Error("Bot messaging sender generation is no longer current.");
			if (
				sourceAlias &&
				this.getBotTeamStore().getBot(sourceAlias) &&
				this.botBindings.runtime(sourceAlias, context.teamId, context.teamIncarnationId) !== sender
			)
				throw new Error("Bot messaging sender alias has been rebound.");
			requireGroup();
		};
		return {
			assertCurrent,
			list: (teamId) => {
				assertCurrent();
				const group = requireGroup(teamId);
				const teams = store.listTeams();
				const groups = teams.filter((team) =>
					group ? team.teamId === group.teamId : team.memberAgentIds.includes(sourceAlias),
				);
				const agents = new Map(this.listWorkerAgents().map((agent) => [agent.agentId, agent]));
				const peers = store
					.listBots({ includeRetired: true })
					.filter(
						(bot) =>
							bot.agentId !== sourceAlias &&
							(group
								? group.memberAgentIds.includes(bot.agentId) && admittedMembers.has(bot.agentId)
								: !teams.some((team) => team.memberAgentIds.includes(bot.agentId))),
					)
					.map((bot) => {
						const agent = agents.get(
							this.botBindings.runtime(bot.agentId, context.teamId, context.teamIncarnationId),
						);
						return {
							agentId: bot.agentId,
							displayName: bot.displayName,
							state: bot.retired || agent?.status === "retired" ? "retired" : (agent?.activity ?? "inactive"),
							available: !bot.retired && agent !== undefined && agent.status !== "retired",
						};
					});
				return {
					groups: groups.slice(0, 128).map(({ teamId, name }) => ({ teamId, name })),
					totalGroups: groups.length,
					peers: peers.slice(0, 128),
					total: peers.length,
				};
			},
			resolve: (target, teamId) => {
				assertCurrent();
				const group = requireGroup(teamId);
				const alias = normalizeBotOrTeamId(target, "agentId");
				if (
					group
						? !group.memberAgentIds.includes(alias) || !admittedMembers.has(alias)
						: store
								.listTeams()
								.some(
									(team) => team.memberAgentIds.includes(sourceAlias) || team.memberAgentIds.includes(alias),
								)
				)
					throw new Error("Group messages require a conversation admitted to that group.");
				const bot = store.getBot(alias);
				if (!bot || bot.retired) throw new Error(`Bot ${alias} is missing or retired.`);
				const runtime = this.botBindings.runtime(alias, context.teamId, context.teamIncarnationId);
				if (runtime === sender) throw new Error("A bot cannot message itself.");
				const recipient = this.listWorkerAgents().find((agent) => agent.agentId === runtime);
				if (!recipient || recipient.status === "retired")
					throw new Error(`Bot ${alias} is inactive in this parent session; ask the parent to start it.`);
				return runtime;
			},
			threadId: (teamId) => {
				assertCurrent();
				requireGroup(teamId);
				return thread;
			},
			authorizeReply: (requestThread, requester, teamId) => {
				assertCurrent();
				const group = requireGroup(teamId);
				if (requester === sessionRootAddress(manager.getSessionId())) return;
				if (requestThread !== thread || !requester) throw new Error("Reply belongs to another conversation group.");
				const peer = this.botBindings.generationContext(requester);
				if (
					peer.teamId !== context.teamId ||
					peer.teamIncarnationId !== context.teamIncarnationId ||
					(group
						? !group.memberAgentIds.includes(peer.agentId) || !admittedMembers.has(peer.agentId)
						: store.listTeams().some((team) => team.memberAgentIds.includes(peer.agentId)))
				)
					throw new Error("Reply requester is outside this conversation group.");
			},
			recordSent: (messageId, target, message) => {
				if (!context.teamId || !context.teamIncarnationId) return;
				store.appendScopedTeamMessage(
					{
						messageId,
						teamId: context.teamId,
						sender: { kind: "bot", agentId: sourceAlias },
						text: message,
						timestamp: Date.now(),
						targetAgentIds: [target],
						deliveries: [{ agentId: target, outcome: "queued", messageId }],
					},
					context.teamIncarnationId,
				);
			},
		};
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
		let laneRecords: LaneRecord[];
		if (hasWorkerState) {
			laneRecords = this.getLaneRecords();
		} else {
			this._hydrateManagedLanes();
			laneRecords = this._laneTracker.getRecords();
		}
		const views = this.getBotTeamStore().projectBotViews(
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
		if (!teamId) this._botViews = { defaultModelRef, delegateActive, bindings, views };
		return teamId ? views.filter((view) => team?.memberAgentIds.includes(view.agentId)) : [...views];
	}

	/**
	 * The model a bot or team member runs on. With no reference it runs on the foreground model. A reference resolves
	 * through the registry's resolver, authenticated models first; one the registry cannot resolve is an error, never a
	 * guessed provider.
	 */
	resolveModelSpec(rawModel?: string): { provider: string; modelId: string; thinkingLevel?: string } {
		const fgThinking = this.deps.getThinkingLevel
			? String(this.deps.getThinkingLevel())
			: this.deps.getForegroundThinkingLevel
				? String(this.deps.getForegroundThinkingLevel())
				: undefined;

		const reference = rawModel?.trim();
		if (!reference) {
			const current = this.deps.getModel();
			if (!current) throw new Error("No model is selected: give the model as <provider>/<model>.");
			return { provider: current.provider, modelId: current.id, thinkingLevel: fgThinking };
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

	upsertPersistentBot(input: UpsertPersistentBotInput): PersistentBotRecord {
		const store = this.getBotTeamStore();
		const agentId = normalizeBotOrTeamId(input.agentId, "agentId");
		this.assertBotDispatchIdle(agentId);
		store.reload();
		const existing = store.getBot(agentId);
		const bindingFields = ["provider", "modelId", "thinkingLevel", "profileId", "canWrite", "instructions"] as const;
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
				`Retire bot ${input.agentId} before changing its model, profile, permissions or instructions; an existing worker's grant is immutable.`,
			);
		return store.upsertBot({ ...input, agentId });
	}

	retirePersistentBot(agentId: string): { retired: boolean; detail: string } {
		try {
			agentId = normalizeBotOrTeamId(agentId, "agentId");
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
			const results = this.listWorkerAgents()
				.filter((agent) => runtimes.has(agent.agentId))
				.map((agent) => this.interruptWorkerAgent(agent.agentId, undefined, { force: false }));
			const res = results.find((result) => result.interrupted) ?? results[0] ?? { interrupted: false };
			return {
				stopped: res.interrupted,
				detail: res.interrupted
					? `Stopped ${agentId} (${res.mode ?? "halt"}).`
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

	private isOrchestrationThinkingLevel(value: string | undefined): value is OrchestrationThinkingLevel {
		return (
			value === "off" ||
			value === "minimal" ||
			value === "low" ||
			value === "medium" ||
			value === "high" ||
			value === "xhigh" ||
			value === "max" ||
			value === "ultra"
		);
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
						shown.push({
							...msg,
							content: msg.content.map((part) =>
								part.type === "text" ? { ...part, text: botReplyText(part.text) } : part,
							),
						});
						continue;
					}
					if (msg.role !== "user") {
						shown.push(msg);
						continue;
					}
					const text = operatorTextOf(
						typeof msg.content === "string"
							? msg.content
							: msg.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
					);
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
			if (msg.sender.kind === "operator") {
				result.push({
					role: "user",
					content: [
						{
							type: "text",
							text: `[to team:${teamId} -> ${msg.targetAgentIds.length > 0 ? msg.targetAgentIds.join(", ") : "all members"}] ${msg.text}`,
						},
					],
					timestamp: msg.timestamp,
				});
			} else if (msg.sender.kind === "bot") {
				result.push({
					role: "custom",
					customType: "team-bot-message",
					content: `**[bot: ${msg.sender.agentId}]**\n${msg.text}`,
					display: true,
					timestamp: msg.timestamp,
				});
			} else {
				result.push({
					role: "custom",
					customType: "team-brain-message",
					content: `**[brain]**\n${msg.text}`,
					display: true,
					timestamp: msg.timestamp,
				});
			}
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
		options?: { mode?: "follow_up" | "queue" | "start"; teamId?: string; teamIncarnationId?: string },
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
		options: { mode?: "follow_up" | "queue" | "start" } | undefined,
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
		const messageOptions = teamId ? { threadId: `team:${teamId}:${teamIncarnationId}` } : undefined;

		if (existingAgent && (requestedMode === "follow_up" || requestedMode === "queue")) {
			// The bot received its memory block when it started and edits its blackboards directly; repeating the
			// block in every operator message would bloat its transcript and the chat the operator reads.
			const modelRef = existingAgent.modelRef ?? `${bot.provider}/${bot.modelId}`;
			if (requestedMode === "queue") {
				const res = this.sendSessionRootWorkerAgentMessage(runtime, message, messageOptions);
				return { agentId: normId, mode: "queued", messageId: res.messageId, modelRef };
			}
			const res = this.followUpSessionRootWorkerAgent(runtime, message, messageOptions);
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
		const baseInstructions = bot.instructions ? `${bot.instructions}\n\nTask:\n${message}` : message;
		// The memory block follows the task: the lane label, the roster line and the chat open on what the operator sent.
		const fullInstructions =
			memoryCtx.promptBlock.length > 0
				? `${baseInstructions}${BOT_MEMORY_BLOCK_SEPARATOR}${memoryCtx.promptBlock}`
				: baseInstructions;

		const activeIds = Array.from(
			new Set(
				this.getLaneRecords()
					.filter((r) => r.status === "running" || r.status === "queued")
					.map((r) => r.agentId ?? r.laneId)
					.filter((id): id is string => typeof id === "string" && id.length > 0 && id !== normId),
			),
		);

		const preferredAgentId = `bot-${randomUUID()}`;
		// Publish the context before execution: recovery never has to guess a group's origin from its name.
		assertCurrentBranch();
		this.botBindings.bind(normId, preferredAgentId, teamId, teamIncarnationId);
		const started = await this.startWorkerDelegation({
			instructions: fullInstructions,
			...(bot.profileId ? { profileId: bot.profileId } : {}),
			authority: {
				...(!bot.profileId ? { model: { provider: spec.provider, modelId: spec.modelId } } : {}),
				// A chat bot answers in plain text, which only a read-only worker may do; a write-capable one reports in the claim envelope.
				readOnly: bot.canWrite !== true,
				...(!bot.profileId && this.isOrchestrationThinkingLevel(bot.thinkingLevel)
					? { thinkingLevel: bot.thinkingLevel }
					: {}),
			},
			preferredAgentId,
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
