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

import type { Api, Model } from "@caupulican/pi-ai";
import type {
	GoalContinuationLoopOptions,
	GoalContinuationLoopResult,
	PromptOptions,
	ResearchLaneRunOutcome,
	WorkerDelegationRunOutcome,
} from "./agent-session.ts";
import { type LaneRecord, LaneTracker } from "./autonomy/lane-tracker.ts";
import { appendLaneRecordSnapshot, getLatestLaneRecordSnapshots } from "./autonomy/session-lane-record.ts";
import { ManagedLaneController } from "./delegation/managed-lane-controller.ts";
import {
	WorkerDelegationController,
	type WorkerDelegationControllerDeps,
} from "./delegation/worker-delegation-controller.ts";
import type { WorkerDelegationRequest } from "./delegation/worker-delegation-request.ts";
import { WorkerLifecycle } from "./delegation/worker-lifecycle.ts";
import { WorkerNotificationCoordinator } from "./delegation/worker-notification-coordinator.ts";
import type { ManagedLaneEvent } from "./extensions/types.ts";
import { GoalAutoContinueController } from "./goals/goal-auto-continue-controller.ts";
import type { GoalRuntimeSnapshot, GoalRuntimeSnapshotSettings } from "./goals/goal-runtime-snapshot.ts";
import type { GoalState } from "./goals/goal-state.ts";
import type { ModelCapabilityProfile } from "./model-capability.ts";
import type { StoredFitnessReport } from "./models/fitness-store.ts";
import type { TaskRuntimeProjection } from "./orchestration/task-runtime.ts";
import { LaneModelResolver, type LaneModelResolverDeps } from "./research/lane-model-resolver.ts";
import type { ModelFitnessReport } from "./research/model-fitness.ts";
import { ModelFitnessController, type ModelFitnessControllerDeps } from "./research/model-fitness-controller.ts";
import { ResearchLaneController, type ResearchLaneControllerDeps } from "./research/research-lane-controller.ts";
import { getActiveSessionBranchEntries } from "./session-snapshot.ts";

export { isLocalExecutionModel } from "./delegation/worker-delegation-controller.ts";
export { clampLaneMaxUsd } from "./research/lane-model-resolver.ts";

export interface BackgroundLaneControllerDeps
	extends WorkerDelegationControllerDeps,
		ResearchLaneControllerDeps,
		ModelFitnessControllerDeps,
		LaneModelResolverDeps {
	/** True iff the `goal` tool is in the session's ACTIVE surface -- the capability-adaptive gate
	 * for every goal-continuation loop (see `continueGoalLoopExclusive`): a surface without the
	 * goal tool (lean capability blocklist, worker role ceiling, --tools/profile exclusion) must
	 * never be driven with continuation prompts it cannot execute. */
	isGoalToolActive(): boolean;
	/** Capability profile of the SESSION model (gates background lanes, scales continuation budgets). */
	getModelCapabilityProfile(): ModelCapabilityProfile;
	/** Continuation gate + goal state for the idle autosteer scheduler. */
	getGoalRuntimeSnapshot(settings: GoalRuntimeSnapshotSettings): GoalRuntimeSnapshot;
	/** Drive-loop boundary: the session's bounded goal-continuation loop (owns `prompt()`, not us). */
	continueGoalLoop(options: GoalContinuationLoopOptions): Promise<GoalContinuationLoopResult>;
	/** Persist an explicit stopped state when the selected surface cannot drive the active goal. */
	markGoalToolUnavailable(): void;
}

