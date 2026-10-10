/**
 * Safe, leak-free diagnostic projections of the memory-retrieval/prompt-inclusion state,
 * for the context_audit tool (src/core/extensions/builtin.ts). Nothing here queries a
 * provider or touches the OKF directory -- callers must pass in already-computed reports
 * (AgentSession's existing no-arg, latest-stored-only getters).
 *
 * `sanitizeMemoryRetrievalReportForDiagnostics` is ALLOW-LIST based, not deny-list: it
 * builds its output by explicitly copying only known-safe fields, never by spreading the
 * source report and deleting unsafe ones. A spread-then-delete approach would silently
 * re-expose any new content-bearing field added to `MemoryRetrievalReport` later; an
 * allow-list cannot leak a field it was never told to copy.
 */

import { MEMORY_RETRIEVAL_DISABLED_REASON, type TranscriptCoverage } from "../memory/transcript-memory-contracts.ts";
import type { TranscriptSummaryHeldByKind, TranscriptSummaryHoldKind } from "../memory/transcript-summary-store.ts";
import type { MemoryPolicyRejectionReason } from "./memory-provider-contract.ts";
import type { MemoryProviderRetrievalStatus, MemoryRetrievalReport } from "./memory-retrieval.ts";

export type MemoryPromptInclusionStatus =
	| "disabled"
	| "include_disabled"
	| "no_results"
	| "empty_block"
	| "included"
	| "failed";

export interface MemoryPromptInclusionReport {
	status: MemoryPromptInclusionStatus;
	enabled: boolean;
	includeInPrompt: boolean;
	selectedItemCount: number;
	includedCount: number;
	omittedCount: number;
	blockChars: number;
	sourceLabel?: string;
}

export function defaultMemoryPromptInclusionReport(): MemoryPromptInclusionReport {
	return {
		status: "disabled",
		enabled: false,
		includeInPrompt: false,
		selectedItemCount: 0,
		includedCount: 0,
		omittedCount: 0,
		blockChars: 0,
	};
}

/** Safe per-provider projection: fixed enums and counts only, never `error` (may embed a filesystem path). */
export interface MemoryRetrievalProviderDiagnostics {
	providerId: string;
	status: MemoryProviderRetrievalStatus;
	rejectionReasons: MemoryPolicyRejectionReason[];
	resultCount: number;
	/**
	 * For a failed provider, the leading typed status of its error (`pending`, `unavailable`, ...) or
	 * `error` when it carries none. The error text itself is never projected: it may embed a path.
	 */
	failure?: string;
}

/** Typed reader statuses a transcript provider error may start with (`<status>: <reason>`). */
const TYPED_FAILURE_STATUS = /^(pending|unavailable|forbidden|not_found|expired|uncaptured|stale_snapshot):/;

export function failureClassOfError(error: string | undefined): string {
	return TYPED_FAILURE_STATUS.exec(error ?? "")?.[1] ?? "error";
}

export interface MemoryRetrievalDiagnostics {
	enabled: boolean;
	maxResults: number;
	providerReports: MemoryRetrievalProviderDiagnostics[];
	selectedItemCount: number;
}

/**
 * Projects a live `MemoryRetrievalReport` down to only safe, bounded metadata. Drops
 * `request.query`, every `results[]`/`contextItems[]` content field, and
 * `providerReports[].error` entirely (never redacted -- redaction logic is itself a place
 * a leak could slip back in).
 */
export function sanitizeMemoryRetrievalReportForDiagnostics(
	report: MemoryRetrievalReport,
	settings: { enabled: boolean; maxResults: number },
): MemoryRetrievalDiagnostics {
	return {
		enabled: settings.enabled,
		maxResults: settings.maxResults,
		providerReports: report.providerReports.map((providerReport) => ({
			providerId: providerReport.providerId,
			status: providerReport.status,
			rejectionReasons: [...providerReport.rejectionReasons],
			resultCount: providerReport.resultCount,
			...(providerReport.status === "failed" ? { failure: failureClassOfError(providerReport.error) } : {}),
		})),
		selectedItemCount: report.contextItems.length,
	};
}

// ---------------------------------------------------------------------------------------------
// Past-session history (transcript recall)
// ---------------------------------------------------------------------------------------------

