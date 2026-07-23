/**
 * Compatibility facade for goal continuation, research, managed lanes, worker delegation, and fitness.
 *
 * Coordination state is owned by focused controllers. This facade retains the public AgentSession
 * seam and the managed-lane bridge. Everything else it needs
 * — the session manager, settings, model registry, live model, capability envelope, the goal
 * continuation LOOP, the isolated-completion primitive, spawned-usage accounting, and the telemetry
 * sink — is reached through narrow deps accessors rather than the whole AgentSession.
 *
 * Drive-loop boundary (deliberate): the idle triggers ({@link scheduleGoalAutoContinueFromIdle},
 * {@link scheduleResearchLaneFromIdle}) are invoked from the session's prompt tail as one-line
 * delegations; goal auto-continue itself only ever asks the session to `continueGoalLoop`, so this
 * controller never touches `prompt()`, the last-assistant-message, retry, or streaming state.
 */

import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, Model, Usage } from "@caupulican/pi-ai";
import type {
	AgentSessionEvent,
	GoalContinuationLoopOptions,
	GoalContinuationLoopResult,
	IsolatedCompletionOptions,
	IsolatedCompletionResult,
	PromptOptions,
	ResearchLaneRunOutcome,
	WorkerDelegationRunOutcome,
} from "./agent-session.ts";
import type {
	CapabilityEnvelope,
	EvidenceBundle,
	WorkerRequest,
	WorkerResult,
	WorkerResultStatus,
} from "./autonomy/contracts.ts";
import { type LaneRecord, type LaneTerminalStatus, LaneTracker } from "./autonomy/lane-tracker.ts";
import { appendLaneRecordSnapshot } from "./autonomy/session-lane-record.ts";
import type { AutonomyTelemetryEvent } from "./autonomy/telemetry-events.ts";
import {
	WorkerDelegationController,
	type WorkerDelegationControllerDeps,
} from "./delegation/worker-delegation-controller.ts";
import type { WorkerDelegationRequest } from "./delegation/worker-delegation-request.ts";
import { reviewManagedLaneChangedFiles } from "./delegation/worker-result.ts";
import type { ManagedLaneEvent } from "./extensions/types.ts";
import { GoalAutoContinueController } from "./goals/goal-auto-continue-controller.ts";
import type { GoalRuntimeSnapshot, GoalRuntimeSnapshotSettings } from "./goals/goal-runtime-snapshot.ts";
import type { GoalState } from "./goals/goal-state.ts";
import type { ModelCapabilityProfile } from "./model-capability.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { StoredFitnessReport } from "./models/fitness-store.ts";
import type { OrchestrationProfile } from "./orchestration/contracts.ts";
import { registerInFlightWork } from "./reload-blockers.ts";
import { LaneModelResolver } from "./research/lane-model-resolver.ts";
import type { ModelFitnessReport } from "./research/model-fitness.ts";
import { ModelFitnessController } from "./research/model-fitness-controller.ts";
import { ResearchLaneController } from "./research/research-lane-controller.ts";
import type { collectWorkspaceSources } from "./research/workspace-collector.ts";
import type { SettingsManager } from "./settings-manager.ts";

export { isLocalExecutionModel } from "./delegation/worker-delegation-controller.ts";
export { clampLaneMaxUsd } from "./research/lane-model-resolver.ts";

const KNOWN_LANE_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
	"succeeded",
	"failed",
	"canceled",
	"timeout",
	"budget_exhausted",
]);

/**
 * Resolves a managed lane's caller-reported terminal `status` (a free-form CLAIM — e.g. a tmux job's
 * own "done"/"blocked" completion marker, a lifecycle tag like "dismissed", or a raw
 * {@link WorkerResultStatus} spelling) onto the LaneTracker's {@link LaneTerminalStatus} vocabulary.
 * Mirrors the same success/blocked mapping direction `worker-runner.ts` already uses for in-process
 * workers ("completed"/"done" -> succeeded, "blocked" -> failed). An unrecognized or missing status is
 * conservatively reported as `"failed"` rather than silently assumed successful (claims-to-review).
 */
export function resolveManagedLaneTerminalStatus(status: string | undefined): LaneTerminalStatus {
	if (status !== undefined && KNOWN_LANE_TERMINAL_STATUSES.has(status)) {
		return status as LaneTerminalStatus;
	}
	switch (status) {
		case "done":
		case "completed":
			return "succeeded";
		case "blocked":
			return "failed";
		case "dismissed":
		case "cancelled":
			return "canceled";
		default:
			return "failed";
	}
}

