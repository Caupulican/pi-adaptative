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
import type { CapabilityEnvelope, EvidenceBundle, WorkerRequest, WorkerResult } from "./autonomy/contracts.ts";
import { type LaneRecord, LaneTracker } from "./autonomy/lane-tracker.ts";
import { appendLaneRecordSnapshot, getLaneRecordSnapshots } from "./autonomy/session-lane-record.ts";
import { composeSubagentSystemPrompt } from "./autonomy/subagent-prompt.ts";
import { AUTONOMY_TELEMETRY_EVENT_TYPES, type AutonomyTelemetryEvent } from "./autonomy/telemetry-events.ts";
import { applyWorkerActions } from "./delegation/worker-actions.ts";
import { runWorker } from "./delegation/worker-runner.ts";
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
import { type ModelFitnessReport, runModelFitnessProbe } from "./research/model-fitness.ts";
import { runResearch } from "./research/research-runner.ts";
import type { collectWorkspaceSources } from "./research/workspace-collector.ts";
import type { SettingsManager } from "./settings-manager.ts";

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
	/** Foreground cost ceiling — a lane budget is clamped to it, never exceeds it. */
	getCapabilityEnvelope(): CapabilityEnvelope | undefined;
	/** Capability profile of the SESSION model (gates background lanes, scales continuation budgets). */
	getModelCapabilityProfile(): ModelCapabilityProfile;
	/** Emits a session event (only `warning` from this controller). */
	emit(event: AgentSessionEvent): void;
	/** G3/G8 telemetry sink (codes/ids only — never lane product text). */
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
	/** Roll a lane's spawned usage into session accounting (idempotent per reportId). */
	addSpawnedUsage(
		usage: Usage,
		opts?: { label?: string; sourceSessionId?: string; reportId?: string },
	): string | undefined;
	/** One-shot LLM call fully isolated from the main session — the lane execution primitive. */
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
	/** Session-lifetime abort for in-flight research passes (same pattern as _reflectionAbort). */
	private readonly _researchLaneAbort = new AbortController();
	/** Session-lifetime abort for in-flight delegated workers. */
	private readonly _workerDelegationAbort = new AbortController();

	private readonly deps: BackgroundLaneControllerDeps;

	constructor(deps: BackgroundLaneControllerDeps) {
		this.deps = deps;
	}

	/** Live lane records tracked by this process (running and terminal). */
	getLaneRecords(): LaneRecord[] {
		return this._laneTracker.getRecords();
	}

	/** Live count of active lanes — the real source for AutonomyStatusSnapshot.activeLaneCount. */
	getActiveLaneCount(): number {
		return this._laneTracker.getActiveCount();
	}

	/** Why the last idle research-lane evaluation skipped, for /autonomy diagnostics. */
	getLastResearchLaneSkipReason(): string | undefined {
		return this._lastResearchLaneSkipReason;
	}

	/** Abort any in-flight research pass or delegated worker (called on session dispose). */
	abortInFlightLanes(): void {
		this._researchLaneAbort.abort();
		this._workerDelegationAbort.abort();
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

		this._isGoalAutoContinuing = true;
		try {
			await this.deps.continueGoalLoop({
				maxTurns: scaled.maxTurns,
				maxStallTurns,
				maxWallClockMinutes: scaled.maxWallClockMinutes,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.deps.emit({ type: "warning", message: `Goal auto-continuation failed: ${message}` });
		} finally {
			this._isGoalAutoContinuing = false;
		}
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

		if (!this.deps.getModelCapabilityProfile().backgroundLanesEnabled) {
			this._lastResearchLaneSkipReason = "model_context_too_small";
			return;
		}

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
		const priorRuns = getLaneRecordSnapshots(this.deps.getSessionManager().getEntries()).filter(
			(record) => record.type === "research",
		).length;
		if (priorRuns >= research.maxRunsPerSession) {
			this._lastResearchLaneSkipReason = "max_runs_reached";
			return;
		}
		if (!this._buildResearchLaneDemand()) return;

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
			laneProfile = this.deps.getSettingsManager().getProfileRegistry().getProfile(laneSettings.profile);
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

	/** UAC tool grants from a shipped lane profile, recorded on the lane envelope. */
	private _laneProfileToolGrants(
		laneProfile?: NormalizedProfile,
	): Pick<CapabilityEnvelope, "allowedTools" | "deniedTools"> {
		const toolsFilter = laneProfile?.resources.tools;
		return {
			...(toolsFilter?.allow && toolsFilter.allow.length > 0 ? { allowedTools: [...toolsFilter.allow] } : {}),
			...(toolsFilter?.block && toolsFilter.block.length > 0 ? { deniedTools: [...toolsFilter.block] } : {}),
		};
	}

	/** Stripped research envelope — never the foreground/architect envelope. */
	private _buildResearchLaneEnvelope(maxUsd: number, laneProfile?: NormalizedProfile): CapabilityEnvelope {
		return {
			id: `research-${this.deps.getSessionId()}-${Date.now()}`,
			profileId: laneProfile?.name,
			capabilities: ["research", "read_files", "memory_read"],
			...this._laneProfileToolGrants(laneProfile),
			maxEstimatedUsd: Math.min(
				maxUsd,
				this.deps.getCapabilityEnvelope()?.maxEstimatedUsd ?? Number.POSITIVE_INFINITY,
			),
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

		this._isResearchLaneRunning = true;
		this._laneTracker.ensureCounterAtLeast(
			getLaneRecordSnapshots(this.deps.getSessionManager().getEntries()).length + 1,
		);
		const startedRecord = this._laneTracker.start({ type: "research", goalId: demand.goalId });
		try {
			let spentUsage: Usage | undefined;
			// Best-effort, pointer-first workspace evidence. Derives search terms from the goal/requirement
			// text (not the identity-key query) and is bounded + silent-on-failure: [] == today's behavior.
			const workspaceSources = await this.deps.collectWorkspaceSources({
				query: `${demand.context}\n${demand.query}`,
				cwd: this.deps.getCwd(),
				maxSources: settings.maxSources,
			});
			const result = await runResearch({
				query: demand.query,
				context: demand.context,
				sources: workspaceSources,
				envelope: this._buildResearchLaneEnvelope(settings.maxUsd, laneProfile),
				maxUsd: settings.maxUsd,
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
						maxTokens: this._laneCapabilityProfile(model).laneMaxOutputTokens,
						signal,
						// Core/soul/role are all static per configuration — the provider can cache the prefix.
						cacheRetention: "short",
					});
					spentUsage = completion.usage;
					return {
						text: completion.text,
						costUsd: completion.usage.cost.total,
						stopReason: String(completion.stopReason),
					};
				},
			});

			// Bug #21 pattern: if the session was disposed while the completion was in flight, do NOT
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
				// G3: a research lane's product is an evidence bundle, so its terminal record maps to
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
		}
	}

	/**
	 * Run one bounded scout-worker delegation: build a WorkerRequest with a stripped read-only
	 * envelope, execute it as an isolated completion on a cheap lane, validate the result via
	 * {@link validateWorkerResult} before acceptance, and persist result + lane record + spawned
	 * usage (idempotent per-lane reportId). Consumed by the `delegate` tool.
	 */
	async runWorkerDelegationOnce(request: {
		instructions: string;
		/** Model-provided replacement for the worker role prompt (the level-0 core always remains). */
		systemPrompt?: string;
	}): Promise<WorkerDelegationRunOutcome> {
		const delegationSettings = this.deps.getSettingsManager().getWorkerDelegationSettings();
		if (this._laneTracker.getActiveCount("worker") >= delegationSettings.maxConcurrent) {
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
		if (!settings.enabled) {
			return { started: false, skipReason: "worker_delegation_disabled" };
		}

		const shipment = this._resolveLaneShipment(settings, "no_worker_model");
		if (!shipment.ok) {
			return { started: false, skipReason: shipment.skipReason };
		}
		const { model, laneProfile } = shipment;

		this._laneTracker.ensureCounterAtLeast(
			getLaneRecordSnapshots(this.deps.getSessionManager().getEntries()).length + 1,
		);
		const startedRecord = this._laneTracker.start({ type: "worker" });
		const maxUsd = Math.min(
			settings.maxUsd,
			this.deps.getCapabilityEnvelope()?.maxEstimatedUsd ?? Number.POSITIVE_INFINITY,
		);
		const workerRequest: WorkerRequest = {
			id: startedRecord.laneId,
			instructions,
			route: {
				tier: "cheap",
				risk: "read-only",
				confidence: 1,
				reasonCode: "scout_worker",
				reasons: ["Read-only scout delegation"],
			},
			envelope: {
				id: `worker-${this.deps.getSessionId()}-${startedRecord.laneId}`,
				profileId: laneProfile?.name,
				// write_files requires BOTH the opt-in AND an explicit non-empty path scope —
				// an unscoped write grant is refused here, not discovered at validation time.
				capabilities:
					settings.writeEnabled && settings.writePaths.length > 0 ? ["read_files", "write_files"] : ["read_files"],
				...(settings.writeEnabled && settings.writePaths.length > 0
					? { allowedPaths: [...settings.writePaths] }
					: {}),
				...this._laneProfileToolGrants(laneProfile),
				maxEstimatedUsd: maxUsd,
				createdAt: new Date().toISOString(),
			},
			maxEstimatedUsd: maxUsd,
			createdAt: new Date().toISOString(),
		};
		// G8: worker delegation START. Routing/scope codes + budget only — never the instructions text.
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

		try {
			let spentUsage: Usage | undefined;
			const outcome = await runWorker({
				request: workerRequest,
				maxUsd,
				maxWallClockMs: settings.maxWallClockMs,
				usageReportId,
				signal: this._workerDelegationAbort.signal,
				// Parent validation must use the same relative-path baseline the runner reports in.
				cwd: this.deps.getCwd(),
				// Write lane (G2): runner-side action application through the envelope path scope.
				applyActions: workerRequest.envelope.capabilities.includes("write_files")
					? (actions) => applyWorkerActions({ actions, envelope: workerRequest.envelope, cwd: this.deps.getCwd() })
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
						maxTokens: this._laneCapabilityProfile(model).laneMaxOutputTokens,
						signal,
						// Core/soul/role are all static per configuration — the provider can cache the prefix.
						cacheRetention: "short",
					});
					spentUsage = completion.usage;
					return {
						text: completion.text,
						costUsd: completion.usage.cost.total,
						stopReason: String(completion.stopReason),
					};
				},
			});

			// Bug #21 pattern: never persist against a disposed session.
			if (this.deps.isDisposed()) {
				const record = this._laneTracker.complete(startedRecord.laneId, {
					status: "canceled",
					reasonCode: "session_disposed",
				});
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
				appendLaneRecordSnapshot(this.deps.getSessionManager(), record);
				// G3: worker lane terminal record -> worker_result event. Lane outcome only
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
	}): Promise<{ started: true; model: string; report: ModelFitnessReport } | { started: false; skipReason: string }> {
		if (this.deps.isDisposed()) return { started: false, skipReason: "session_disposed" };
		const resolved = this.resolveLaneModel(args.model.trim() || undefined);
		if (!resolved) return { started: false, skipReason: "model_unresolved_or_unauthenticated" };
		const capability = this._laneCapabilityProfile(resolved);

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
		if (!this.deps.isDisposed() && (spent.cost.total > 0 || spent.totalTokens > 0)) {
			this.deps.addSpawnedUsage(spent, { label: "model-fitness" });
		}
		const modelRef = `${resolved.provider}/${resolved.id}`;
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
