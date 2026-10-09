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
import { limitFrontierToPrefix, renderFrontier } from "./transcript-frontier.ts";
import {
	TranscriptMemory,
	type TranscriptMemoryStatus,
	type TranscriptMemoryTerminalEvent,
} from "./transcript-memory.ts";
import type { TranscriptLineageReader } from "./transcript-memory-contracts.ts";
import type { TranscriptNodeExpander } from "./transcript-source-tools.ts";
import { resolveTranscriptSummarizer, type TranscriptSummarizerDeps } from "./transcript-summarizer.ts";
import { TranscriptSummaryStore } from "./transcript-summary-store.ts";

export interface TranscriptHistorySettings {
	hierarchy: boolean;
	summaryModel: string | undefined;
	allowExternalSummaryEgress: boolean;
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
	/** True while the foreground owns the provider; background summaries wait for it to end. */
	isForegroundBusy(): boolean;
	/** Foreground activity changes (a submission starts or ends). No polling. */
	subscribeForegroundActivity(listener: () => void): () => void;
	/** The operator-facing warning path; failures and self-stops are reported once per batch. */
	emitWarning(message: string): void;
}

/**
 * The live branch as the frontier is fenced against it: the first entry the live context keeps after the
 * latest compaction, and the two ancestry questions the fence asks. The frontier may only describe
 * history that was compacted away on THIS branch.
 */
export interface FrontierBranchFence {
	firstKeptEntryId: string;
	/** The entry lies above `firstKeptEntryId` on the live branch (it was compacted away). */
	isCompactedAway(entryId: string): boolean;
	/** `firstKeptEntryId` lies on the path to this entry (the entry is in or after the live context). */
	isInLiveContext(entryId: string): boolean;
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
	/** The frontier's covered entries are not on the live branch (after a branch switch): never described. */
	| "lineage_mismatch"
	/** The frontier covers only history that is still in the live context. */
	| "live_context"
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
	 * The current session's frontier, cut to the history compacted away on the live branch and rendered
	 * within `allowanceBytes` (further capped by `frontierMaxBytes`). Nodes that reach into the live context
	 * are not shown, and a frontier whose entries are off the live branch is reported, never described.
	 */
	previewFrontier(allowanceBytes: number, fence: FrontierBranchFence): TranscriptFrontierPreview {
		const coordinator = this.coordinator;
		if (!coordinator?.isRunning()) return { state: "not_running" };
		const sessionId = this.deps.getSessionId();
		const snapshot = coordinator.frontierSnapshot(sessionId);
		if (!snapshot || snapshot.selection.nodeIds.length === 0) return { state: "no_frontier" };
		const lastEntryId = (node: { sourceRefs: readonly { entryId: string }[] }): string | undefined =>
			node.sourceRefs[node.sourceRefs.length - 1]?.entryId;
		const limited = limitFrontierToPrefix(snapshot.selection, snapshot.nodes, (node) => {
			const entryId = lastEntryId(node);
			return entryId !== undefined && fence.isCompactedAway(entryId);
		});
		if (limited.keptCount === 0) {
			const first = snapshot.nodes.get(snapshot.selection.nodeIds[0] as string);
			const entryId = first ? lastEntryId(first) : undefined;
			return {
				state: entryId !== undefined && fence.isInLiveContext(entryId) ? "live_context" : "lineage_mismatch",
			};
		}
		const truncated = limited.keptCount < snapshot.selection.nodeIds.length;
		const rendering = renderFrontier(limited.selection, snapshot.nodes, {
			sessionId,
			// A cut at the compaction boundary leaves nothing missing; only a frontier that reaches it can have a gap.
			...(!truncated && snapshot.gap ? { gap: snapshot.gap } : {}),
			allowanceBytes: Math.min(allowanceBytes, this.deps.getHistorySettings().frontierMaxBytes),
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
			settings: () => {
				const live = this.deps.getHistorySettings();
				return {
					hierarchy: live.hierarchy,
					allowExternalSummaryEgress: live.allowExternalSummaryEgress,
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
