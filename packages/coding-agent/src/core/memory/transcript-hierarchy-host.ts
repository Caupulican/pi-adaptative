/**
 * Session-side host of the history hierarchy: decides whether the coordinator should run for the current
 * memory generation, builds its ports from the session's own owners (settings, model registry, isolated
 * completion, usage ledger, foreground activity), restarts it when the settings that shape it change,
 * and projects its frontier into the request. The coordinator itself stays free of sessions and timers.
 *
 * Background construction runs only for a non-child session with an attached history index, the hierarchy
 * on, memory retrieval enabled and a configured summary model that resolves and may receive the history
 * (local, or external egress allowed). Anything else leaves it stopped with the real reason, which
 * diagnostics report. Reading summaries that already exist does not depend on it: while no coordinator
 * runs, expansion and discovery go through a read-only view of the stored nodes.
 */

import type { TranscriptHierarchyStatus } from "../context/memory-diagnostics.ts";
import type { SemanticDecisionEngine } from "../decision/engine.ts";
import type { ActiveBranchEntryStanding } from "./active-branch-probe.ts";
import { type FrontierAudience, projectFrontierView, renderFrontierView } from "./transcript-frontier.ts";
import {
	type TranscriptForgetOutcome,
	TranscriptMemory,
	type TranscriptMemoryStatus,
	type TranscriptMemoryTerminalEvent,
} from "./transcript-memory.ts";
import {
	MEMORY_RETRIEVAL_DISABLED_REASON,
	TRANSCRIPT_SUMMARY_CHANGED_IN_FLIGHT,
	type TranscriptLineageReader,
	type TranscriptReadUnavailable,
	truncateUtf8,
	utf8ByteLength,
} from "./transcript-memory-contracts.ts";
import {
	reasonSentence,
	type TranscriptNodeExpander,
	type TranscriptSummaryLookup,
} from "./transcript-source-tools.ts";
import { resolveTranscriptSummarizer, type TranscriptSummarizerDeps } from "./transcript-summarizer.ts";
import { createSemanticSummaryAdmission, type TranscriptSummaryAdmissionPort } from "./transcript-summary-admission.ts";
import { transcriptRetentionCutoff } from "./transcript-summary-catalog.ts";
import {
	type TranscriptSummaryHeldByKind,
	type TranscriptSummaryHoldKind,
	TranscriptSummaryStore,
} from "./transcript-summary-store.ts";
import { TranscriptSummaryView } from "./transcript-summary-view.ts";

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

// Reasons are whole sentences, like the shared MEMORY_RETRIEVAL_DISABLED_REASON, wherever they are shown.
const NOT_RUNNING_REASON = "The summary hierarchy is not running.";

/** Each hold kind in words; `sparesExactCopies`: reached only after a job's exact-copy path (model summaries alone). */
const HOLD_KINDS: Record<TranscriptSummaryHoldKind, { label: string; sparesExactCopies: boolean }> = {
	model_work: { label: "model work cannot run", sparesExactCopies: true },
	children: { label: "awaiting child summary admission", sparesExactCopies: true },
	proof: { label: "terminal-proof capacity", sparesExactCopies: false },
	persistence: { label: "state not yet saved durably", sparesExactCopies: false },
	reconciliation: { label: "awaiting session reconciliation", sparesExactCopies: false },
};

/** The kinds holding at least one job, in a fixed order. */
function heldKinds(byKind: TranscriptSummaryHeldByKind | undefined): TranscriptSummaryHoldKind[] {
	return (Object.keys(HOLD_KINDS) as TranscriptSummaryHoldKind[]).filter((kind) => (byKind?.[kind] ?? 0) > 0);
}

/**
 * The operator warning for held work. When every held job shares one kind that holds model summaries alone
 * (model work or child admission), the one recorded cause describes them all: the standing wording, cause verbatim.
 * Otherwise each kind is listed with its count beside the first recorded cause, and exact copies are said to be
 * unaffected only when every kind present spares them. Without per-kind counts nothing about all of them is claimed.
 */
function describeHold(
	held: number,
	byKind: TranscriptSummaryHeldByKind | undefined,
	reason: string | undefined,
): string {
	const kinds = heldKinds(byKind);
	const only = kinds.length === 1 ? kinds[0] : undefined;
	if (only !== undefined && HOLD_KINDS[only].sparesExactCopies) {
		return `History summaries: ${held} model summary job(s) are held: ${reason ?? "a condition is not met"}. Exact copies and exact history recall are unaffected.`;
	}
	const listed = kinds.map((kind) => `${byKind?.[kind] ?? 0} ${HOLD_KINDS[kind].label}`).join(", ");
	const unaffected =
		kinds.length > 0 && kinds.every((kind) => HOLD_KINDS[kind].sparesExactCopies)
			? "Exact copies and exact history recall are unaffected."
			: "Exact history recall is unaffected.";
	return `History summaries: ${held} summary job(s) are held${listed ? ` (${listed})` : ""}; first cause: ${reasonSentence(reason ?? "a condition is not met")} ${unaffected}`;
}

const NOT_ATTACHED_REASON = "No history index is attached.";
const HIERARCHY_OFF_REASON = "The summary hierarchy is off.";

