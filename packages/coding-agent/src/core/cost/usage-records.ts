import type { Usage } from "@caupulican/pi-ai";
import { resolveCatalogPricing } from "@caupulican/pi-ai/models";
import { calculateCost } from "@caupulican/pi-ai/usage";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { type SessionEntryUsageComponent, validateUsageComponents } from "../../kernel/usage.ts";
import type { UsageComponent } from "../../kernel/usage-components.ts";
import type { MaintenanceUsageRoute, SystemOneUsageRoute } from "../review/system-one-review-port.ts";
import type { AccountingOrigin } from "./accounting-evidence.ts";

export const SPAWNED_USAGE_CUSTOM_TYPE = "spawned_usage";
export const SEMANTIC_USAGE_CUSTOM_TYPE = "semantic_usage";

export function isMaintenanceUsageRoute(route: SystemOneUsageRoute | undefined): route is MaintenanceUsageRoute {
	return route === "compaction" || route === "branch_summary";
}

/** A recorded charge can be known while its model-specific API equivalent remains unattributable. */
export function hasUnknownUsageModel(usage: Usage, provider?: string, model?: string): boolean {
	return usage.totalTokens > 0 && (!provider || !model);
}

export interface SpawnedUsageReport {
	/** Cumulative child usage, including that child's already-rolled-up descendants. */
	usage: Usage;
	usageComponents?: readonly UsageComponent[];
	label?: string;
	model?: string;
	provider?: string;
	goalId?: string;
	origin?: AccountingOrigin;
	costBasis?: "response";
	sourceSessionId?: string;
	/** Stable idempotency identity for retry-safe ingestion. */
	reportId?: string;
}

export function getSpawnedUsageComponents(
	report: SpawnedUsageReport,
	timestamp: string,
): readonly SessionEntryUsageComponent[] {
	if (report.usageComponents !== undefined) return validateUsageComponents(report.usage, report.usageComponents);
	return [
		{
			sourceId: report.reportId ?? timestamp,
			timestamp,
			usage: report.usage,
			provider: report.provider,
			model: report.model,
		},
	];
}

/**
 * Preserve recorded charges. Historical Antigravity entries lacked catalog pricing; only an exact
 * provider/model identity permits reconstructing their API-equivalent estimate. Cumulative worker
 * reports can contain several models, so their aggregate tokens must never be repriced as one model.
 */
export function resolveEffectiveEntryCost(
	usage: Usage | undefined,
	options?: {
		model?: string;
		provider?: string;
		kind?: "own" | "spawned" | "semantic";
		perResponse?: boolean;
		costStatus?: "catalog_priced" | "unpriced";
	},
): { total: number; reportedTotal: number; estimated: boolean } | undefined {
	const rawTotal = usage?.cost?.total;
	if (typeof rawTotal !== "number" || !Number.isFinite(rawTotal) || rawTotal < 0 || !usage) return undefined;
	if (
		![usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens].every(
			(value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
		)
	)
		return undefined;
	const mayEstimate = options?.provider === "google-antigravity" || options?.costStatus === "unpriced";
	if (rawTotal !== 0 || !usage || !mayEstimate || (options?.kind === "spawned" && !options.perResponse))
		return {
			total: rawTotal,
			reportedTotal: rawTotal,
			estimated: usage?.cost?.estimate === "base-rates" || options?.provider === "google-antigravity",
		};
	const model =
		options?.model && options.provider ? resolveCatalogPricing(options.provider, options.model) : undefined;
	if (!model) return { total: rawTotal, reportedTotal: rawTotal, estimated: usage.cost.estimate === "base-rates" };
	const priced = { ...usage, cost: { ...usage.cost } };
	const total = calculateCost(model, priced).total;
	return { total, reportedTotal: rawTotal, estimated: total > 0 || usage.cost.estimate === "base-rates" };
}

/** One shared pricing rule for cumulative receipts and their conserved per-response components. */
export function resolveSpawnedUsageComponents(
	report: SpawnedUsageReport,
	timestamp: string,
): {
	part: SessionEntryUsageComponent;
	cost: { total: number; reportedTotal: number; estimated: boolean };
}[] {
	return getSpawnedUsageComponents(report, timestamp).flatMap((part) => {
		const cost = resolveEffectiveEntryCost(part.usage, {
			model: part.model,
			provider: part.provider,
			kind: "spawned",
			perResponse: report.costBasis === "response" || report.usageComponents !== undefined,
		});
		return cost ? [{ part, cost }] : [];
	});
}

export interface SemanticUsageReport {
	readonly responseTimestamp?: string;
	readonly origin?: AccountingOrigin;
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

/** Archived direct tool usage has no proven retry ordinal. */
export type RecoveredDirectUsageReport = Omit<SemanticUsageReport, "attempt"> & {
	readonly costBasis: "direct";
	readonly modelProvenance?: "request-bound";
};
export type SemanticAccountingReport = SemanticUsageReport | RecoveredDirectUsageReport;

/** One validated projection for every semantic-cost reader. */
export function resolveSemanticUsageEntry(entry: SessionEntry):
	| {
			report: SemanticAccountingReport;
			cost: { total: number; reportedTotal: number; estimated: boolean };
	  }
	| undefined {
	if (entry.type !== "custom" || entry.customType !== SEMANTIC_USAGE_CUSTOM_TYPE) return undefined;
	const report = entry.data as SemanticAccountingReport | undefined;
	if (!report?.reportId) return undefined;
	const cost = resolveEffectiveEntryCost(report.usage, {
		model: report.model,
		provider: report.provider,
		kind: "semantic",
		costStatus: report.costStatus,
	});
	return cost ? { report, cost } : undefined;
}

/**
 * The one mapping from a semantic evaluation receipt to the session's usage record, so the reviewer's usage sink and
 * the retry of an unrecorded receipt write the identical entry (aggregation dedupes by `reportId`).
 */
export function semanticUsageReportOf(receipt: {
	responseTimestamp?: string;
	origin?: AccountingOrigin;
	receiptId: string;
	provider: string;
	model: string;
	attempt: number;
	usage: Usage;
	costStatus?: SemanticUsageReport["costStatus"];
	route?: SystemOneUsageRoute;
}): SemanticUsageReport {
	return {
		...(receipt.responseTimestamp ? { responseTimestamp: receipt.responseTimestamp } : {}),
		...(receipt.origin ? { origin: { ...receipt.origin } } : {}),
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
