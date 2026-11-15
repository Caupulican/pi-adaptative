/**
 * Reads a session file's auto-learn session id and aggregates whole-session usage from its entries, counting each spawned or semantic report once.
 */
import * as fs from "node:fs";
import type { Usage } from "@caupulican/pi-ai";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { addUsage, createEmptyUsage, getSessionEntryUsage } from "../../kernel/usage.ts";
import { type ChargedRange, ChargedRanges, chargedRangeSource, legacyChargedRangeSource } from "./charged-ranges.ts";
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

/**
 * Whole-session spend, including direct entry charges and already-rolled-up descendants. `pending` are held semantic
 * reports the ledger does not carry yet; a report already in `entries` is counted once, from its row. Spawned reports
 * that charge a range count as the union of their ranges (`ChargedRanges`), any other once by report id.
 */
export function aggregateCumulativeUsageFromSessionEntries(
	entries: readonly SessionEntry[],
	pending: readonly SemanticUsageReport[] = [],
	overflow?: Usage,
): Usage {
	const total = createEmptyUsage();
	const seenSpawnedReportIds = new Set<string>();
	const seenSemanticReportIds = new Set<string>();
	const ranges = new ChargedRanges();
	for (const entry of entries) {
		const usage = getSessionEntryUsage(entry);
		if (usage && isUsage(usage)) {
			addUsage(total, usage);
		} else if (entry.type === "custom" && entry.customType === SPAWNED_USAGE_CUSTOM_TYPE) {
			const data = entry.data as SpawnedUsageReport | undefined;
			if (!data?.usage || !isUsage(data.usage)) continue;
			const range = chargedRangeOf(data);
			if (range) {
				const open = ranges.take(range, data.usage);
				if (open) addUsage(total, open);
				continue;
			}
			if (data.reportId) {
				if (seenSpawnedReportIds.has(data.reportId)) continue;
				seenSpawnedReportIds.add(data.reportId);
			}
			addUsage(total, data.usage);
		} else if (entry.type === "custom" && entry.customType === SEMANTIC_USAGE_CUSTOM_TYPE) {
			const data = entry.data as SemanticAccountingReport | undefined;
			if (!data?.usage || !isUsage(data.usage) || !data.reportId || seenSemanticReportIds.has(data.reportId))
				continue;
			seenSemanticReportIds.add(data.reportId);
			addUsage(total, data.usage);
		}
	}
	for (const report of pending) {
		if (seenSemanticReportIds.has(report.reportId) || !isUsage(report.usage)) continue;
		seenSemanticReportIds.add(report.reportId);
		addUsage(total, report.usage);
	}
	// Paid history spend the bounded journal had no room for: live only.
	if (overflow !== undefined && isUsage(overflow)) addUsage(total, overflow);
	return total;
}
