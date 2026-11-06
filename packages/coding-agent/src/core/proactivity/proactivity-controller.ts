import { isDeepStrictEqual } from "node:util";
import { resolveModelThinkingLevel } from "@caupulican/pi-ai/models";
import type { ParentInputMode } from "../../kernel/session/parent-input-ledger.ts";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import type { AgentSessionEvent, IsolatedCompletionOptions, IsolatedCompletionResult } from "../agent-session.ts";
import { BoundedCompletionUsage } from "../cost/bounded-completion-usage.ts";
import type { DailyUsageTotals, DailyUsageWindow } from "../cost/daily-usage.ts";
import { sessionSemanticUsageOf } from "../cost/semantic-usage-delivery.ts";
import type { SemanticDecisionEngine } from "../decision/engine.ts";
import { captureWorkerReceiptOrigin } from "../delegation/worker-receipt-origin.ts";
import type { GoalState } from "../goals/goal-state.ts";
import type { HarnessNotice, HarnessNoticeKind, HarnessNoticeObservation } from "../harness-notice.ts";
import type { ParentInputDelivery, ParentInputDeliveryOptions, ParentInputReceipt } from "../parent-input-delivery.ts";
import { truncateWithEllipsis } from "../provider-tool-text.ts";
import { registerInFlightWork } from "../reload-blockers.ts";
import { clampLaneMaxUsd, type LaneModelResolver } from "../research/lane-model-resolver.ts";
import { type RuntimeWorkLease, runtimeGenerationAdmission } from "../runtime-generation-admission.ts";
import { getActiveSessionBranchEntries } from "../session-snapshot.ts";
import type { ResolvedProactivityFeedbackSettings, ResolvedProactivitySettings } from "../settings/settings-schema.ts";
import { canonicalDigest } from "../steering/canonical.ts";
import { SYSTEM_TIMER_PORT, type TimerPort } from "../util/timer-port.ts";
import {
	decideNoteFeedback,
	foldFeedback,
	isSubjectTopicKey,
	isTopicSuppressed,
	type NoteTopic,
	noteTopics,
	PROACTIVITY_FEEDBACK_CUSTOM_TYPE,
	subjectTopic,
	subjectTopicKey,
} from "./proactivity-feedback.ts";
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
	getProactivityFeedbackSettings(): ResolvedProactivityFeedbackSettings;
	subscribeChanges(listener: () => void): () => void;
}

/**
 * What a review run ended as; `skipReason` names the first gate that kept it from running, and `deliveryHold` names the
 * bound that made a configured parent wake wait for the owner's next turn instead.
 */
export interface ProactivityRunOutcome {
	readonly started: boolean;
	readonly skipReason?: string;
	readonly delivered: readonly ProactiveNote[];
	readonly deliveryHold?: string;
}

/** The rolling day the daily bounds count: everything recorded since one day before the measurement. */
const DAY_MS = 24 * 60 * 60 * 1000;

export function rollingDayWindow(atMs: number): DailyUsageWindow {
	return { startMs: atMs - DAY_MS, endMs: Number.POSITIVE_INFINITY };
}

/** The hold `proactivity.maxTurnWakesPerDay` names when it carries a delivery with the owner's next turn. */
export const MAX_TURN_WAKES_HOLD = "max_turn_wakes_per_day_reached";

/** Measured wakes that count toward `proactivity.maxTurnWakesPerDay`: proactive notes and host events alike. */
export function parentTurnWakes(day: Pick<DailyUsageTotals, "proactiveTurnWakes" | "hostEventTurnWakes">): number {
	return day.proactiveTurnWakes + day.hostEventTurnWakes;
}

/**
 * The owner notice for a review that did not start, or undefined for a gate that is normal flow (busy, too few owner
 * turns, the per-session count), the owner's own switch, a transient model quota, or a session with no model at all.
 */
