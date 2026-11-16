import { existsSync, readdirSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { Usage } from "@caupulican/pi-ai";
import { parentInputOf, parentInputOriginalDetails } from "../../kernel/session/parent-input-ledger.ts";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { loadEntriesFromFile, visitSessionEntriesAsync } from "../../kernel/session/session-manager.ts";
import { getSessionEntryUsageComponents } from "../../kernel/usage.ts";
import { HOST_EVENT_CUSTOM_TYPE } from "../events/host-event-delivery.ts";
import { steeredDeliveryOf } from "../parent-input-steer.ts";
import { ACT_AHEAD_CUSTOM_TYPE, actAheadAccount, actAheadRecordOf } from "../proactivity/act-ahead-record.ts";
import { PROACTIVE_NOTE_CUSTOM_TYPE } from "../proactivity/proactivity-review.ts";
import { ROUTINE_COMPLETION_TYPE } from "../routines/routine-parent-input.ts";
import { isMissingFileError } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { accountingProjectionPath } from "./accounting-evidence.ts";
import { accountingFragmentPath } from "./accounting-fragments.ts";
import {
	readAccountingRevision,
	readProjectedSessionEntries,
	readProjectedSessionEntriesSync,
} from "./accounting-history.ts";
import { type ChargedRange, sweepChargedRanges } from "./charged-ranges.ts";
import { chargedRangeOf } from "./session-usage.ts";
import { USAGE_RECEIPT_CUSTOM_TYPE, usageOfReceipt, usageReceiptOf } from "./usage-receipt.ts";
import {
	getSpawnedUsageComponents,
	hasUnknownUsageModel,
	resolveEffectiveEntryCost,
	SEMANTIC_USAGE_CUSTOM_TYPE,
	type SemanticAccountingReport,
	type SemanticUsageReport,
	SPAWNED_USAGE_CUSTOM_TYPE,
	type SpawnedUsageReport,
	spawnedReportModel,
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
	/** The proactive-review share of `ownCost`. */
	proactivityCost: number;
	/** `proactivityCost` by the model that spent it, for a bound that counts only part of it (metered spend). */
	proactivitySpend: ProactivitySpend[];
	/** Accepted proactive-note deliveries that start a parent turn without an owner message. */
	proactiveTurnWakes: number;
	/** Host events (CI results) delivered to the main session as a parent turn without an owner message. */
	hostEventTurnWakes: number;
	/** Routine results delivered to the parent as a turn without an owner message. */
	routineResultTurnWakes: number;
	/** Acting-ahead attempts started (admitted) over the window. */
	actAheadAttempts: number;
	/** Acting-ahead spend: each attempt's charge at admission, corrected to its settled spend. Bound accounting only. */
	actAheadUsd: number;
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

/** Proactive-review spend made on one model, named as its usage records name it (either part may be absent). */
export interface ProactivitySpend {
	readonly provider?: string;
	readonly model?: string;
	usd: number;
}

function addProactivitySpend(
	spend: ProactivitySpend[],
	record: Pick<DailyUsageSpendRecord, "provider" | "model">,
	usd: number,
): void {
	const same = spend.find((entry) => entry.provider === record.provider && entry.model === record.model);
	if (same) same.usd += usd;
	else
		spend.push({
			...(record.provider !== undefined ? { provider: record.provider } : {}),
			...(record.model !== undefined ? { model: record.model } : {}),
			usd,
		});
}

function createZeroTotals(): DailyUsageTotals {
	return {
		ownCost: 0,
		reportedTotalCost: 0,
		spawnedCost: 0,
		historySummaryCost: 0,
		proactivityCost: 0,
		proactivitySpend: [],
		proactiveTurnWakes: 0,
		hostEventTurnWakes: 0,
		routineResultTurnWakes: 0,
		actAheadAttempts: 0,
		actAheadUsd: 0,
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

/**
 * What counts once in one aggregation: spawned and semantic report ids, and the part of each spawned report that charges a
 * range that counts (`sweepChargedRanges`, once every source is read).
 */
interface DailyUsageSeen {
	readonly spawned: Set<string>;
	readonly semantic: Set<string>;
	ranged: ReadonlyMap<DailyUsageRecord, Usage | undefined>;
}

/** What one session file (or the live session) counts as when any of its records counts. */
type DailyUsageSourceKind = "session" | "fragment" | undefined;

function countSource(totals: DailyUsageTotals, counts: DailyUsageSourceKind): void {
	if (counts === "fragment") totals.fragments = (totals.fragments ?? 0) + 1;
	else if (counts === "session") totals.sessions++;
}

/**
 * One aggregation's count, source by source. A record counts as its source is read, each report once by id, but a spawned
 * report that charges a range: those are held, with their source, until every source is read, then counted as the union
 * of their ranges, each covered stretch on the earliest day a charge covering it was recorded, whichever file holds it.
 * Only the ranged records are held across sources.
 */
class DailyUsageCount {
	private readonly totals: DailyUsageTotals;
	private readonly window: DailyUsageWindow;
	private readonly seen: DailyUsageSeen = { spawned: new Set(), semantic: new Set(), ranged: new Map() };
	private readonly held: { readonly records: readonly DailyUsageRecord[]; readonly counts: DailyUsageSourceKind }[] =
		[];
	private ranged: DailyUsageRecord[] = [];
	private used = false;

	constructor(totals: DailyUsageTotals, window: DailyUsageWindow) {
		this.totals = totals;
		this.window = window;
	}

	/** Counts one record of the source being read; one that charges a range waits for `finish`. */
	record(record: DailyUsageRecord): void {
		if (record.kind === "spawned" && record.range) this.ranged.push(record);
		else if (addDailyUsageRecord(this.totals, record, this.window, this.seen)) this.used = true;
	}

	/** The source being read ended: it counts as `counts` once any of its records counted, now or at `finish`. */
	sourceEnded(counts: DailyUsageSourceKind): void {
		if (this.used) countSource(this.totals, counts);
		if (this.ranged.length > 0) this.held.push({ records: this.ranged, counts: this.used ? undefined : counts });
		this.ranged = [];
		this.used = false;
	}

	/** Counts the held ranged records, then the totals are final. */
	finish(): DailyUsageTotals {
		this.seen.ranged = sweepChargedRanges(
			this.held.flatMap((source) => source.records),
			(record) =>
				record.kind === "spawned" && record.range
					? { range: record.range, usage: record.usage, at: Date.parse(record.timestamp) }
					: undefined,
		);
		for (const source of this.held) {
			let used = false;
			for (const record of source.records)
				if (addDailyUsageRecord(this.totals, record, this.window, this.seen)) used = true;
			if (used) countSource(this.totals, source.counts);
		}
		return finishTotals(this.totals);
	}
}

function addDailyUsageRecord(
	totals: DailyUsageTotals,
	record: DailyUsageRecord,
	window: DailyUsageWindow,
	seen: DailyUsageSeen,
): boolean {
	if (!isInsideWindow(Date.parse(record.timestamp), window)) return false;
	// A wake is an event, not spend: it does not make its session one that spent in the window.
	if (record.kind === "wake") {
		if (record.wake === "proactive_note") totals.proactiveTurnWakes++;
		else if (record.wake === "routine_result") totals.routineResultTurnWakes++;
		else totals.hostEventTurnWakes++;
		return false;
	}
	// The worker's real spend arrives as its own spawned usage; this is the acting-ahead bound's account, not spend.
	if (record.kind === "act_ahead") {
		totals.actAheadAttempts += record.attempts;
		totals.actAheadUsd += record.usd;
		return false;
	}
	// A charged range counts the part of it no earlier-dated charge covers; any other report counts once by report id.
	const ranged = record.kind === "spawned" && record.range !== undefined;
	const usage = ranged ? seen.ranged.get(record) : record.usage;
	if (!usage) return false;
	const ids = ranged
		? undefined
		: record.kind === "spawned"
			? seen.spawned
			: record.kind === "semantic"
				? seen.semantic
				: undefined;
	if (record.reportId && ids?.has(record.reportId)) return false;
	const resolved = resolveEffectiveEntryCost(usage, {
		model: record.model,
		provider: record.provider,
		kind: record.kind,
		perResponse: record.perResponse,
		costStatus: record.costStatus,
	});
	if (!resolved) return false;
	if (record.reportId) ids?.add(record.reportId);
	if (hasUnknownUsageModel(usage, record.provider, record.model)) {
		totals.modelUnknownTokens = (totals.modelUnknownTokens ?? 0) + usage.totalTokens;
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
	if (record.proactivity) {
		totals.proactivityCost += costTotal;
		addProactivitySpend(totals.proactivitySpend, record, costTotal);
	}
	if (resolved?.estimated) totals.costEstimate = "base-rates";
	addUsage(totals, usage);
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
	pending: readonly SemanticUsageReport[] = [],
): DailyUsageTotals {
	const count = new DailyUsageCount(createZeroTotals(), window);
	for (const entry of entries) for (const record of usageRecords(entry)) count.record(record);
	const now = new Date().toISOString();
	for (const report of pending) count.record(semanticUsageRecord(report, now));
	count.sourceEnded("session");
	return count.finish();
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

interface DailyUsageSpendRecord {
	costStatus?: SemanticUsageReport["costStatus"];
	timestamp: string;
	usage: Usage;
	kind: "own" | "spawned" | "semantic";
	model?: string;
	provider?: string;
	perResponse?: boolean;
	reportId?: string;
	/** The range a spawned report charges (`chargedRangeOf`): it counts as the union of the ranges, not by report id. */
	range?: ChargedRange;
	historySummary: boolean;
	proactivity: boolean;
}

/** An accepted proactive note, host event or routine result that starts a parent turn, at its acceptance time. */
interface ParentWakeRecord {
	kind: "wake";
	wake: "proactive_note" | "host_event" | "routine_result";
	timestamp: string;
}

/** An acting-ahead admission (one attempt and its charge) or settlement (the charge corrected to the spend). */
interface ActAheadAccountRecord {
	kind: "act_ahead";
	attempts: number;
	usd: number;
	timestamp: string;
}

type DailyUsageRecord = DailyUsageSpendRecord | ParentWakeRecord | ActAheadAccountRecord;

/** The wake an accepted parent input of this type counts as, if its mode starts a turn or steers a running one. */
const PARENT_WAKE_KINDS: ReadonlyMap<string, ParentWakeRecord["wake"]> = new Map([
	[PROACTIVE_NOTE_CUSTOM_TYPE, "proactive_note"],
	[HOST_EVENT_CUSTOM_TYPE, "host_event"],
	[ROUTINE_COMPLETION_TYPE, "routine_result"],
]);

/** Persisted and held semantic receipts map to one record shape, so the report-id dedupe sees them as the same charge. */
function semanticUsageRecord(report: SemanticAccountingReport, timestamp: string): DailyUsageSpendRecord {
	return {
		timestamp: report.responseTimestamp ?? timestamp,
		usage: report.usage,
		kind: "semantic",
		costStatus: report.costStatus,
		...(typeof report.model === "string" ? { model: report.model } : {}),
		...(typeof report.provider === "string" ? { provider: report.provider } : {}),
		reportId: report.reportId,
		historySummary: report.route === "history_summary",
		proactivity: report.route === "proactivity",
	};
}

/** A one-shot watch's wake: its slots and end time bound it, so it counts toward no day's wake bound it is exempt from. */
function isBoundExemptWake(entry: SessionEntry): boolean {
	const details = parentInputOriginalDetails(entry);
	return isPlainRecord(details) && details.oneShotWatch === true;
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
			proactivity: false,
		}));
	const wake = entry.type === "custom_message" ? PARENT_WAKE_KINDS.get(entry.customType) : undefined;
	if (wake)
		return (parentInputOf(entry)?.metadata.mode === "turn" || steeredDeliveryOf(entry)) && !isBoundExemptWake(entry)
			? [{ kind: "wake", wake, timestamp: entry.timestamp }]
			: [];
	if (entry.type !== "custom") return [];
	if (entry.customType === ACT_AHEAD_CUSTOM_TYPE) {
		const record = actAheadRecordOf(entry);
		const account = record ? actAheadAccount(record) : undefined;
		return account ? [{ kind: "act_ahead", ...account, timestamp: entry.timestamp }] : [];
	}
	if (entry.customType === SEMANTIC_USAGE_CUSTOM_TYPE) {
		const report = entry.data as SemanticAccountingReport | undefined;
		return report?.usage && report.reportId ? [semanticUsageRecord(report, entry.timestamp)] : [];
	}
	const receipt = usageReceiptOf(entry);
	// A usage receipt names no model: its cost counts as recorded, on the day it was recorded.
	if (receipt)
		return [
			{
				timestamp: entry.timestamp,
				usage: usageOfReceipt(receipt),
				kind: "spawned",
				reportId: receipt.reportId,
				historySummary: false,
				proactivity: false,
			},
		];
	if (entry.customType !== SPAWNED_USAGE_CUSTOM_TYPE) return [];
	const data = entry.data as SpawnedUsageReport | undefined;
	if (!data?.usage) return [];
	// A report recorded again in another file counts on the day it was first recorded, whichever file holds it.
	const recordedAt =
		typeof data.recordedAt === "string" && Number.isFinite(Date.parse(data.recordedAt))
			? data.recordedAt
			: entry.timestamp;
	const range = chargedRangeOf(data);
	if (data.usageComponents !== undefined)
		return getSpawnedUsageComponents(data, recordedAt).map((part) => ({
			timestamp: part.timestamp,
			usage: part.usage,
			kind: "spawned",
			model: part.model,
			provider: part.provider,
			perResponse: true,
			reportId: `${data.reportId ?? entry.id}:${part.sourceId}`,
			historySummary: false,
			proactivity: false,
		}));
	return [
		{
			timestamp: recordedAt,
			usage: data.usage,
			kind: "spawned",
			...spawnedReportModel(data),
			...(data.costBasis === "response" ? { perResponse: true } : {}),
			reportId: data.reportId,
			...(range ? { range } : {}),
			historySummary: false,
			proactivity: false,
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

/** A session directory that does not exist yet holds no sessions. */
async function readSessionDirectory(directory: string) {
	try {
		return await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (isMissingFileError(error)) return [];
		throw error;
	}
}

/** Wake, acting-ahead and usage-receipt lines carry no `usage` field, so the usage prefilter also admits them. */
const LINES_WITHOUT_USAGE = [...PARENT_WAKE_KINDS.keys(), ACT_AHEAD_CUSTOM_TYPE, USAGE_RECEIPT_CUSTOM_TYPE].map(
	(customType) => `"${customType}"`,
);

/**
 * Entire scan is asynchronous; retained cache entries contain usage only, never conversation payloads. The live session
 * counts even before its file is listed, and `pending` adds its held semantic receipts the ledger does not carry yet,
 * once by report id.
 */
export async function aggregateDailyUsageAsync(
	scope: string,
	root: boolean,
	window: DailyUsageWindow,
	liveSession?: LiveSessionDailyUsageSource,
	pending: readonly SemanticUsageReport[] = [],
): Promise<DailyUsageTotals> {
	const totals = createZeroTotals();
	const count = new DailyUsageCount(totals, window);
	let liveCounted = false;
	const directories = root
		? (await readSessionDirectory(scope))
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(scope, entry.name))
		: [scope];
	for (const directory of directories) {
		for (const { name } of await readSessionDirectory(directory)) {
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
				liveCounted = true;
				records = await liveUsageRecords(liveSession);
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
							(line) => line.includes('"usage"') || LINES_WITHOUT_USAGE.some((type) => line.includes(type)),
							(entry) => {
								records.push(...usageRecords(entry));
							},
						);
					await retainUsageRecords(filePath, key, records, materialized);
				}
			}
			for (let index = 0; index < records.length; index++) {
				if (index % 256 === 0) await yieldToEventLoop();
				count.record(records[index]!);
			}
			count.sourceEnded(fragmentRevision ? "fragment" : "session");
		}
	}
	if (liveSession && !liveCounted) for (const record of await liveUsageRecords(liveSession)) count.record(record);
	const now = new Date().toISOString();
	for (const report of pending) count.record(semanticUsageRecord(report, now));
	count.sourceEnded(liveCounted ? undefined : "session");
	return count.finish();
}

async function liveUsageRecords(liveSession: LiveSessionDailyUsageSource): Promise<DailyUsageRecord[]> {
	const records: DailyUsageRecord[] = [];
	for (let index = 0; index < liveSession.entries.length; index++) {
		if (index % 256 === 0) await yieldToEventLoop();
		records.push(...usageRecords(liveSession.entries[index]!));
	}
	return records;
}

function addDailyUsageFile(
	count: DailyUsageCount,
	filePath: string,
	window: DailyUsageWindow,
	liveSession?: LiveSessionDailyUsageSource,
): void {
	if (!shouldReadSessionFile(filePath, window)) return;
	for (const entry of getSessionEntries(filePath, liveSession))
		for (const record of usageRecords(entry)) count.record(record);
	count.sourceEnded(existsSync(accountingFragmentPath(filePath)) ? "fragment" : "session");
}

export function aggregateDailyUsageFromSessionFiles(
	sessionDir: string,
	window: DailyUsageWindow,
	liveSession?: LiveSessionDailyUsageSource,
): DailyUsageTotals {
	const totals = createZeroTotals();
	if (!sessionDir || !existsSync(sessionDir)) return totals;
	const count = new DailyUsageCount(totals, window);
	for (const name of readdirSync(sessionDir)) {
		if (!name.endsWith(".jsonl")) continue;
		addDailyUsageFile(count, join(sessionDir, name), window, liveSession);
	}
	return count.finish();
}

export function aggregateDailyUsageFromSessionRoot(
	sessionRoot: string,
	window: DailyUsageWindow,
	liveSession?: LiveSessionDailyUsageSource,
): DailyUsageTotals {
	const totals = createZeroTotals();
	if (!sessionRoot || !existsSync(sessionRoot)) return totals;
	const count = new DailyUsageCount(totals, window);
	for (const name of readdirSync(sessionRoot)) {
		const dir = join(sessionRoot, name);
		if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
		for (const fileName of readdirSync(dir)) {
			if (!fileName.endsWith(".jsonl")) continue;
			addDailyUsageFile(count, join(dir, fileName), window, liveSession);
		}
	}
	return count.finish();
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