/** One finished batch of summary work, as a bounded terminal record. */
export interface TranscriptHierarchyBatch {
	batchId: number;
	outcome: "completed" | "stopped";
	succeeded: number;
	failed: number;
	cancelled: number;
	stale: number;
	interrupted: number;
	endedAt: number;
}

/** How derived-summary retention applies; counts and instants only. The setting ages out DERIVED summaries, never canonical transcripts or exact reads. */
export interface TranscriptHierarchyRetention {
	scope: "derived_summaries_only";
	days?: number;
	/** When the next accepted summary reaches its retention deadline. */
	nextDeadlineAt?: number;
	/** Source parts without an event time that age from their first capture (`event_time_unknown`). */
	eventTimeUnknownSources: number;
	/** Source parts without an entry time that age from the canonical session timestamp. */
	sessionTimestampSources: number;
	/** Source parts the anchor ceiling refused: dependent summaries are held. */
	heldForAnchor: number;
}

/** The latest revocation of derived history and what was done about the summaries built on it. */
export interface TranscriptHierarchyRevocation {
	at: number;
	reason: "invalidated" | "retention" | "forgotten" | "admission_rejected" | "admission_uncertain";
	revokedNodes: number;
	droppedReadyJobs: number;
	readmittedParents: number;
}

/** Why model summary work cannot proceed: a fixed class (safe in diagnostics) and the real cause in words (operator view only). */
export type TranscriptHierarchyBlockKind =
	| "no_summarizer"
	| "summary_egress_not_allowed"
	| "no_admission_evaluator"
	| "admission_egress_not_allowed"
	| "admission_not_bound"
	| "admission_not_calibrated";

/**
 * Evidence-quality admission of model summaries. Exact copies are never judged. A model summary is accepted
 * only after a System One judgment; while one cannot run, model summaries are held and exact copies still flow.
 */
export interface TranscriptHierarchyAdmission {
	contractVersion: number;
	blocked?: { kind: TranscriptHierarchyBlockKind; reason: string };
	/** Model-summary jobs held before any provider call. */
	heldJobs: number;
	/** The FIRST hold's kind (a fixed class, safe in diagnostics); statements about all held jobs use `heldByKind`. */
	heldKind?: TranscriptSummaryHoldKind;
	/** Held jobs counted per hold kind (fixed classes and counts, safe in diagnostics); present when `heldJobs > 0`. */
	heldByKind?: TranscriptSummaryHeldByKind;
	/** The hold's real cause in words (operator view only). */
	heldReason?: string;
	judgments: { accepted: number; rejected: number; uncertain: number; unavailable: number };
	/** Reuses of a kept acceptance published again without a new judgment (events, not distinct acceptances); never counted in `judgments`. */
	reused: number;
	/** Accepted model summaries without a current admission: never shown or expanded as approved. */
	unapprovedNodes: number;
	readmission: {
		admitted: number;
		rejected: number;
		uncertain: number;
		unavailable: number;
		/** Unapproved nodes by the wait code that says why each is not approved. */
		waitingFor: Partial<Record<string, number>>;
	};
}

/** How approved stored summaries are read (see {@link TranscriptHierarchyStatus.readAccess}). */
export type TranscriptHierarchyReadAccess = "coordinator" | "read_only_view" | "forbidden" | "unavailable";

