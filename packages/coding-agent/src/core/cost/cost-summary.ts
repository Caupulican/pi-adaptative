import type { Usage } from "@caupulican/pi-ai";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { getSessionEntryUsage } from "../../kernel/usage.ts";
import type { DailyUsageTotals, DailyUsageWindow } from "./daily-usage.ts";
import {
	SEMANTIC_USAGE_CUSTOM_TYPE,
	type SemanticUsageReport,
	SPAWNED_USAGE_CUSTOM_TYPE,
	type SpawnedUsageReport,
} from "./usage-records.ts";

export interface CurrentSessionCostTotals {
	costEstimate?: "base-rates";
	ownCost: number;
	/** Background spend: worker subagents plus the ICM history summaries below. The cost guard reads it as one total. */
	subagentCost: number;
	subagentReports: number;
	/** The ICM history-summary share of the background spend, so a display can name where the money goes. */
	historySummaryCost: number;
	historySummaryReports: number;
	currentCost: number;
}

export interface CurrentSessionCostAccumulator extends CurrentSessionCostTotals {
	seenSubagentReportIds: Set<string>;
	seenSemanticReportIds: Set<string>;
}

export interface SessionCostSummary extends CurrentSessionCostTotals {
	todayCostEstimate?: "base-rates";
	todayCost: number;
	todayOwnCost: number;
	todaySubagentCost: number;
	/** The ICM history-summary share of `todaySubagentCost`. */
	todayHistorySummaryCost: number;
	todayWindow: DailyUsageWindow;
	todayRollover: "local-midnight";
}

