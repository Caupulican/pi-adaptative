import type { Usage } from "@caupulican/pi-ai";

export const SPAWNED_USAGE_CUSTOM_TYPE = "spawned_usage";
export const SEMANTIC_USAGE_CUSTOM_TYPE = "semantic_usage";

export interface SpawnedUsageReport {
	/** Cumulative child usage, including that child's already-rolled-up descendants. */
	usage: Usage;
	label?: string;
	sourceSessionId?: string;
	/** Stable idempotency identity for retry-safe ingestion. */
	reportId?: string;
}

export interface SemanticUsageReport {
	/** One provider response, including a retry response, priced against its exact catalog identity. */
	usage: Usage;
	provider: string;
	model: string;
	attempt: number;
	/** Stable idempotency identity for retry-safe aggregation. */
	reportId: string;
	costStatus?: "catalog_priced" | "unpriced";
}

/**
 * The one mapping from a semantic evaluation receipt to the session's usage record, so the reviewer's usage sink and
 * the retry of an unrecorded receipt write the identical entry (aggregation dedupes by `reportId`).
 */
export function semanticUsageReportOf(receipt: {
	receiptId: string;
	provider: string;
	model: string;
	attempt: number;
	usage: Usage;
	costStatus?: SemanticUsageReport["costStatus"];
}): SemanticUsageReport {
	return {
		reportId: receipt.receiptId,
		provider: receipt.provider,
		model: receipt.model,
		attempt: receipt.attempt,
		usage: receipt.usage,
		...(receipt.costStatus !== undefined ? { costStatus: receipt.costStatus } : {}),
	};
}

export interface SpawnedUsageTotals {
	cost: number;
	reports: number;
}
