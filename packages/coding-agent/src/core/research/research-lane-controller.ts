import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { resolveModelThinkingLevel, type Usage } from "@caupulican/pi-ai";
import type {
	AgentSessionEvent,
	IsolatedCompletionOptions,
	IsolatedCompletionResult,
	ResearchLaneRunOutcome,
} from "../agent-session.ts";
import type { CapabilityEnvelope, EvidenceBundle } from "../autonomy/contracts.ts";
import { getPrivateLaneDeniedPaths } from "../autonomy/lane-private-paths.ts";
import { createLaneToolSurface, type LaneToolSurface } from "../autonomy/lane-tool-surface.ts";
import type { LaneTracker } from "../autonomy/lane-tracker.ts";
import { appendLaneRecordSnapshot, getLaneRecordSnapshots } from "../autonomy/session-lane-record.ts";
import { composeSubagentSystemPrompt } from "../autonomy/subagent-prompt.ts";
import { AUTONOMY_TELEMETRY_EVENT_TYPES, type AutonomyTelemetryEvent } from "../autonomy/telemetry-events.ts";
import type { GoalState } from "../goals/goal-state.ts";
import type { NormalizedProfile } from "../profile-registry.ts";
import { registerInFlightWork } from "../reload-blockers.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { clampLaneMaxUsd, type LaneModelResolver } from "./lane-model-resolver.ts";
import { runResearch } from "./research-runner.ts";
import type { collectWorkspaceSources } from "./workspace-collector.ts";

export interface ResearchLaneControllerDeps {
	isDisposed(): boolean;
	isChildSession(): boolean;
	getSessionId(): string;
	getCwd(): string;
	getAgentDir(): string;
	getSessionManager(): SessionManager;
	getSettingsManager(): SettingsManager;
	getCapabilityEnvelope(): CapabilityEnvelope | undefined;
	emit(event: AgentSessionEvent): void;
	emitAutonomyTelemetry(event: AutonomyTelemetryEvent): void;
	getGoalStateSnapshot(): GoalState | undefined;
	getEvidenceBundleSnapshot(): EvidenceBundle | undefined;
	saveEvidenceBundleSnapshot(bundle: EvidenceBundle): string;
	addSpawnedUsage(
		usage: Usage,
		opts: { label?: string; sourceSessionId?: string; reportId: string },
	): string | undefined;
	runIsolatedCompletion(opts: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
	collectWorkspaceSources: typeof collectWorkspaceSources;
}

/** Owns autonomous research demand, scheduling, execution, persistence, and cancellation. */
export class ResearchLaneController {
	private _timer: ReturnType<typeof setTimeout> | undefined;
	private _isRunning = false;
	private _lastSkipReason: string | undefined;
	private _historySeeded = false;
	private _persistedRunCount = 0;
	private readonly abortController = new AbortController();
	private readonly warnedUnboundToolGrants = new Set<string>();
	private readonly deps: ResearchLaneControllerDeps;
	private readonly lanes: LaneTracker;
	private readonly models: LaneModelResolver;

	constructor(deps: ResearchLaneControllerDeps, lanes: LaneTracker, models: LaneModelResolver) {
		this.deps = deps;
		this.lanes = lanes;
		this.models = models;
	}

	seedHistory(): void {
		if (this._historySeeded) return;
		const records = getLaneRecordSnapshots(this.deps.getSessionManager().getEntries());
		this.lanes.ensureCounterAtLeast(records.length + 1);
		this._persistedRunCount = records.filter((record) => record.type === "research").length;
		this._historySeeded = true;
	}

	getLastSkipReason(): string | undefined {
		return this._lastSkipReason;
	}

	abort(): void {
		this.clearTimer();
		this.abortController.abort();
	}

	clearTimer(): void {
		if (this._timer !== undefined) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
	}

