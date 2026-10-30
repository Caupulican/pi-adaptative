import type { Usage } from "@caupulican/pi-ai";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { getSessionEntryUsageComponents } from "../../kernel/usage.ts";
import type { DailyUsageTotals, DailyUsageWindow } from "./daily-usage.ts";
import {
	hasUnknownUsageModel,
	resolveEffectiveEntryCost,
	resolveSemanticUsageEntry,
	resolveSpawnedUsageComponents,
	type SemanticUsageReport,
	SPAWNED_USAGE_CUSTOM_TYPE,
	type SpawnedUsageReport,
} from "./usage-records.ts";

export interface CurrentSessionCostTotals {
	modelUnknownTokens?: number;
	modelUnknownOperations?: number;
	apiEquivalentPartial?: boolean;
	reportedCost?: number;
	reportedOwnCost?: number;
	reportedSubagentCost?: number;
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
	todayApiEquivalentPartial?: boolean;
	todayModelUnknownTokens?: number;
	todayModelUnknownOperations?: number;
	accountingStatus?: "pending" | "unavailable";
	todayCostEstimate?: "base-rates";
	todayPending?: boolean;
	todayCost: number;
	todayReportedCost?: number;
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

function recordUnknownModel(
	accumulator: CurrentSessionCostAccumulator,
	usage: Usage,
	provider?: string,
	model?: string,
): void {
	if (!hasUnknownUsageModel(usage, provider, model)) return;
	accumulator.modelUnknownTokens = (accumulator.modelUnknownTokens ?? 0) + usage.totalTokens;
	accumulator.modelUnknownOperations = (accumulator.modelUnknownOperations ?? 0) + 1;
	accumulator.apiEquivalentPartial = true;
}

export function createCurrentSessionCostAccumulator(): CurrentSessionCostAccumulator {
	return {
		reportedCost: 0,
		reportedOwnCost: 0,
		reportedSubagentCost: 0,
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
		const parts = getSessionEntryUsageComponents(entry);
		if (parts.length > 0) {
			for (const part of parts) {
				const resolved = resolveEffectiveEntryCost(part.usage, {
					model: part.model,
					provider: part.provider,
					kind: "own",
				});
				if (resolved !== undefined) {
					accumulator.ownCost += resolved.total;
					accumulator.reportedOwnCost = (accumulator.reportedOwnCost ?? 0) + resolved.reportedTotal;
					if (resolved.estimated) accumulator.costEstimate = "base-rates";
					recordUnknownModel(accumulator, part.usage, part.provider, part.model);
				}
			}
			continue;
		}

		const semantic = resolveSemanticUsageEntry(entry);
		if (semantic) {
			const { report, cost: resolved } = semantic;
			if (accumulator.seenSemanticReportIds.has(report.reportId)) continue;
			accumulator.seenSemanticReportIds.add(report.reportId);
			// History summary spend was a spawned (background) report before it moved onto this row; it stays background spend.
			if (report.route === "history_summary") {
				accumulator.reportedSubagentCost = (accumulator.reportedSubagentCost ?? 0) + resolved.reportedTotal;
				accumulator.subagentCost += resolved.total;
				accumulator.subagentReports += 1;
				accumulator.historySummaryCost += resolved.total;
				accumulator.historySummaryReports += 1;
			} else {
				accumulator.ownCost += resolved.total;
				accumulator.reportedOwnCost = (accumulator.reportedOwnCost ?? 0) + resolved.reportedTotal;
			}
			if (resolved.estimated) accumulator.costEstimate = "base-rates";
			recordUnknownModel(accumulator, report.usage, report.provider, report.model);
			continue;
		}

		if (entry.type !== "custom" || entry.customType !== SPAWNED_USAGE_CUSTOM_TYPE) continue;
		const report = entry.data as SpawnedUsageReport | undefined;
		if (!report) continue;
		if (report?.reportId) {
			if (accumulator.seenSubagentReportIds.has(report.reportId)) continue;
			accumulator.seenSubagentReportIds.add(report.reportId);
		}
		for (const { part, cost: resolved } of resolveSpawnedUsageComponents(report, entry.timestamp)) {
			accumulator.subagentCost += resolved.total;
			accumulator.reportedSubagentCost = (accumulator.reportedSubagentCost ?? 0) + resolved.reportedTotal;
			if (resolved.estimated) accumulator.costEstimate = "base-rates";
			accumulator.subagentReports += 1;
			recordUnknownModel(accumulator, part.usage, part.provider, part.model);
		}
	}
	accumulator.currentCost = accumulator.ownCost + accumulator.subagentCost;
	accumulator.reportedCost = (accumulator.reportedOwnCost ?? 0) + (accumulator.reportedSubagentCost ?? 0);
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
	let reportedOwnCost = accumulator.reportedOwnCost ?? accumulator.ownCost;
	let reportedSubagentCost = accumulator.reportedSubagentCost ?? accumulator.subagentCost;
	for (const report of pending) {
		const resolved = resolveEffectiveEntryCost(report.usage, {
			model: report.model,
			provider: report.provider,
			kind: "semantic",
			costStatus: report.costStatus,
		});
		if (!resolved || accumulator.seenSemanticReportIds.has(report.reportId)) continue;
		const total = resolved.total;
		// History summary spend is background spend: the same classification as its recorded row.
		if (report.route === "history_summary") {
			reportedSubagentCost += resolved.reportedTotal;
			subagentCost += total;
			subagentReports += 1;
			historySummaryCost += total;
			historySummaryReports += 1;
		} else {
			ownCost += total;
			reportedOwnCost += resolved.reportedTotal;
		}
		if (resolved.estimated) costEstimate = "base-rates";
	}
	// Paid history spend the bounded journal had no room for: live only, counted with the background spend it is.
	const overflowCost = overflow === undefined ? undefined : getUsageTotalCost(overflow.usage);
	if (overflow !== undefined && overflowCost !== undefined) {
		reportedSubagentCost += overflowCost;
		subagentCost += overflowCost;
		subagentReports += overflow.reports;
		historySummaryCost += overflowCost;
		historySummaryReports += overflow.reports;
		if (overflow.usage.cost.estimate === "base-rates") costEstimate = "base-rates";
	}
	return {
		modelUnknownTokens: accumulator.modelUnknownTokens,
		modelUnknownOperations: accumulator.modelUnknownOperations,
		apiEquivalentPartial: accumulator.apiEquivalentPartial,
		reportedOwnCost,
		reportedSubagentCost,
		reportedCost: reportedOwnCost + reportedSubagentCost,
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
		modelUnknownTokens: currentSource.modelUnknownTokens,
		modelUnknownOperations: currentSource.modelUnknownOperations,
		apiEquivalentPartial: currentSource.apiEquivalentPartial,
		reportedCost: currentSource.reportedCost ?? currentSource.currentCost,
		reportedOwnCost: currentSource.reportedOwnCost ?? currentSource.ownCost,
		reportedSubagentCost: currentSource.reportedSubagentCost ?? currentSource.subagentCost,
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
		todayApiEquivalentPartial: args.dailyTotals.apiEquivalentPartial,
		todayModelUnknownTokens: args.dailyTotals.modelUnknownTokens,
		todayModelUnknownOperations: args.dailyTotals.modelUnknownOperations,
		...(args.dailyTotals.costEstimate ? { todayCostEstimate: args.dailyTotals.costEstimate } : {}),
		todayCost: args.dailyTotals.totalCost,
		todayReportedCost: args.dailyTotals.reportedTotalCost ?? args.dailyTotals.totalCost,
		...(args.dailyTotals.pending ? { todayPending: true } : {}),
		todayOwnCost: args.dailyTotals.ownCost,
		todaySubagentCost: args.dailyTotals.spawnedCost,
		todayHistorySummaryCost: args.dailyTotals.historySummaryCost,
		todayWindow: args.todayWindow,
		todayRollover: "local-midnight",
	};
}

export function hasCostSummarySignal(summary: SessionCostSummary): boolean {
	return (
		summary.currentCost > 0 || summary.todayCost > 0 || summary.subagentReports > 0 || summary.todayPending === true
	);
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
	const { agentCost, icmCost, icmReports } = backgroundCostBreakdown(summary);
	if (summary.currentCost > 0 || hasSubagentCostSignal(summary) || options.subscription) {
		parts.push(`CURRENT:${summary.costEstimate ? "~" : ""}${formatCost(summary.currentCost, precision)}`);
		parts.push(`ROOT:${summary.costEstimate ? "~" : ""}${formatCost(summary.ownCost, precision)}`);
		parts.push(`SUB:${formatCost(agentCost, precision)}`);
	}
	if (icmReports > 0 || icmCost > 0) {
		parts.push(`ICM:${formatCost(icmCost, precision)}`);
	}
	if (summary.apiEquivalentPartial) parts.push(`MODEL UNKNOWN:${summary.modelUnknownTokens ?? 0} tokens`);
	if (summary.todayCost > 0 || summary.todayPending) {
		parts.push(
			`TODAY:${summary.todayCostEstimate ? "~" : ""}${formatCost(summary.todayCost, precision)}${summary.todayPending ? " (partial; updating)" : ""}`,
		);
	}
	if (summary.todayApiEquivalentPartial)
		parts.push(`TODAY MODEL UNKNOWN:${summary.todayModelUnknownTokens ?? 0} tokens`);
	return parts;
}

export function formatStatusCostSummary(summary: SessionCostSummary, precision = 4): string {
	const { agentCost, icmCost, icmReports } = backgroundCostBreakdown(summary);
	const parts = [
		...(summary.apiEquivalentPartial
			? [`PARTIAL API EQUIVALENT (${summary.modelUnknownTokens ?? 0} tokens without model attribution)`]
			: []),
		...(summary.todayApiEquivalentPartial
			? [`TODAY API EQUIVALENT PARTIAL (${summary.todayModelUnknownTokens ?? 0} tokens without model attribution)`]
			: []),
		`CURRENT ${summary.costEstimate ? "~" : ""}${formatCost(summary.currentCost, precision)}${summary.costEstimate ? " (base-rate estimate)" : ""}`,
		`ROOT ${summary.costEstimate ? "~" : ""}${formatCost(summary.ownCost, precision)}`,
		`SUBAGENTS ${formatCost(agentCost, precision)} (included in CURRENT)`,
		...(icmReports > 0 || icmCost > 0 ? [`ICM ${formatCost(icmCost, precision)} (included in CURRENT)`] : []),
		`TODAY ${summary.todayCostEstimate ? "~" : ""}${formatCost(summary.todayCost, precision)}${summary.todayCostEstimate ? " (base-rate estimate)" : ""}${summary.todayPending ? " (partial; updating)" : ""}`,
	];
	return parts.join(", ");
}

export {
	computeSessionTaskAndModelMetrics,
	formatCompactTaskDuration,
	isTaskExecutionActive,
	type ModelCostBreakdownRow,
	type SessionTaskAndModelSummary,
	type TaskExecutionMetrics,
	type TaskMetricsGoalInput,
	type TaskMetricsPlanInput,
} from "./task-cost-metrics.ts";
export { resolveEffectiveEntryCost } from "./usage-records.ts";
