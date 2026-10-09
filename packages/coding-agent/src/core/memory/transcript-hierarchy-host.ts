/**
 * Session-side host of the history hierarchy: decides whether the coordinator should run for the current
 * memory generation, builds its ports from the session's own owners (settings, model registry, isolated
 * completion, usage ledger, foreground activity), restarts it when the settings that shape it change,
 * and projects its frontier into the request. The coordinator itself stays free of sessions and timers.
 *
 * The hierarchy runs only for an OKF, non-child session whose memory retrieval is enabled and whose
 * configured summary model resolves and may receive the history (local, or external egress allowed).
 * Anything else leaves it stopped with the real reason, which diagnostics report.
 */

import type { TranscriptHierarchyStatus } from "../context/memory-diagnostics.ts";
import type { SemanticDecisionEngine } from "../decision/engine.ts";
import type { ActiveBranchEntryStanding } from "./active-branch-probe.ts";
import { type FrontierAudience, projectFrontierView, renderFrontierView } from "./transcript-frontier.ts";
import {
	TranscriptMemory,
	type TranscriptMemoryStatus,
	type TranscriptMemoryTerminalEvent,
} from "./transcript-memory.ts";
import type { TranscriptLineageReader } from "./transcript-memory-contracts.ts";
import type { TranscriptNodeExpander } from "./transcript-source-tools.ts";
import { resolveTranscriptSummarizer, type TranscriptSummarizerDeps } from "./transcript-summarizer.ts";
import { createSemanticSummaryAdmission, type TranscriptSummaryAdmissionPort } from "./transcript-summary-admission.ts";
import { TranscriptSummaryStore } from "./transcript-summary-store.ts";

export interface TranscriptHistorySettings {
	hierarchy: boolean;
	summaryModel: string | undefined;
	allowExternalSummaryEgress: boolean;
	allowExternalAdmissionEgress: boolean;
	maxConcurrentSummaries: number;
	frontierMaxBytes: number;
	retentionDays: number | undefined;
}

export interface TranscriptHierarchyHostDeps {
	getAgentDir(): string;
	getSessionId(): string;
	/** The project identity the derived state and every handle are scoped to. */
	projectId(): string;
	isChildSession(): boolean;
	getHistorySettings(): TranscriptHistorySettings;
	isRetrievalEnabled(): boolean;
	summarizer: TranscriptSummarizerDeps;
	/**
	 * The session's recording semantic engine (System One), the one judge that admits model summaries. Resolved
	 * per judgment: undefined while System One is not bound, and then model summaries are held, never accepted unjudged.
	 */
	getAdmissionEngine(): SemanticDecisionEngine | undefined;
	/** True while the foreground owns the provider; background summaries wait for it to end. */
	isForegroundBusy(): boolean;
	/** Foreground activity changes (a submission starts or ends). No polling. */
	subscribeForegroundActivity(listener: () => void): () => void;
	/** The operator-facing warning path; failures and self-stops are reported once per batch. */
	emitWarning(message: string): void;
}

/**
 * The live branch as the frontier is fenced against it: for every source entry, whether the live context
 * still shows it after the latest compaction. The frontier describes only history compacted away on THIS
 * branch, and never what the live context already carries verbatim.
 */
export interface FrontierBranchFence {
	standing(entryId: string): ActiveBranchEntryStanding;
}

/** Why a frontier is, or is not, shown for one provider request. */
export type TranscriptFrontierState =
	| "shown"
	/** The coordinator is not running. */
	| "not_running"
	/** The conversation has not been compacted on this branch: every span is still in context. */
	| "not_compacted"
	/** The coordinator has no accepted nodes for this session yet. */
	| "no_frontier"
	/** The frontier names model summaries without an admission under the current contract: withheld until re-admitted. */
	| "not_admitted"
	/** The frontier's covered entries are not on the live branch (after a branch switch): never described. */
	| "lineage_mismatch"
	/** The frontier covers only history that is still in the live context. */
	| "live_context"
	/** The frontier names summaries past the retention window that are not revoked yet: withheld, never shown. */
	| "expired"
	/** The allowance cannot hold even the frame and one record. */
	| "no_room";

/** What the request projection takes from the frontier for one provider request. */
export type TranscriptFrontierPreview =
	| {
			state: "shown";
			/** Rendered record text (without the untrusted wrapper). */
			text: string;
			bytes: number;
			revision: number;
	  }
	| { state: Exclude<TranscriptFrontierState, "shown"> };

