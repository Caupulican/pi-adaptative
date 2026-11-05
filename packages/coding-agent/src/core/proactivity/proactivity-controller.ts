import { resolveModelThinkingLevel } from "@caupulican/pi-ai/models";
import type { Usage } from "@caupulican/pi-ai/types";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import type { AgentSessionEvent, IsolatedCompletionOptions, IsolatedCompletionResult } from "../agent-session.ts";
import type { CapabilityEnvelope } from "../autonomy/contracts.ts";
import { type GoalState, isGoalExecutionActive } from "../goals/goal-state.ts";
import { registerInFlightWork } from "../reload-blockers.ts";
import { clampLaneMaxUsd, type LaneModelResolver } from "../research/lane-model-resolver.ts";
import { runtimeGenerationAdmission } from "../runtime-generation-admission.ts";
import { getActiveSessionBranchEntries } from "../session-snapshot.ts";
import type { ResolvedProactivitySettings } from "../settings/settings-schema.ts";
import { SYSTEM_TIMER_PORT, type TimerPort } from "../util/timer-port.ts";
import {
	buildReviewPrompt,
	countOwnerTurns,
	createRaiseNoteTool,
	PROACTIVE_NOTE_CUSTOM_TYPE,
	type ProactiveNote,
	priorNotes,
	REVIEW_SYSTEM_PROMPT,
	renderNoteMessage,
	selectNotesToDeliver,
} from "./proactivity-review.ts";

/** The settings this module reads, declared by the module itself; the composition root passes the SettingsManager. */
export interface ProactivityControllerSettingsSource {
	getProactivitySettings(): ResolvedProactivitySettings;
}

/** What a review run ended as; `skipReason` names the first gate that kept it from running. */
export interface ProactivityRunOutcome {
	readonly started: boolean;
	readonly skipReason?: string;
	readonly delivered: readonly ProactiveNote[];
}

export interface ProactivityControllerDeps {
	isDisposed(): boolean;
	isChildSession(): boolean;
	/** True while the owner's turn (or its retry or follow-up) holds the session. */
	isForegroundBusy(): boolean;
	getSessionId(): string;
	getAgentDir(): string;
	getSessionManager(): SessionManager;
	getSettingsManager(): ProactivityControllerSettingsSource;
	getCapabilityEnvelope(): CapabilityEnvelope | undefined;
	getGoalStateSnapshot(): GoalState | undefined;
	/** What the memory system knows about the owner (the same guidance a delegated lane receives); absent when memory is off. */
	getHandoffPersonaGuidance?(): string | undefined;
	emit(event: AgentSessionEvent): void;
	addSpawnedUsage(
		usage: Usage,
		opts: { label?: string; sourceSessionId?: string; reportId: string },
	): string | undefined;
	runIsolatedCompletion(opts: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
	/** Appends the notes to the session as one visible message; `turn` also starts a turn on it. */
	deliverNotes(
		message: { customType: string; content: string; display: boolean; details: { notes: ProactiveNote[] } },
		delivery: "note" | "turn",
	): Promise<void>;
	/** The `proactivity` port; defaults to the system timers. */
	timers?: TimerPort;
}

/**
 * Owns the idle review that raises notes the owner would want to hear. The host decides everything that has a cost or a
 * consequence: whether a review may start (opt-in, per-session cap, enough new owner turns, an idle
 * foreground), what it may do (one tool that records a note; no files, commands or messages), and what is delivered
 * (well-formed, new, within the limit). The model only judges whether the conversation shows a need, so the path is the
 * same for every model that can call a tool.
 */
export class ProactivityController {
	private _timer: unknown;
	private _isRunning = false;
	private _aborted = false;
	private _runs = 0;
	private _ownerTurnsAtLastRun = 0;
	private _lastSkipReason: string | undefined;
	private readonly abortController = new AbortController();
	private readonly deps: ProactivityControllerDeps;
	private readonly models: LaneModelResolver;

	constructor(deps: ProactivityControllerDeps, models: LaneModelResolver) {
		this.deps = deps;
		this.models = models;
	}

	getLastSkipReason(): string | undefined {
		return this._lastSkipReason;
	}

	abort(): void {
		if (this._aborted) return;
		this._aborted = true;
		this.clearTimer();
		this.abortController.abort();
	}

	clearTimer(): void {
		if (this._timer === undefined) return;
		(this.deps.timers ?? SYSTEM_TIMER_PORT).clearTimeout(this._timer);
		this._timer = undefined;
	}

	/** Arms the review when every gate holds; otherwise records the first gate that did not and arms nothing. */
	scheduleFromIdle(): void {
		if (this._isRunning || this._aborted || this.deps.isDisposed() || this.deps.isChildSession()) return;
		const reason = this.gate();
		this._lastSkipReason = reason;
		if (reason !== undefined) {
			this.clearTimer();
			return;
		}
		const settings = this.deps.getSettingsManager().getProactivitySettings();
		const timers = this.deps.timers ?? SYSTEM_TIMER_PORT;
		const timer = timers.setTimeout(() => {
			if (this._timer !== timer) return;
			this._timer = undefined;
			void this.runScheduled();
		}, settings.idleDelayMs);
		const previous = this._timer;
		this._timer = timer;
		if (previous !== undefined) timers.clearTimeout(previous);
	}

