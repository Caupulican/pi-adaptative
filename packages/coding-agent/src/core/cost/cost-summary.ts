import type { SessionEntry } from "@caupulican/pi-agent-core/node";
import type { AssistantMessage, Usage } from "@caupulican/pi-ai";
import { SPAWNED_USAGE_CUSTOM_TYPE, type SpawnedUsageReport } from "../agent-session.ts";
import type { DailyUsageTotals, DailyUsageWindow } from "./daily-usage.ts";

export interface CurrentSessionCostTotals {
	ownCost: number;
	subagentCost: number;
	subagentReports: number;
	currentCost: number;
}

export interface SessionCostSummary extends CurrentSessionCostTotals {
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

export function aggregateCurrentSessionCostsFromEntries(entries: readonly SessionEntry[]): CurrentSessionCostTotals {
	let ownCost = 0;
	let subagentCost = 0;
	let subagentReports = 0;
	const seenSubagentReportIds = new Set<string>();

	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const total = getUsageTotalCost((entry.message as AssistantMessage).usage);
			if (total !== undefined) ownCost += total;
			continue;
		}

		if (entry.type !== "custom" || entry.customType !== SPAWNED_USAGE_CUSTOM_TYPE) continue;
		const report = entry.data as SpawnedUsageReport | undefined;
		const total = getUsageTotalCost(report?.usage);
		if (total === undefined) continue;
		if (report?.reportId) {
			if (seenSubagentReportIds.has(report.reportId)) continue;
			seenSubagentReportIds.add(report.reportId);
		}
		subagentCost += total;
		subagentReports += 1;
	}

	return {
		ownCost,
		subagentCost,
		subagentReports,
		currentCost: ownCost + subagentCost,
	};
}

export function createSessionCostSummary(args: {
	entries: readonly SessionEntry[];
	dailyTotals: DailyUsageTotals;
	todayWindow: DailyUsageWindow;
}): SessionCostSummary {
	const current = aggregateCurrentSessionCostsFromEntries(args.entries);
	return {
		...current,
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

export function formatFooterCostParts(summary: SessionCostSummary, precision = 3): string[] {
	const parts: string[] = [];
	if (summary.currentCost > 0 || hasSubagentCostSignal(summary)) {
		parts.push(`CURRENT:${formatCost(summary.currentCost, precision)}`);
	}
	if (summary.todayCost > 0) {
		parts.push(`TODAY:${formatCost(summary.todayCost, precision)}`);
	}
	if (hasSubagentCostSignal(summary)) {
		parts.push(`SUBAGENTS:${formatCost(summary.subagentCost, precision)} in CURRENT`);
	}
	return parts;
}

export function formatStatusCostSummary(summary: SessionCostSummary, precision = 4): string {
	const parts = [
		`CURRENT ${formatCost(summary.currentCost, precision)}`,
		`TODAY ${formatCost(summary.todayCost, precision)}`,
	];
	if (hasSubagentCostSignal(summary)) {
		parts.push(`SUBAGENTS ${formatCost(summary.subagentCost, precision)} (included in CURRENT)`);
	}
	return parts.join(", ");
}
