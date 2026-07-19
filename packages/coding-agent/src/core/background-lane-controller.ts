/**
 * Background-lane controller: goal auto-continue, the research lane, scout-worker delegation, and
 * the model-fitness probe.
 *
 * Extracted verbatim from agent-session.ts (god-file decomposition). Owns the lane timers, the
 * single-flight guards, the last research-lane skip reason, the live {@link LaneTracker}, and the
 * session-lifetime abort controllers for in-flight research/worker passes. Everything else it needs
 * — the session manager, settings, model registry, live model, capability envelope, the goal
 * continuation LOOP, the isolated-completion primitive, spawned-usage accounting, and the telemetry
 * sink — is reached through narrow deps accessors rather than the whole AgentSession.
 *
 * Drive-loop boundary (deliberate): the idle triggers ({@link scheduleGoalAutoContinueFromIdle},
 * {@link scheduleResearchLaneFromIdle}) are invoked from the session's prompt tail as one-line
 * delegations; goal auto-continue itself only ever asks the session to `continueGoalLoop`, so this
 * controller never touches `prompt()`, the last-assistant-message, retry, or streaming state.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, Model, Usage } from "@caupulican/pi-ai";
import { configFile, getWorkRoot, sessionsDir, stateDir } from "./agent-paths.ts";
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
import { createLaneToolSurface, type LaneToolSurface } from "./autonomy/lane-tool-surface.ts";
import { type LaneRecord, type LaneTerminalStatus, LaneTracker } from "./autonomy/lane-tracker.ts";
import { safeRealpathSync } from "./autonomy/path-scope.ts";
import { appendLaneRecordSnapshot, getLaneRecordSnapshots } from "./autonomy/session-lane-record.ts";
import { composeSubagentSystemPrompt } from "./autonomy/subagent-prompt.ts";
import { AUTONOMY_TELEMETRY_EVENT_TYPES, type AutonomyTelemetryEvent } from "./autonomy/telemetry-events.ts";
import { applyWorkerActions, type WorkerAction } from "./delegation/worker-actions.ts";
import { reviewManagedLaneChangedFiles } from "./delegation/worker-result.ts";
import { runWorker } from "./delegation/worker-runner.ts";
import type { ManagedLaneEvent } from "./extensions/types.ts";
import type { GoalRuntimeSnapshot, GoalRuntimeSnapshotSettings } from "./goals/goal-runtime-snapshot.ts";
import type { GoalState } from "./goals/goal-state.ts";
import {
	deriveModelCapabilityProfile,
	type ModelCapabilityProfile,
	scaleContinuationBudgetsForCapability,
} from "./model-capability.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { resolveCliModel } from "./model-resolver.ts";
import { FitnessStore, type StoredFitnessReport } from "./models/fitness-store.ts";
import type { NormalizedProfile } from "./profile-registry.ts";
import { registerInFlightWork } from "./reload-blockers.ts";
import { type ModelFitnessReport, runModelFitnessProbe } from "./research/model-fitness.ts";
import { runResearch } from "./research/research-runner.ts";
import type { collectWorkspaceSources } from "./research/workspace-collector.ts";
import type { SettingsManager } from "./settings-manager.ts";

const WORKER_HANDOFF_TIMEOUT_MS = 30_000;

export function clampLaneMaxUsd(settingsMaxUsd: number, foregroundMaxEstimatedUsd?: number): number {
	return Math.min(settingsMaxUsd, foregroundMaxEstimatedUsd ?? Number.POSITIVE_INFINITY);
}

/**
 * Deterministic `addSpawnedUsage` reportId: `kind` + session id + a content hash of `identity`
 * (never `Date.now`/random). Same identity on a retry of the same logical work unit yields the same
 * id, so the ledger's `seenSubagentReportIds` dedupe catches a duplicate report instead of
 * double-counting spend.
 */
function deriveSpawnedUsageReportId(kind: string, sessionId: string, identity: string): string {
	const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
	return `${kind}:${sessionId}:${digest}`;
}

export function getPrivateLaneDeniedPaths(cwd: string, agentDir: string): string[] {
	return [
		configFile(agentDir, "auth.json"),
		configFile(agentDir, "MEMORY.md"),
		configFile(agentDir, "USER.md"),
		configFile(agentDir, "settings.json"),
		configFile(agentDir, "models.json"),
		// trust.json now lives under state/ -- covered by the whole-state-dir
		// denial below instead of its own root-level entry.
		sessionsDir(agentDir),
		stateDir(agentDir),
		getWorkRoot(agentDir),
	].concat(path.join(cwd, ".pi", "settings.json"));
}

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

export function isLocalExecutionModel(model: Pick<Model<Api>, "provider" | "baseUrl">): boolean {
	if (model.provider === "ollama" || model.provider === "transformers" || model.provider === "llama-cpp") {
		return true;
	}
	try {
		const hostname = new URL(model.baseUrl).hostname.toLowerCase();
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
	} catch {
		return false;
	}
}

export interface BackgroundLaneControllerDeps {
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
	/** Resolves a configured lane model pattern against configured auth. */
	getModelRegistry(): ModelRegistry;
	/** Session-scoped provider/model quota exhaustion guard. */
	isModelExhausted(model: Model<Api>): boolean;
	/** The session's current model — lanes inherit it unless a lane model is explicitly configured. */
	getModel(): Model<Api> | undefined;
	/** Tool/profile gate: delegation is unavailable when the active surface removes `delegate`. */
	isDelegateToolActive(): boolean;
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
	/** Pending idle timer that starts bounded goal continuation after the session becomes idle. */
	private _goalAutoContinueTimer: ReturnType<typeof setTimeout> | undefined;
	/** Guards bounded idle autosteer so continuation prompts do not recursively trigger themselves. */
	private _isGoalAutoContinuing = false;
	/** Pending idle timer that starts an autonomous research pass after the session becomes idle. */
	private _researchLaneTimer: ReturnType<typeof setTimeout> | undefined;
	/** Single-flight guard: at most one research pass runs at a time per session. */
	private _isResearchLaneRunning = false;
	/** Why the last idle research-lane evaluation skipped, for /autonomy diagnostics. */
	private _lastResearchLaneSkipReason: string | undefined;
	/** Live lane registry — the real source for AutonomyStatusSnapshot.activeLaneCount. */
	private readonly _laneTracker = new LaneTracker();
	private _laneHistorySeeded = false;
	private _persistedResearchRunCount = 0;
	/** Session-lifetime abort for in-flight research passes (same pattern as _reflectionAbort). */
	private readonly _researchLaneAbort = new AbortController();
	/** Session-lifetime abort for in-flight delegated workers. */
	private readonly _workerDelegationAbort = new AbortController();
	/** Session-local de-duplication for fail-closed profile grants that cannot bind to lane tools. */
	private readonly _warnedUnboundLaneToolGrants = new Set<string>();
	/** Every background execution is retained until its terminal result is observed. */
	private readonly _workerPromises = new Map<string, Promise<WorkerDelegationRunOutcome>>();
	private readonly _queuedWorkers = new Map<
		string,
		{ instructions: string; systemPrompt?: string; memoryRead?: boolean }
	>();
	private _workerNotificationScheduled = false;
	private _workerNotificationTail = Promise.resolve();
	private _disposed = false;
	private _workersCompletedSinceFlush = 0;
	private _workersFailedSinceFlush = 0;
	private readonly _workerTerminalSinceFlush: Array<{
		laneId: string;
		status: LaneTerminalStatus;
		reasonCode?: string;
	}> = [];
	/** Live per-lane mutation ledger for a RUNNING worker — the SAME `toolChangedFiles` Set its
	 * `afterToolCall` hook mutates, plus a spend getter and the originating request. Read
	 * synchronously by `abortInFlightLanes()`'s disposal cutoff, the only provably-safe write window
	 * for a mid-flight cancellation (see that method); deleted there (consumed-ledger guard against
	 * the post-await disposed branch re-persisting) or in the lane's own `finally` on a normal exit. */
	private readonly _inFlightWorkerLedgers = new Map<
		string,
		{ changedFiles: Set<string>; getSpend: () => Usage | undefined; request: WorkerRequest }
	>();
	/** Reload-gate deregister function for a worker queued (not yet running) behind a
	 * contending local-execution foreground model. Registered at enqueue so `/reload` waits for
	 * queued work too, not just running work; deregistered exactly once, either on disposal
	 * (`abortInFlightLanes`) or at the running handoff (`drainQueuedWorkerDelegations`). A laneId with
	 * no entry here (e.g. seeded directly into `_queuedWorkers` by a test) is simply untracked —
	 * deregistration is best-effort by design, never required. */
	private readonly _queuedWorkerDeregisters = new Map<string, () => void>();
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