const DISABLED_EXPANDER_REASON = "the summary hierarchy is not running";

export class TranscriptHierarchyHost {
	private readonly deps: TranscriptHierarchyHostDeps;
	private readonly admission: TranscriptSummaryAdmissionPort;
	private lastHeldWarning: string | undefined;
	private coordinator: TranscriptMemory | undefined;
	private reader: TranscriptLineageReader | undefined;
	private isCurrent: () => boolean = () => false;
	private attachment = 0;
	private appliedSignature: string | undefined;
	private offReason: string | undefined = "the summary hierarchy is off";
	private chain: Promise<void> = Promise.resolve();
	private lastError: string | undefined;
	private frontierState: TranscriptFrontierState | undefined;

	constructor(deps: TranscriptHierarchyHostDeps) {
		this.deps = deps;
		this.admission = createSemanticSummaryAdmission({ getEngine: () => deps.getAdmissionEngine() });
	}

	/** Bind the hierarchy to one memory generation's history index and (re)start it as settings allow. */
	attach(reader: TranscriptLineageReader, isCurrent: () => boolean): Promise<void> {
		this.reader = reader;
		this.isCurrent = isCurrent;
		this.attachment += 1;
		return this.request();
	}

	/** Stop the coordinator before the generation's reader is released. */
	detach(): Promise<void> {
		this.reader = undefined;
		this.isCurrent = () => false;
		this.attachment += 1;
		return this.request();
	}

	/** Called when effective settings changed; restarts only when something that shapes the coordinator did. */
	settingsChanged(): Promise<void> {
		return this.request();
	}

	/** Forget a session's derived history, by operator or retention authority. */
	async forgetSession(sessionId: string): Promise<void> {
		await this.coordinator?.forgetSession(sessionId);
	}

	/** The zoom surface for the current coordinator; resolves it per call so a restart is never held on to. */
	expander(): TranscriptNodeExpander {
		return {
			expand: async (handle) =>
				this.coordinator
					? this.coordinator.expand(handle)
					: { status: "unavailable", reason: this.offReason ?? DISABLED_EXPANDER_REASON },
		};
	}

	/**
	 * The current session's frontier as the live branch sees it, rendered within `allowanceBytes` (further capped
	 * by `frontierMaxBytes`): the compacted-away coverage minus whatever the live context still shows (see
	 * {@link projectFrontierView}). The persisted selection is never changed. A frontier with nothing compacted
	 * away is reported as live context, and one whose entries are off the live branch is reported, never described.
	 * `audience` only picks the tool names its pointers use (the root's history actions or a lane's `memory_read`).
	 */
	previewFrontier(
		allowanceBytes: number,
		fence: FrontierBranchFence,
		audience: FrontierAudience = "root",
	): TranscriptFrontierPreview {
		const coordinator = this.coordinator;
		if (!coordinator?.isRunning()) return { state: "not_running" };
		const sessionId = this.deps.getSessionId();
		if (coordinator.frontierExpired(sessionId)) return { state: "expired" };
		if (coordinator.frontierNotAdmitted(sessionId)) return { state: "not_admitted" };
		const snapshot = coordinator.frontierSnapshot(sessionId);
		if (!snapshot || snapshot.selection.nodeIds.length === 0) return { state: "no_frontier" };
		const view = projectFrontierView(snapshot.selection, snapshot.nodes, (entryId) => fence.standing(entryId));
		if (view.items.every((item) => item.kind === "visible")) {
			return { state: view.offBranch ? "lineage_mismatch" : "live_context" };
		}
		const rendering = renderFrontierView(view, {
			sessionId,
			revision: snapshot.selection.revision,
			omittedBeforeIndex: snapshot.selection.omittedBeforeIndex,
			// A cut at the compaction boundary leaves nothing missing; only a frontier that reaches it can have a gap.
			...(!view.truncated && snapshot.gap ? { gap: snapshot.gap } : {}),
			allowanceBytes: Math.min(allowanceBytes, this.deps.getHistorySettings().frontierMaxBytes),
			audience,
		});
		return rendering.text === ""
			? { state: "no_room" }
			: { state: "shown", text: rendering.text, bytes: rendering.bytes, revision: snapshot.selection.revision };
	}

