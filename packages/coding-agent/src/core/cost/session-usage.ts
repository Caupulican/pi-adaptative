/**
 * Reads a session file's auto-learn session id and aggregates whole-session usage from its entries, counting each spawned or semantic report once.
 */
import * as fs from "node:fs";
import type { Usage } from "@caupulican/pi-ai";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { addUsage, createEmptyUsage, getSessionEntryUsage } from "../../kernel/usage.ts";
import { type ChargedRange, ChargedRanges, chargedRangeSource, legacyChargedRangeSource } from "./charged-ranges.ts";
import { type UsageReceiptReport, usageOfReceipt, usageReceiptOf } from "./usage-receipt.ts";
import {
	BOT_SESSION_USAGE_LABEL,
	SEMANTIC_USAGE_CUSTOM_TYPE,
	type SemanticAccountingReport,
	type SemanticUsageReport,
	SPAWNED_USAGE_CUSTOM_TYPE,
	type SpawnedUsageReport,
} from "./usage-records.ts";

/** Whether a persisted value is a whole `Usage` record: every token count and every cost field a number. */
export function isUsage(value: unknown): value is Usage {
	if (!value || typeof value !== "object") return false;
	const usage = value as Partial<Usage>;
	const cost = usage.cost as Partial<Usage["cost"]> | undefined;
	return (
		typeof usage.input === "number" &&
		typeof usage.output === "number" &&
		typeof usage.cacheRead === "number" &&
		typeof usage.cacheWrite === "number" &&
		typeof usage.totalTokens === "number" &&
		!!cost &&
		typeof cost.input === "number" &&
		typeof cost.output === "number" &&
		typeof cost.cacheRead === "number" &&
		typeof cost.cacheWrite === "number" &&
		typeof cost.total === "number"
	);
}

/**
 * The range a spawned report charges, when it names one: both ends, its source session and no per-model components
 * (`ChargedRanges`). Its source is that session's file instance (`chargedRangeSource`); a bot session's report that names
 * no instance (an earlier build's) charges its range under the session alone, as that build's readers took it
 * (`legacyChargedRangeSource`), and one whose instance is no string charges none.
 */
export function chargedRangeOf(report: SpawnedUsageReport | undefined): ChargedRange | undefined {
	if (
		!report ||
		report.label !== BOT_SESSION_USAGE_LABEL ||
		report.usageComponents !== undefined ||
		typeof report.sourceSessionId !== "string"
	)
		return undefined;
	const { from, through, sourceSessionId, sourceInstance } = report;
	if (!isUsage(from) || !isUsage(through)) return undefined;
	if (sourceInstance === undefined) return { source: legacyChargedRangeSource(sourceSessionId), from, through };
	return typeof sourceInstance === "string"
		? { source: chargedRangeSource(sourceSessionId, sourceInstance), from, through }
		: undefined;
}

export function readAutoLearnSessionIdFromFile(filePath: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
		const buffer = Buffer.alloc(64 * 1024);
		const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
		const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n", 1)[0]?.trim();
		if (!firstLine) return undefined;
		const header = JSON.parse(firstLine) as Record<string, unknown>;
		return header.type === "session" && typeof header.id === "string" ? header.id : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// Ignore close errors
			}
		}
	}
}

/** What one share of a session's cumulative usage was spent on, as the record that holds it names it. */
export type CumulativeUsageShare =
	/** An entry's own usage: an assistant or tool result message, a compaction or a branch summary. */
	| { readonly kind: "direct"; readonly entry: SessionEntry }
	/** A spawned report (its open part, for one that charges a range). */
	| { readonly kind: "spawned"; readonly report: SpawnedUsageReport }
	/** A usage receipt, which names no model. */
	| { readonly kind: "receipt"; readonly receipt: UsageReceiptReport }
	/** A semantic report, recorded or held. */
	| { readonly kind: "semantic"; readonly report: SemanticAccountingReport }
	/** Paid history spend the bounded journal had no room for. */
	| { readonly kind: "overflow" };

/**
 * Whether a share is background spend, as the current session's cost totals class it (`subagentCost`, what
 * `SessionAnalytics.getSpawnedUsage` reads): a spawned report, a usage receipt, a history summary's System One report and
 * the paid history spend its journal had no room for; not the session's own entries or its other System One reports.
 */
export function isBackgroundShare(share: CumulativeUsageShare): boolean {
	if (share.kind === "direct") return false;
	return share.kind !== "semantic" || share.report.route === "history_summary";
}

/**
 * What names one share of a session's cumulative usage across readings: its entry, or the report id it is counted once
 * by; undefined for the paid history spend the journal had no room for, which changes as it is read.
 */
export function usageShareKey(share: CumulativeUsageShare): string | undefined {
	switch (share.kind) {
		case "direct":
			return `entry:${share.entry.id}`;
		case "spawned":
			return share.report.reportId === undefined ? undefined : `spawned:${share.report.reportId}`;
		case "receipt":
			return `receipt:${share.receipt.reportId}`;
		case "semantic":
			return `semantic:${share.report.reportId}`;
		case "overflow":
			return undefined;
	}
}

/** The dollars of `usage`, one share of a session's cumulative usage (`share`), that are metered spend (`isMeteredSpend`). */
export type MeteredUsageShare = (usage: Usage, share: CumulativeUsageShare) => number;

/**
 * Whole-session spend, including direct entry charges and already-rolled-up descendants. `pending` are held semantic
 * reports the ledger does not carry yet; a report already in `entries` is counted once, from its row. Spawned reports
 * that charge a range count as the union of their ranges (`ChargedRanges`), any other once by report id; a usage receipt
 * (`usage-receipt.ts`) counts once by its report id, its cost and token total only.
 */
