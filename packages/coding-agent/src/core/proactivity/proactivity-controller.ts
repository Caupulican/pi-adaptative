import { isDeepStrictEqual } from "node:util";
import { resolveModelThinkingLevel } from "@caupulican/pi-ai/models";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import type { AgentSessionEvent, IsolatedCompletionOptions, IsolatedCompletionResult } from "../agent-session.ts";
import { BoundedCompletionUsage } from "../cost/bounded-completion-usage.ts";
import { sessionSemanticUsageOf } from "../cost/semantic-usage-delivery.ts";
import { captureWorkerReceiptOrigin } from "../delegation/worker-receipt-origin.ts";
import type { GoalState } from "../goals/goal-state.ts";
import type { ParentInputDelivery, ParentInputDeliveryOptions, ParentInputReceipt } from "../parent-input-delivery.ts";
import { truncateWithEllipsis } from "../provider-tool-text.ts";
import { registerInFlightWork } from "../reload-blockers.ts";
import { clampLaneMaxUsd, type LaneModelResolver } from "../research/lane-model-resolver.ts";
import { type RuntimeWorkLease, runtimeGenerationAdmission } from "../runtime-generation-admission.ts";
import { getActiveSessionBranchEntries } from "../session-snapshot.ts";
import type { ResolvedProactivitySettings } from "../settings/settings-schema.ts";
import { canonicalDigest } from "../steering/canonical.ts";
import { SYSTEM_TIMER_PORT, type TimerPort } from "../util/timer-port.ts";
import { ProactivityInvestigation } from "./proactivity-investigation.ts";
import type { ProactivityInvestigationHost } from "./proactivity-read-authority.ts";
import {
	buildReviewPrompt,
	countOwnerTurns,
	createRaiseNoteTool,
	MAX_REVIEW_PROFILE_CHARS,
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
	subscribeChanges(listener: () => void): () => void;
}

/** What a review run ended as; `skipReason` names the first gate that kept it from running. */
export interface ProactivityRunOutcome {
	readonly started: boolean;
	readonly skipReason?: string;
	readonly delivered: readonly ProactiveNote[];
}