	/** Record why the latest committed request did or did not carry the frontier (diagnostics only). */
	noteFrontierState(state: TranscriptFrontierState): void {
		this.frontierState = state;
	}

	/** Operator-view status; reads stored state only. */
	status(): TranscriptHierarchyStatus | undefined {
		const coordinator = this.coordinator;
		const settings = this.deps.getHistorySettings();
		if (!coordinator) {
			if (!settings.hierarchy && this.lastError === undefined) return undefined;
			return {
				state: settings.hierarchy ? "stopped" : "off",
				disabledReason: this.lastError ?? this.offReason ?? DISABLED_EXPANDER_REASON,
				counts: {},
				failures: [],
				recoveryIssues: [],
				acceptedNodes: 0,
				recentBatches: [],
			};
		}
		return this.mapStatus(coordinator.status(), this.deps.getSessionId(), this.frontierState);
	}

	// ---- internals ----------------------------------------------------------------------------

	private request(): Promise<void> {
		this.chain = this.chain
			.then(() => this.reconcile())
			.catch((error: unknown) => {
				this.lastError = error instanceof Error ? error.message : String(error);
			});
		return this.chain;
	}

	private async reconcile(): Promise<void> {
		const reader = this.reader;
		const settings = this.deps.getHistorySettings();
		let reason: string | undefined;
		if (!reader) reason = "no history index is attached";
		else if (this.deps.isChildSession()) reason = "child sessions do not build a history hierarchy";
		else if (!settings.hierarchy) reason = "the summary hierarchy is off";
		else if (!this.deps.isRetrievalEnabled()) reason = "memory retrieval is disabled by policy";
		let summarizer: ReturnType<typeof resolveTranscriptSummarizer> | undefined;
		if (reason === undefined) {
			summarizer = resolveTranscriptSummarizer(settings.summaryModel, this.deps.summarizer);
			if (!summarizer.ok) reason = summarizer.reason;
			else if (summarizer.summarizer.egress === "external" && !settings.allowExternalSummaryEgress) {
				reason = `summary model ${summarizer.model} is not local and external summary egress is not allowed`;
			}
		}
		const signature =
			reason === undefined
				? JSON.stringify([
						this.attachment,
						settings.summaryModel,
						settings.maxConcurrentSummaries,
						settings.allowExternalSummaryEgress,
						settings.allowExternalAdmissionEgress,
						// The retention wake is armed from persisted metadata at start, so a new window restarts it.
						settings.retentionDays,
					])
				: undefined;
		if (reason !== undefined || this.appliedSignature !== signature || this.coordinator?.isRunning() === false) {
			await this.stopCoordinator();
		}
		if (reason !== undefined || summarizer === undefined || !summarizer.ok || !reader) {
			this.offReason = reason;
			this.appliedSignature = undefined;
			return;
		}
		if (this.coordinator) return;
		const coordinator = new TranscriptMemory({
			reader,
			store: new TranscriptSummaryStore({ agentDir: this.deps.getAgentDir(), projectId: this.deps.projectId() }),
			summarizer: summarizer.summarizer,
			admission: this.admission,
			settings: () => {
				const live = this.deps.getHistorySettings();
				return {
					hierarchy: live.hierarchy,
					allowExternalSummaryEgress: live.allowExternalSummaryEgress,
					allowExternalAdmissionEgress: live.allowExternalAdmissionEgress,
					maxConcurrentSummaries: live.maxConcurrentSummaries,
					frontierMaxBytes: live.frontierMaxBytes,
					...(live.retentionDays !== undefined ? { retentionDays: live.retentionDays } : {}),
				};
			},
			canRunBackground: () => !this.deps.isForegroundBusy(),
			onBackgroundAvailable: (listener) =>
				this.deps.subscribeForegroundActivity(() => {
					if (!this.deps.isForegroundBusy()) listener();
				}),
			isCurrent: () => this.isCurrent() && this.deps.isRetrievalEnabled(),
			now: () => Date.now(),
			setTimer: (callback, delayMs) => {
				const timer = setTimeout(callback, delayMs);
				timer.unref();
				return timer;
			},
			clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
			onTerminal: (event) => this.reportTerminal(event),
			onFrontierChanged: () => {},
		});
		this.coordinator = coordinator;
		this.appliedSignature = signature;
		this.offReason = undefined;
		this.lastError = undefined;
		const started = await coordinator.start();
		if (!started.enabled) {
			this.coordinator = undefined;
			this.appliedSignature = undefined;
			this.offReason = started.reason;
		}
	}

