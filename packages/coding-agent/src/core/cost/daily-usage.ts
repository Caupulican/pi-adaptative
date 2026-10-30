import { existsSync, readdirSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { Usage } from "@caupulican/pi-ai";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { loadEntriesFromFile, visitSessionEntriesAsync } from "../../kernel/session/session-manager.ts";
import { getSessionEntryUsageComponents } from "../../kernel/usage.ts";
import { accountingProjectionPath } from "./accounting-evidence.ts";
import { accountingFragmentPath } from "./accounting-fragments.ts";
import {
	readAccountingRevision,
	readProjectedSessionEntries,
	readProjectedSessionEntriesSync,
} from "./accounting-history.ts";
import {
	getSpawnedUsageComponents,
	hasUnknownUsageModel,
	resolveEffectiveEntryCost,
	SEMANTIC_USAGE_CUSTOM_TYPE,
	type SemanticAccountingReport,
	type SemanticUsageReport,
	SPAWNED_USAGE_CUSTOM_TYPE,
	type SpawnedUsageReport,
} from "./usage-records.ts";

export type DailyUsageWindow = {
	startMs: number;
	endMs: number;
};

export type DailyUsageTotals = {
	modelUnknownTokens?: number;
	modelUnknownOperations?: number;
	apiEquivalentPartial?: boolean;
	/** Cross-session refresh is not settled; values are the last available projection. */
	pending?: boolean;
	costEstimate?: "base-rates";
	ownCost: number;
	/** Background spend: spawned workers plus the history summaries below. */
	spawnedCost: number;
	/** The ICM history-summary share of `spawnedCost`. */
	historySummaryCost: number;
	totalCost: number;
	reportedTotalCost?: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	sessions: number;
	fragments?: number;
	reports: number;
};

function createZeroTotals(): DailyUsageTotals {
	return {
		ownCost: 0,
		reportedTotalCost: 0,
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
		for (const record of usageRecords(entry)) {
			if (addDailyUsageRecord(totals, record, window, seenSpawnedReportIds, seenSemanticReportIds)) hasUsage = true;
		}
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
	const resolved = resolveEffectiveEntryCost(record.usage, {
		model: record.model,
		provider: record.provider,
		kind: record.kind,
		perResponse: record.perResponse,
		costStatus: record.costStatus,
	});
	if (!resolved) return false;
	if (record.reportId) seen?.add(record.reportId);
	if (hasUnknownUsageModel(record.usage, record.provider, record.model)) {
		totals.modelUnknownTokens = (totals.modelUnknownTokens ?? 0) + record.usage.totalTokens;
		totals.modelUnknownOperations = (totals.modelUnknownOperations ?? 0) + 1;
		totals.apiEquivalentPartial = true;
	}
	const costTotal = resolved.total;
	totals.reportedTotalCost = (totals.reportedTotalCost ?? 0) + resolved.reportedTotal;
	if (record.kind === "spawned" || record.historySummary) {
		totals.spawnedCost += costTotal;
		totals.reports++;
	} else totals.ownCost += costTotal;
	if (record.historySummary) totals.historySummaryCost += costTotal;
	if (resolved?.estimated) totals.costEstimate = "base-rates";
	addUsage(totals, record.usage);
	return true;
}

function finishTotals(totals: DailyUsageTotals): DailyUsageTotals {
	totals.totalCost = totals.ownCost + totals.spawnedCost;
	return totals;
}

function shouldReadSessionFile(filePath: string, window: DailyUsageWindow): boolean {
	try {
		return (
			Math.max(
				...[filePath, accountingProjectionPath(filePath), accountingFragmentPath(filePath)].map((path) => {
					try {
						return statSync(path).mtimeMs;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
						throw error;
					}
				}),
			) >= window.startMs
		);
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
	return (
		readProjectedSessionEntriesSync(filePath) ??
		loadEntriesFromFile(filePath).filter((entry): entry is SessionEntry => entry.type !== "session")
	);
}

interface DailyUsageRecord {
	costStatus?: SemanticUsageReport["costStatus"];
	timestamp: string;
	usage: Usage;
	kind: "own" | "spawned" | "semantic";
	model?: string;
	provider?: string;
	perResponse?: boolean;
	reportId?: string;
	historySummary: boolean;
}

function usageRecords(entry: SessionEntry): DailyUsageRecord[] {
	const own = getSessionEntryUsageComponents(entry);
	if (own.length > 0)
		return own.map((part) => ({
			timestamp: part.timestamp,
			usage: part.usage,
			kind: "own",
			model: part.model,
			provider: part.provider,
			historySummary: false,
		}));
	if (entry.type !== "custom") return [];
	if (entry.customType !== SPAWNED_USAGE_CUSTOM_TYPE && entry.customType !== SEMANTIC_USAGE_CUSTOM_TYPE) return [];
	const data = entry.data as SemanticAccountingReport | SpawnedUsageReport | undefined;
	if (!data?.usage) return [];
	const semantic = entry.customType === SEMANTIC_USAGE_CUSTOM_TYPE;
	if (semantic && !data.reportId) return [];
	if (!semantic && (data as SpawnedUsageReport).usageComponents !== undefined)
		return getSpawnedUsageComponents(data as SpawnedUsageReport, entry.timestamp).map((part) => ({
			timestamp: part.timestamp,
			usage: part.usage,
			kind: "spawned",
			model: part.model,
			provider: part.provider,
			perResponse: true,
			reportId: `${data.reportId ?? entry.id}:${part.sourceId}`,
			historySummary: false,
		}));
	return [
		{
			timestamp: semantic
				? ((data as SemanticAccountingReport).responseTimestamp ?? entry.timestamp)
				: entry.timestamp,
			usage: data.usage,
			kind: semantic ? "semantic" : "spawned",
			...(semantic ? { costStatus: (data as SemanticAccountingReport).costStatus } : {}),
			...(typeof data.model === "string" ? { model: data.model } : {}),
			...(typeof data.provider === "string" ? { provider: data.provider } : {}),
			...(!semantic && (data as SpawnedUsageReport).costBasis === "response" ? { perResponse: true } : {}),
			reportId: data.reportId,
			historySummary: semantic && (data as SemanticAccountingReport).route === "history_summary",
		},
	];
}

const MAX_CACHED_USAGE_RECORDS = 50_000;
const MAX_CACHED_USAGE_BYTES = 8 * 1024 * 1024;
const fileUsageCache = new Map<
	string,
	{ key: string; records: DailyUsageRecord[]; bytes: number; projection?: string }
>();
let cachedUsageRecords = 0;
let cachedUsageBytes = 0;

async function retainUsageRecords(
	path: string,
	key: string,
	records: DailyUsageRecord[],
	projection?: string,
): Promise<void> {
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
	fileUsageCache.set(path, { key, records, bytes, projection });
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
			const projectionRevision = await stat(accountingProjectionPath(filePath)).catch((error: unknown) => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			});
			const fragmentRevision = await stat(accountingFragmentPath(filePath)).catch((error: unknown) => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			});
			if (
				Math.max(revision.mtimeMs, projectionRevision?.mtimeMs ?? 0, fragmentRevision?.mtimeMs ?? 0) <
				window.startMs
			)
				continue;
			const key = `${revision.dev}:${revision.ino}:${revision.size}:${revision.mtimeMs}:${revision.ctimeMs}:${projectionRevision?.mtimeMs ?? 0}:${fragmentRevision?.mtimeMs ?? 0}`;
			let records: DailyUsageRecord[];
			if (liveSession && resolve(filePath) === resolve(liveSession.filePath)) {
				records = [];
				for (let index = 0; index < liveSession.entries.length; index++) {
					if (index % 256 === 0) await yieldToEventLoop();
					records.push(...usageRecords(liveSession.entries[index]!));
				}
			} else {
				const materialized = projectionRevision ? await readAccountingRevision(filePath) : undefined;
				if (projectionRevision && !materialized) totals.pending = true;
				const cached = fileUsageCache.get(filePath);
				if (cached?.key === key && cached.projection === materialized) records = cached.records;
				else {
					records = [];
					const projected =
						projectionRevision || fragmentRevision ? await readProjectedSessionEntries(filePath) : undefined;
					if (projected) {
						for (const entry of projected) {
							records.push(...usageRecords(entry));
						}
					} else
						await visitSessionEntriesAsync(
							filePath,
							(line) => line.includes('"usage"'),
							(entry) => {
								records.push(...usageRecords(entry));
							},
						);
					await retainUsageRecords(filePath, key, records, materialized);
				}
			}
			let used = false;
			for (let index = 0; index < records.length; index++) {
				if (index % 256 === 0) await yieldToEventLoop();
				const record = records[index]!;
				if (addDailyUsageRecord(totals, record, window, spawned, semantic)) used = true;
			}
			if (used) {
				if (fragmentRevision) totals.fragments = (totals.fragments ?? 0) + 1;
				else totals.sessions++;
			}
		}
	}
	return finishTotals(totals);
}