function isFiniteCost(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function getUsageTotalCost(usage: Usage | undefined): number | undefined {
	const total = usage?.cost?.total;
	return isFiniteCost(total) ? total : undefined;
}

export function createCurrentSessionCostAccumulator(): CurrentSessionCostAccumulator {
	return {
		ownCost: 0,
		subagentCost: 0,
		subagentReports: 0,
		historySummaryCost: 0,
		historySummaryReports: 0,
		currentCost: 0,
		seenSubagentReportIds: new Set<string>(),
		seenSemanticReportIds: new Set<string>(),
	};
}

export function accumulateCurrentSessionCostsFromEntries(
	accumulator: CurrentSessionCostAccumulator,
	entries: readonly SessionEntry[],
): CurrentSessionCostAccumulator {
	for (const entry of entries) {
		const usage = getSessionEntryUsage(entry);
		if (usage) {
			const total = getUsageTotalCost(usage);
			if (total !== undefined) {
				accumulator.ownCost += total;
				if (usage.cost.estimate === "base-rates") accumulator.costEstimate = "base-rates";
			}
			continue;
		}

		if (entry.type === "custom" && entry.customType === SEMANTIC_USAGE_CUSTOM_TYPE) {
			const report = entry.data as SemanticUsageReport | undefined;
			const total = getUsageTotalCost(report?.usage);
			if (total === undefined || !report?.reportId || accumulator.seenSemanticReportIds.has(report.reportId))
				continue;
			accumulator.seenSemanticReportIds.add(report.reportId);
			// History summary spend was a spawned (background) report before it moved onto this row; it stays background spend.
			if (report.route === "history_summary") {
				accumulator.subagentCost += total;
				accumulator.subagentReports += 1;
				accumulator.historySummaryCost += total;
				accumulator.historySummaryReports += 1;
			} else accumulator.ownCost += total;
			if (report.usage.cost.estimate === "base-rates") accumulator.costEstimate = "base-rates";
			continue;
		}

		if (entry.type !== "custom" || entry.customType !== SPAWNED_USAGE_CUSTOM_TYPE) continue;
		const report = entry.data as SpawnedUsageReport | undefined;
		const total = getUsageTotalCost(report?.usage);
		if (total === undefined) continue;
		if (report?.reportId) {
			if (accumulator.seenSubagentReportIds.has(report.reportId)) continue;
			accumulator.seenSubagentReportIds.add(report.reportId);
		}
		accumulator.subagentCost += total;
		if (report?.usage.cost.estimate === "base-rates") accumulator.costEstimate = "base-rates";
		accumulator.subagentReports += 1;
	}
	accumulator.currentCost = accumulator.ownCost + accumulator.subagentCost;
	return accumulator;
}

export function aggregateCurrentSessionCostsFromEntries(entries: readonly SessionEntry[]): CurrentSessionCostTotals {
	const {
		seenSubagentReportIds: _seenSubagentReportIds,
		seenSemanticReportIds: _seenSemanticReportIds,
		...totals
	} = accumulateCurrentSessionCostsFromEntries(createCurrentSessionCostAccumulator(), entries);
	return totals;
}

/**
 * The current totals plus the held reports the ledger does not carry yet. Read-only: the accumulator and its seen set
 * stay as they are, so a report counts once whether its ledger row arrives before or after this projection.
 */
export function projectPendingSemanticCost(
	accumulator: CurrentSessionCostAccumulator,
	pending: readonly SemanticUsageReport[],
	overflow?: { readonly usage: Usage; readonly reports: number },
): CurrentSessionCostTotals {
	let ownCost = accumulator.ownCost;
	let subagentCost = accumulator.subagentCost;
	let subagentReports = accumulator.subagentReports;
	let historySummaryCost = accumulator.historySummaryCost;
	let historySummaryReports = accumulator.historySummaryReports;
	let costEstimate = accumulator.costEstimate;
	for (const report of pending) {
		const total = getUsageTotalCost(report.usage);
		if (total === undefined || accumulator.seenSemanticReportIds.has(report.reportId)) continue;
		// History summary spend is background spend: the same classification as its recorded row.
		if (report.route === "history_summary") {
			subagentCost += total;
			subagentReports += 1;
			historySummaryCost += total;
			historySummaryReports += 1;
		} else ownCost += total;
		if (report.usage.cost.estimate === "base-rates") costEstimate = "base-rates";
	}
	// Paid history spend the bounded journal had no room for: live only, counted with the background spend it is.
	const overflowCost = overflow === undefined ? undefined : getUsageTotalCost(overflow.usage);
	if (overflow !== undefined && overflowCost !== undefined) {
		subagentCost += overflowCost;
		subagentReports += overflow.reports;
		historySummaryCost += overflowCost;
		historySummaryReports += overflow.reports;
		if (overflow.usage.cost.estimate === "base-rates") costEstimate = "base-rates";
	}
	return {
		...(costEstimate ? { costEstimate } : {}),
		ownCost,
		subagentCost,
		subagentReports,
		historySummaryCost,
		historySummaryReports,
		currentCost: ownCost + subagentCost,
	};
}

export function createSessionCostSummary(args: {
	entries?: readonly SessionEntry[];
	dailyTotals: DailyUsageTotals;
	todayWindow: DailyUsageWindow;
	currentTotals?: CurrentSessionCostTotals;
}): SessionCostSummary {
	const currentSource = args.currentTotals ?? aggregateCurrentSessionCostsFromEntries(args.entries ?? []);
	const current: CurrentSessionCostTotals = {
		...(currentSource.costEstimate ? { costEstimate: currentSource.costEstimate } : {}),
		ownCost: currentSource.ownCost,
		subagentCost: currentSource.subagentCost,
		subagentReports: currentSource.subagentReports,
		historySummaryCost: currentSource.historySummaryCost,
		historySummaryReports: currentSource.historySummaryReports,
		currentCost: currentSource.currentCost,
	};
	return {
		...current,
		...(args.dailyTotals.costEstimate ? { todayCostEstimate: args.dailyTotals.costEstimate } : {}),
		todayCost: args.dailyTotals.totalCost,
		todayOwnCost: args.dailyTotals.ownCost,
		todaySubagentCost: args.dailyTotals.spawnedCost,
		todayHistorySummaryCost: args.dailyTotals.historySummaryCost,
		todayWindow: args.todayWindow,
		todayRollover: "local-midnight",
	};
}

export function hasCostSummarySignal(summary: SessionCostSummary): boolean {
	return summary.currentCost > 0 || summary.todayCost > 0 || summary.subagentReports > 0;
}

export function hasSubagentCostSignal(summary: Pick<SessionCostSummary, "subagentReports" | "subagentCost">): boolean {
	return summary.subagentReports > 0 || summary.subagentCost > 0;
}

/** Background spend split by where it goes: delegated workers and bots, and the ICM history summaries. */
export interface BackgroundCostBreakdown {
	agentCost: number;
	agentReports: number;
	icmCost: number;
	icmReports: number;
}

export function backgroundCostBreakdown(
	summary: Pick<
		SessionCostSummary,
		"subagentCost" | "subagentReports" | "historySummaryCost" | "historySummaryReports"
	>,
): BackgroundCostBreakdown {
	return {
		agentCost: Math.max(0, summary.subagentCost - summary.historySummaryCost),
		agentReports: Math.max(0, summary.subagentReports - summary.historySummaryReports),
		icmCost: summary.historySummaryCost,
		icmReports: summary.historySummaryReports,
	};
}

/** The non-empty background shares, each with the label a display shows and its formatted amount. */
export function backgroundCostShares(
	summary: Pick<
		SessionCostSummary,
		"subagentCost" | "subagentReports" | "historySummaryCost" | "historySummaryReports"
	>,
	precision: number,
): { label: "AGENTS" | "ICM"; amount: string }[] {
	const { agentCost, agentReports, icmCost, icmReports } = backgroundCostBreakdown(summary);
	const shares: { label: "AGENTS" | "ICM"; amount: string }[] = [];
	if (agentReports > 0 || agentCost > 0) shares.push({ label: "AGENTS", amount: formatCost(agentCost, precision) });
	if (icmReports > 0 || icmCost > 0) shares.push({ label: "ICM", amount: formatCost(icmCost, precision) });
	return shares;
}

function formatCost(value: number, precision: number): string {
	return `$${value.toFixed(precision)}`;
}

export function formatFooterCostParts(
	summary: SessionCostSummary,
	precision = 3,
	options: { subscription?: boolean } = {},
): string[] {
	const parts: string[] = [];
	if (summary.currentCost > 0 || hasSubagentCostSignal(summary) || options.subscription) {
		parts.push(
			`CURRENT:${summary.costEstimate ? "~" : ""}${formatCost(summary.currentCost, precision)}${options.subscription ? " (sub)" : ""}`,
		);
	}
	if (summary.todayCost > 0) {
		parts.push(`TODAY:${summary.todayCostEstimate ? "~" : ""}${formatCost(summary.todayCost, precision)}`);
	}
	for (const share of backgroundCostShares(summary, precision))
		parts.push(`${share.label}:${share.amount} in CURRENT`);
	return parts;
}

export function formatStatusCostSummary(summary: SessionCostSummary, precision = 4): string {
	const parts = [
		`CURRENT ${summary.costEstimate ? "~" : ""}${formatCost(summary.currentCost, precision)}${summary.costEstimate ? " (base-rate estimate)" : ""}`,
		`TODAY ${summary.todayCostEstimate ? "~" : ""}${formatCost(summary.todayCost, precision)}${summary.todayCostEstimate ? " (base-rate estimate)" : ""}`,
	];
	for (const share of backgroundCostShares(summary, precision))
		parts.push(`${share.label} ${share.amount} (included in CURRENT)`);
	return parts.join(", ");
}