export class BackgroundLaneController {
	/** Live lane registry — the real source for AutonomyStatusSnapshot.activeLaneCount. */
	private readonly _laneTracker = new LaneTracker();
	private readonly _laneModels: LaneModelResolver;
	private readonly _goalAutoContinue: GoalAutoContinueController;
	private readonly _research: ResearchLaneController;
	private readonly _fitness: ModelFitnessController;
	/** Lazily materialized only when managed-lane state is queried or reported. */
	private _managedLanes: ManagedLaneController | undefined;
	/** Lazily materialized so a UAC surface without `delegate` allocates no worker runtime state. */
	private _workers: WorkerDelegationController | undefined;
	/** One durable lifecycle shared by every worker execution adapter. */
	private _workerLifecycle: WorkerLifecycle | undefined;
	/** Shared terminal outbox for managed and in-process workers; lazy under UAC omission. */
	private _workerNotifications: WorkerNotificationCoordinator | undefined;
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
		this._laneModels = new LaneModelResolver(deps);
		this._research = new ResearchLaneController(deps, this._laneTracker, this._laneModels);
		this._fitness = new ModelFitnessController(deps, this._laneModels);
		this._goalAutoContinue = new GoalAutoContinueController({
			isDisposed: deps.isDisposed,
			isGoalToolActive: deps.isGoalToolActive,
			getSettingsManager: deps.getSettingsManager,
			getModelCapabilityProfile: deps.getModelCapabilityProfile,
			getGoalRuntimeSnapshot: deps.getGoalRuntimeSnapshot,
			hasInFlightLaneForGoal: (goalId) => this._hasInFlightLaneForGoal(goalId),
			continueGoalLoop: deps.continueGoalLoop,
			markGoalToolUnavailable: deps.markGoalToolUnavailable,
			emit: deps.emit,
		});
	}

	private _getWorkerController(): WorkerDelegationController {
		this._workers ??= new WorkerDelegationController(
			this.deps,
			this._getWorkerNotificationCoordinator(),
			this._getWorkerLifecycle(),
		);
		return this._workers;
	}

	private _getWorkerLifecycle(): WorkerLifecycle {
		if (this._workerLifecycle) return this._workerLifecycle;
		const lifecycle = new WorkerLifecycle({
			agentDir: this.deps.getAgentDir(),
			sessionId: this.deps.getSessionId(),
		});
		this._workerLifecycle = lifecycle;
		for (const notification of lifecycle.getPendingTerminalNotifications()) {
			this._getWorkerNotificationCoordinator().recordTerminal(notification.record, notification.notificationId);
		}
		return lifecycle;
	}

	private _getWorkerNotificationCoordinator(): WorkerNotificationCoordinator {
		this._workerNotifications ??= new WorkerNotificationCoordinator({
			getWorkerRecords: () => this._workerLifecycle?.getAllRecords() ?? [],
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

	private _getManagedLaneController(): ManagedLaneController {
		this._managedLanes ??= new ManagedLaneController(
			this.deps,
			this._getWorkerLifecycle(),
			(record, notificationId) => this._recordWorkerTerminal(record, notificationId),
		);
		return this._managedLanes;
	}

	private _hydrateManagedLanes(): void {
		if (this._managedLanes) {
			this._managedLanes.ensureHydrated();
			return;
		}
		const hasPersistedActiveManagedLane = getLatestLaneRecordSnapshots(
			getActiveSessionBranchEntries(this.deps.getSessionManager()),
		).some((record) => record.type === "tmux-worker" && (record.status === "queued" || record.status === "running"));
		if (hasPersistedActiveManagedLane) this._getManagedLaneController().ensureHydrated();
	}

	/** Live lane records tracked by this process (running and terminal). */
	getLaneRecords(): LaneRecord[] {
		this._hydrateManagedLanes();
		const workerRecords =
			this._workers?.getRecords() ??
			(this.deps.isDelegateToolActive?.() ? this._getWorkerController().getRecords() : []);
		return [
			...this._laneTracker.getRecords(),
			...workerRecords,
			...(this._workerLifecycle?.getManagedRecords() ?? []),
		];
	}

	/** Does not materialize the worker controller when UAC omitted delegation. */
	getTaskRuntimeSnapshot(): TaskRuntimeProjection | undefined {
		return this._workerLifecycle?.getTaskRuntimeSnapshot();
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
	abortInFlightLanes(): void {
		this._goalAutoContinue.clearTimer();
		this._research.abort();
		this._fitness.abort();
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
		this._managedLanes?.release();

		this._workers?.abort();
		this._workerNotifications?.dispose();
	}

	clearGoalAutoContinueTimer(): void {
		this._goalAutoContinue.clearTimer();
	}

	scheduleGoalAutoContinueFromIdle(options?: PromptOptions): void {
		this._goalAutoContinue.scheduleFromIdle(options);
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

	scheduleResearchLaneFromIdle(): void {
		this._research.scheduleFromIdle();
	}

	resolveLaneModel(configuredPattern: string | undefined): Model<Api> | undefined {
		return this._laneModels.resolveModel(configuredPattern);
	}

	getOrchestrationProfileCatalog(): Array<{ profileId: string; role: string; description: string }> {
		return this._getWorkerController().getProfileCatalog();
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
	/** Start a durable, profile-bound worker delegation. */
	startWorkerDelegation(
		request: WorkerDelegationRequest,
	): { started: false; skipReason: string } | { started: true; record: LaneRecord } {
		return this._getWorkerController().start(request);
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
		if (this.deps.isDelegateToolActive?.()) this._getWorkerController().drain();
	}

	/** Fitness reports persisted for THIS host (measured evidence for architect/profile decisions). */
	getStoredFitnessReports(): StoredFitnessReport[] {
		return this._fitness.getStoredReports();
	}
}