/** The summary hierarchy as the operator sees it; the diagnostic projection is derived from it. */
export interface TranscriptHierarchyStatus {
	state: "off" | "starting" | "running" | "stopped";
	/** Why the hierarchy is not running (real cause, operator view only). */
	disabledReason?: string;
	/** Jobs by state. */
	counts: Record<string, number>;
	/** Age of the oldest job that is not finished; absent when there is no backlog. */
	oldestBacklogAgeMs?: number;
	/** Recent job failures: `reason` is a fixed class, `message` the real cause (operator view only). */
	failures: { level: number; reason: string; message: string; at: number }[];
	/** Recovery states found while loading derived state, in words (operator view only). */
	recoveryIssues: string[];
	/** Accepted summary nodes the running coordinator holds; absent when no coordinator counts them. */
	acceptedNodes?: number;
	/**
	 * How approved stored summaries are read right now: through the running coordinator, through the read-only
	 * view (construction off; reads need no model, admission or egress), refused by policy, or not at all.
	 */
	readAccess?: TranscriptHierarchyReadAccess;
	/** The real cause behind `readAccess` (operator view only). */
	readAccessReason?: string;
	admission?: TranscriptHierarchyAdmission;
	retention?: TranscriptHierarchyRetention;
	/** Parents being derived again after a revocation: those ranges are covered by their children meanwhile. */
	pendingParentRederivations?: number;
	/**
	 * Durable terminal-proof capacity: `recorded` proof records (spent and reserved) of `bound`, `reserved` held by
	 * admitted jobs that have not ended, and the durable saturation hold that keeps new summary work from starting.
	 */
	spentAttempts?: {
		recorded: number;
		reserved: number;
		bound: number;
		hold?: { cause: "capacity" | "possibly_lost_proof"; since: string };
	};
	lastRevocation?: TranscriptHierarchyRevocation;
	/** Why the latest committed request did or did not carry the history frontier. */
	frontierState?: string;
	/** The current session's frontier, when one exists. */
	frontier?: {
		revision: number;
		bytes: number;
		nodeCount: number;
		omittedBeforeIndex: number;
		coveredThroughIndex: number;
	};
	recentBatches: TranscriptHierarchyBatch[];
	/**
	 * The coordinator's latest internal cause (re-admission waits, discarded judgments, unread sources, save
	 * failures) and the ISO time it was recorded at: one slot the next cause overwrites, not cleared when the
	 * condition ends. The cause is bounded in bytes, a cut cause ending with a truncation marker. Operator view only:
	 * it may embed a block reason or a path, so the diagnostic projection never carries it.
	 */
	lastInternalError?: { cause: string; at: string };
}

/** What the operator-facing view knows about history recall; the diagnostic projection is derived from it. */
export interface TranscriptHistoryStatus {
	/** `on_demand`: the index is bound but not started; the first history request starts it (it may answer `pending`). */
	availability: "disabled" | "unavailable" | "on_demand" | "loading" | "active";
	/** Why the index is unavailable (real cause). Operator view only. */
	unavailableReason?: string;
	/** Absent while the index is loading or when the backend is unavailable. */
	coverage?: TranscriptCoverage;
	/** Transport facts the availability alone does not say: when it stopped, and reads that gave up on it. */
	transport?: TranscriptTransportDiagnostics;
	/** The transcript provider's slot in the latest retrieval pass, when it was queried. */
	latestRetrieval?: {
		status: MemoryProviderRetrievalStatus;
		resultCount: number;
		/** Returned hits that each name an exact source (`tx:` handle). */
		sourceRefCount: number;
		/** The provider's real failure text. Operator view only. */
		error?: string;
	};
	/** Transcript items admitted into the prompt memory block of the latest query pass. */
	admittedInPromptCount: number;
	/** Absent when the summary hierarchy was never configured for this session. */
	hierarchy?: TranscriptHierarchyStatus;
}

export interface ReasonCount {
	reason: string;
	count: number;
}

export interface TranscriptCoverageDiagnostics {
	sessionsEligible: number;
	sessionsIndexed: number;
	sessionsUnsupported: number;
	sessionsSkipped: number;
	spansIndexed: number;
	spansUncaptured: number;
	truncated: boolean;
	skipped: ReasonCount[];
	unsupported: ReasonCount[];
	uncaptured: ReasonCount[];
	/** Sources failing to read right now; a `lastError` with none failing is history, not a current fault. */
	activeFailures: number;
	lastError?: { at: string; kind: string };
	lastRecoveryAt?: string;
}

/** Timestamps and counts only. A stopped transport's cause text is operator-view only (it may name a path). */
export interface TranscriptTransportDiagnostics {
	stoppedAt?: string;
	readTimeouts?: { count: number; lastAt: string };
}

/**
 * Allow-list projection of the hierarchy: counts and fixed failure classes only, never a cause text or a path
 * (so neither `disabledReason`, `readAccessReason`, failure messages, recovery issues nor `lastInternalError`).
 */