	scheduleFromIdle(): void {
		if (this._isRunning || this.deps.isDisposed() || this.deps.isChildSession()) return;
		const research = this.deps.getSettingsManager().getResearchLaneSettings();
		if (!research.enabled) {
			this._lastSkipReason = "research_lane_disabled";
			return;
		}
		const { mode } = this.deps.getSettingsManager().getAutonomySettings();
		if (mode === "off") {
			this._lastSkipReason = "autonomy_mode_off";
			return;
		}
		this.seedHistory();
		if (this._persistedRunCount >= research.maxRunsPerSession) {
			this._lastSkipReason = "max_runs_reached";
			return;
		}
		if (!this.buildDemand()) return;
		const shipment = this.models.resolveShipment(research, "no_research_model");
		if (!shipment.ok) {
			this._lastSkipReason = shipment.skipReason;
			return;
		}
		if (!this.models.capabilityProfile(shipment.model).backgroundLanesEnabled) {
			this._lastSkipReason = "model_research_unsupported";
			return;
		}

		this.clearTimer();
		this._timer = setTimeout(() => {
			this._timer = undefined;
			void this.runScheduled();
		}, research.idleDelayMs);
		const timer = this._timer;
		if (typeof timer === "object" && timer && "unref" in timer) {
			const { unref } = timer as { unref?: () => void };
			unref?.call(timer);
		}
	}