export function proactiveReviewNotice(
	skipReason: string,
	settings: Pick<ResolvedProactivitySettings, "model">,
): HarnessNotice | undefined {
	const paused = "Proactive review paused because";
	switch (skipReason) {
		case "max_usd_per_day_reached":
			return {
				reason: skipReason,
				text: `${paused} review spend over the last 24 hours, across this agent's sessions, reached proactivity.maxUsdPerDay. Reviews start again once older spend leaves the rolling day, or sooner if proactivity.maxUsdPerDay is raised.`,
			};
		case "no_proactivity_model":
			return settings.model === undefined
				? undefined
				: {
						reason: skipReason,
						text: `${paused} proactivity.model ${JSON.stringify(settings.model)} does not resolve to an available model. Set proactivity.model to a configured, signed-in model, or remove it to use the session model.`,
					};
		case "model_proactivity_unsupported":
			return {
				reason: skipReason,
				text: `${paused} its model's capability tier allows no background lanes. Set proactivity.model to a model with a larger context window.`,
			};
		default:
			return undefined;
	}
}

/** How one parent delivery was made, and the bound that carried it with the owner's next turn instead of waking. */
export interface ParentWakeDelivery {
	readonly mode: ParentInputMode;
	readonly hold?: string;
}

/**
 * The last rolling-day measurement across the owner's sessions, and how the last accepted notes and the last CI event
 * for the main session were delivered. `turnWakes` counts every wake the bound counts; `eventWakes` is the CI share.
 */
export interface ProactivityDailyState {
	readonly measured?: {
		readonly reviewUsd: number;
		readonly turnWakes: number;
		readonly eventWakes: number;
		readonly atMs: number;
	};
	readonly lastDelivery?: ParentWakeDelivery;
	readonly lastEventDelivery?: ParentWakeDelivery;
}

