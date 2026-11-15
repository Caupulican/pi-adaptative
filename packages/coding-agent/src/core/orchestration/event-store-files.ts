/**
 * The orchestration event store's file primitives (`event-store.ts`): signed re-reads of its small state files, the
 * cursor's lenient parse, bounded serialization, and the exact-field check its file records share with the carry file
 * beside a snapshot (`snapshot-carry-file.ts`).
 */

import { lstatSync, opendirSync, type Stats } from "node:fs";
import { readBoundedTextFileSync } from "../util/bounded-file.ts";
import { OrchestrationEventStoreError } from "./event-store-errors.ts";

export const MAX_CURSOR_BYTES = 64 * 1024;
/** The widest tail a store may be configured with; one event file is read within the configured tail bound, so within this. */
export const MAX_CONFIGURED_TAIL_BYTES = 16 * 1024 * 1024;

export interface EventCursor {
	version: 1;
	lastOrdinal: number;
	tailBytes?: number;
}

/** What one lstat tells about a small state file; a change in any of it means re-read and re-parse. */
interface FileSignature {
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	ino: number;
}

export interface SignedRead<T> {
	signature: FileSignature;
	value: T;
}

function fileSignature(stats: Stats): FileSignature {
	return { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino };
}

function sameFileSignature(left: FileSignature, right: FileSignature): boolean {
	return (
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs &&
		left.ino === right.ino
	);
}

/**
 * Re-read a small state file only when its signature changed. The bounded, version-stable read
 * behind `parse` costs five system calls; one lstat answers the common case that nothing changed,
 * which on Windows was the difference between a poll and a stall. The store invalidates the cached
 * read after its own writes, so a rewrite that lands inside one timestamp tick is only ever missed
 * for a foreign writer, and only until the next tick. A missing file yields undefined.
 */
export function readIfChanged<T>(
	filePath: string,
	cached: SignedRead<T> | undefined,
	parse: () => T,
): SignedRead<T> | undefined {
	let stats: Stats;
	try {
		stats = lstatSync(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const signature = fileSignature(stats);
	if (cached && sameFileSignature(cached.signature, signature)) return cached;
	return { signature, value: parse() };
}

export function parseCursor(filePath: string): EventCursor | undefined {
	let content: string;
	try {
		content = readBoundedTextFileSync(filePath, MAX_CURSOR_BYTES, "Orchestration cursor");
	} catch (error) {
		throw new OrchestrationEventStoreError(
			`Failed to read orchestration cursor: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		const parsed: unknown = JSON.parse(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const record = parsed as Record<string, unknown>;
		if (record.version !== 1 || !Number.isSafeInteger(record.lastOrdinal) || Number(record.lastOrdinal) < 0) {
			return undefined;
		}
		if (record.tailBytes !== undefined && (!Number.isSafeInteger(record.tailBytes) || Number(record.tailBytes) < 0)) {
			return undefined;
		}
		return {
			version: 1,
			lastOrdinal: Number(record.lastOrdinal),
			...(record.tailBytes !== undefined ? { tailBytes: Number(record.tailBytes) } : {}),
		};
	} catch {
		return undefined;
	}
}

function serialize(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

function serializeCompact(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

export function serializeBounded(
	value: unknown,
	maxBytes: number,
	label: string,
	oversizedMessage = `${label} exceeds its byte limit.`,
): string {
	const serialized = serialize(value);
	if (Buffer.byteLength(serialized, "utf-8") > maxBytes) {
		throw new OrchestrationEventStoreError(oversizedMessage);
	}
	return serialized;
}

export function serializeCompactBounded(value: unknown, maxBytes: number, label: string): string {
	const serialized = serializeCompact(value);
	if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
		throw new OrchestrationEventStoreError(`${label} exceeds its byte limit.`);
	}
	return serialized;
}

export function hasExactFields(record: Record<string, unknown>, fields: readonly string[]): boolean {
	const actualFields = Object.keys(record);
	return actualFields.length === fields.length && fields.every((field) => Object.hasOwn(record, field));
}

/**
 * Visits each entry name of `dir`, read one entry at a time with no entry bound, so a cleanup reaches what is past a
 * reader's bound; `visit` may remove the entry it is given. A missing directory has no entries.
 */
export function forEachDirectoryEntrySync(dir: string, visit: (name: string) => void): void {
	let directory: ReturnType<typeof opendirSync>;
	try {
		directory = opendirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	try {
		for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) visit(entry.name);
	} finally {
		directory.closeSync();
	}
}