/** Maps a LaneTracker terminal status onto the WorkerResult status vocabulary a managed-lane claim
 * snapshot is persisted under — the two enums use different spellings/values, never interchangeable
 * (e.g. `"canceled"` vs `"cancelled"`); `timeout`/`budget_exhausted` have no dedicated WorkerResult
 * counterpart and are conservatively reported as `"failed"`. */
export function mapManagedLaneTerminalStatus(status: LaneTerminalStatus): WorkerResultStatus {
	switch (status) {
		case "succeeded":
			return "completed";
		case "canceled":
			return "cancelled";
		case "failed":
		case "timeout":
		case "budget_exhausted":
			return "failed";
	}
}

export interface BackgroundLaneControllerDeps extends WorkerDelegationControllerDeps {
	/** A disposed session must never schedule/persist a lane or continuation. */
	isDisposed(): boolean;
	/** Child sessions never run the idle research lane (only the top-level session drives autonomy). */
	isChildSession(): boolean;
	/** This session's id, for lane envelope ids and spawned-usage report ids. */
	getSessionId(): string;
	/** The workspace root a lane runs relative to (worker path scope + research source collection). */
	getCwd(): string;
	/** Root dir the host-keyed {@link FitnessStore} persists under. */
	getAgentDir(): string;
	/** Session log: lane records read/append here and feed lane-history dedupe. */
	getSessionManager(): SessionManager;
	/** Autonomy / research-lane / worker-delegation / model-capability settings + the profile registry. */
	getSettingsManager(): SettingsManager;
	/** Immutable owner-authored profile of the foreground session, when active. */
	getActiveOrchestrationProfile?(): OrchestrationProfile | undefined;
	/** Resolves a configured lane model pattern against configured auth. */
	getModelRegistry(): ModelRegistry;
	/** Session-scoped provider/model quota exhaustion guard. */
	isModelExhausted(model: Model<Api>): boolean;
	/** The session's current model — lanes inherit it unless a lane model is explicitly configured. */
	getModel(): Model<Api> | undefined;
	/** Tool/profile gate: delegation is unavailable when the active surface removes `delegate`. */
	isDelegateToolActive(): boolean;
	/** True iff the `goal` tool is in the session's ACTIVE surface -- the capability-adaptive gate
	 * for every goal-continuation loop (see `continueGoalLoopExclusive`): a surface without the
	 * goal tool (lean capability blocklist, worker role ceiling, --tools/profile exclusion) must
	 * never be driven with continuation prompts it cannot execute. */
	isGoalToolActive(): boolean;
	/** Foreground cost ceiling — a lane budget is clamped to it, never exceeds it. */
	getCapabilityEnvelope(): CapabilityEnvelope | undefined;
	/** Capability profile of the SESSION model (gates background lanes, scales continuation budgets). */
	getModelCapabilityProfile(): ModelCapabilityProfile;
	/** Emits session events for diagnostics and UI state. */
	emit(event: AgentSessionEvent): void;
	/** Queue one bounded terminal handoff that wakes the parent without injecting worker product text. */
	notifyWorkerTerminalHandoff(
		records: readonly { laneId: string; status: LaneTerminalStatus; reasonCode?: string }[],
	): Promise<void>;
	/** Telemetry sink (codes/ids only — never lane product text). */
	emitAutonomyTelemetry(event: AutonomyTelemetryEvent): void;
	/** Durable goal state, if a goal is active (the research lane's demand source). */
	getGoalStateSnapshot(): GoalState | undefined;
	/** Continuation gate + goal state for the idle autosteer scheduler. */
	getGoalRuntimeSnapshot(settings: GoalRuntimeSnapshotSettings): GoalRuntimeSnapshot;
	/** Latest persisted evidence bundle, for research-lane dedupe. */
	getEvidenceBundleSnapshot(): EvidenceBundle | undefined;
	/** Persist a research lane's evidence bundle to the session log. */
	saveEvidenceBundleSnapshot(bundle: EvidenceBundle): string;
	/** Persist a worker delegation's result snapshot to the session log. */
	saveWorkerResultSnapshot(result: WorkerResult, request?: WorkerRequest): string;
	/** Bounded, source-labeled memory retrieval for an orchestrator-authorized worker. */
	readMemoryForLane(query: string): Promise<string>;
	/** Roll a lane's spawned usage into session accounting (idempotent per reportId). `reportId` is
	 * REQUIRED: every caller derives a stable id from the work unit's identity so a retry
	 * cannot double-count. */
	addSpawnedUsage(
		usage: Usage,
		opts: { label?: string; sourceSessionId?: string; reportId: string },
	): string | undefined;
	/** Bounded LLM call fully isolated from the main session; lanes may supply a child tool loop. */
	runIsolatedCompletion(opts: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
	/** Drive-loop boundary: the session's bounded goal-continuation loop (owns `prompt()`, not us). */
	continueGoalLoop(options: GoalContinuationLoopOptions): Promise<GoalContinuationLoopResult>;
	/** Best-effort workspace evidence collection (silent-on-failure; [] preserves prior behavior). */
	collectWorkspaceSources: typeof collectWorkspaceSources;
}

export class BackgroundLaneController {
	/** Live lane registry — the real source for AutonomyStatusSnapshot.activeLaneCount. */
	private readonly _laneTracker = new LaneTracker();
	private readonly _laneModels: LaneModelResolver;
	private readonly _goalAutoContinue: GoalAutoContinueController;
	private readonly _research: ResearchLaneController;
	private readonly _fitness: ModelFitnessController;
	/** Lazily materialized so a UAC surface without `delegate` allocates no worker runtime state. */
	private _workers: WorkerDelegationController | undefined;
	/** Dispatch -> terminal correlation for out-of-process managed lanes (`pi.reportManagedLane`
	 * host bridge), keyed by the CALLER's own `laneId` (e.g. a tmux job id) — distinct from the
	 * internal `LaneTracker` id it maps to. Removed on the matching terminal report so a duplicate or
	 * unmatched terminal call is a safe no-op instead of a double-deregister or an orphaned entry. */
	private readonly _managedLaneDispatches = new Map<string, { laneId: string; deregister: () => void }>();

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