/** The topics the owner's replies to proactive notes set aside now, each with when it ends. */
export interface ProactivityFeedbackView {
	readonly suppressed: readonly { readonly topic: string; readonly label: string; readonly until: number }[];
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
	/** The session's bound System One engine, if any: it judges what the owner did with a delivered note. */
	getSystemOneEngine(): SemanticDecisionEngine | undefined;
	subscribeForegroundActivity(listener: () => void): () => void;
	/** Whole current owner records, bounded for this review; separate from worker handoff authority. */
	captureReviewContext(maxChars: number): { readonly text: string; isCurrent(): boolean };
	/** Review spend, parent wakes and acting-ahead accounting inside a window across the owner's sessions. */
	aggregateUsageWindow(
		window: DailyUsageWindow,
	): Promise<
		Pick<
			DailyUsageTotals,
			| "proactivityCost"
			| "proactiveTurnWakes"
			| "hostEventTurnWakes"
			| "routineResultTurnWakes"
			| "actAheadAttempts"
			| "actAheadUsd"
		>
	>;
	emit(event: AgentSessionEvent): void;
	runIsolatedCompletion(opts: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
	/** Resolves after canonical acceptance; consumption is owned by the mode-aware parent ledger. */
	deliverNotes(input: ParentInputDelivery, options: ParentInputDeliveryOptions): Promise<ParentInputReceipt>;
	/** The `proactivity` port; defaults to the system timers. */
	timers?: TimerPort;
	/** The session's harness notices: a gate the owner can act on is told once, a started review clears it. */
	observeHarnessNotice?(kind: HarnessNoticeKind, read: () => HarnessNoticeObservation | undefined): void;
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

/** The review's own subject (the goal while one exists, otherwise the conversation) and the inputs it stands on. */
function reviewSubject(
	settings: Pick<ResolvedProactivitySettings, "preferences">,
	goal: GoalState | undefined,
	ownerProfile: string,
): NoteTopic {
	return subjectTopic({
		preferences: settings.preferences,
		ownerProfile,
		...(goal ? { goal: { goalId: goal.goalId, userGoal: goal.userGoal, summary: goalSummary(goal) } } : {}),
	});
}

/**
 * Owns the idle review that raises notes the owner would want to hear. The host decides everything that has a cost or a
 * consequence: whether a review may start (enabled, per-session cap, enough new owner turns, an idle
 * foreground, the rolling-day review spend across the owner's sessions), which bounded source reads its current authority
 * permits, and what is delivered (well-formed, new, within the limit, with current evidence) and how (a parent wake only
 * within the rolling-day wake bound, otherwise with the owner's next turn). The model judges whether the conversation shows a need;
 * the host admits reads and validates their evidence before any note reaches the owner.
 */
export class ProactivityController {
	private _timer: unknown;
	private _isRunning = false;
	private _aborted = false;
	private _runs = 0;
	private _ownerTurnsAtLastRun = 0;
	private _lastSkipReason: string | undefined;
	private _daily: ProactivityDailyState = {};
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

	getDailyState(): ProactivityDailyState {
		return this._daily;
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
			this.noticeSkip(reason, this.deps.getSettingsManager().getProactivitySettings());
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
		if (this.isSubjectSuppressed(entries, settings)) return "topic_suppressed";
		return undefined;
	}

	/**
	 * True while the owner's replies set the review's own subject aside and the inputs it stands on are unchanged: such a
	 * review starts nothing for itself, silently. Changed inputs (preferences, owner knowledge, the goal) lift it.
	 */
	private isSubjectSuppressed(entries: readonly SessionEntry[], settings: ResolvedProactivitySettings): boolean {
		const feedback = this.deps.getSettingsManager().getProactivityFeedbackSettings();
		if (!feedback.enabled) return false;
		const now = Date.now();
		const state = foldFeedback(entries, feedback, now);
		const goal = this.deps.getGoalStateSnapshot();
		// The owner knowledge read is only paid for a subject that is set aside at all.
		if (state.topics.get(subjectTopicKey(goal?.goalId))?.suppressed === undefined) return false;
		const profile = this.deps.captureReviewContext(MAX_REVIEW_PROFILE_CHARS).text;
		return isTopicSuppressed(state, reviewSubject(settings, goal, profile), now);
	}

	/** The topics the owner's replies set aside now, with when each ends; read-only. */
	getFeedbackState(): ProactivityFeedbackView {
		const feedback = this.deps.getSettingsManager().getProactivityFeedbackSettings();
		if (!feedback.enabled) return { suppressed: [] };
		const entries = getActiveSessionBranchEntries(this.deps.getSessionManager());
		const now = Date.now();
		const state = foldFeedback(entries, feedback, now);
		const settings = this.deps.getSettingsManager().getProactivitySettings();
		const goal = this.deps.getGoalStateSnapshot();
		let subject: NoteTopic | undefined;
		const suppressed = [...state.topics.values()].flatMap(({ topic, label, suppressed }) => {
			if (suppressed === undefined || suppressed.until <= now) return [];
			if (isSubjectTopicKey(topic)) {
				// A subject topic holds only for the current subject with unchanged inputs; a finished goal's no longer applies.
				subject ??= reviewSubject(settings, goal, this.deps.captureReviewContext(MAX_REVIEW_PROFILE_CHARS).text);
				if (topic !== subject.topic || suppressed.fingerprint !== subject.fingerprint) return [];
			}
			return [{ topic, label, until: suppressed.until }];
		});
		return { suppressed };
	}

	private noticeSkip(skipReason: string, settings: Pick<ResolvedProactivitySettings, "model">): void {
		this.deps.observeHarnessNotice?.("proactive-review", () => proactiveReviewNotice(skipReason, settings));
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
		const settingsSource = this.deps.getSettingsManager();
		const settings = structuredClone(settingsSource.getProactivitySettings());
		if (skipped !== undefined) {
			this.noticeSkip(skipped, settings);
			return { started: false, skipReason: skipped, delivered: [] };
		}
		const shipment = this.models.resolveShipment(settings, "no_proactivity_model");
		if (!shipment.ok) {
			this.noticeSkip(shipment.skipReason, settings);
			return { started: false, skipReason: shipment.skipReason, delivered: [] };
		}
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
		const subject = reviewSubject(settings, goal, memory.text);
		const feedback = settingsSource.getProactivityFeedbackSettings();
		try {
			assertCurrent();
			// What the owner did with earlier notes is judged only when a review would otherwise run, before it spends.
			const engine = this.deps.getSystemOneEngine();
			if (feedback.enabled && engine !== undefined) {
				const records = await decideNoteFeedback({
					entries: getActiveSessionBranchEntries(manager),
					settings: feedback,
					engine,
					signal,
					now: Date.now(),
				});
				assertCurrent();
				for (const record of records) manager.appendCustomEntry(PROACTIVITY_FEEDBACK_CUSTOM_TYPE, record);
				const now = Date.now();
				if (isTopicSuppressed(foldFeedback(getActiveSessionBranchEntries(manager), feedback, now), subject, now)) {
					this._lastSkipReason = "topic_suppressed";
					this.noticeSkip("topic_suppressed", settings);
					return { started: false, skipReason: "topic_suppressed", delivered: [] };
				}
			}
			// The daily bounds count every session of this owner over the last rolling day, measured once at admission: a
			// session runs one review at a time, so only another session admitting concurrently can pass the same measurement.
			const atMs = Date.now();
			const day = await this.deps.aggregateUsageWindow(rollingDayWindow(atMs));
			const turnWakes = parentTurnWakes(day);
			this._daily = {
				...this._daily,
				measured: { reviewUsd: day.proactivityCost, turnWakes, eventWakes: day.hostEventTurnWakes, atMs },
			};
			assertCurrent();
			const remainingDayUsd = settings.maxUsdPerDay - day.proactivityCost;
			if (remainingDayUsd <= 0) {
				this._lastSkipReason = "max_usd_per_day_reached";
				this.noticeSkip("max_usd_per_day_reached", settings);
				return { started: false, skipReason: "max_usd_per_day_reached", delivered: [] };
			}
			// Past the wake bound the review still runs; its accepted notes wait for the owner's next turn.
			const deliveryHold =
				settings.delivery === "turn" && turnWakes >= settings.maxTurnWakesPerDay ? MAX_TURN_WAKES_HOLD : undefined;
			const runUsage = new BoundedCompletionUsage(usageOwner, "proactivity", Math.min(maxUsd, remainingDayUsd), 2);
			usage = runUsage;
			runtimeLease = await runtimeGenerationAdmission(this.deps.getAgentDir()).admitWork({
				kind: "lane",
				label: "proactive review",
				signal,
			});
			runtimeLease.assertCurrent();
			assertCurrent();
			started = true;
			// A review that starts has passed every gate the owner may have been told about.
			this.deps.observeHarnessNotice?.("proactive-review", () => "clear");
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
			const evidence = reviewInvestigation.evidenceDetails();
			const branch = getActiveSessionBranchEntries(this.deps.getSessionManager());
			const now = Date.now();
			const feedbackState = feedback.enabled ? foldFeedback(branch, feedback, now) : undefined;
			// A note on a topic the owner's replies set aside is not offered while its sources stand where they stood.
			const offered = capture.raised.filter(
				(note) =>
					feedbackState === undefined ||
					!noteTopics([note], evidence, subject).some((topic) => isTopicSuppressed(feedbackState, topic, now)),
			);
			const notes = selectNotesToDeliver(offered, priorNotes(branch).digests, settings.maxNotesPerRun);
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
				details: { notes, evidence, topics: noteTopics(notes, evidence, subject) },
			};
			const mode: ParentInputMode =
				settings.delivery === "turn" && deliveryHold === undefined ? "turn" : "next-owner-turn";
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
			this._daily = { ...this._daily, lastDelivery: { mode, ...(deliveryHold ? { hold: deliveryHold } : {}) } };
			this.deps.emit({ type: "proactive_review", outcome: "raised", noteCount: notes.length });
			return { started: true, delivered: notes, ...(deliveryHold ? { deliveryHold } : {}) };
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