export interface ProactivityControllerDeps extends ProactivityInvestigationHost {
	isDisposed(): boolean;
	isChildSession(): boolean;
	/** True while the owner's turn (or its retry or follow-up) holds the session. */
	isForegroundBusy(): boolean;
	getSessionId(): string;
	getSessionManager(): SessionManager;
	getSettingsManager(): ProactivityControllerSettingsSource;
	getGoalStateSnapshot(): GoalState | undefined;
	subscribeForegroundActivity(listener: () => void): () => void;
	/** Whole current owner records, bounded for this review; separate from worker handoff authority. */
	captureReviewContext(maxChars: number): { readonly text: string; isCurrent(): boolean };
	emit(event: AgentSessionEvent): void;
	runIsolatedCompletion(opts: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
	/** Resolves after canonical acceptance; consumption is owned by the mode-aware parent ledger. */
	deliverNotes(input: ParentInputDelivery, options: ParentInputDeliveryOptions): Promise<ParentInputReceipt>;
	/** The `proactivity` port; defaults to the system timers. */
	timers?: TimerPort;
}

/** The active goal and what is still open on it, bounded: the host's own record of work the owner asked for. */
function goalSummary(goal: GoalState): string {
	const open = goal.requirements.filter((requirement) => requirement.status === "open").slice(0, 8);
	return [
		`Status: ${goal.status}. Only active goals may be continued.`,
		truncateWithEllipsis(goal.userGoal, 1_000),
		...(open.length > 0
			? ["Still open:", ...open.map((requirement) => `- ${truncateWithEllipsis(requirement.text, 300)}`)]
			: []),
	].join("\n");
}

/**
 * Owns the idle review that raises notes the owner would want to hear. The host decides everything that has a cost or a
 * consequence: whether a review may start (enabled, per-session cap, enough new owner turns, an idle
 * foreground), which bounded source reads its current authority permits, and what is delivered
 * (well-formed, new, within the limit, with current evidence). The model judges whether the conversation shows a need;
 * the host admits reads and validates their evidence before any note reaches the owner.
 */
export class ProactivityController {
	private _timer: unknown;
	private _isRunning = false;
	private _aborted = false;
	private _runs = 0;
	private _ownerTurnsAtLastRun = 0;
	private _lastSkipReason: string | undefined;
	private _unsubscribeActivity: (() => void) | undefined;
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
		this._unsubscribeActivity?.();
		this._unsubscribeActivity = undefined;
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
		// The prompt tail can schedule while its outer submission still owns the foreground.
		// Subscribe lazily: the composition root constructs lanes before the foreground owner.
		this._unsubscribeActivity ??= this.deps.subscribeForegroundActivity(() => {
			if (this.deps.isForegroundBusy()) this.clearTimer();
			else if (this._timer === undefined) this.scheduleFromIdle();
		});
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
		if (this.deps.isChildSession()) return "child_session";
		if (this.deps.isForegroundBusy()) return "foreground_busy";
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
		const skipped = this.gate();
		this._lastSkipReason = skipped;
		if (skipped !== undefined) return { started: false, skipReason: skipped, delivered: [] };
		const settingsSource = this.deps.getSettingsManager();
		const settings = structuredClone(settingsSource.getProactivitySettings());
		const shipment = this.models.resolveShipment(settings, "no_proactivity_model");
		if (!shipment.ok) return { started: false, skipReason: shipment.skipReason, delivered: [] };
		const { model } = shipment;
		const capability = this.models.capabilityProfile(model);
		const manager = this.deps.getSessionManager();
		const branchGuard = manager.captureBranchContext();
		const origin = captureWorkerReceiptOrigin(manager);
		const entries = getActiveSessionBranchEntries(manager);
		const goal = structuredClone(this.deps.getGoalStateSnapshot());
		const envelope = structuredClone(this.deps.getCapabilityEnvelope());
		const memory = this.deps.captureReviewContext(MAX_REVIEW_PROFILE_CHARS);
		const maxUsd = clampLaneMaxUsd(settings.maxUsd, envelope?.maxEstimatedUsd);
		const usageOwner = sessionSemanticUsageOf(manager);
		const runAbort = new AbortController();
		const signal = AbortSignal.any([this.abortController.signal, runAbort.signal]);
		const prompt = buildReviewPrompt({
			entries,
			preferences: settings.preferences,
			ownerProfile: memory.text,
			...(goal ? { goalSummary: goalSummary(goal) } : {}),
		});
		const assertCurrent = () => {
			signal.throwIfAborted();
			branchGuard();
			if (
				this.deps.isDisposed() ||
				this.deps.getSessionManager() !== manager ||
				this.deps.isForegroundBusy() ||
				!isDeepStrictEqual(settings, settingsSource.getProactivitySettings()) ||
				!isDeepStrictEqual(envelope, this.deps.getCapabilityEnvelope()) ||
				!isDeepStrictEqual(goal, this.deps.getGoalStateSnapshot()) ||
				!memory.isCurrent()
			)
				throw new Error("Proactive review context changed; its result was discarded.");
		};
		const invalidate = () => runAbort.abort(new Error("Proactive review context changed; its result was discarded."));
		const checkChange = () => {
			try {
				assertCurrent();
			} catch {
				invalidate();
			}
		};
		const unsubscribe = [
			// Activity also reports runtime availability; only changed review inputs invalidate the run.
			this.deps.subscribeForegroundActivity(checkChange),
			settingsSource.subscribeChanges(checkChange),
			manager.onEntriesPersisted((event) => {
				if (event.rewritten || event.entryIds.some((id) => manager.getEntry(id)?.type === "message")) invalidate();
				else checkChange();
			}),
		];
		const stopObserving = () => {
			for (const off of unsubscribe.splice(0)) off();
		};
		this._isRunning = true;
		let runtimeLease: RuntimeWorkLease | undefined;
		let usage: BoundedCompletionUsage | undefined;
		let investigation: ProactivityInvestigation | undefined;
		let deregisterInFlight: (() => void) | undefined;
		let started = false;
		try {
			assertCurrent();
			const runUsage = new BoundedCompletionUsage(usageOwner, "proactivity", maxUsd, 2);
			usage = runUsage;
			runtimeLease = await runtimeGenerationAdmission(this.deps.getAgentDir()).admitWork({
				kind: "lane",
				label: "proactive review",
				signal,
			});
			runtimeLease.assertCurrent();
			assertCurrent();
			started = true;
			this._runs++;
			this._ownerTurnsAtLastRun = countOwnerTurns(entries);
			deregisterInFlight = registerInFlightWork(this.deps.getAgentDir(), "lane", `proactivity:${this._runs}`);
			const capture: { raised: ProactiveNote[] } = { raised: [] };
			const reviewInvestigation = new ProactivityInvestigation(this.deps, {
				model,
				maxOutputTokens: capability.laneMaxOutputTokens,
				signal,
				assertCurrent,
				isNoteRaised: () => capture.raised.length > 0,
			});
			investigation = reviewInvestigation;
			const completion = await this.deps.runIsolatedCompletion({
				systemPrompt: REVIEW_SYSTEM_PROMPT,
				messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
				model,
				thinkingLevel: resolveModelThinkingLevel(model, "low"),
				maxTokens: capability.laneMaxOutputTokens,
				tools: [
					...reviewInvestigation.tools,
					createRaiseNoteTool(capture, settings.maxNotesPerRun, (ids) =>
						reviewInvestigation.validateEvidenceForNote(ids),
					),
				],
				maxTurns: 2,
				signal,
				beforeToolCall: (context, toolSignal) => reviewInvestigation.beforeToolCall(context, toolSignal),
				onMessage: (message) => reviewInvestigation.onMessage(message),
				onProviderRequestSnapshot: (request) => reviewInvestigation.noteRequest(request.context),
				requestPreflight: (request) => {
					assertCurrent();
					const sourceAllowance = reviewInvestigation.preflight(request);
					const spendingAllowance = runUsage.preflight(request);
					return { maxTokens: Math.min(sourceAllowance.maxTokens, spendingAllowance.maxTokens) };
				},
				requestGuard: () => {
					assertCurrent();
					runUsage.assertHealthy();
					reviewInvestigation.assertHealthy();
				},
				providerResponseObserver: runUsage,
				maxRetries: 0,
				cacheRetention: "short",
				laneKind: "proactivity",
			});
			runUsage.assertHealthy();
			reviewInvestigation.assertHealthy();
			assertCurrent();
			if (completion.stopReason === "error" || completion.stopReason === "aborted")
				throw new Error(completion.errorMessage ?? `Proactive review ${completion.stopReason}.`);
			const notes = selectNotesToDeliver(
				capture.raised,
				priorNotes(getActiveSessionBranchEntries(this.deps.getSessionManager())).digests,
				settings.maxNotesPerRun,
			);
			if (notes.length === 0) {
				this.deps.emit({ type: "proactive_review", outcome: "quiet", noteCount: 0 });
				return { started: true, delivered: [] };
			}
			await reviewInvestigation.revalidate();
			assertCurrent();
			runUsage.assertHealthy();
			reviewInvestigation.assertHealthy();
			const message = {
				customType: PROACTIVE_NOTE_CUSTOM_TYPE,
				content: renderNoteMessage(notes),
				display: true,
				details: { notes, evidence: reviewInvestigation.evidenceDetails() },
			};
			const mode = settings.delivery === "turn" ? "turn" : "next-owner-turn";
			const payloadDigest = canonicalDigest({ message, mode });
			await this.deps.deliverNotes(
				{
					deliveryId: `proactivity:${canonicalDigest({ origin, mode, payloadDigest })}`,
					payloadDigest,
					message,
					origin,
					mode,
				},
				{
					runtimeLease,
					signal,
					beforeOwnership: () => {
						assertCurrent();
						runUsage.assertHealthy();
						reviewInvestigation.assertHealthy();
						stopObserving();
					},
				},
			);
			this.deps.emit({ type: "proactive_review", outcome: "raised", noteCount: notes.length });
			return { started: true, delivered: notes };
		} catch (error) {
			if (started) this.deps.emit({ type: "proactive_review", outcome: "failed", noteCount: 0 });
			usage?.assertHealthy();
			if (signal.aborted) return { started, delivered: [], skipReason: "review_context_changed" };
			throw error;
		} finally {
			stopObserving();
			try {
				await investigation?.dispose();
			} finally {
				this._isRunning = false;
				usage?.release();
				deregisterInFlight?.();
				runtimeLease?.release();
				if (signal.aborted && !this._aborted && !this.deps.isDisposed()) this.scheduleFromIdle();
			}
		}
	}
}
