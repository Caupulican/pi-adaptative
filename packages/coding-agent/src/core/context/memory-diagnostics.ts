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
		})),
		selectedItemCount: report.contextItems.length,
	};
}
