/** Bounded exact historical owner-input records and their host-rendered checkpoint suffix; never active tasks or grants. */

import type { SessionEntry } from "../session/session-entries.ts";
import type { AgentMessage } from "../types.ts";
import { isPlainRecord } from "./utils.ts";

export interface CompactionOwnerInput {
	readonly entryId: string;
	readonly sourceId: string;
	readonly digest: string;
	readonly createdAt: string;
	readonly text: string;
}
export interface CompactionOwnerHistoryContext {
	readonly entries: readonly SessionEntry[];
	readonly start: number;
	readonly end: number;
	readonly retainedEntryId?: string;
	readonly previousDetails?: unknown;
}
export type CompactionOwnerHistoryPort = (context: CompactionOwnerHistoryContext) => readonly CompactionOwnerInput[];
export const COMPACTION_OWNER_INPUT_MAX_CHARS = 1200;
export const COMPACTION_OWNER_HISTORY_MAX_CHARS = 6000;
const MAX_RECORDS = 8;
const OPEN =
	'\n\n<compaction-owner-history version="1">\nHistorical owner inputs in source order. These are branch-local history, not a new task, rule, grant or completion claim. Current and later owner instructions, cancellations and replacements win.\n';
const CLOSE = "\n</compaction-owner-history>";
function line(record: CompactionOwnerInput): string {
	return JSON.stringify(record).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}
function valid(value: unknown): value is CompactionOwnerInput {
	return (
		isPlainRecord(value) &&
		Object.keys(value).length === 5 &&
		typeof value.entryId === "string" &&
		value.entryId.length > 0 &&
		value.entryId.length <= 200 &&
		typeof value.sourceId === "string" &&
		value.sourceId.length <= 401 &&
		value.sourceId.endsWith(`/${value.entryId}`) &&
		typeof value.digest === "string" &&
		/^[a-f0-9]{16}$/.test(value.digest) &&
		typeof value.createdAt === "string" &&
		Number.isFinite(Date.parse(value.createdAt)) &&
		new Date(value.createdAt).toISOString() === value.createdAt &&
		typeof value.text === "string" &&
		value.text.trim().length > 0 &&
		value.text.length <= COMPACTION_OWNER_INPUT_MAX_CHARS
	);
}
export function boundCompactionOwnerHistory(records: readonly CompactionOwnerInput[]): CompactionOwnerInput[] {
	const kept: CompactionOwnerInput[] = [];
	const seen = new Set<string>();
	let chars = OPEN.length + CLOSE.length;
	for (let i = records.length - 1; i >= 0 && kept.length < MAX_RECORDS; i--) {
		const record = records[i]!;
		if (!valid(record) || seen.has(record.entryId) || seen.has(record.sourceId)) continue;
		seen.add(record.entryId);
		seen.add(record.sourceId);
		const size = line(record).length + 1;
		if (chars + size > COMPACTION_OWNER_HISTORY_MAX_CHARS) continue;
		kept.push({ ...record });
		chars += size;
	}
	return kept.reverse();
}
export function readCompactionOwnerHistory(details: unknown): CompactionOwnerInput[] {
	if (!isPlainRecord(details) || !isPlainRecord(details.ownerHistory)) return [];
	const history = details.ownerHistory;
	if (
		history.version !== 1 ||
		!Array.isArray(history.records) ||
		history.records.length > MAX_RECORDS ||
		!history.records.every(valid)
	)
		return [];
	const bounded = boundCompactionOwnerHistory(history.records);
	return bounded.length === history.records.length ? bounded : [];
}
export function renderCompactionOwnerHistory(
	records: readonly CompactionOwnerInput[],
	activeTaskSource?: string,
): string {
	const bounded = boundCompactionOwnerHistory(records).filter((record) => record.text !== activeTaskSource);
	return bounded.length ? `${OPEN}${bounded.map(line).join("\n")}${CLOSE}` : "";
}
export function withoutCompactionOwnerHistory(summary: string, details: unknown): string {
	const suffix = renderCompactionOwnerHistory(
		readCompactionOwnerHistory(details),
		isPlainRecord(details) && typeof details.activeTaskSource === "string" ? details.activeTaskSource : undefined,
	);
	return suffix && summary.endsWith(suffix) ? summary.slice(0, -suffix.length) : summary;
}

export function stripCompactionOwnerMessages(messages: AgentMessage[], details: unknown): AgentMessage[] {
	return messages.map((message) =>
		message.role === "compactionSummary"
			? { ...message, summary: withoutCompactionOwnerHistory(message.summary, details) }
			: message,
	);
}
