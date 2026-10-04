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
	subagentCost: number;
	subagentReports: number;
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
			accumulator.ownCost += total;
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
		currentCost: currentSource.currentCost,
	};
	return {
		...current,
		...(args.dailyTotals.costEstimate ? { todayCostEstimate: args.dailyTotals.costEstimate } : {}),
		todayCost: args.dailyTotals.totalCost,
		todayOwnCost: args.dailyTotals.ownCost,
		todaySubagentCost: args.dailyTotals.spawnedCost,
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
	if (hasSubagentCostSignal(summary)) {
		parts.push(`SUBAGENTS:${formatCost(summary.subagentCost, precision)} in CURRENT`);
	}
	return parts;
}

export function formatStatusCostSummary(summary: SessionCostSummary, precision = 4): string {
	const parts = [
		`CURRENT ${summary.costEstimate ? "~" : ""}${formatCost(summary.currentCost, precision)}${summary.costEstimate ? " (base-rate estimate)" : ""}`,
		`TODAY ${summary.todayCostEstimate ? "~" : ""}${formatCost(summary.todayCost, precision)}${summary.todayCostEstimate ? " (base-rate estimate)" : ""}`,
	];
	if (hasSubagentCostSignal(summary)) {
		parts.push(`SUBAGENTS ${formatCost(summary.subagentCost, precision)} (included in CURRENT)`);
	}
	return parts.join(", ");
}