	private _scheduleWorkerNotification(): void {
		if (this._disposed || this._workerNotificationScheduled) return;
		this._workerNotificationScheduled = true;
		queueMicrotask(() => this._flushWorkerNotification());
	}

	private _flushWorkerNotification(): void {
		this._workerNotificationScheduled = false;
		if (this._disposed) return;
		const queued = this._laneTracker
			.getRecords()
			.filter((record) => record.type === "worker" && record.status === "queued").length;
		const running = this._laneTracker.getRunningCount("worker");
		const terminalSinceFlush = this._workerTerminalSinceFlush.splice(0);
		const completedSinceFlush = this._workersCompletedSinceFlush;
		const failedSinceFlush = this._workersFailedSinceFlush;
		this._workersCompletedSinceFlush = 0;
		this._workersFailedSinceFlush = 0;
		this.deps.emit({
			type: "delegate_workers",
			active: queued + running,
			queued,
			running,
			completedSinceFlush,
			failedSinceFlush,
			terminalSinceFlush,
		});
		if (terminalSinceFlush.length === 0) return;
		const delivery = this._workerNotificationTail.then(async () => {
			if (this._disposed) return;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					this.deps.notifyWorkerTerminalHandoff(terminalSinceFlush),
					new Promise<never>((_resolve, reject) => {
						timeout = setTimeout(
							() => reject(new Error(`worker terminal handoff timed out after ${WORKER_HANDOFF_TIMEOUT_MS}ms`)),
							WORKER_HANDOFF_TIMEOUT_MS,
						);
						timeout.unref();
					}),
				]);
			} finally {
				if (timeout) clearTimeout(timeout);
			}
		});
		this._workerNotificationTail = delivery.catch((error: unknown) => {
			this.deps.emit({
				type: "warning",
				message: `Background worker handoff failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		});
	}

	private _recordWorkerTerminal(record: LaneRecord): void {
		if (record.status === "queued" || record.status === "running") return;
		if (record.status === "succeeded") this._workersCompletedSinceFlush++;
		else this._workersFailedSinceFlush++;
		this._workerTerminalSinceFlush.push({
			laneId: record.laneId,
			status: record.status,
			...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
		});
		this._scheduleWorkerNotification();
	}

	constructor(deps: BackgroundLaneControllerDeps) {
		this.deps = deps;
	}

	private _seedLaneHistory(): void {
		if (this._laneHistorySeeded) return;
		const records = getLaneRecordSnapshots(this.deps.getSessionManager().getEntries());
		this._laneTracker.ensureCounterAtLeast(records.length + 1);
		this._persistedResearchRunCount = records.filter((record) => record.type === "research").length;
		this._laneHistorySeeded = true;
	}

	/** Live lane records tracked by this process (running and terminal). */
	getLaneRecords(): LaneRecord[] {
		return this._laneTracker.getRecords();
	}

	/** Live count of active lanes — the real source for AutonomyStatusSnapshot.activeLaneCount. */
	getActiveLaneCount(): number {
		return this._laneTracker.getActiveCount();
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
	 */
	recordManagedLane(event: ManagedLaneEvent): void {
		if (this.deps.isDisposed()) return;
		if (event.phase === "dispatch") {
			if (this._managedLaneDispatches.has(event.laneId)) return;
			this._seedLaneHistory();
			const record = this._laneTracker.start({ type: "tmux-worker", goalId: event.goalId });
			const deregister = registerInFlightWork(this.deps.getAgentDir(), "lane", `tmux:${record.laneId}`);
			this._managedLaneDispatches.set(event.laneId, { laneId: record.laneId, deregister });
			return;
		}

		const dispatch = this._managedLaneDispatches.get(event.laneId);
		if (!dispatch) return;
		this._managedLaneDispatches.delete(event.laneId);
		try {
			const resolvedStatus = resolveManagedLaneTerminalStatus(event.status);
			const record = this._laneTracker.complete(dispatch.laneId, {
				status: resolvedStatus,
				reasonCode: event.reasonCode,
			});
			if (!record) return;
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
			this.deps.saveWorkerResultSnapshot(result);
		} finally {
			dispatch.deregister();
		}
	}

	/** Why the last idle research-lane evaluation skipped, for /autonomy diagnostics. */
	getLastResearchLaneSkipReason(): string | undefined {
		return this._lastResearchLaneSkipReason;
	}

	/**
	 * Abort any in-flight research pass or delegated worker (called on session dispose).
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
		this._disposed = true;
		this._researchLaneAbort.abort();
		this._workerDelegationAbort.abort();

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
			if (canceled.type !== "worker") continue;
			// Only a RUNNING worker ever registers a ledger (a queued-never-started worker has none;
			// its cancellation is already fully captured by the lane record above). Consumed
			// (deleted) here so the post-await disposed branch never re-persists it.
			const ledger = this._inFlightWorkerLedgers.get(record.laneId);
			if (!ledger) continue;
			this._inFlightWorkerLedgers.delete(record.laneId);
			try {
				const spend = ledger.getSpend();
				const reportId = `worker:${this.deps.getSessionId()}:${record.laneId}`;
				const result: WorkerResult = {
					requestId: ledger.request.id,
					status: "cancelled",
					summary: "canceled on session dispose",
					changedFiles: [...ledger.changedFiles],
					usageReportId: reportId,
					createdAt: new Date().toISOString(),
				};
				// Bounded honesty: spend may be incomplete (it lands only when the isolated completion
				// returns, which a mid-flight abort preempts) — record what `getSpend()` knows. Same
				// deterministic reportId scheme as the normal path, so a later duplicate report (there
				// is none in practice here, since the lane is now terminal) stays idempotent.
				this.deps.saveWorkerResultSnapshot(result, ledger.request);
				if (spend && (spend.cost.total > 0 || spend.totalTokens > 0)) {
					this.deps.addSpawnedUsage(spend, { label: "worker-delegation", reportId });
				}
			} catch (error) {
				this._safeWarn(
					`Failed to persist canceled worker result ${record.laneId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		// A queued (never-started) worker's reload-gate registration ends here on cancellation;
		// the other end is the running handoff in `drainQueuedWorkerDelegations`.
		for (const deregister of this._queuedWorkerDeregisters.values()) deregister();
		this._queuedWorkerDeregisters.clear();
		this._queuedWorkers.clear();

		this._workerNotificationScheduled = false;
		this._workerTerminalSinceFlush.length = 0;
	}

	clearGoalAutoContinueTimer(): void {
		if (this._goalAutoContinueTimer !== undefined) {
			clearTimeout(this._goalAutoContinueTimer);
			this._goalAutoContinueTimer = undefined;
		}
	}

	scheduleGoalAutoContinueFromIdle(options?: PromptOptions): void {
		if (options?.autoContinueGoal === false || this._isGoalAutoContinuing || this.deps.isDisposed()) return;

		// Small-window models cannot afford multi-thousand-token continuation prompts per idle turn.
		if (!this.deps.getModelCapabilityProfile().backgroundLanesEnabled) return;

		const { maxStallTurns, goalAutoContinue, goalAutoContinueDelayMs } = this.deps
			.getSettingsManager()
			.getAutonomySettings();
		if (!goalAutoContinue) return;

		const snapshot = this.deps.getGoalRuntimeSnapshot({ maxStallTurns });
		if (snapshot.continuation.action !== "continue") return;

		// Belt-and-braces: the snapshot above is already lane-aware (a bound in-flight worker
		// yields action:"waiting", already caught by the check above), so this direct lane check is
		// redundant in the normal case. It stays as an explicit second gate so a future change that
		// decouples the lane injection from THIS snapshot read can never silently reopen the idle
		// re-dispatch race this guard closes.
		const activeGoalId = snapshot.goalState?.goalId;
		if (activeGoalId !== undefined && this._hasInFlightLaneForGoal(activeGoalId)) return;

		this.clearGoalAutoContinueTimer();
		this._goalAutoContinueTimer = setTimeout(() => {
			this._goalAutoContinueTimer = undefined;
			void this._runScheduledGoalAutoContinue();
		}, goalAutoContinueDelayMs);

		const timer = this._goalAutoContinueTimer;
		if (typeof timer === "object" && timer && "unref" in timer) {
			const { unref } = timer as { unref?: () => void };
			unref?.call(timer);
		}
	}

	private async _runScheduledGoalAutoContinue(): Promise<void> {
		if (this._isGoalAutoContinuing || this.deps.isDisposed()) return;

		const { maxStallTurns, goalContinueTurns, goalContinueMaxWallClockMinutes, goalAutoContinue } = this.deps
			.getSettingsManager()
			.getAutonomySettings();
		if (!goalAutoContinue) return;

		const snapshot = this.deps.getGoalRuntimeSnapshot({ maxStallTurns });
		if (snapshot.continuation.action !== "continue") return;

		// Lean-window models (16-32k) keep autosteer but at a reduced budget; full passes through.
		const scaled = scaleContinuationBudgetsForCapability(this.deps.getModelCapabilityProfile(), {
			maxTurns: goalContinueTurns,
			maxWallClockMinutes: goalContinueMaxWallClockMinutes,
		});

		try {
			await this.continueGoalLoopExclusive({
				maxTurns: scaled.maxTurns,
				maxStallTurns,
				maxWallClockMinutes: scaled.maxWallClockMinutes,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.deps.emit({ type: "warning", message: `Goal auto-continuation failed: ${message}` });
		}
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
		if (this._isGoalAutoContinuing) return this._skippedGoalResult(options, "already_continuing");
		if (this.deps.isDisposed()) return this._skippedGoalResult(options, "session_disposed");
		this._isGoalAutoContinuing = true;
		try {
			return await this.deps.continueGoalLoop(options);
		} finally {
			this._isGoalAutoContinuing = false;
		}
	}

	/**
	 * A full {@link GoalContinuationLoopResult} for a continuation request that never ran a pass
	 * (another loop already owns the mutex, or the session is disposed). Keeps the skip path
	 * type-identical to a real pass — no separate skip union — so every caller keeps reading
	 * `result.stopReason`/`result.finalSnapshot` unchanged.
	 */
	private _skippedGoalResult(
		options: GoalContinuationLoopOptions,
		stopReason: "already_continuing" | "session_disposed",
	): GoalContinuationLoopResult {
		return {
			turnsSubmitted: 0,
			stopReason,
			finalSnapshot: this.deps.getGoalRuntimeSnapshot({ maxStallTurns: options.maxStallTurns }),
		};
	}

	clearResearchLaneTimer(): void {
		if (this._researchLaneTimer !== undefined) {
			clearTimeout(this._researchLaneTimer);
			this._researchLaneTimer = undefined;
		}
	}

	/**
	 * Derive the research demand from durable goal state: an active goal with open requirements,
	 * deduplicated against the latest persisted bundle so the same requirement set is never
	 * researched twice (the query is deterministic, so dedupe survives session reload).
	 */
	private _buildResearchLaneDemand(): { query: string; context: string; goalId: string } | undefined {
		const goal = this.deps.getGoalStateSnapshot();
		if (!goal || goal.status !== "active") {
			this._lastResearchLaneSkipReason = "no_active_goal";
			return undefined;
		}
		const open = goal.requirements.filter((requirement) => requirement.status === "open");
		if (open.length === 0) {
			this._lastResearchLaneSkipReason = "no_open_requirements";
			return undefined;
		}
		const query = `goal:${goal.goalId} requirements:${open
			.map((requirement) => requirement.id)
			.sort()
			.join(",")}`;
		if (this.deps.getEvidenceBundleSnapshot()?.query === query) {
			this._lastResearchLaneSkipReason = "recent_evidence_sufficient";
			return undefined;
		}
		const context = [
			`Goal: ${goal.userGoal}`,
			"Open requirements:",
			...open.slice(0, 20).map((requirement) => `- ${requirement.text}`),
		].join("\n");
		return { query, context, goalId: goal.goalId };
	}

	/**
	 * Idle trigger for the autonomous research lane (mirrors {@link scheduleGoalAutoContinueFromIdle}).
	 * All skips are recorded in `_lastResearchLaneSkipReason` and surfaced via diagnostics — the lane
	 * informs, it never prompts or blocks the foreground.
	 */
	scheduleResearchLaneFromIdle(): void {
		if (this._isResearchLaneRunning || this.deps.isDisposed() || this.deps.isChildSession()) return;

		const research = this.deps.getSettingsManager().getResearchLaneSettings();
		if (!research.enabled) {
			this._lastResearchLaneSkipReason = "research_lane_disabled";
			return;
		}
		const { mode } = this.deps.getSettingsManager().getAutonomySettings();
		if (mode === "off") {
			this._lastResearchLaneSkipReason = "autonomy_mode_off";
			return;
		}
		this._seedLaneHistory();
		if (this._persistedResearchRunCount >= research.maxRunsPerSession) {
			this._lastResearchLaneSkipReason = "max_runs_reached";
			return;
		}
		if (!this._buildResearchLaneDemand()) return;
		const shipment = this._resolveLaneShipment(research, "no_research_model");
		if (!shipment.ok) {
			this._lastResearchLaneSkipReason = shipment.skipReason;
			return;
		}
		if (!this._laneCapabilityProfile(shipment.model).backgroundLanesEnabled) {
			this._lastResearchLaneSkipReason = "model_research_unsupported";
			return;
		}

		this.clearResearchLaneTimer();
		this._researchLaneTimer = setTimeout(() => {
			this._researchLaneTimer = undefined;
			void this._runScheduledResearchLane();
		}, research.idleDelayMs);

		const timer = this._researchLaneTimer;
		if (typeof timer === "object" && timer && "unref" in timer) {
			const { unref } = timer as { unref?: () => void };
			unref?.call(timer);
		}
	}

	private async _runScheduledResearchLane(): Promise<void> {
		if (this._isResearchLaneRunning || this.deps.isDisposed()) return;

		const research = this.deps.getSettingsManager().getResearchLaneSettings();
		const { mode } = this.deps.getSettingsManager().getAutonomySettings();
		if (!research.enabled || mode === "off") return;

		try {
			await this.runResearchLaneOnce();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.deps.emit({ type: "warning", message: `Research lane failed: ${message}` });
		}
	}

	/** Capability profile for a specific lane model (lane budgets scale to the lane model's window). */
	private _laneCapabilityProfile(model: Model<Api>): ModelCapabilityProfile {
		return deriveModelCapabilityProfile({
			contextWindow: model.contextWindow,
			mode: this.deps.getSettingsManager().getModelCapabilitySettings().mode,
		});
	}

	/**
	 * Resolve the model for a background lane. Lanes are shipped BY this session, so they inherit
	 * the session's own model unless a lane-specific model is explicitly configured — a single-model
	 * setup (e.g. one local open model) runs its lanes on that same model. An explicitly configured
	 * pattern that cannot resolve/authenticate is a visible skip, not a silent fallback.
	 */
	resolveLaneModel(configuredPattern: string | undefined): Model<Api> | undefined {
		if (configuredPattern) {
			const resolved = resolveCliModel({ cliModel: configuredPattern, modelRegistry: this.deps.getModelRegistry() });
			if (resolved.model && this.deps.getModelRegistry().hasConfiguredAuth(resolved.model)) {
				return resolved.model;
			}
			return undefined;
		}
		return this.deps.getModel() ?? undefined;
	}

	/**
	 * Resolve what a lane ships with. Precedence: explicit lane model setting, then the lane
	 * profile's model (a shipped profile with a model MUST be obeyed — unresolvable is a visible
	 * skip, never a fallback), then generic inheritance of the session model.
	 */
	private _resolveLaneShipment(
		laneSettings: { model?: string; profile?: string },
		missingModelReason: string,
	): { ok: true; model: Model<Api>; laneProfile?: NormalizedProfile } | { ok: false; skipReason: string } {
		let laneProfile: NormalizedProfile | undefined;
		if (laneSettings.profile) {
			const profileRef = laneSettings.profile.trim();
			const registry = this.deps.getSettingsManager().getProfileRegistry();
			laneProfile =
				profileRef.startsWith("./") || profileRef.startsWith("../")
					? registry.resolveProfileRef(profileRef, this.deps.getCwd())
					: registry.getProfile(profileRef);
			if (!laneProfile) {
				return { ok: false, skipReason: "lane_profile_not_found" };
			}
		}

		let model: Model<Api> | undefined;
		if (laneSettings.model) {
			model = this.resolveLaneModel(laneSettings.model);
			if (!model) return { ok: false, skipReason: missingModelReason };
		} else if (laneProfile?.model) {
			model = this.resolveLaneModel(laneProfile.model);
			if (!model) return { ok: false, skipReason: "no_lane_profile_model" };
		} else {
			model = this.deps.getModel() ?? undefined;
			if (!model) return { ok: false, skipReason: missingModelReason };
		}
		if (this.deps.isModelExhausted(model)) {
			return { ok: false, skipReason: `${model.provider}/${model.id} model exhausted: quota` };
		}
		return { ok: true, model, laneProfile };
	}

	private _warnUnboundLaneToolGrants(laneProfile: NormalizedProfile | undefined, surface: LaneToolSurface): void {
		if (!laneProfile || surface.unboundAllowPatterns.length === 0) return;
		const warningKey = `${laneProfile.name}\0${[...surface.unboundAllowPatterns].sort().join("\0")}`;
		if (this._warnedUnboundLaneToolGrants.has(warningKey)) return;
		this._warnedUnboundLaneToolGrants.add(warningKey);
		this.deps.emit({
			type: "warning",
			message: `Lane profile '${laneProfile.name}' grants unavailable isolated-lane tools: ${surface.unboundAllowPatterns.join(", ")}. Only classified lane tools can execute.`,
		});
	}

	/** Stripped research envelope — never the foreground/architect envelope. */
	private _buildResearchLaneEnvelope(
		maxUsd: number,
		laneProfile: NormalizedProfile | undefined,
		surface: LaneToolSurface,
	): CapabilityEnvelope {
		return {
			id: `research-${this.deps.getSessionId()}-${Date.now()}`,
			profileId: laneProfile?.name,
			capabilities: ["research", "read_files", "memory_read"],
			allowedTools: [...surface.allowedTools],
			deniedTools: [...surface.deniedTools],
			allowedPaths: [this.deps.getCwd()],
			deniedPaths: getPrivateLaneDeniedPaths(this.deps.getCwd(), this.deps.getAgentDir()),
			maxEstimatedUsd: clampLaneMaxUsd(maxUsd, this.deps.getCapabilityEnvelope()?.maxEstimatedUsd),
			createdAt: new Date().toISOString(),
		};
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
		if (this._isResearchLaneRunning) {
			return { started: false, skipReason: "research_lane_already_running" };
		}
		if (this.deps.isDisposed()) {
			return { started: false, skipReason: "session_disposed" };
		}

		const settings = this.deps.getSettingsManager().getResearchLaneSettings();
		const demand = request?.query
			? { query: request.query, context: request.context ?? "", goalId: request.goalId }
			: this._buildResearchLaneDemand();
		if (!demand) {
			return { started: false, skipReason: this._lastResearchLaneSkipReason ?? "no_research_demand" };
		}

		const shipment = this._resolveLaneShipment(settings, "no_research_model");
		if (!shipment.ok) {
			this._lastResearchLaneSkipReason = shipment.skipReason;
			return { started: false, skipReason: shipment.skipReason };
		}
		const { model, laneProfile } = shipment;
		const laneCapability = this._laneCapabilityProfile(model);
		if (!laneCapability.backgroundLanesEnabled) {
			this._lastResearchLaneSkipReason = "model_research_unsupported";
			return { started: false, skipReason: "model_research_unsupported" };
		}

		this._isResearchLaneRunning = true;
		this._seedLaneHistory();
		const startedRecord = this._laneTracker.start({ type: "research", goalId: demand.goalId });
		this._persistedResearchRunCount++;
		// Registered for the lane's full run so the reload gate waits it out; deregistered in the
		// finally below no matter how this lane terminates (success, disposal, or a thrown error).
		const deregisterInFlight = registerInFlightWork(
			this.deps.getAgentDir(),
			"lane",
			`research:${startedRecord.laneId}`,
		);
		try {
			let spentUsage: Usage | undefined;
			// Best-effort, pointer-first workspace evidence. Derives search terms from the goal/requirement
			// text (not the identity-key query) and is bounded + silent-on-failure: [] == today's behavior.
			const workspaceSources = await this.deps.collectWorkspaceSources({
				query: `${demand.context}\n${demand.query}`,
				cwd: this.deps.getCwd(),
				maxSources: settings.maxSources,
			});
			const maxUsd = clampLaneMaxUsd(settings.maxUsd, this.deps.getCapabilityEnvelope()?.maxEstimatedUsd);
			const toolSurface = createLaneToolSurface({
				cwd: this.deps.getCwd(),
				profile: laneProfile,
				deniedPaths: getPrivateLaneDeniedPaths(this.deps.getCwd(), this.deps.getAgentDir()),
			});
			this._warnUnboundLaneToolGrants(laneProfile, toolSurface);
			const result = await runResearch({
				query: demand.query,
				context: demand.context,
				sources: workspaceSources,
				envelope: this._buildResearchLaneEnvelope(maxUsd, laneProfile, toolSurface),
				maxUsd,
				maxSources: settings.maxSources,
				maxFindings: settings.maxFindings,
				maxWallClockMs: settings.maxWallClockMs,
				signal: this._researchLaneAbort.signal,
				complete: async ({ systemPrompt, userPrompt, signal }) => {
					const completion = await this.deps.runIsolatedCompletion({
						// Level-0 core always survives; profile soul and role prompt are the replaceable
						// layers; a settings-provided prompt replaces everything above the core.
						systemPrompt: composeSubagentSystemPrompt({
							soul: laneProfile?.soul,
							rolePrompt: systemPrompt,
							override: settings.systemPrompt,
						}),
						messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
						model,
						thinkingLevel: laneProfile?.thinking ?? "off",
						maxTokens: laneCapability.laneMaxOutputTokens,
						tools: toolSurface.tools,
						maxTurns: 6,
						beforeToolCall: toolSurface.beforeToolCall,
						signal,
						// Core/soul/role are all static per configuration — the provider can cache the prefix.
						cacheRetention: "short",
						// Stable per-lane synthetic affinity key so repeat research calls route to the
						// same cache-warm backend without carrying the real session id.
						laneKind: "research",
					});
					spentUsage = completion.usage;
					return {
						text: completion.text,
						costUsd: completion.usage.cost.total,
						stopReason: String(completion.stopReason),
					};
				},
			});

			// If the session was disposed while the completion was in flight, do NOT
			// persist evidence/records/usage against the dead session.
			if (this.deps.isDisposed()) {
				const record = this._laneTracker.complete(startedRecord.laneId, {
					status: "canceled",
					reasonCode: "session_disposed",
				});
				return { started: true, record, result };
			}

			let evidenceEntryId: string | undefined;
			if (result.bundle) {
				evidenceEntryId = this.deps.saveEvidenceBundleSnapshot(result.bundle);
			}
			if (spentUsage && (spentUsage.cost.total > 0 || spentUsage.totalTokens > 0)) {
				this.deps.addSpawnedUsage(spentUsage, {
					label: "research-lane",
					reportId: `research:${this.deps.getSessionId()}:${startedRecord.laneId}`,
				});
			}

			const record = this._laneTracker.complete(startedRecord.laneId, {
				status: result.status,
				reasonCode: result.reasonCode,
				costUsd: result.costUsd,
				evidenceEntryId,
			});
			if (record) {
				appendLaneRecordSnapshot(this.deps.getSessionManager(), record);
				// A research lane's product is an evidence bundle, so its terminal record maps to
				// the evidence_bundle event. Lane outcome only (status/reasonCode/cost) — no findings text.
				this.deps.emitAutonomyTelemetry({
					type: AUTONOMY_TELEMETRY_EVENT_TYPES.evidenceBundle,
					timestamp: new Date().toISOString(),
					payload: {
						laneId: record.laneId,
						laneType: record.type,
						status: record.status,
						reasonCode: record.reasonCode ?? null,
						costUsd: record.costUsd ?? null,
						hasEvidence: record.evidenceEntryId !== undefined,
					},
				});
			}
			return { started: true, record, result };
		} catch (error) {
			const record = this._laneTracker.complete(startedRecord.laneId, {
				status: "failed",
				reasonCode: "research_lane_error",
			});
			if (record && !this.deps.isDisposed()) {
				appendLaneRecordSnapshot(this.deps.getSessionManager(), record);
				this.deps.emitAutonomyTelemetry({
					type: AUTONOMY_TELEMETRY_EVENT_TYPES.evidenceBundle,
					timestamp: new Date().toISOString(),
					payload: {
						laneId: record.laneId,
						laneType: record.type,
						status: record.status,
						reasonCode: record.reasonCode ?? null,
						costUsd: record.costUsd ?? null,
						hasEvidence: record.evidenceEntryId !== undefined,
					},
				});
			}
			const message = error instanceof Error ? error.message : String(error);
			this.deps.emit({ type: "warning", message: `Research lane failed: ${message}` });
			return { started: true, record };
		} finally {
			this._isResearchLaneRunning = false;
			deregisterInFlight();
		}
	}

	/**
	 * Run one bounded scout-worker delegation: build a WorkerRequest with a stripped read-only
	 * envelope, execute it as an isolated completion on a cheap lane, validate the result via
	 * {@link validateWorkerResult} before acceptance, and persist result + lane record + spawned
	 * usage (idempotent per-lane reportId). Consumed by the `delegate` tool.
	 */
	startWorkerDelegation(request: {
		instructions: string;
		/** Model-provided replacement for the worker role prompt (the level-0 core always remains). */
		systemPrompt?: string;
		/** Orchestrator-requested read-only memory access; the lane profile may still deny it. */
		memoryRead?: boolean;
	}): { started: false; skipReason: string } | { started: true; record: LaneRecord } {
		const settings = this.deps.getSettingsManager().getWorkerDelegationSettings();
		if (this.deps.isDisposed()) return { started: false, skipReason: "session_disposed" };
		if (request.instructions.trim().length === 0) return { started: false, skipReason: "missing_instructions" };
		if (!this.deps.isDelegateToolActive()) return { started: false, skipReason: "delegate_tool_inactive" };
		if (!settings.enabled) return { started: false, skipReason: "worker_delegation_disabled" };
		const shipment = this._resolveLaneShipment(settings, "no_worker_model");
		if (!shipment.ok) return { started: false, skipReason: shipment.skipReason };
		if (!this._laneCapabilityProfile(shipment.model).backgroundLanesEnabled) {
			return { started: false, skipReason: "model_delegation_unsupported" };
		}

		const foreground = this.deps.getModel();
		const contendsWithLocalForeground =
			foreground !== undefined && isLocalExecutionModel(foreground) && isLocalExecutionModel(shipment.model);
		if (contendsWithLocalForeground) {
			if (
				this._queuedWorkers.size >= 8 ||
				this._laneTracker.getActiveCount("worker") >= settings.maxConcurrent + 8
			) {
				return { started: false, skipReason: "worker_delegation_queue_full" };
			}
			const record = this._laneTracker.enqueue({ type: "worker", goalId: this.deps.getGoalStateSnapshot()?.goalId });
			this._queuedWorkers.set(record.laneId, request);
			// Register the reload-gate quiesce unit at ENQUEUE (not at the later running handoff)
			// so `/reload` waits for queued-but-not-yet-started work too, matching running workers.
			this._queuedWorkerDeregisters.set(
				record.laneId,
				registerInFlightWork(this.deps.getAgentDir(), "lane", `worker-queued:${record.laneId}`),
			);
			this._scheduleWorkerNotification();
			return { started: true, record };
		}
		if (this._laneTracker.getRunningCount("worker") >= settings.maxConcurrent) {
			return { started: false, skipReason: "worker_delegation_already_running" };
		}
		let startedRecord: LaneRecord | undefined;
		const promise = this.runWorkerDelegationOnce(request, (record) => {
			startedRecord = record;
		});
		if (!startedRecord) {
			// Preparation is synchronous up to the first isolated completion await. A promise that
			// rejected before producing a lane is still observed below, so it cannot become unhandled.
			void promise.catch(() => undefined);
			return { started: false, skipReason: "worker_not_started" };
		}
		this._workerPromises.set(startedRecord.laneId, promise);
		void promise.then(
			() => this._workerPromises.delete(startedRecord?.laneId ?? ""),
			() => this._workerPromises.delete(startedRecord?.laneId ?? ""),
		);
		return { started: true, record: startedRecord };
	}

	async runWorkerDelegationOnce(
		request: {
			instructions: string;
			/** Model-provided replacement for the worker role prompt (the level-0 core always remains). */
			systemPrompt?: string;
			/** Orchestrator-requested read-only memory access; the lane profile may still deny it. */
			memoryRead?: boolean;
		},
		onStarted?: (record: LaneRecord) => void,
		existingRecord?: LaneRecord,
	): Promise<WorkerDelegationRunOutcome> {
		const delegationSettings = this.deps.getSettingsManager().getWorkerDelegationSettings();
		const runningWorkers = this._laneTracker.getRunningCount("worker");
		if (runningWorkers >= delegationSettings.maxConcurrent) {
			return { started: false, skipReason: "worker_delegation_already_running" };
		}
		if (this.deps.isDisposed()) {
			return { started: false, skipReason: "session_disposed" };
		}
		const instructions = request.instructions.trim();
		if (instructions.length === 0) {
			return { started: false, skipReason: "missing_instructions" };
		}

		const settings = delegationSettings;
		if (!this.deps.isDelegateToolActive()) {
			return { started: false, skipReason: "delegate_tool_inactive" };
		}
		if (!settings.enabled) {
			return { started: false, skipReason: "worker_delegation_disabled" };
		}

		const shipment = this._resolveLaneShipment(settings, "no_worker_model");
		if (!shipment.ok) {
			return { started: false, skipReason: shipment.skipReason };
		}
		const { model, laneProfile } = shipment;
		const laneCapability = this._laneCapabilityProfile(model);
		if (!laneCapability.backgroundLanesEnabled) {
			return { started: false, skipReason: "model_delegation_unsupported" };
		}

		this._seedLaneHistory();
		const startedRecord =
			existingRecord ??
			this._laneTracker.start({ type: "worker", goalId: this.deps.getGoalStateSnapshot()?.goalId });
		if (existingRecord) this._laneTracker.markRunning(existingRecord.laneId);
		onStarted?.(startedRecord);
		const maxUsd = Math.min(
			settings.maxUsd,
			this.deps.getCapabilityEnvelope()?.maxEstimatedUsd ?? Number.POSITIVE_INFINITY,
		);
		const writeEnabled = settings.writeEnabled && settings.writePaths.length > 0;
		const toolSurface = createLaneToolSurface({
			cwd: this.deps.getCwd(),
			profile: laneProfile,
			deniedPaths: getPrivateLaneDeniedPaths(this.deps.getCwd(), this.deps.getAgentDir()),
			readMemory: request.memoryRead ? (query) => this.deps.readMemoryForLane(query) : undefined,
			writeEnabled,
			writePaths: settings.writePaths,
		});
		this._warnUnboundLaneToolGrants(laneProfile, toolSurface);
		const allowedActionOps = new Set<WorkerAction["op"]>(
			toolSurface.allowedTools.filter((name): name is WorkerAction["op"] => name === "write" || name === "edit"),
		);
		const writeGranted = writeEnabled && allowedActionOps.size > 0;
		const memoryReadGranted = request.memoryRead === true && toolSurface.allowedTools.includes("memory");
		const workerRequest: WorkerRequest = {
			id: startedRecord.laneId,
			instructions,
			route: {
				tier: "cheap",
				risk: writeGranted ? "scoped-write" : "read-only",
				confidence: 1,
				reasonCode: "scout_worker",
				reasons: [writeGranted ? "Path-scoped worker delegation" : "Read-only scout delegation"],
			},
			envelope: {
				id: `worker-${this.deps.getSessionId()}-${startedRecord.laneId}`,
				profileId: laneProfile?.name,
				// write_files requires BOTH the opt-in AND an explicit non-empty path scope —
				// an unscoped write grant is refused here, not discovered at validation time.
				capabilities: [
					"read_files",
					...(memoryReadGranted ? (["memory_read"] as const) : []),
					...(writeGranted ? (["write_files"] as const) : []),
				],
				...(writeGranted ? { allowedPaths: [...settings.writePaths] } : {}),
				deniedPaths: getPrivateLaneDeniedPaths(this.deps.getCwd(), this.deps.getAgentDir()),
				allowedTools: [...toolSurface.allowedTools],
				deniedTools: [...toolSurface.deniedTools],
				maxEstimatedUsd: maxUsd,
				createdAt: new Date().toISOString(),
			},
			maxEstimatedUsd: maxUsd,
			createdAt: new Date().toISOString(),
		};
		// Worker delegation START. Routing/scope codes + budget only — never the instructions text.
		this.deps.emitAutonomyTelemetry({
			type: AUTONOMY_TELEMETRY_EVENT_TYPES.workerRequest,
			timestamp: new Date().toISOString(),
			payload: {
				id: workerRequest.id,
				tier: workerRequest.route.tier,
				capabilities: [...workerRequest.envelope.capabilities],
				maxEstimatedUsd: workerRequest.maxEstimatedUsd ?? null,
			},
		});
		const usageReportId = `worker:${this.deps.getSessionId()}:${startedRecord.laneId}`;

		// Registered for the lane's full run so the reload gate waits it out; deregistered in the
		// finally below no matter how this lane terminates (success, disposal, or a thrown error).
		// registerInFlightWork is a pure sync map op (cannot throw), so placing it as the last
		// statement before `try` still guarantees the matching finally always runs.
		const deregisterInFlight = registerInFlightWork(
			this.deps.getAgentDir(),
			"lane",
			`worker:${startedRecord.laneId}`,
		);
		try {
			let spentUsage: Usage | undefined;
			const toolChangedFiles = new Set<string>();
			const toolIssues = new Set<string>();
			// Register the live mutation ledger BEFORE the suspend point below so a synchronous
			// disposal cutoff (`abortInFlightLanes`) can read a race-free snapshot of whatever this
			// worker has already applied — the worker is suspended at the `await runWorker(...)` below
			// whenever abort runs, and the abort signal stops further tool calls. Deleted in the
			// `finally` on every exit path (normal completion, throw, or already consumed by abort).
			this._inFlightWorkerLedgers.set(startedRecord.laneId, {
				changedFiles: toolChangedFiles,
				getSpend: () => spentUsage,
				request: workerRequest,
			});
			const outcome = await runWorker({
				request: workerRequest,
				maxUsd,
				maxWallClockMs: settings.maxWallClockMs,
				usageReportId,
				getChangedFiles: () => [...toolChangedFiles],
				signal: this._workerDelegationAbort.signal,
				// Parent validation must use the same relative-path baseline the runner reports in.
				cwd: this.deps.getCwd(),
				// Write lane: runner-side action application through the envelope path scope.
				applyActions: workerRequest.envelope.capabilities.includes("write_files")
					? (actions) => {
							const permitted = actions.filter((action) => allowedActionOps.has(action.op));
							const applied = applyWorkerActions({
								actions: permitted,
								envelope: workerRequest.envelope,
								cwd: this.deps.getCwd(),
							});
							return {
								...applied,
								refused: [
									...actions
										.filter((action) => !allowedActionOps.has(action.op))
										.map((action) => ({
											path: action.path,
											reason: `${action.op} is not granted by the lane profile`,
										})),
									...applied.refused,
								],
							};
						}
					: undefined,
				complete: async ({ systemPrompt, userPrompt, signal }) => {
					const completion = await this.deps.runIsolatedCompletion({
						// Level-0 core always survives. A model-provided prompt (delegate tool) is the most
						// specific override, then the settings-level prompt, then profile soul + role prompt.
						systemPrompt: composeSubagentSystemPrompt({
							soul: laneProfile?.soul,
							rolePrompt: systemPrompt,
							override: request.systemPrompt ?? settings.systemPrompt,
						}),
						messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
						model,
						thinkingLevel: laneProfile?.thinking ?? "off",
						maxTokens: laneCapability.laneMaxOutputTokens,
						tools: toolSurface.tools,
						maxTurns: 6,
						finalTextPrompt:
							"The tool-turn budget is exhausted. Do not call more tools. Return the required worker-result JSON envelope now using only evidence already gathered. If the investigation is incomplete, say so in the summary or blockers instead of omitting the envelope.",
						beforeToolCall: async (context, toolSignal) => {
							const decision = await toolSurface.beforeToolCall(context, toolSignal);
							if (decision?.block) {
								toolIssues.add(`${context.toolCall.name} blocked: ${decision.reason ?? "capability denied"}`);
							}
							return decision;
						},
						afterToolCall: async ({ toolCall, args, isError }) => {
							// This hook runs only for a validated, gate-approved tool that actually entered
							// execution. Record a direct mutation target before inspecting `isError`: write/edit
							// may have changed disk and then observed cancellation, timeout, or a late I/O error.
							// Pre-gate/profile/path refusals never reach afterToolCall, so they remain unreported.
							if (toolCall.name === "write" || toolCall.name === "edit") {
								if (args && typeof args === "object" && !Array.isArray(args)) {
									const rawPath = (args as Record<string, unknown>).path;
									if (typeof rawPath === "string" && rawPath.length > 0) {
										const absolutePath = path.isAbsolute(rawPath)
											? path.resolve(rawPath)
											: path.resolve(this.deps.getCwd(), rawPath);
										let canonicalPath = absolutePath;
										try {
											canonicalPath = safeRealpathSync(absolutePath);
										} catch {
											// Execution was attempted; preserve conservative accounting with the lexical path.
										}
										toolChangedFiles.add(
											path.relative(this.deps.getCwd(), canonicalPath).split(path.sep).join("/"),
										);
									}
								}
							}
							if (isError) {
								toolIssues.add(`${toolCall.name} failed during isolated execution`);
								return undefined;
							}
							return undefined;
						},
						signal,
						// Core/soul/role are all static per configuration — the provider can cache the prefix.
						cacheRetention: "short",
						// Stable per-lane synthetic affinity key so repeat worker-delegation calls route to
						// the same cache-warm backend without carrying the real session id.
						laneKind: "worker",
					});
					spentUsage = completion.usage;
					return {
						text: completion.text,
						costUsd: completion.usage.cost.total,
						stopReason: String(completion.stopReason),
						changedFiles: [...toolChangedFiles],
						blockers: [...toolIssues],
					};
				},
			});

			// Never persist against a disposed session. When disposal raced this
			// await, `abortInFlightLanes()`'s synchronous cutoff already completed this lane, persisted
			// its durable lane record + bounded WorkerResult, and consumed (deleted) the ledger —
			// `.complete()` below is then a no-op (the lane is already terminal, so it returns
			// undefined) and no double persistence or duplicate terminal notification can happen here.
			if (this.deps.isDisposed()) {
				const record = this._laneTracker.complete(startedRecord.laneId, {
					status: "canceled",
					reasonCode: "session_disposed",
				});
				if (record) this._recordWorkerTerminal(record);
				return { started: true, record, outcome };
			}

			this.deps.saveWorkerResultSnapshot(outcome.result, workerRequest);
			if (spentUsage && (spentUsage.cost.total > 0 || spentUsage.totalTokens > 0)) {
				this.deps.addSpawnedUsage(spentUsage, { label: "worker-delegation", reportId: usageReportId });
			}

			const record = this._laneTracker.complete(startedRecord.laneId, {
				status: outcome.laneStatus,
				reasonCode: outcome.reasonCode,
				costUsd: outcome.costUsd,
			});
			if (record) {
				this._recordWorkerTerminal(record);
				appendLaneRecordSnapshot(this.deps.getSessionManager(), record);
				// Worker lane terminal record -> worker_result event. Lane outcome only
				// (status/reasonCode/cost) — never the worker's summary/changed-file text.
				this.deps.emitAutonomyTelemetry({
					type: AUTONOMY_TELEMETRY_EVENT_TYPES.workerResult,
					timestamp: new Date().toISOString(),
					payload: {
						laneId: record.laneId,
						laneType: record.type,
						status: record.status,
						reasonCode: record.reasonCode ?? null,
						costUsd: record.costUsd ?? null,
					},
				});
			}
			return { started: true, record, outcome };
		} catch (error) {
			const record = this._laneTracker.complete(startedRecord.laneId, {
				status: "failed",
				reasonCode: "worker_delegation_error",
			});
			if (record) this._recordWorkerTerminal(record);
			if (record && !this.deps.isDisposed()) {
				appendLaneRecordSnapshot(this.deps.getSessionManager(), record);
				this.deps.emitAutonomyTelemetry({
					type: AUTONOMY_TELEMETRY_EVENT_TYPES.workerResult,
					timestamp: new Date().toISOString(),
					payload: {
						laneId: record.laneId,
						laneType: record.type,
						status: record.status,
						reasonCode: record.reasonCode ?? null,
						costUsd: record.costUsd ?? null,
					},
				});
			}
			const message = error instanceof Error ? error.message : String(error);
			this.deps.emit({ type: "warning", message: `Worker delegation failed: ${message}` });
			return { started: true, record };
		} finally {
			this._inFlightWorkerLedgers.delete(startedRecord.laneId);
			deregisterInFlight();
		}
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
		if (this.deps.isDisposed()) return { started: false, skipReason: "session_disposed" };
		const resolved = this.resolveLaneModel(args.model.trim() || undefined);
		if (!resolved) return { started: false, skipReason: "model_unresolved_or_unauthenticated" };
		const capability = this._laneCapabilityProfile(resolved);

		// Registered for the probe's full run (it can execute several isolated-completion trials)
		// so the reload gate waits it out; deregistered in the finally below on any exit path. Unlike
		// research/worker, a fitness probe is not tracked in `_laneTracker` (it has no persisted lane
		// record), so this registry is its ONLY reload-gate visibility.
		const deregisterInFlight = registerInFlightWork(
			this.deps.getAgentDir(),
			"lane",
			`fitness:${resolved.provider}/${resolved.id}`,
		);
		try {
			const spent: Usage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			const report = await runModelFitnessProbe({
				trials: args.trials,
				signal: this._researchLaneAbort.signal,
				capacityProbe:
					resolved.provider === "ollama" && resolved.contextWindow > 0
						? { registeredContextWindow: resolved.contextWindow }
						: undefined,
				complete: async ({ systemPrompt, userPrompt, signal }) => {
					const callStarted = Date.now();
					const completion = await this.deps.runIsolatedCompletion({
						systemPrompt,
						messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
						model: resolved,
						thinkingLevel: "off",
						maxTokens: capability.laneMaxOutputTokens,
						signal,
						cacheRetention: "short",
						// Stable per-lane synthetic affinity key so repeat fitness-probe trials against the
						// same candidate model route to the same cache-warm backend without carrying the real
						// session id.
						laneKind: "fitness",
					});
					const callMs = Date.now() - callStarted;
					spent.input += completion.usage.input;
					spent.output += completion.usage.output;
					spent.cacheRead += completion.usage.cacheRead;
					spent.cacheWrite += completion.usage.cacheWrite;
					spent.totalTokens += completion.usage.totalTokens;
					spent.cost.input += completion.usage.cost.input;
					spent.cost.output += completion.usage.cost.output;
					spent.cost.cacheRead += completion.usage.cost.cacheRead;
					spent.cost.cacheWrite += completion.usage.cost.cacheWrite;
					spent.cost.total += completion.usage.cost.total;
					return {
						text: completion.text,
						costUsd: completion.usage.cost.total,
						stopReason: String(completion.stopReason),
						// Wall-clock fallback for tok/s: providers don't expose pure eval time, so the
						// measured call time stands in — slightly conservative (includes network/queue).
						outputTokens: completion.usage.output,
						evalMs: callMs,
					};
				},
			});
			const modelRef = `${resolved.provider}/${resolved.id}`;
			if (!this.deps.isDisposed() && (spent.cost.total > 0 || spent.totalTokens > 0)) {
				// Prefer the LLM tool-call id as the idempotency token: it is assigned once per
				// distinct model_fitness tool call, so two deliberately separate calls on the same
				// (model, trials) get DISTINCT ids (both count) while a retry of the same tool call
				// (same toolCallId) keeps the same id (deduped). Callers with no toolCallId (the manual
				// /fitness command, the auto-probe-on-model-add flows in local-model-commands.ts) fall
				// back to the (model, trials) identity, unchanged from before.
				const identity = args.toolCallId
					? `toolcall:${args.toolCallId}`
					: `${modelRef} ${args.trials ?? "default"}`;
				const reportId = deriveSpawnedUsageReportId("model-fitness", this.deps.getSessionId(), identity);
				this.deps.addSpawnedUsage(spent, { label: "model-fitness", reportId });
			}
			// Fitness is a property of a model ON a host — persist the report host-keyed so role
			// assignments stay per-machine (a model can await better hardware without being forgotten).
			// Best-effort: a disk problem must not fail the probe itself.
			try {
				if (!this.deps.isDisposed()) {
					FitnessStore.forAgentDir(this.deps.getAgentDir()).save(modelRef, report);
				}
			} catch {
				// best-effort persistence
			}
			return { started: true, model: modelRef, report };
		} finally {
			deregisterInFlight();
		}
	}

	/** Start queued local workers at the owner session's foreground-idle boundary. */
	drainQueuedWorkerDelegations(): void {
		for (const [laneId, request] of [...this._queuedWorkers]) {
			if (
				this._laneTracker.getRunningCount("worker") >=
				this.deps.getSettingsManager().getWorkerDelegationSettings().maxConcurrent
			)
				break;
			const record = this._laneTracker.getRecords().find((candidate) => candidate.laneId === laneId);
			// The queued-phase reload-gate registration ends here, at the running handoff, no
			// matter which branch below runs. `runWorkerDelegationOnce` registers its OWN "running"
			// unit independently and synchronously (no `await` separates the two calls), so there is
			// no window where this lane is invisible to the reload gate.
			const deregisterQueued = this._queuedWorkerDeregisters.get(laneId);
			this._queuedWorkerDeregisters.delete(laneId);
			if (!record) {
				this._queuedWorkers.delete(laneId);
				deregisterQueued?.();
				continue;
			}
			this._queuedWorkers.delete(laneId);
			deregisterQueued?.();
			const promise = this.runWorkerDelegationOnce(request, undefined, record);
			this._workerPromises.set(laneId, promise);
			void promise.then(
				(outcome) => {
					if (!outcome.started) {
						const terminal = this._laneTracker.complete(laneId, {
							status: "canceled",
							reasonCode: outcome.skipReason,
						});
						if (terminal) this._recordWorkerTerminal(terminal);
					}
					this._workerPromises.delete(laneId);
					if (!this.deps.isDisposed()) this.drainQueuedWorkerDelegations();
				},
				() => {
					const terminal = this._laneTracker.complete(laneId, {
						status: "failed",
						reasonCode: "worker_background_error",
					});
					if (terminal) this._recordWorkerTerminal(terminal);
					this._workerPromises.delete(laneId);
					if (!this.deps.isDisposed()) this.drainQueuedWorkerDelegations();
				},
			);
		}
	}

	/** Fitness reports persisted for THIS host (measured evidence for architect/profile decisions). */
	getStoredFitnessReports(): StoredFitnessReport[] {
		try {
			return FitnessStore.forAgentDir(this.deps.getAgentDir()).getForHost();
		} catch {
			return [];
		}
	}
}