/** The operator view's bound on the coordinator's latest internal cause, marker included. */
const MAX_INTERNAL_CAUSE_BYTES = 512;
const INTERNAL_CAUSE_TRUNCATED = " [truncated]";

/** `cause` within {@link MAX_INTERNAL_CAUSE_BYTES} UTF-8 bytes; a cut cause ends with the truncation marker. */
function boundInternalCause(cause: string): string {
	if (utf8ByteLength(cause) <= MAX_INTERNAL_CAUSE_BYTES) return cause;
	const kept = truncateUtf8(cause, MAX_INTERNAL_CAUSE_BYTES - utf8ByteLength(INTERNAL_CAUSE_TRUNCATED));
	return `${kept}${INTERNAL_CAUSE_TRUNCATED}`;
}

export class TranscriptHierarchyHost {
	private readonly deps: TranscriptHierarchyHostDeps;
	private readonly admission: TranscriptSummaryAdmissionPort;
	private lastHeldKey: string | undefined;
	private coordinator: TranscriptMemory | undefined;
	/** Read-only access to stored nodes for the current attachment while no coordinator runs; built on first read. */
	private view: TranscriptSummaryView | undefined;
	private reader: TranscriptLineageReader | undefined;
	private isCurrent: () => boolean = () => false;
	private attachment = 0;
	private appliedSignature: string | undefined;
	private offReason: string | undefined = HIERARCHY_OFF_REASON;
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
		this.view = undefined;
		return this.request();
	}

	/** Stop the coordinator before the generation's reader is released; the read-only view goes with it. */
	detach(): Promise<void> {
		this.reader = undefined;
		this.isCurrent = () => false;
		this.attachment += 1;
		this.view = undefined;
		return this.request();
	}

	/** Called when effective settings changed; restarts only when something that shapes the coordinator did. */
	settingsChanged(): Promise<void> {
		return this.request();
	}

	/**
	 * Forget a session's derived history, by operator or retention authority. The outcome is the running
	 * coordinator's (`forgotten`, or `refused` with its cause); with none running nothing can be forgotten, and
	 * that is a refusal, never a silent success.
	 */
	async forgetSession(sessionId: string): Promise<TranscriptForgetOutcome> {
		if (!this.coordinator?.isRunning()) {
			return { status: "refused", reason: "no history hierarchy is active; nothing was forgotten" };
		}
		return this.coordinator.forgetSession(sessionId);
	}

	/** The zoom surface; resolves its source per call so a restart or a new generation is never held on to. */
	expander(): TranscriptNodeExpander {
		return { expand: (handle, options) => this.readSummaries((source) => source.expand(handle, options)) };
	}

	/** Approved summaries covering history hits (contract C5); resolved per call like {@link expander}. */
	summaryLookup(): TranscriptSummaryLookup {
		return {
			summariesFor: (refs, limits, options) =>
				this.readSummaries((source) => source.summariesFor(refs, limits, options)),
		};
	}

	/**
	 * The current session's frontier as the live branch sees it, rendered within `allowanceBytes` (further capped
	 * by `frontierMaxBytes`) and `allowanceLines` (the whole rendering, frame and pointers included): the
	 * compacted-away coverage minus whatever the live context still shows (see
	 * {@link projectFrontierView}). The persisted selection is never changed. A frontier with nothing compacted
	 * away is reported as live context, and one whose entries are off the live branch is reported, never described.
	 * `audience` only picks the tool names its pointers use (the root's history actions or a lane's `memory_read`).
	 */
	previewFrontier(
		allowanceBytes: number,
		allowanceLines: number,
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
			allowanceLines,
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

	/**
	 * Operator-view status; reads in-memory state only and never loads the store. `readAccess` names where a
	 * summary read would go now (the same resolution reads use), so construction being off is never mistaken
	 * for stored summaries being unreadable.
	 */
	status(): TranscriptHierarchyStatus {
		const coordinator = this.coordinator;
		const settings = this.deps.getHistorySettings();
		const route = this.readRoute();
		const readAccess =
			route.kind === "refused"
				? { readAccess: route.refusal.status, readAccessReason: route.refusal.reason }
				: { readAccess: route.kind };
		if (!coordinator) {
			return {
				state: settings.hierarchy ? "stopped" : "off",
				disabledReason: reasonSentence(this.lastError ?? this.offReason ?? NOT_RUNNING_REASON),
				counts: {},
				failures: [],
				recoveryIssues: [],
				recentBatches: [],
				...readAccess,
			};
		}
		return { ...this.mapStatus(coordinator.status(), this.deps.getSessionId(), this.frontierState), ...readAccess };
	}

	// ---- internals ----------------------------------------------------------------------------

	/**
	 * One summary read against the running coordinator's catalog, or else the read-only view of the stored
	 * nodes. Disabled retrieval is a policy refusal and no attachment is unavailable, both before any read. A
	 * generation, attachment or policy that changed while the read ran never receives its answer.
	 */
	private async readSummaries<T>(
		run: (source: TranscriptNodeExpander & TranscriptSummaryLookup) => Promise<T>,
	): Promise<T | TranscriptReadUnavailable> {
		const route = this.readRoute();
		if (route.kind === "refused") return route.refusal;
		const attachment = this.attachment;
		let source: TranscriptNodeExpander & TranscriptSummaryLookup;
		if (route.kind === "coordinator") source = route.coordinator;
		else {
			this.view ??= new TranscriptSummaryView({
				store: this.openStore(),
				reader: route.reader,
				cutoff: () => transcriptRetentionCutoff(this.deps.getHistorySettings().retentionDays, Date.now()),
			});
			source = this.view;
		}
		const result = await run(source);
		if (attachment !== this.attachment || !this.isCurrent() || !this.deps.isRetrievalEnabled()) {
			return {
				status: "stale_snapshot",
				reason: `The history generation or retrieval policy ${TRANSCRIPT_SUMMARY_CHANGED_IN_FLIGHT}.`,
			};
		}
		return result;
	}

	/**
	 * Where a summary read goes now, decided without reading anything: refused by policy (`forbidden`) or for
	 * want of an attached current index (`unavailable`), else the running coordinator, else the read-only view.
	 */
	private readRoute():
		| { kind: "refused"; refusal: { status: "forbidden" | "unavailable"; reason: string } }
		| { kind: "coordinator"; coordinator: TranscriptMemory }
		| { kind: "read_only_view"; reader: TranscriptLineageReader } {
		if (!this.deps.isRetrievalEnabled()) {
			return { kind: "refused", refusal: { status: "forbidden", reason: MEMORY_RETRIEVAL_DISABLED_REASON } };
		}
		const reader = this.reader;
		if (!reader || !this.isCurrent()) {
			return { kind: "refused", refusal: { status: "unavailable", reason: NOT_ATTACHED_REASON } };
		}
		const coordinator = this.coordinator;
		return coordinator?.isRunning() ? { kind: "coordinator", coordinator } : { kind: "read_only_view", reader };
	}

	private openStore(): TranscriptSummaryStore {
		return new TranscriptSummaryStore({ agentDir: this.deps.getAgentDir(), projectId: this.deps.projectId() });
	}

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
		if (!reader) reason = NOT_ATTACHED_REASON;
		else if (this.deps.isChildSession()) reason = "Child sessions do not build a history hierarchy.";
		else if (!settings.hierarchy) reason = HIERARCHY_OFF_REASON;
		else if (!this.deps.isRetrievalEnabled()) reason = MEMORY_RETRIEVAL_DISABLED_REASON;
		let summarizer: ReturnType<typeof resolveTranscriptSummarizer> | undefined;
		if (reason === undefined) {
			summarizer = resolveTranscriptSummarizer(settings.summaryModel, this.deps.summarizer);
			if (!summarizer.ok) reason = summarizer.reason;
			else if (summarizer.summarizer.egress === "external" && !settings.allowExternalSummaryEgress) {
				reason = `Summary model ${summarizer.model} is not local, and external summary egress is not allowed.`;
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
			store: this.openStore(),
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
			return;
		}
		// The coordinator reads through its own catalog now; the view's copy of the nodes is dropped.
		this.view = undefined;
		// Indexing starts on purpose only after the coordinator subscribed to index changes (during start), so the
		// ready change reaches it. A reader that was replaced meanwhile is left to its own generation.
		if (this.reader === reader && this.isCurrent()) reader.start();
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
		// Held work is neither failed nor done: say so once per distinct set of kinds and cause (not per count).
		if (event.held !== undefined && event.held > 0) {
			const key = `${heldKinds(event.heldByKind).join(",")}\u0000${event.heldReason ?? ""}`;
			if (key !== this.lastHeldKey) {
				this.lastHeldKey = key;
				this.deps.emitWarning(describeHold(event.held, event.heldByKind, event.heldReason));
			}
		} else this.lastHeldKey = undefined;
	}

	private mapStatus(
		status: TranscriptMemoryStatus,
		sessionId: string,
		frontierState: TranscriptFrontierState | undefined,
	): TranscriptHierarchyStatus {
		const frontier = status.frontiers.find((entry) => entry.lineageKey === sessionId);
		return {
			state: status.phase,
			...(status.disabledReason ? { disabledReason: reasonSentence(status.disabledReason) } : {}),
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
			// The operator view's admission has exactly the coordinator's fields: a copy, nested records included.
			admission: {
				...status.admission,
				...(status.admission.blocked ? { blocked: { ...status.admission.blocked } } : {}),
				...(status.admission.heldByKind ? { heldByKind: { ...status.admission.heldByKind } } : {}),
				judgments: { ...status.admission.judgments },
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
			spentAttempts: {
				recorded: status.spentAttempts.recorded,
				reserved: status.spentAttempts.reserved,
				bound: status.spentAttempts.bound,
				...(status.spentAttempts.hold ? { hold: { ...status.spentAttempts.hold } } : {}),
			},
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
			...(status.lastInternalError !== undefined
				? {
						lastInternalError: {
							cause: boundInternalCause(status.lastInternalError.cause),
							at: status.lastInternalError.at,
						},
					}
				: {}),
		};
	}
}