	async runOnce(request?: { query?: string; context?: string; goalId?: string }): Promise<ResearchLaneRunOutcome> {
		if (this._isRunning) return { started: false, skipReason: "research_lane_already_running" };
		if (this.deps.isDisposed()) return { started: false, skipReason: "session_disposed" };

		const settings = this.deps.getSettingsManager().getResearchLaneSettings();
		const demand = request?.query
			? { query: request.query, context: request.context ?? "", goalId: request.goalId }
			: this.buildDemand();
		if (!demand) return { started: false, skipReason: this._lastSkipReason ?? "no_research_demand" };

		const shipment = this.models.resolveShipment(settings, "no_research_model");
		if (!shipment.ok) {
			this._lastSkipReason = shipment.skipReason;
			return { started: false, skipReason: shipment.skipReason };
		}
		const { model, laneProfile } = shipment;
		const laneCapability = this.models.capabilityProfile(model);
		if (!laneCapability.backgroundLanesEnabled) {
			this._lastSkipReason = "model_research_unsupported";
			return { started: false, skipReason: "model_research_unsupported" };
		}

		this._isRunning = true;
		this.seedHistory();
		const startedRecord = this.lanes.start({ type: "research", goalId: demand.goalId });
		this._persistedRunCount++;
		const deregisterInFlight = registerInFlightWork(
			this.deps.getAgentDir(),
			"lane",
			`research:${startedRecord.laneId}`,
		);
		try {
			let spentUsage: Usage | undefined;
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
			this.warnUnboundToolGrants(laneProfile, toolSurface);
			const result = await runResearch({
				query: demand.query,
				context: demand.context,
				sources: workspaceSources,
				envelope: this.buildEnvelope(maxUsd, laneProfile, toolSurface),
				maxUsd,
				maxSources: settings.maxSources,
				maxFindings: settings.maxFindings,
				maxWallClockMs: settings.maxWallClockMs,
				signal: this.abortController.signal,
				complete: async ({ systemPrompt, userPrompt, signal }) => {
					const completion = await this.deps.runIsolatedCompletion({
						systemPrompt: composeSubagentSystemPrompt({
							soul: laneProfile?.soul,
							rolePrompt: systemPrompt,
							override: settings.systemPrompt,
						}),
						messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
						model,
						thinkingLevel: resolveModelThinkingLevel(model, laneProfile?.thinking),
						maxTokens: laneCapability.laneMaxOutputTokens,
						tools: toolSurface.tools,
						maxTurns: 6,
						beforeToolCall: toolSurface.beforeToolCall,
						signal,
						cacheRetention: "short",
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

			if (this.deps.isDisposed()) {
				const record = this.lanes.complete(startedRecord.laneId, {
					status: "canceled",
					reasonCode: "session_disposed",
				});
				return { started: true, record, result };
			}

			let evidenceEntryId: string | undefined;
			if (result.bundle) evidenceEntryId = this.deps.saveEvidenceBundleSnapshot(result.bundle);
			if (spentUsage && (spentUsage.cost.total > 0 || spentUsage.totalTokens > 0)) {
				this.deps.addSpawnedUsage(spentUsage, {
					label: "research-lane",
					reportId: `research:${this.deps.getSessionId()}:${startedRecord.laneId}`,
				});
			}

			const record = this.lanes.complete(startedRecord.laneId, {
				status: result.status,
				reasonCode: result.reasonCode,
				costUsd: result.costUsd,
				evidenceEntryId,
			});
			if (record) {
				appendLaneRecordSnapshot(this.deps.getSessionManager(), record);
				this.emitTerminalTelemetry(record);
			}
			return { started: true, record, result };
		} catch (error) {
			const record = this.lanes.complete(startedRecord.laneId, {
				status: "failed",
				reasonCode: "research_lane_error",
			});
			if (record && !this.deps.isDisposed()) {
				appendLaneRecordSnapshot(this.deps.getSessionManager(), record);
				this.emitTerminalTelemetry(record);
			}
			const message = error instanceof Error ? error.message : String(error);
			this.deps.emit({ type: "warning", message: `Research lane failed: ${message}` });
			return { started: true, record };
		} finally {
			this._isRunning = false;
			deregisterInFlight();
		}
	}

	private buildDemand(): { query: string; context: string; goalId: string } | undefined {
		const goal = this.deps.getGoalStateSnapshot();
		if (!goal || goal.status !== "active") {
			this._lastSkipReason = "no_active_goal";
			return undefined;
		}
		const open = goal.requirements.filter((requirement) => requirement.status === "open");
		if (open.length === 0) {
			this._lastSkipReason = "no_open_requirements";
			return undefined;
		}
		const query = `goal:${goal.goalId} requirements:${open
			.map((requirement) => requirement.id)
			.sort()
			.join(",")}`;
		if (this.deps.getEvidenceBundleSnapshot()?.query === query) {
			this._lastSkipReason = "recent_evidence_sufficient";
			return undefined;
		}
		const context = [
			`Goal: ${goal.userGoal}`,
			"Open requirements:",
			...open.slice(0, 20).map((requirement) => `- ${requirement.text}`),
		].join("\n");
		return { query, context, goalId: goal.goalId };
	}

	private async runScheduled(): Promise<void> {
		if (this._isRunning || this.deps.isDisposed()) return;
		const research = this.deps.getSettingsManager().getResearchLaneSettings();
		const { mode } = this.deps.getSettingsManager().getAutonomySettings();
		if (!research.enabled || mode === "off") return;
		try {
			await this.runOnce();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.deps.emit({ type: "warning", message: `Research lane failed: ${message}` });
		}
	}

	private buildEnvelope(
		maxUsd: number,
		laneProfile: NormalizedProfile | undefined,
		surface: LaneToolSurface,
	): CapabilityEnvelope {
		return {
			id: `research-${this.deps.getSessionId()}-${Date.now()}`,
			profileId: laneProfile?.name,
			capabilities: ["research.execute", "filesystem.read", "memory.query"],
			allowedTools: [...surface.allowedTools],
			deniedTools: [...surface.deniedTools],
			allowedPaths: [this.deps.getCwd()],
			deniedPaths: getPrivateLaneDeniedPaths(this.deps.getCwd(), this.deps.getAgentDir()),
			maxEstimatedUsd: clampLaneMaxUsd(maxUsd, this.deps.getCapabilityEnvelope()?.maxEstimatedUsd),
			createdAt: new Date().toISOString(),
		};
	}

	private warnUnboundToolGrants(laneProfile: NormalizedProfile | undefined, surface: LaneToolSurface): void {
		if (!laneProfile || surface.unboundAllowPatterns.length === 0) return;
		const warningKey = `${laneProfile.name}\0${[...surface.unboundAllowPatterns].sort().join("\0")}`;
		if (this.warnedUnboundToolGrants.has(warningKey)) return;
		this.warnedUnboundToolGrants.add(warningKey);
		this.deps.emit({
			type: "warning",
			message: `Lane profile '${laneProfile.name}' grants unavailable isolated-lane tools: ${surface.unboundAllowPatterns.join(", ")}. Only classified lane tools can execute.`,
		});
	}

	private emitTerminalTelemetry(record: ReturnType<LaneTracker["complete"]> & {}): void {
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
}