export interface TranscriptHierarchyDiagnostics {
	state: TranscriptHierarchyStatus["state"];
	counts: Record<string, number>;
	oldestBacklogAgeMs?: number;
	failureClasses: ReasonCount[];
	recoveryIssueCount: number;
	acceptedNodes?: number;
	/** The fixed read-access class only; never its cause text. */
	readAccess?: TranscriptHierarchyReadAccess;
	/** Counts and the fixed block class only; never the cause text. */
	admission?: Omit<TranscriptHierarchyAdmission, "blocked" | "heldReason"> & {
		blockedKind?: TranscriptHierarchyBlockKind;
	};
	retention?: TranscriptHierarchyRetention;
	pendingParentRederivations?: number;
	spentAttempts?: TranscriptHierarchyStatus["spentAttempts"];
	lastRevocation?: TranscriptHierarchyRevocation;
	frontierState?: string;
	frontier?: TranscriptHierarchyStatus["frontier"];
	lastBatch?: TranscriptHierarchyBatch;
}

export interface TranscriptMemoryDiagnostics {
	availability: TranscriptHistoryStatus["availability"];
	coverage?: TranscriptCoverageDiagnostics;
	transport?: TranscriptTransportDiagnostics;
	latestRetrieval?: {
		status: MemoryProviderRetrievalStatus;
		resultCount: number;
		sourceRefCount: number;
		failure?: string;
	};
	admittedInPromptCount: number;
	hierarchy?: TranscriptHierarchyDiagnostics;
}

const TOP_REASONS = 5;
const MAX_ERROR_KIND_CHARS = 64;

function topReasons(reasons: Readonly<Record<string, number>>): ReasonCount[] {
	return Object.entries(reasons)
		.map(([reason, count]) => ({ reason, count }))
		.sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))
		.slice(0, TOP_REASONS);
}

/** Allow-list projection: counts, reason keys and the error CLASS only; never text that may hold a path or content. */
export function sanitizeTranscriptHistoryForDiagnostics(status: TranscriptHistoryStatus): TranscriptMemoryDiagnostics {
	const coverage = status.coverage;
	const retrieval = status.latestRetrieval;
	return {
		availability: status.availability,
		...(coverage
			? {
					coverage: {
						sessionsEligible: coverage.sessionsEligible,
						sessionsIndexed: coverage.sessionsIndexed,
						sessionsUnsupported: coverage.sessionsUnsupported,
						sessionsSkipped: coverage.sessionsSkipped,
						spansIndexed: coverage.spansIndexed,
						spansUncaptured: coverage.spansUncaptured,
						truncated: coverage.truncated,
						skipped: topReasons(coverage.skipped),
						unsupported: topReasons(coverage.unsupported),
						activeFailures: coverage.activeFailures,
						...(coverage.lastRecoveryAt ? { lastRecoveryAt: coverage.lastRecoveryAt } : {}),
						uncaptured: topReasons(coverage.uncaptured),
						...(coverage.lastError
							? {
									lastError: {
										at: coverage.lastError.at,
										kind:
											coverage.lastError.message.split(": ", 1)[0]?.slice(0, MAX_ERROR_KIND_CHARS) ??
											"error",
									},
								}
							: {}),
					},
				}
			: {}),
		...(status.transport ? { transport: { ...status.transport } } : {}),
		...(retrieval
			? {
					latestRetrieval: {
						status: retrieval.status,
						resultCount: retrieval.resultCount,
						sourceRefCount: retrieval.sourceRefCount,
						...(retrieval.status === "failed" ? { failure: failureClassOfError(retrieval.error) } : {}),
					},
				}
			: {}),
		admittedInPromptCount: status.admittedInPromptCount,
		...(status.hierarchy ? { hierarchy: sanitizeHierarchyForDiagnostics(status.hierarchy) } : {}),
	};
}

