import { existsSync, readdirSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { Usage } from "@caupulican/pi-ai";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { loadEntriesFromFile, visitSessionEntriesAsync } from "../../kernel/session/session-manager.ts";
import { getSessionEntryUsage } from "../../kernel/usage.ts";
import {
	SEMANTIC_USAGE_CUSTOM_TYPE,
	type SemanticUsageReport,
	SPAWNED_USAGE_CUSTOM_TYPE,
	type SpawnedUsageReport,
} from "./usage-records.ts";

export type DailyUsageWindow = {
	startMs: number;
	endMs: number;
};

export type DailyUsageTotals = {
	/** Cross-session refresh is not settled; values are the last available projection. */
	pending?: boolean;
	costEstimate?: "base-rates";
	ownCost: number;
	/** Background spend: spawned workers plus the history summaries below. */
	spawnedCost: number;
	/** The ICM history-summary share of `spawnedCost`. */
	historySummaryCost: number;
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
		historySummaryCost: 0,
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
	totals: Pick<DailyUsageTotals, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens" | "costEstimate">,
	usage: Usage,
): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.totalTokens += usage.totalTokens;
	if (usage.cost.estimate === "base-rates") totals.costEstimate = "base-rates";
}

function addDailyUsageFromEntries(
	totals: DailyUsageTotals,
	entries: readonly SessionEntry[],
	window: DailyUsageWindow,
	seenSpawnedReportIds: Set<string>,
	seenSemanticReportIds: Set<string>,
): boolean {
	let hasUsage = false;
	for (const entry of entries) {
		const record = usageRecord(entry);
		if (record && addDailyUsageRecord(totals, record, window, seenSpawnedReportIds, seenSemanticReportIds))
			hasUsage = true;
	}
	return hasUsage;
}

function addDailyUsageRecord(
	totals: DailyUsageTotals,
	record: DailyUsageRecord,
	window: DailyUsageWindow,
	spawned: Set<string>,
	semantic: Set<string>,
): boolean {
	if (!isInsideWindow(Date.parse(record.timestamp), window)) return false;
	const seen = record.kind === "spawned" ? spawned : record.kind === "semantic" ? semantic : undefined;
	if (record.reportId && seen?.has(record.reportId)) return false;
	if (record.reportId) seen?.add(record.reportId);
	if (record.kind === "spawned" || record.historySummary) {
		totals.spawnedCost += record.usage.cost.total;
		totals.reports++;
	} else totals.ownCost += record.usage.cost.total;
	if (record.historySummary) totals.historySummaryCost += record.usage.cost.total;
	addUsage(totals, record.usage);
	return true;
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

export function aggregateDailyUsageFromEntries(
	entries: readonly SessionEntry[],
	window: DailyUsageWindow,
): DailyUsageTotals {
	const totals = createZeroTotals();
	const hasUsage = addDailyUsageFromEntries(totals, entries, window, new Set(), new Set());
	totals.sessions = hasUsage ? 1 : 0;
	return finishTotals(totals);
}

export interface LiveSessionDailyUsageSource {
	filePath: string;
	entries: readonly SessionEntry[];
}

function getSessionEntries(
	filePath: string,
	liveSession: LiveSessionDailyUsageSource | undefined,
): readonly SessionEntry[] {
	if (liveSession && resolve(filePath) === resolve(liveSession.filePath)) return liveSession.entries;
	return loadEntriesFromFile(filePath).filter((entry): entry is SessionEntry => entry.type !== "session");
}

interface DailyUsageRecord {
	timestamp: string;
	usage: Usage;
	kind: "own" | "spawned" | "semantic";
	reportId?: string;
	historySummary: boolean;
}

function usageRecord(entry: SessionEntry): DailyUsageRecord | undefined {
	const own = getSessionEntryUsage(entry);
	if (own) return { timestamp: entry.timestamp, usage: own, kind: "own", historySummary: false };
	if (entry.type !== "custom") return;
	if (entry.customType !== SPAWNED_USAGE_CUSTOM_TYPE && entry.customType !== SEMANTIC_USAGE_CUSTOM_TYPE) return;
	const data = entry.data as SemanticUsageReport | SpawnedUsageReport | undefined;
	if (!data?.usage) return;
	const semantic = entry.customType === SEMANTIC_USAGE_CUSTOM_TYPE;
	if (semantic && !data.reportId) return;
	return {
		timestamp: entry.timestamp,
		usage: data.usage,
		kind: semantic ? "semantic" : "spawned",
		reportId: data.reportId,
		historySummary: semantic && (data as SemanticUsageReport).route === "history_summary",
	};
}

const MAX_CACHED_USAGE_RECORDS = 50_000;
const MAX_CACHED_USAGE_BYTES = 8 * 1024 * 1024;
const fileUsageCache = new Map<string, { key: string; records: DailyUsageRecord[]; bytes: number }>();
let cachedUsageRecords = 0;
let cachedUsageBytes = 0;

async function retainUsageRecords(path: string, key: string, records: DailyUsageRecord[]): Promise<void> {
	const remove = (target: string): void => {
		const cached = fileUsageCache.get(target);
		if (!cached) return;
		cachedUsageRecords -= cached.records.length;
		cachedUsageBytes -= cached.bytes;
		fileUsageCache.delete(target);
	};
	if (records.length > MAX_CACHED_USAGE_RECORDS) {
		remove(path);
		return;
	}
	let bytes = 0;
	for (let index = 0; index < records.length; index++) {
		if (index % 256 === 0) await yieldToEventLoop();
		const record = records[index]!;
		bytes += Buffer.byteLength(JSON.stringify(record));
		if (bytes > MAX_CACHED_USAGE_BYTES) {
			remove(path);
			return;
		}
	}
	// Cache replacement and counters form one synchronous transaction after all yielding work.
	remove(path);
	while (
		fileUsageCache.size >= 1024 ||
		cachedUsageRecords + records.length > MAX_CACHED_USAGE_RECORDS ||
		cachedUsageBytes + bytes > MAX_CACHED_USAGE_BYTES
	) {
		const oldest = fileUsageCache.keys().next().value;
		if (oldest === undefined) return;
		remove(oldest);
	}
	fileUsageCache.set(path, { key, records, bytes });
	cachedUsageRecords += records.length;
	cachedUsageBytes += bytes;
}

/** Entire scan is asynchronous; retained cache entries contain usage only, never conversation payloads. */
export async function aggregateDailyUsageAsync(
	scope: string,
	root: boolean,
	window: DailyUsageWindow,
	liveSession?: LiveSessionDailyUsageSource,
): Promise<DailyUsageTotals> {
	const totals = createZeroTotals();
	const spawned = new Set<string>();
	const semantic = new Set<string>();
	const directories = root
		? (await readdir(scope, { withFileTypes: true }))
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(scope, entry.name))
		: [scope];
	for (const directory of directories) {
		for (const name of await readdir(directory)) {
			if (!name.endsWith(".jsonl")) continue;
			const filePath = join(directory, name);
			const revision = await stat(filePath);
			if (revision.mtimeMs < window.startMs) continue;
			const key = `${revision.dev}:${revision.ino}:${revision.size}:${revision.mtimeMs}:${revision.ctimeMs}`;
			let records: DailyUsageRecord[];
			if (liveSession && resolve(filePath) === resolve(liveSession.filePath)) {
				records = [];
				for (let index = 0; index < liveSession.entries.length; index++) {
					if (index % 256 === 0) await yieldToEventLoop();
					const record = usageRecord(liveSession.entries[index]!);
					if (record) records.push(record);
				}
			} else {
				const cached = fileUsageCache.get(filePath);
				if (cached?.key === key) records = cached.records;
				else {
					records = [];
					await visitSessionEntriesAsync(
						filePath,
						(line) => line.includes('"usage"'),
						(entry) => {
							const record = usageRecord(entry);
							if (record) records.push(record);
						},
					);
					await retainUsageRecords(filePath, key, records);
				}
			}
			let used = false;
			for (let index = 0; index < records.length; index++) {
				if (index % 256 === 0) await yieldToEventLoop();
				const record = records[index]!;
				if (addDailyUsageRecord(totals, record, window, spawned, semantic)) used = true;
			}
			if (used) totals.sessions++;
		}
	}
	return finishTotals(totals);
}

