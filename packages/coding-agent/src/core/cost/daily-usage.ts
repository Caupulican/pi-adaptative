import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadEntriesFromFile, type SessionEntry } from "@caupulican/pi-agent-core/node";
import type { AssistantMessage, Usage } from "@caupulican/pi-ai";
import { SPAWNED_USAGE_CUSTOM_TYPE, type SpawnedUsageReport } from "../agent-session.ts";

export type DailyUsageWindow = {
	startMs: number;
	endMs: number;
};

export type DailyUsageTotals = {
	ownCost: number;
	spawnedCost: number;
	totalCost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	sessions: number;
	reports: number;
};

function createZeroTotals(): DailyUsageTotals {
	return {
		ownCost: 0,
		spawnedCost: 0,
		totalCost: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		sessions: 0,
		reports: 0,
	};
}

function isInsideWindow(timestamp: number, window: DailyUsageWindow): boolean {
	return timestamp >= window.startMs && timestamp < window.endMs;
}

function addUsage(
	totals: Pick<DailyUsageTotals, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens">,
	usage: Usage,
): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.totalTokens += usage.totalTokens;
}

function addDailyUsageFromEntries(
	totals: DailyUsageTotals,
	entries: SessionEntry[],
	window: DailyUsageWindow,
	seenSpawnedReportIds: Set<string>,
): boolean {
	let hasUsage = false;
	for (const entry of entries) {
		if (!isInsideWindow(Date.parse(entry.timestamp), window)) continue;
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = (entry.message as AssistantMessage).usage;
			if (!usage) continue;
			totals.ownCost += usage.cost.total;
			addUsage(totals, usage);
			hasUsage = true;
			continue;
		}
		if (entry.type === "custom" && entry.customType === SPAWNED_USAGE_CUSTOM_TYPE) {
			const data = entry.data as SpawnedUsageReport | undefined;
			if (!data?.usage) continue;
			if (data.reportId) {
				if (seenSpawnedReportIds.has(data.reportId)) continue;
				seenSpawnedReportIds.add(data.reportId);
			}
			totals.spawnedCost += data.usage.cost.total;
			totals.reports += 1;
			addUsage(totals, data.usage);
			hasUsage = true;
		}
	}
	return hasUsage;
}

function finishTotals(totals: DailyUsageTotals): DailyUsageTotals {
	totals.totalCost = totals.ownCost + totals.spawnedCost;
	return totals;
}

function shouldReadSessionFile(filePath: string, window: DailyUsageWindow): boolean {
	try {
		return statSync(filePath).mtimeMs >= window.startMs;
	} catch {
		return false;
	}
}

export function aggregateDailyUsageFromEntries(entries: SessionEntry[], window: DailyUsageWindow): DailyUsageTotals {
	const totals = createZeroTotals();
	const hasUsage = addDailyUsageFromEntries(totals, entries, window, new Set());
	totals.sessions = hasUsage ? 1 : 0;
	return finishTotals(totals);
}

export function aggregateDailyUsageFromSessionFiles(sessionDir: string, window: DailyUsageWindow): DailyUsageTotals {
	const totals = createZeroTotals();
	if (!sessionDir || !existsSync(sessionDir)) return totals;
	const seenSpawnedReportIds = new Set<string>();
	for (const name of readdirSync(sessionDir)) {
		if (!name.endsWith(".jsonl")) continue;
		const filePath = join(sessionDir, name);
		if (!shouldReadSessionFile(filePath, window)) continue;
		const entries = loadEntriesFromFile(filePath).filter((entry): entry is SessionEntry => entry.type !== "session");
		if (addDailyUsageFromEntries(totals, entries, window, seenSpawnedReportIds)) {
			totals.sessions += 1;
		}
	}
	return finishTotals(totals);
}

export function aggregateDailyUsageFromSessionRoot(sessionRoot: string, window: DailyUsageWindow): DailyUsageTotals {
	const totals = createZeroTotals();
	if (!sessionRoot || !existsSync(sessionRoot)) return totals;
	const seenSpawnedReportIds = new Set<string>();
	for (const name of readdirSync(sessionRoot)) {
		const dir = join(sessionRoot, name);
		if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
		for (const fileName of readdirSync(dir)) {
			if (!fileName.endsWith(".jsonl")) continue;
			const filePath = join(dir, fileName);
			if (!shouldReadSessionFile(filePath, window)) continue;
			const entries = loadEntriesFromFile(filePath).filter(
				(entry): entry is SessionEntry => entry.type !== "session",
			);
			if (addDailyUsageFromEntries(totals, entries, window, seenSpawnedReportIds)) {
				totals.sessions += 1;
			}
		}
	}
	return finishTotals(totals);
}

export function formatDailyUsageBreakdown(
	totals: DailyUsageTotals,
	formatLabel: (label: string) => string = (label) => label,
): string {
	return [
		`${formatLabel("Today:")} $${totals.totalCost.toFixed(4)}`,
		`${formatLabel("Own/session messages:")} $${totals.ownCost.toFixed(4)}`,
		`${formatLabel("Spawned/background reports:")} $${totals.spawnedCost.toFixed(4)}`,
		`${formatLabel("Sessions scanned:")} ${totals.sessions}`,
		`${formatLabel("Spawned/background report count:")} ${totals.reports}`,
	].join("\n");
}

export function getLocalDayWindow(now = new Date()): DailyUsageWindow {
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	const end = new Date(start);
	end.setDate(end.getDate() + 1);
	return { startMs: start.getTime(), endMs: end.getTime() };
}