function sanitizeHierarchyForDiagnostics(status: TranscriptHierarchyStatus): TranscriptHierarchyDiagnostics {
	const classes: Record<string, number> = {};
	for (const failure of status.failures) classes[failure.reason] = (classes[failure.reason] ?? 0) + 1;
	const lastBatch = status.recentBatches[status.recentBatches.length - 1];
	return {
		state: status.state,
		counts: { ...status.counts },
		...(status.oldestBacklogAgeMs !== undefined ? { oldestBacklogAgeMs: status.oldestBacklogAgeMs } : {}),
		failureClasses: topReasons(classes),
		recoveryIssueCount: status.recoveryIssues.length,
		...(status.acceptedNodes !== undefined ? { acceptedNodes: status.acceptedNodes } : {}),
		...(status.readAccess !== undefined ? { readAccess: status.readAccess } : {}),
		...(status.admission
			? {
					admission: {
						contractVersion: status.admission.contractVersion,
						...(status.admission.blocked ? { blockedKind: status.admission.blocked.kind } : {}),
						heldJobs: status.admission.heldJobs,
						...(status.admission.heldKind !== undefined ? { heldKind: status.admission.heldKind } : {}),
						...(status.admission.heldByKind !== undefined
							? { heldByKind: { ...status.admission.heldByKind } }
							: {}),
						judgments: { ...status.admission.judgments },
						reused: status.admission.reused,
						unapprovedNodes: status.admission.unapprovedNodes,
						readmission: { ...status.admission.readmission },
					},
				}
			: {}),
		...(status.retention ? { retention: { ...status.retention } } : {}),
		...(status.pendingParentRederivations !== undefined
			? { pendingParentRederivations: status.pendingParentRederivations }
			: {}),
		...(status.spentAttempts
			? {
					spentAttempts: {
						...status.spentAttempts,
						...(status.spentAttempts.hold ? { hold: { ...status.spentAttempts.hold } } : {}),
					},
				}
			: {}),
		...(status.lastRevocation ? { lastRevocation: { ...status.lastRevocation } } : {}),
		...(status.frontierState ? { frontierState: status.frontierState } : {}),
		...(status.frontier ? { frontier: { ...status.frontier } } : {}),
		...(lastBatch ? { lastBatch: { ...lastBatch } } : {}),
	};
}

function describeReasonCounts(reasons: readonly ReasonCount[]): string {
	return reasons.length === 0 ? "" : ` (${reasons.map(({ reason, count }) => `${reason}=${count}`).join(", ")})`;
}

/** Bounded, deterministic lines for context_audit and `/memory history`: safe metadata only. */
export function formatTranscriptMemoryLines(diagnostics: TranscriptMemoryDiagnostics): string[] {
	const lines: string[] = [];
	const coverage = diagnostics.coverage;
	if (coverage) {
		lines.push(
			`History recall: ${diagnostics.availability}; ${coverage.sessionsEligible} eligible session(s): ${coverage.sessionsIndexed} indexed, ${coverage.sessionsUnsupported} unsupported${describeReasonCounts(coverage.unsupported)}; ${coverage.sessionsSkipped} skipped${describeReasonCounts(coverage.skipped)}; ${coverage.spansIndexed} span(s) indexed, ${coverage.spansUncaptured} uncaptured${describeReasonCounts(coverage.uncaptured)}; ${coverage.truncated ? "indexing cut off by its budget" : "no budget cutoff"}; sessions not indexed cannot be found`,
		);
		if (coverage.activeFailures > 0) lines.push(`  ${coverage.activeFailures} source(s) failing to read now`);
		if (coverage.lastError) {
			lines.push(
				`  ${coverage.activeFailures > 0 ? "last" : "historical"} indexing error at ${coverage.lastError.at}: ${coverage.lastError.kind}${coverage.activeFailures > 0 ? "" : " (no source failing now)"}`,
			);
		}
		if (coverage.lastRecoveryAt)
			lines.push(`  a failing source last became readable again at ${coverage.lastRecoveryAt}`);
	} else {
		lines.push(
			`History recall: ${diagnostics.availability}${diagnostics.availability === "active" ? "; coverage not yet reported" : diagnostics.availability === "on_demand" ? "; the index starts on the first history request" : ""}`,
		);
	}
	const transport = diagnostics.transport;
	if (transport?.stoppedAt) lines.push(`  transport stopped at ${transport.stoppedAt}`);
	if (transport?.readTimeouts) {
		lines.push(`  ${transport.readTimeouts.count} read(s) timed out, latest at ${transport.readTimeouts.lastAt}`);
	}
	const retrieval = diagnostics.latestRetrieval;
	if (retrieval) {
		const outcome =
			retrieval.status === "failed"
				? `failed (${retrieval.failure ?? "error"})`
				: `${retrieval.status}, ${retrieval.resultCount} result(s), ${retrieval.sourceRefCount} source ref(s)`;
		lines.push(`  latest retrieval: ${outcome}; ${diagnostics.admittedInPromptCount} admitted into the prompt block`);
	}
	if (diagnostics.hierarchy) lines.push(...formatHierarchyLines(diagnostics.hierarchy));
	return lines;
}