	private async stopCoordinator(): Promise<void> {
		const coordinator = this.coordinator;
		this.coordinator = undefined;
		if (coordinator) await coordinator.stop();
	}

	/**
	 * Terminal handoff to the owning session. A success is diagnostics only (the coordinator persisted it)
	 * and never reaches the conversation; a failed batch or a self-stop is told through the warning path.
	 */
	private reportTerminal(event: TranscriptMemoryTerminalEvent): void {
		if (event.stopReason !== undefined) {
			this.lastError = `the summary hierarchy stopped: ${event.stopReason}`;
			this.deps.emitWarning(`History summaries stopped: ${event.stopReason}. Exact history recall is unaffected.`);
			return;
		}
		if (event.failed > 0) {
			const cause = event.causes[0];
			this.deps.emitWarning(
				`History summaries: ${event.failed} job(s) failed, ${event.succeeded} succeeded${cause ? ` (first cause: ${cause.reason}: ${cause.message})` : ""}. Exact history recall is unaffected.`,
			);
		}
		// Held model-summary work is neither failed nor done: say so once per distinct cause, plainly.
		if (event.held !== undefined && event.held > 0) {
			if (event.heldReason !== this.lastHeldWarning) {
				this.lastHeldWarning = event.heldReason;
				this.deps.emitWarning(
					`History summaries: ${event.held} model summary job(s) are held: ${event.heldReason ?? "a condition is not met"}. Exact copies and exact history recall are unaffected.`,
				);
			}
		} else this.lastHeldWarning = undefined;
	}

	private mapStatus(
		status: TranscriptMemoryStatus,
		sessionId: string,
		frontierState: TranscriptFrontierState | undefined,
	): TranscriptHierarchyStatus {
		const frontier = status.frontiers.find((entry) => entry.lineageKey === sessionId);
		return {
			state: status.phase,
			...(status.disabledReason ? { disabledReason: status.disabledReason } : {}),
			counts: { ...status.counts },
			...(status.oldestBacklogAgeMs !== undefined ? { oldestBacklogAgeMs: status.oldestBacklogAgeMs } : {}),
			failures: status.recentFailures.map((failure) => ({
				level: failure.level,
				reason: failure.reason,
				message: failure.message,
				at: failure.at,
			})),
			recoveryIssues: [...status.recoveryIssues],
			acceptedNodes: status.acceptedNodes,
			admission: {
				contractVersion: status.admission.contractVersion,
				...(status.admission.blocked ? { blocked: { ...status.admission.blocked } } : {}),
				heldJobs: status.admission.heldJobs,
				...(status.admission.heldReason !== undefined ? { heldReason: status.admission.heldReason } : {}),
				judgments: { ...status.admission.judgments },
				unapprovedNodes: status.admission.unapprovedNodes,
				readmission: { ...status.admission.readmission },
			},
			retention: {
				scope: status.retention.scope,
				...(status.retention.days !== undefined ? { days: status.retention.days } : {}),
				...(status.retention.nextDeadlineAt !== undefined
					? { nextDeadlineAt: status.retention.nextDeadlineAt }
					: {}),
				eventTimeUnknownSources: status.retention.eventTimeUnknownSources,
				sessionTimestampSources: status.retention.sessionTimestampSources,
				heldForAnchor: status.retention.heldForAnchor,
			},
			pendingParentRederivations: status.pendingParentRederivations,
			spentAttempts: { ...status.spentAttempts },
			...(status.lastRevocation ? { lastRevocation: { ...status.lastRevocation } } : {}),
			...(frontierState ? { frontierState } : {}),
			...(frontier
				? {
						frontier: {
							revision: frontier.revision,
							bytes: frontier.bytes,
							nodeCount: frontier.nodeCount,
							omittedBeforeIndex: frontier.omittedBeforeIndex,
							coveredThroughIndex: frontier.coveredThroughIndex,
						},
					}
				: {}),
			recentBatches: status.recentBatches.map((batch) => ({
				batchId: batch.batchId,
				outcome: batch.outcome,
				succeeded: batch.succeeded,
				failed: batch.failed,
				cancelled: batch.cancelled,
				stale: batch.stale,
				interrupted: batch.interrupted,
				endedAt: batch.endedAt,
			})),
		};
	}
}