export function aggregateDailyUsageFromSessionFiles(
	sessionDir: string,
	window: DailyUsageWindow,
	liveSession?: LiveSessionDailyUsageSource,
): DailyUsageTotals {
	const totals = createZeroTotals();
	if (!sessionDir || !existsSync(sessionDir)) return totals;
	const seenSpawnedReportIds = new Set<string>();
	const seenSemanticReportIds = new Set<string>();
	for (const name of readdirSync(sessionDir)) {
		if (!name.endsWith(".jsonl")) continue;
		const filePath = join(sessionDir, name);
		if (!shouldReadSessionFile(filePath, window)) continue;
		const entries = getSessionEntries(filePath, liveSession);
		if (addDailyUsageFromEntries(totals, entries, window, seenSpawnedReportIds, seenSemanticReportIds)) {
			totals.sessions += 1;
		}
	}
	return finishTotals(totals);
}

export function aggregateDailyUsageFromSessionRoot(
	sessionRoot: string,
	window: DailyUsageWindow,
	liveSession?: LiveSessionDailyUsageSource,
): DailyUsageTotals {
	const totals = createZeroTotals();
	if (!sessionRoot || !existsSync(sessionRoot)) return totals;
	const seenSpawnedReportIds = new Set<string>();
	const seenSemanticReportIds = new Set<string>();
	for (const name of readdirSync(sessionRoot)) {
		const dir = join(sessionRoot, name);
		if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
		for (const fileName of readdirSync(dir)) {
			if (!fileName.endsWith(".jsonl")) continue;
			const filePath = join(dir, fileName);
			if (!shouldReadSessionFile(filePath, window)) continue;
			const entries = getSessionEntries(filePath, liveSession);
			if (addDailyUsageFromEntries(totals, entries, window, seenSpawnedReportIds, seenSemanticReportIds)) {
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
		`${formatLabel("Today:")} ${totals.costEstimate ? "~" : ""}$${totals.totalCost.toFixed(4)}${totals.costEstimate ? " (base-rate estimate)" : ""}${totals.pending ? " (partial; updating)" : ""}`,
		`${formatLabel("Own/session messages:")} $${totals.ownCost.toFixed(4)}`,
		`${formatLabel("Spawned/background reports:")} $${(totals.spawnedCost - totals.historySummaryCost).toFixed(4)}`,
		`${formatLabel("ICM history summaries:")} $${totals.historySummaryCost.toFixed(4)}`,
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