const BLOCK_SENTENCES: Readonly<Record<TranscriptHierarchyBlockKind, string>> = {
	no_summarizer: "no summary model is configured",
	summary_egress_not_allowed: "the summary model is external and allowExternalSummaryEgress is off",
	no_admission_evaluator: "no summary admission evaluator is configured",
	admission_egress_not_allowed:
		"sending history to the remote System One evaluator needs contextPolicy.memory.history.allowExternalAdmissionEgress (a local summary model does not make it local)",
	admission_not_bound: "System One is not bound to this session",
	admission_not_calibrated: "the bound evaluator does not report calibrated probabilities",
};

/** Hold kinds that never hold an exact copy: only model summary work waits under them. */
const EXACT_COPY_SPARING_HOLDS: ReadonlySet<string> = new Set<TranscriptSummaryHoldKind>(["model_work", "children"]);

/** ` (kind n, kind n)` for every hold kind holding jobs, or "" when the counts are not known. */
function describeHeldByKind(heldByKind: TranscriptSummaryHeldByKind | undefined): string {
	const counts = Object.entries(heldByKind ?? {}).filter(([, count]) => (count ?? 0) > 0);
	return counts.length === 0 ? "" : ` (${counts.map(([kind, count]) => `${kind} ${count}`).join(", ")})`;
}

function formatAdmissionLines(admission: TranscriptHierarchyDiagnostics["admission"]): string[] {
	if (!admission) return [];
	const lines: string[] = [];
	const held =
		admission.heldJobs > 0 ? `${admission.heldJobs} summary job(s)${describeHeldByKind(admission.heldByKind)}` : "";
	if (admission.blockedKind) {
		// Exact copies flow only when every held job waits under a hold that spares them; with unknown counts, unclaimed.
		const exactCopiesFlow =
			admission.heldJobs === 0 ||
			(admission.heldByKind !== undefined &&
				Object.entries(admission.heldByKind).every(
					([kind, count]) => (count ?? 0) === 0 || EXACT_COPY_SPARING_HOLDS.has(kind),
				));
		lines.push(
			`  model summaries are held (${BLOCK_SENTENCES[admission.blockedKind]}); ${exactCopiesFlow ? "exact copies and exact history recall are unaffected" : "exact history recall is unaffected"}${held ? `; ${held} waiting` : ""}`,
		);
	} else if (admission.heldJobs > 0) {
		lines.push(`  ${held} held`);
	}
	const judged = admission.judgments;
	if (judged.accepted + judged.rejected + judged.uncertain + judged.unavailable + admission.reused > 0) {
		lines.push(
			`  summary admission (contract ${admission.contractVersion}): ${judged.accepted} accepted, ${judged.rejected} rejected, ${judged.uncertain} uncertain, ${judged.unavailable} evaluator-unavailable${admission.reused > 0 ? `; ${admission.reused} reuse(s) of a kept acceptance without a new judgment` : ""}`,
		);
	}
	if (admission.unapprovedNodes > 0) {
		const re = admission.readmission;
		lines.push(
			`  ${admission.unapprovedNodes} accepted summary(ies) predate the current admission contract and are not shown as approved until re-admitted (re-admitted ${re.admitted}, rejected ${re.rejected}, uncertain ${re.uncertain}, unavailable ${re.unavailable})`,
		);
		const waits = Object.entries(re.waitingFor)
			.filter(([, count]) => (count ?? 0) > 0)
			.map(([wait, count]) => `${wait} ${count}`);
		if (waits.length > 0) lines.push(`  unapproved summaries wait for: ${waits.join(", ")}`);
	}
	return lines;
}

const READ_ACCESS_SENTENCES: Readonly<Record<TranscriptHierarchyReadAccess, string>> = {
	coordinator: "approved summaries are read through the running hierarchy",
	read_only_view:
		"approved stored summaries are readable on demand through a read-only view; no summaries are being built, and reading them needs no model, admission or egress",
	forbidden: `refused: ${MEMORY_RETRIEVAL_DISABLED_REASON}`,
	unavailable: "unavailable: stored summaries cannot be read in this session right now",
};