export function aggregateCumulativeUsageFromSessionEntries(
	entries: readonly SessionEntry[],
	pending: readonly SemanticUsageReport[] = [],
	overflow?: Usage,
): Usage {
	const total = createEmptyUsage();
	forEachCumulativeShare(entries, pending, overflow, (usage) => addUsage(total, usage));
	return total;
}

/**
 * The part of the whole-session spend (`aggregateCumulativeUsageFromSessionEntries`, over the same records counted the
 * same way) that is metered, as `metered` reads each share: in dollars.
 */
export function meteredCumulativeUsd(
	entries: readonly SessionEntry[],
	metered: MeteredUsageShare,
	pending: readonly SemanticUsageReport[] = [],
	overflow?: Usage,
): number {
	let usd = 0;
	forEachCumulativeShare(entries, pending, overflow, (usage, share) => {
		usd += metered(usage, share);
	});
	return usd;
}

/** The spend of the shares a session's records hold past an entry, and the last entry read. */
export interface SharesPastEntry {
	/** Their cost, in dollars. */
	readonly usd: number;
	/** Their metered part, in dollars, as the reader's `metered` reads each share. */
	readonly meteredUsd: number;
	/** The last of the entries read: where the next reading of new shares starts; undefined with no entry. */
	readonly lastEntryId: string | undefined;
}

/**
 * The cumulative usage the entries recorded by `atMs` hold: those before the first entry dated after it (each by its
 * `timestamp`), so a clock that went back never lets a later entry in.
 */
export function usageRecordedBy(entries: readonly SessionEntry[], atMs: number): Usage {
	const after = entries.findIndex((entry) => !(Date.parse(entry.timestamp) <= atMs));
	return aggregateCumulativeUsageFromSessionEntries(after < 0 ? entries : entries.slice(0, after));
}

/**
 * The shares of the whole-session spend (counted once, as `aggregateCumulativeUsageFromSessionEntries` counts them) that
 * the entries after `afterEntryId` hold: what a reading that fixes each share's metered part once (a bot's charge) adds
 * since its last one, never reading the shares before it again. With no `afterEntryId`, or one `entries` do not hold (a
 * history not loaded yet, another file's), every share is past it.
 */
export function sharesPastEntry(
	entries: readonly SessionEntry[],
	metered: MeteredUsageShare,
	afterEntryId: string | undefined,
): SharesPastEntry {
	const after = afterEntryId === undefined ? -1 : entries.findIndex((entry) => entry.id === afterEntryId);
	let usd = 0;
	let meteredUsd = 0;
	forEachCumulativeShare(entries, [], undefined, (usage, share, index) => {
		if (index === undefined || index <= after) return;
		usd += usage.cost.total;
		meteredUsd += metered(usage, share);
	});
	return { usd, meteredUsd, lastEntryId: entries.at(-1)?.id };
}

/**
 * Each share of the whole-session spend, counted once as `aggregateCumulativeUsageFromSessionEntries` counts it, with the
 * index in `entries` of the entry that holds it (none for a held report or the overflow).
 */
function forEachCumulativeShare(
	entries: readonly SessionEntry[],
	pending: readonly SemanticUsageReport[],
	overflow: Usage | undefined,
	visit: (usage: Usage, share: CumulativeUsageShare, index?: number) => void,
): void {
	const seenSpawnedReportIds = new Set<string>();
	const seenSemanticReportIds = new Set<string>();
	const ranges = new ChargedRanges();
	for (const [index, entry] of entries.entries()) {
		const usage = getSessionEntryUsage(entry);
		const receipt = usageReceiptOf(entry);
		if (usage && isUsage(usage)) {
			visit(usage, { kind: "direct", entry }, index);
		} else if (entry.type === "custom" && entry.customType === SPAWNED_USAGE_CUSTOM_TYPE) {
			const data = entry.data as SpawnedUsageReport | undefined;
			if (!data?.usage || !isUsage(data.usage)) continue;
			const range = chargedRangeOf(data);
			if (range) {
				const open = ranges.take(range, data.usage);
				if (open) visit(open, { kind: "spawned", report: data }, index);
				continue;
			}
			if (data.reportId) {
				if (seenSpawnedReportIds.has(data.reportId)) continue;
				seenSpawnedReportIds.add(data.reportId);
			}
			visit(data.usage, { kind: "spawned", report: data }, index);
		} else if (receipt) {
			if (seenSpawnedReportIds.has(receipt.reportId)) continue;
			seenSpawnedReportIds.add(receipt.reportId);
			visit(usageOfReceipt(receipt), { kind: "receipt", receipt }, index);
		} else if (entry.type === "custom" && entry.customType === SEMANTIC_USAGE_CUSTOM_TYPE) {
			const data = entry.data as SemanticAccountingReport | undefined;
			if (!data?.usage || !isUsage(data.usage) || !data.reportId || seenSemanticReportIds.has(data.reportId))
				continue;
			seenSemanticReportIds.add(data.reportId);
			visit(data.usage, { kind: "semantic", report: data }, index);
		}
	}
	for (const report of pending) {
		if (seenSemanticReportIds.has(report.reportId) || !isUsage(report.usage)) continue;
		seenSemanticReportIds.add(report.reportId);
		visit(report.usage, { kind: "semantic", report });
	}
	// Paid history spend the bounded journal had no room for: live only.
	if (overflow !== undefined && isUsage(overflow)) visit(overflow, { kind: "overflow" });
}