	private _recordWorkerTerminal(record: LaneRecord): void {
		this._getWorkerController().recordTerminal(record);
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
			emit: deps.emit,
		});
	}

	private _getWorkerController(): WorkerDelegationController {
		this._workers ??= new WorkerDelegationController(this.deps);
		return this._workers;
	}

	private _seedLaneHistory(): void {
		this._research.seedHistory();
	}

	/** Live lane records tracked by this process (running and terminal). */
	getLaneRecords(): LaneRecord[] {
		const workerRecords =
			this._workers?.getRecords() ??
			(this.deps.isDelegateToolActive?.() ? this._getWorkerController().getRecords() : []);
		return [...this._laneTracker.getRecords(), ...workerRecords];
	}

	/**
	 * Resolve a tracked managed-lane dispatch's internal `LaneTracker` id from the CALLER's own
	 * `laneId` (the id passed to `recordManagedLane`'s `phase: "dispatch"`, e.g. a reconstructed
	 * `tmux:jobId:agentId`). A deterministic, non-racy keyed lookup against `_managedLaneDispatches` —
	 * NOT a `getLaneRecords()` diff — for a caller (e.g. the goal-to-tmux dispatch adapter) that just
	 * minted the dispatch and needs the internal id `Requirement.boundLaneId`/`inFlightGoalLaneIds`
	 * actually match. `undefined` once the dispatch has gone terminal (removed from the map) or was
	 * never tracked.
	 */
	resolveManagedLaneId(callerLaneId: string): string | undefined {
		return this._managedLaneDispatches.get(callerLaneId)?.laneId;
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

	/**
	 * Host-side bridge for `pi.reportManagedLane`: makes an out-of-process managed lane (e.g. a tmux
	 * worker) a first-class lane in THIS process's LaneTracker. HONEST cross-process seam — the
	 * extension only ever REPORTS a claim; this controller stays the lane-tracking SSOT (no in-process
	 * sandboxing is implied by accepting the report).
	 *
	 * `phase: "dispatch"` mints a `tmux-worker` lane record (goalId-tagged) and registers exactly one
	 * reload-quiesce unit for it. `phase: "terminal"` resolves the caller's free-form `status` claim
	 * onto {@link LaneTerminalStatus} (see {@link resolveManagedLaneTerminalStatus}), completes that
	 * same record, deregisters the quiesce unit (inside a `finally` — never left stuck regardless of
	 * what persistence below does), and persists a bounded worker-result CLAIM snapshot from the
	 * reported `changedFiles`. Host re-review: the reported `changedFiles` are re-checked against
	 * the session's active capability envelope ({@link reviewManagedLaneChangedFiles}, reusing
	 * `validateWorkerResult`'s symlink-safe scope check verbatim) and `parentReviewRequired` is
	 * stamped on the persisted claim whenever that check does not cleanly "allow" -- an out-of-scope
	 * (or no-scope-configured) path is flagged exactly like an in-scope one, since a tmux worker's
	 * write never passed through this process's enforcement in the first place. This is the SESSION
	 * envelope, not a per-launch tmux standing grant (that is a narrower, launch-specific scope;
	 * documented follow-up, not yet implemented). `event.request` stays an unvalidated
	 * caller-supplied bag (per its own doc comment) and is deliberately never read for scoping. A
	 * terminal report for an unknown `laneId` (no matching dispatch tracked) and a duplicate dispatch
	 * for an already-tracked `laneId` are both safe no-ops — never a double registration, a double
	 * persisted claim, or a crash.
	 *
	 * Returns the minted (`phase: "dispatch"`) or completed (`phase: "terminal"`) LaneRecord for an
	 * in-process caller that wants the record without a second `getLaneRecords()` read (e.g. a
	 * faux-bridge test, or the goal-to-tmux dispatch adapter via `resolveManagedLaneId`); `undefined`
	 * on every no-op path (disposed controller, duplicate dispatch, unknown-laneId terminal). The
	 * extension-facing `ExtensionActions.reportManagedLane` TYPE stays `=> void` -- that call site is a
	 * fire-and-forget statement and is unaffected by this return.
	 */
	recordManagedLane(event: ManagedLaneEvent): LaneRecord | undefined {
		if (this.deps.isDisposed()) return undefined;
		if (event.phase === "dispatch") {
			if (this._managedLaneDispatches.has(event.laneId)) return undefined;
			this._seedLaneHistory();
			const record = this._laneTracker.start({
				type: "tmux-worker",
				goalId: event.goalId,
				worktreeLaneKey: event.worktreeLaneKey,
			});
			const deregister = registerInFlightWork(this.deps.getAgentDir(), "lane", `tmux:${record.laneId}`);
			this._managedLaneDispatches.set(event.laneId, { laneId: record.laneId, deregister });
			return record;
		}

		const dispatch = this._managedLaneDispatches.get(event.laneId);
		if (!dispatch) return undefined;
		this._managedLaneDispatches.delete(event.laneId);
		try {
			const resolvedStatus = resolveManagedLaneTerminalStatus(event.status);
			const record = this._laneTracker.complete(dispatch.laneId, {
				status: resolvedStatus,
				reasonCode: event.reasonCode,
				costUsd: event.usage?.cost.total,
			});
			if (!record) return undefined;
			appendLaneRecordSnapshot(this.deps.getSessionManager(), record);
			const changedFiles = event.changedFiles ? [...event.changedFiles] : [];
			const review = reviewManagedLaneChangedFiles({
				changedFiles,
				envelope: this.deps.getCapabilityEnvelope() ?? {},
				cwd: this.deps.getCwd(),
			});
			const result: WorkerResult = {
				requestId: dispatch.laneId,
				status: mapManagedLaneTerminalStatus(resolvedStatus),
				summary: `Managed tmux-worker lane ${dispatch.laneId} reported terminal status "${event.status ?? "unknown"}"${
					event.reasonCode ? ` (${event.reasonCode})` : ""
				}.${review.reviewRequired ? ` Changed files require parent review (${review.reasonCode}).` : ""}`,
				changedFiles,
				parentReviewRequired: review.reviewRequired,
				createdAt: new Date().toISOString(),
			};
			try {
				this.deps.saveWorkerResultSnapshot(result);
			} finally {
				// Managed workers must wake their owning parent through the same bounded, event-driven
				// terminal handoff as in-process workers. The lane record is already durable above, so
				// notification still happens if the richer result snapshot fails to persist.
				this._recordWorkerTerminal(record);
			}
			return record;
		} finally {
			dispatch.deregister();
		}
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

		this._workers?.abort();
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