function formatHierarchyLines(hierarchy: TranscriptHierarchyDiagnostics): string[] {
	const counts = Object.entries(hierarchy.counts)
		.filter(([, count]) => count > 0)
		.map(([state, count]) => `${state}=${count}`)
		.join(", ");
	const lines = [
		`History hierarchy: ${hierarchy.state}${hierarchy.acceptedNodes !== undefined ? `; ${hierarchy.acceptedNodes} accepted node(s)` : ""}; jobs ${counts || "none"}${hierarchy.oldestBacklogAgeMs !== undefined ? `; oldest backlog ${Math.round(hierarchy.oldestBacklogAgeMs / 1000)}s` : ""}`,
	];
	if (hierarchy.readAccess) lines.push(`  summary reads: ${READ_ACCESS_SENTENCES[hierarchy.readAccess]}`);
	if (hierarchy.frontierState) lines.push(`  history frontier in the latest request: ${hierarchy.frontierState}`);
	if (hierarchy.frontier) {
		lines.push(
			`  frontier revision ${hierarchy.frontier.revision}: ${hierarchy.frontier.nodeCount} node(s), ${hierarchy.frontier.bytes} bytes, spans [${hierarchy.frontier.omittedBeforeIndex},${hierarchy.frontier.coveredThroughIndex}) covered`,
		);
	}
	lines.push(...formatAdmissionLines(hierarchy.admission));
	if (hierarchy.failureClasses.length > 0) {
		lines.push(`  recent failures${describeReasonCounts(hierarchy.failureClasses)}`);
	}
	if (hierarchy.recoveryIssueCount > 0)
		lines.push(`  ${hierarchy.recoveryIssueCount} recovery issue(s) found at load`);
	const retention = hierarchy.retention;
	if (retention) {
		lines.push(
			`  retention: ${retention.days !== undefined ? `${retention.days} day(s)` : "off"}; ages DERIVED summaries only, canonical transcripts and exact reads are never erased by it${retention.nextDeadlineAt !== undefined ? `; next summary deadline ${new Date(retention.nextDeadlineAt).toISOString()}` : ""}`,
		);
		if (retention.eventTimeUnknownSources > 0) {
			lines.push(
				`  event_time_unknown: ${retention.eventTimeUnknownSources} source part(s) have no event time and age from their first capture`,
			);
		}
		if (retention.sessionTimestampSources > 0) {
			lines.push(
				`  ${retention.sessionTimestampSources} source part(s) without an entry time age from the canonical session timestamp`,
			);
		}
		if (retention.heldForAnchor > 0) {
			lines.push(
				`  ${retention.heldForAnchor} source part(s) could not be anchored; summaries depending on them are held`,
			);
		}
	}
	if (hierarchy.spentAttempts && (hierarchy.spentAttempts.recorded > 0 || hierarchy.spentAttempts.hold)) {
		const spent = hierarchy.spentAttempts;
		lines.push(
			`  terminal-proof capacity: ${spent.recorded} of ${spent.bound} record(s) held, ${spent.reserved} reserved by running jobs`,
		);
		if (spent.hold) {
			lines.push(
				spent.hold.cause === "capacity"
					? `  new summary work held since ${spent.hold.since}: terminal-proof capacity full; exact history recall is unaffected`
					: `  possibly lost proof (legacy ledger full or damaged): sessions started before ${spent.hold.since} get no new summary work; exact history recall is unaffected`,
			);
		}
	}
	if (hierarchy.lastRevocation) {
		const revocation = hierarchy.lastRevocation;
		lines.push(
			`  last revocation (${revocation.reason}): ${revocation.revokedNodes} node(s), ${revocation.droppedReadyJobs} completed job(s) dropped, ${revocation.readmittedParents} parent(s) derived again`,
		);
	}
	if (hierarchy.pendingParentRederivations)
		lines.push(
			`  ${hierarchy.pendingParentRederivations} parent summary(ies) being derived again; those ranges are covered at child level meanwhile`,
		);
	if (hierarchy.lastBatch) {
		const batch = hierarchy.lastBatch;
		lines.push(
			`  last batch #${batch.batchId} ${batch.outcome}: ${batch.succeeded} succeeded, ${batch.failed} failed, ${batch.stale} stale, ${batch.cancelled} cancelled, ${batch.interrupted} interrupted`,
		);
	}
	return lines;
}
