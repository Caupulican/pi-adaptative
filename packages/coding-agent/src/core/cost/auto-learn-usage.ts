import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Usage } from "@caupulican/pi-ai";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { validateProviderUsage } from "../orchestration/attempt-usage.ts";
import { readBoundedDirectoryNamesSync, readBoundedTextFileSync, readFilePrefixSync } from "../util/bounded-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { aggregateCumulativeUsageFromSessionEntries } from "./session-usage.ts";
import type { SpawnedUsageReceiptDisposition, SpawnedUsageReceiptOptions } from "./spawned-usage-receipt.ts";
import { SEMANTIC_USAGE_CUSTOM_TYPE, SPAWNED_USAGE_CUSTOM_TYPE } from "./usage-records.ts";

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_ENTRIES = 100_000;
const MAX_DISCOVERY_ENTRIES = 4096;

export interface AutoLearnUsageSnapshot {
	usage: Usage;
	sourceFile: string;
	sourceDigest: string;
}

export function reportCompletedAutoLearnUsageHelper(args: {
	runId: string;
	sessionDir: string;
	sessionId: string;
	parentSessionId: string;
	parentSession: {
		deliverSpawnedUsageReceipt(usage: Usage, options: SpawnedUsageReceiptOptions): SpawnedUsageReceiptDisposition;
	};
}): SpawnedUsageReceiptDisposition {
	const snapshot = readAutoLearnUsageSnapshot(args.sessionDir, args.sessionId);
	const disposition = args.parentSession.deliverSpawnedUsageReceipt(snapshot.usage, {
		parentSessionId: args.parentSessionId,
		label: "auto-learn",
		sourceSessionId: args.sessionId,
		reportId: `auto-learn:${args.runId}:${args.sessionId}`,
	});
	if (
		disposition === "persisted" &&
		createHash("sha256")
			.update(readBoundedTextFileSync(snapshot.sourceFile, MAX_SOURCE_BYTES, "Auto Learn child ledger"))
			.digest("hex") !== snapshot.sourceDigest
	) {
		throw new Error("Auto Learn child ledger changed during receipt delivery");
	}
	return disposition;
}

/** Read one exact child ledger. Damaged or ambiguous evidence never certifies a zero charge. */
export function readAutoLearnUsageSnapshot(sessionDir: string, sessionId: string): AutoLearnUsageSnapshot {
	const directories = [sessionDir];
	let sourceFile: string | undefined;
	let remaining = MAX_DISCOVERY_ENTRIES;
	while (directories.length > 0) {
		const directory = directories.pop()!;
		const names = readBoundedDirectoryNamesSync(directory, Math.max(1, remaining), "Auto Learn child session");
		remaining -= names.length;
		if (remaining < 0) throw new Error("Auto Learn session discovery limit exceeded");
		for (const name of names) {
			const file = join(directory, name);
			const stat = lstatSync(file);
			if (stat.isDirectory() && !stat.isSymbolicLink()) {
				directories.push(file);
				continue;
			}
			if (!stat.isFile() || !name.endsWith(".jsonl")) continue;
			const prefix = readFilePrefixSync(file, 64 * 1024, "Auto Learn child header").content.toString("utf8");
			const newline = prefix.indexOf("\n");
			if (newline < 0) throw new Error("Auto Learn child header is incomplete");
			const header: unknown = JSON.parse(prefix.slice(0, newline));
			if (!isPlainRecord(header) || header.type !== "session" || typeof header.id !== "string")
				throw new Error("Invalid Auto Learn child header");
			if (header.id !== sessionId) continue;
			if (sourceFile) throw new Error("Ambiguous Auto Learn child session identity");
			sourceFile = file;
		}
	}
	if (!sourceFile) throw new Error(`No exact Auto Learn child ledger for ${sessionId}`);
	const text = readBoundedTextFileSync(sourceFile, MAX_SOURCE_BYTES, "Auto Learn child ledger");
	if (!text.endsWith("\n")) throw new Error("Auto Learn child ledger has an incomplete tail");
	const lines = text.split("\n", MAX_SOURCE_ENTRIES + 3);
	if (lines.length > MAX_SOURCE_ENTRIES + 2) throw new Error("Auto Learn child ledger entry limit exceeded");
	const header: unknown = JSON.parse(lines[0]);
	if (!isPlainRecord(header) || header.type !== "session" || header.id !== sessionId)
		throw new Error("Auto Learn child identity changed");
	const entries: SessionEntry[] = [];
	const ids = new Set<string>();
	const reports = new Map<string, Usage>();
	for (const line of lines.slice(1, -1)) {
		if (!line.trim()) throw new Error("Auto Learn child ledger contains an empty row");
		const entry: unknown = JSON.parse(line);
		if (
			!isPlainRecord(entry) ||
			typeof entry.type !== "string" ||
			typeof entry.id !== "string" ||
			!entry.id ||
			ids.has(entry.id) ||
			(entry.parentId !== null && (typeof entry.parentId !== "string" || !ids.has(entry.parentId)))
		)
			throw new Error("Invalid Auto Learn child ledger row");
		ids.add(entry.id);
		if (entry.type === "message") {
			if (!isPlainRecord(entry.message) || typeof entry.message.role !== "string")
				throw new Error("Invalid Auto Learn child message");
			const message = entry.message;
			if (message.role === "assistant") validateProviderUsage(message.usage, "Auto Learn assistant usage");
			else if (message.role === "toolResult" && message.usage !== undefined)
				validateProviderUsage(message.usage, "Auto Learn tool usage");
			else if (message.usage !== undefined) throw new Error("Unrecognized Auto Learn message charge");
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			if (entry.usage !== undefined) validateProviderUsage(entry.usage, "Auto Learn summary usage");
		} else if (
			entry.type === "custom" &&
			(entry.customType === SPAWNED_USAGE_CUSTOM_TYPE || entry.customType === SEMANTIC_USAGE_CUSTOM_TYPE)
		) {
			if (!isPlainRecord(entry.data)) throw new Error("Invalid Auto Learn nested charge");
			const usage = validateProviderUsage(entry.data.usage, "Auto Learn nested usage");
			if (
				entry.customType === SEMANTIC_USAGE_CUSTOM_TYPE &&
				(typeof entry.data.reportId !== "string" || !entry.data.reportId)
			)
				throw new Error("Auto Learn semantic charge has no identity");
			if (entry.data.reportId !== undefined) {
				if (typeof entry.data.reportId !== "string" || !entry.data.reportId)
					throw new Error("Invalid Auto Learn charge identity");
				const key = `${entry.customType}\0${entry.data.reportId}`;
				const previous = reports.get(key);
				if (previous && !isDeepStrictEqual(previous, usage))
					throw new Error("Conflicting Auto Learn charge receipts");
				reports.set(key, usage);
			}
		} else if (entry.usage !== undefined) throw new Error("Unrecognized Auto Learn charge row");
		// Only charge-bearing fields are consumed by the shared aggregator; those were validated above.
		entries.push(entry as unknown as SessionEntry);
	}
	const usage = validateProviderUsage(
		aggregateCumulativeUsageFromSessionEntries(entries),
		"Auto Learn cumulative usage",
	);
	return { usage, sourceFile, sourceDigest: createHash("sha256").update(text).digest("hex") };
}
