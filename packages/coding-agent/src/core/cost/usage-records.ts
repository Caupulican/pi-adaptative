import type { Usage } from "@caupulican/pi-ai";
import { resolveCatalogPricing } from "@caupulican/pi-ai/models";
import { calculateCost } from "@caupulican/pi-ai/usage";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import type { SystemOneUsageRoute } from "../review/system-one-review-port.ts";

export const SPAWNED_USAGE_CUSTOM_TYPE = "spawned_usage";
export const SEMANTIC_USAGE_CUSTOM_TYPE = "semantic_usage";

export interface SpawnedUsageReport {
	/** Cumulative child usage, including that child's already-rolled-up descendants. */
	usage: Usage;
	label?: string;
	model?: string;
	provider?: string;
	goalId?: string;
	sourceSessionId?: string;
	/** Stable idempotency identity for retry-safe ingestion. */
	reportId?: string;
}

/**
 * Preserve recorded charges. Historical Antigravity entries lacked catalog pricing; only an exact
 * provider/model identity permits reconstructing their API-equivalent estimate. Cumulative worker
 * reports can contain several models, so their aggregate tokens must never be repriced as one model.
 */
export function resolveEffectiveEntryCost(
	usage: Usage | undefined,
	options?: { model?: string; provider?: string; kind?: "own" | "spawned" | "semantic" },
): { total: number; estimated: boolean } | undefined {
	const rawTotal = usage?.cost?.total;
	if (typeof rawTotal !== "number" || !Number.isFinite(rawTotal) || rawTotal < 0 || !usage) return undefined;
	if (
		![usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens].every(
			(value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
		)
	)
		return undefined;
	if (rawTotal !== 0 || !usage || options?.provider !== "google-antigravity" || options.kind === "spawned")
		return {
			total: rawTotal,
			estimated: usage?.cost?.estimate === "base-rates" || options?.provider === "google-antigravity",
		};
	const model = options.model ? resolveCatalogPricing(options.provider, options.model) : undefined;
	if (!model) return { total: rawTotal, estimated: usage.cost.estimate === "base-rates" };
	const priced = { ...usage, cost: { ...usage.cost } };
	const total = calculateCost(model, priced).total;
	return { total, estimated: total > 0 || usage.cost.estimate === "base-rates" };
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
	/** Absent for a System One review; set for the routes that are not one (see SystemOneUsageRoute). */
	route?: SystemOneUsageRoute;
}

/** One validated projection for every semantic-cost reader. */
export function resolveSemanticUsageEntry(entry: SessionEntry):
	| {
			report: SemanticUsageReport;
			cost: { total: number; estimated: boolean };
	  }
	| undefined {
	if (entry.type !== "custom" || entry.customType !== SEMANTIC_USAGE_CUSTOM_TYPE) return undefined;
	const report = entry.data as SemanticUsageReport | undefined;
	if (!report?.reportId) return undefined;
	const cost = resolveEffectiveEntryCost(report.usage, {
		model: report.model,
		provider: report.provider,
		kind: "semantic",
	});
	return cost ? { report, cost } : undefined;
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
	route?: SystemOneUsageRoute;
}): SemanticUsageReport {
	return {
		reportId: receipt.receiptId,
		provider: receipt.provider,
		model: receipt.model,
		attempt: receipt.attempt,
		usage: receipt.usage,
		...(receipt.costStatus !== undefined ? { costStatus: receipt.costStatus } : {}),
		...(receipt.route !== undefined ? { route: receipt.route } : {}),
	};
}

export interface SpawnedUsageTotals {
	cost: number;
	reports: number;
}