function addDailyUsageFile(
	totals: DailyUsageTotals,
	filePath: string,
	window: DailyUsageWindow,
	spawned: Set<string>,
	semantic: Set<string>,
	liveSession?: LiveSessionDailyUsageSource,
): void {
	if (!shouldReadSessionFile(filePath, window)) return;
	if (!addDailyUsageFromEntries(totals, getSessionEntries(filePath, liveSession), window, spawned, semantic)) return;
	if (existsSync(accountingFragmentPath(filePath))) totals.fragments = (totals.fragments ?? 0) + 1;
	else totals.sessions++;
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
		addDailyUsageFile(totals, filePath, window, seenSpawnedReportIds, seenSemanticReportIds, liveSession);
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
			addDailyUsageFile(totals, filePath, window, seenSpawnedReportIds, seenSemanticReportIds, liveSession);
		}
	}
	return finishTotals(totals);
}

export function formatDailyUsageBreakdown(
	totals: DailyUsageTotals,
	formatLabel: (label: string) => string = (label) => label,
): string {
	return [
		...(totals.apiEquivalentPartial
			? [
					`API equivalent partial: ${totals.modelUnknownTokens ?? 0} tokens across ${totals.modelUnknownOperations ?? 0} operations lack model attribution`,
				]
			: []),
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
