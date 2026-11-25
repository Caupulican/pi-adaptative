/** Bounded, chronological transcript reads over the session's selected ancestry and canonical file offsets. */
import type { Stats } from "node:fs";
import { type FileHandle, open, stat } from "node:fs/promises";
import { getUserMessageText } from "../messages.ts";
import { sameFileVersion } from "../storage/bounded-file.ts";
import { readFileRangeInto } from "../storage/positioned-file.ts";
import type { AgentMessage } from "../types.ts";
import { estimateJsonLikeBytes } from "./message-retention.ts";
import { sessionHistoryMessage } from "./session-context-builder.ts";
import type { SessionEntry } from "./session-entries.ts";
import { parseSessionEntryLine, type SessionEntryFileLocation } from "./session-file-reading.ts";

import { visitSessionAncestry } from "./session-tree.ts";

const PAGE_RECORDS = 32;
const PAGE_BYTES = 512 * 1024;
const RECORD_BYTES = 96 * 1024;
const ANCESTRY_BATCH = 256;

export interface SessionHistoryPage {
	readonly records: readonly { id: string; message?: AgentMessage; oversized?: true }[];
	readonly older: string | null;
}

export interface SessionHistoryPageSource {
	entry(id: string): SessionEntry | undefined;
	isCold(id: string): boolean;
	location(id: string): SessionEntryFileLocation | undefined;
	file?: string;
	revision?: Stats;
	assertCurrent(): void;
}

export interface SessionHistoryPageOptions {
	readonly signal?: AbortSignal;
	readonly stopBefore?: string;
	readonly positionsOnly?: boolean;
	readonly usersOnly?: boolean;
}

function appendCompatible(before: Stats, after: Stats): boolean {
	return (
		sameFileVersion(before, after) ||
		(before.dev === after.dev && before.ino === after.ino && before.size < after.size)
	);
}

export async function readSessionHistoryPage(
	source: SessionHistoryPageSource,
	start: string | null,
	{ signal, stopBefore, positionsOnly, usersOnly }: SessionHistoryPageOptions = {},
): Promise<SessionHistoryPage> {
	const records: SessionHistoryPage["records"][number][] = [];
	const { file, revision } = source;
	let cursor = start;
	let bytes = 0;
	let visited = 0;
	let handle: FileHandle | undefined;
	const assertCurrent = () => {
		signal?.throwIfAborted();
		source.assertCurrent();
	};

	try {
		while (cursor !== null && cursor !== stopBefore && records.length < PAGE_RECORDS) {
			if (++visited % ANCESTRY_BATCH === 0) await new Promise<void>((resolve) => setImmediate(resolve));
			assertCurrent();
			const entry = source.entry(cursor);
			if (!entry) throw new Error(`Missing transcript entry ${cursor}`);
			const id = cursor;
			if (usersOnly && (entry.type !== "message" || entry.message.role !== "user")) {
				cursor = entry.parentId;
				continue;
			}
			if (
				entry.type !== "message" &&
				!(entry.type === "custom_message" && entry.display) &&
				!(entry.type === "branch_summary" && entry.summary) &&
				entry.type !== "compaction"
			) {
				cursor = entry.parentId;
				continue;
			}
			const cold = source.isCold(id);
			const location = cold ? source.location(id) : undefined;
			if (cold && !location) throw new Error(`Missing transcript position for ${id}`);
			const size = location?.length ?? estimateJsonLikeBytes(entry, RECORD_BYTES, true).bytes;
			if (size > RECORD_BYTES) {
				records.push({ id, oversized: true });
			} else {
				if (bytes + size > PAGE_BYTES) break;
				if (positionsOnly) {
					records.push({ id });
					bytes += size;
					cursor = entry.parentId;
					continue;
				}
				let stored: SessionEntry;
				if (location) {
					if (!file || !revision) throw new Error(`Missing transcript file for ${id}`);
					if (!handle) {
						handle = await open(file, "r");
						if (!appendCompatible(revision, await handle.stat())) throw new Error("Transcript file changed");
					}
					const buffer = Buffer.allocUnsafe(location.length);
					await readFileRangeInto(handle, buffer, location.offset, file, signal);
					const parsed = parseSessionEntryLine(buffer.toString("utf8"), true);
					if (parsed?.type !== "message" || parsed.id !== id)
						throw new Error(`Invalid transcript position for ${id}`);
					stored = parsed;
				} else {
					// The retention owner can replace content/output on a hot message after this page was read.
					stored = entry.type === "message" ? { ...entry, message: { ...entry.message } } : entry;
				}
				const message = sessionHistoryMessage(stored);
				records.push({ id, message });
				bytes += size;
			}
			cursor = entry.parentId;
		}
		if (
			handle &&
			file &&
			revision &&
			(!appendCompatible(revision, await handle.stat()) || !appendCompatible(revision, await stat(file)))
		) {
			throw new Error("Transcript file changed");
		}
	} finally {
		if (handle) await handle.close();
	}
	assertCurrent();
	return { records: records.reverse(), older: cursor };
}

/** The synchronous prompt recall path for callers outside the Workbench. */
export function recentSessionUserInputHistory(
	leaf: SessionEntry | undefined,
	byId: ReadonlyMap<string, SessionEntry>,
	limit: number,
): Array<{ entryId: string; text: string }> {
	const maxEntries = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 100;
	if (maxEntries === 0) return [];
	const history: Array<{ entryId: string; text: string }> = [];
	visitSessionAncestry(leaf, byId, (entry) => {
		if (entry.type === "message" && entry.message.role === "user") {
			const text = getUserMessageText(entry.message).trim();
			if (text) history.push({ entryId: entry.id, text });
		}
		if (history.length >= maxEntries) return false;
	});
	return history.reverse();
}