	private gate(): string | undefined {
		const settings = this.deps.getSettingsManager().getProactivitySettings();
		if (!settings.enabled) return "proactivity_disabled";
		if (this._runs >= settings.maxRunsPerSession) return "max_runs_reached";
		const entries = getActiveSessionBranchEntries(this.deps.getSessionManager());
		if (countOwnerTurns(entries) - this._ownerTurnsAtLastRun < settings.minOwnerTurnsBetweenRuns) {
			return "not_enough_new_owner_turns";
		}
		const shipment = this.models.resolveShipment(settings, "no_proactivity_model");
		if (!shipment.ok) return shipment.skipReason;
		if (!this.models.capabilityProfile(shipment.model).backgroundLanesEnabled) return "model_proactivity_unsupported";
		return undefined;
	}

	private async runScheduled(): Promise<void> {
		try {
			if (this._isRunning || this._aborted || this.deps.isDisposed()) return;
			// A turn began while the delay ran: that turn's idle arms the next review, on the conversation it ends with.
			if (this.deps.isForegroundBusy()) {
				this._lastSkipReason = "foreground_busy";
				return;
			}
			await this.runOnce();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.deps.emit({ type: "warning", message: `Proactive review failed: ${message}` });
		}
	}

	/** One review. Every gate is checked again at the moment it starts, because time has passed since it was armed. */
	async runOnce(): Promise<ProactivityRunOutcome> {
		if (this._isRunning) return { started: false, skipReason: "proactivity_already_running", delivered: [] };
		if (this._aborted || this.deps.isDisposed())
			return { started: false, skipReason: "session_disposed", delivered: [] };
		const runtimeLease = await runtimeGenerationAdmission(this.deps.getAgentDir()).admitWork({
			kind: "lane",
			label: "proactive review",
			signal: this.abortController.signal,
		});
		try {
			runtimeLease.assertCurrent();
			if (this._isRunning) return { started: false, skipReason: "proactivity_already_running", delivered: [] };
			if (this._aborted || this.deps.isDisposed())
				return { started: false, skipReason: "session_disposed", delivered: [] };
			const skipped = this.gate();
			if (skipped !== undefined) {
				this._lastSkipReason = skipped;
				return { started: false, skipReason: skipped, delivered: [] };
			}
			const settings = this.deps.getSettingsManager().getProactivitySettings();
			const shipment = this.models.resolveShipment(settings, "no_proactivity_model");
			if (!shipment.ok) return { started: false, skipReason: shipment.skipReason, delivered: [] };
			const { model } = shipment;
			const capability = this.models.capabilityProfile(model);

			this._isRunning = true;
			this._runs++;
			const entries = getActiveSessionBranchEntries(this.deps.getSessionManager());
			this._ownerTurnsAtLastRun = countOwnerTurns(entries);
			const runIndex = this._runs;
			const deregisterInFlight = registerInFlightWork(this.deps.getAgentDir(), "lane", `proactivity:${runIndex}`);
			try {
				const capture: { raised: ProactiveNote[] } = { raised: [] };
				const goal = this.deps.getGoalStateSnapshot();
				const maxUsd = clampLaneMaxUsd(settings.maxUsd, this.deps.getCapabilityEnvelope()?.maxEstimatedUsd);
				const completion = await this.deps.runIsolatedCompletion({
					systemPrompt: REVIEW_SYSTEM_PROMPT,
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: buildReviewPrompt({
										entries,
										preferences: settings.preferences,
										ownerProfile: this.deps.getHandoffPersonaGuidance?.() ?? "",
										...(goal && isGoalExecutionActive(goal.status) ? { goalSummary: goal.userGoal } : {}),
									}),
								},
							],
							timestamp: Date.now(),
						},
					],
					model,
					thinkingLevel: resolveModelThinkingLevel(model, "low"),
					maxTokens: capability.laneMaxOutputTokens,
					tools: [createRaiseNoteTool(capture, settings.maxNotesPerRun)],
					maxTurns: 2,
					signal: this.abortController.signal,
					cacheRetention: "short",
					laneKind: "proactivity",
				});
				if (completion.usage.cost.total > 0 || completion.usage.totalTokens > 0) {
					this.deps.addSpawnedUsage(completion.usage, {
						label: "proactive-review",
						reportId: `proactivity:${this.deps.getSessionId()}:${runIndex}`,
					});
				}
				if (completion.usage.cost.total > maxUsd) {
					this.deps.emit({
						type: "warning",
						message: `Proactive review spent $${completion.usage.cost.total.toFixed(4)}, above its $${maxUsd.toFixed(4)} bound.`,
					});
				}
				if (this.deps.isDisposed() || this._aborted) return { started: true, delivered: [] };
				const notes = selectNotesToDeliver(
					capture.raised,
					priorNotes(getActiveSessionBranchEntries(this.deps.getSessionManager())).digests,
					settings.maxNotesPerRun,
				);
				if (notes.length === 0) {
					this.deps.emit({ type: "proactive_review", outcome: "quiet", noteCount: 0 });
					return { started: true, delivered: [] };
				}
				await this.deps.deliverNotes(
					{
						customType: PROACTIVE_NOTE_CUSTOM_TYPE,
						content: renderNoteMessage(notes),
						display: true,
						details: { notes },
					},
					settings.delivery,
				);
				this.deps.emit({ type: "proactive_review", outcome: "raised", noteCount: notes.length });
				return { started: true, delivered: notes };
			} catch (error) {
				this.deps.emit({ type: "proactive_review", outcome: "failed", noteCount: 0 });
				throw error;
			} finally {
				this._isRunning = false;
				deregisterInFlight();
			}
		} finally {
			runtimeLease.release();
		}
	}
}
