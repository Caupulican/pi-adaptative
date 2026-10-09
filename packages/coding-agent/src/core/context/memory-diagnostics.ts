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

import type { TranscriptCoverage } from "../memory/transcript-memory-contracts.ts";
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
	acceptedNodes: number;
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
}

/** What the operator-facing view knows about history recall; the diagnostic projection is derived from it. */
export interface TranscriptHistoryStatus {
	availability: "disabled" | "unavailable" | "loading" | "active";
	/** Why the index is unavailable (real cause). Operator view only. */
	unavailableReason?: string;
	/** Absent while the index is loading or when the backend is unavailable. */
	coverage?: TranscriptCoverage;
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
	sessionsIndexed: number;
	sessionsSkipped: number;
	spansIndexed: number;
	spansUncaptured: number;
	truncated: boolean;
	skipped: ReasonCount[];
	uncaptured: ReasonCount[];
	lastError?: { at: string; kind: string };
}

/** Allow-list projection of the hierarchy: counts and fixed failure classes only, never a cause text or a path. */
export interface TranscriptHierarchyDiagnostics {
	state: TranscriptHierarchyStatus["state"];
	counts: Record<string, number>;
	oldestBacklogAgeMs?: number;
	failureClasses: ReasonCount[];
	recoveryIssueCount: number;
	acceptedNodes: number;
	frontierState?: string;
	frontier?: TranscriptHierarchyStatus["frontier"];
	lastBatch?: TranscriptHierarchyBatch;
}

export interface TranscriptMemoryDiagnostics {
	availability: TranscriptHistoryStatus["availability"];
	coverage?: TranscriptCoverageDiagnostics;
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
						sessionsIndexed: coverage.sessionsIndexed,
						sessionsSkipped: coverage.sessionsSkipped,
						spansIndexed: coverage.spansIndexed,
						spansUncaptured: coverage.spansUncaptured,
						truncated: coverage.truncated,
						skipped: topReasons(coverage.skipped),
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
		acceptedNodes: status.acceptedNodes,
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
			`History recall: ${diagnostics.availability}; ${coverage.sessionsIndexed} session(s) indexed, ${coverage.sessionsSkipped} skipped${describeReasonCounts(coverage.skipped)}; ${coverage.spansIndexed} span(s) indexed, ${coverage.spansUncaptured} uncaptured${describeReasonCounts(coverage.uncaptured)}; indexing ${coverage.truncated ? "truncated by its budget" : "complete"}`,
		);
		if (coverage.lastError)
			lines.push(`  last indexing error at ${coverage.lastError.at}: ${coverage.lastError.kind}`);
	} else {
		lines.push(
			`History recall: ${diagnostics.availability}${diagnostics.availability === "active" ? "; coverage not yet reported" : ""}`,
		);
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

function formatHierarchyLines(hierarchy: TranscriptHierarchyDiagnostics): string[] {
	const counts = Object.entries(hierarchy.counts)
		.filter(([, count]) => count > 0)
		.map(([state, count]) => `${state}=${count}`)
		.join(", ");
	const lines = [
		`History hierarchy: ${hierarchy.state}; ${hierarchy.acceptedNodes} accepted node(s); jobs ${counts || "none"}${hierarchy.oldestBacklogAgeMs !== undefined ? `; oldest backlog ${Math.round(hierarchy.oldestBacklogAgeMs / 1000)}s` : ""}`,
	];
	if (hierarchy.frontierState) lines.push(`  history frontier in the latest request: ${hierarchy.frontierState}`);
	if (hierarchy.frontier) {
		lines.push(
			`  frontier revision ${hierarchy.frontier.revision}: ${hierarchy.frontier.nodeCount} node(s), ${hierarchy.frontier.bytes} bytes, spans [${hierarchy.frontier.omittedBeforeIndex},${hierarchy.frontier.coveredThroughIndex}) covered`,
		);
	}
	if (hierarchy.failureClasses.length > 0) {
		lines.push(`  recent failures${describeReasonCounts(hierarchy.failureClasses)}`);
	}
	if (hierarchy.recoveryIssueCount > 0)
		lines.push(`  ${hierarchy.recoveryIssueCount} recovery issue(s) found at load`);
	if (hierarchy.lastBatch) {
		const batch = hierarchy.lastBatch;
		lines.push(
			`  last batch #${batch.batchId} ${batch.outcome}: ${batch.succeeded} succeeded, ${batch.failed} failed, ${batch.stale} stale, ${batch.cancelled} cancelled, ${batch.interrupted} interrupted`,
		);
	}
	return lines;
}
