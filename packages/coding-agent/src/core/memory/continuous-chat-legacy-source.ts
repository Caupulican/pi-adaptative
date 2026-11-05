import type { Stats } from "node:fs";
import { type FileHandle, open, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import {
	MAX_SESSION_EVIDENCE_ENTRIES,
	MAX_SESSION_EVIDENCE_ID_CHARS,
	SessionEntryEvidenceIndex,
	sessionEvidenceParentId,
} from "../../kernel/session/session-entry-evidence-index.ts";
import { MAX_SESSION_LINE_CHARS } from "../../kernel/session/session-entry-limits.ts";
import { readSessionHeaderFromDescriptor, type SessionHeader } from "../../kernel/session/session-header.ts";
import { MAX_SESSION_HEADER_BYTES } from "../../kernel/session/session-identity.ts";
import { sameFileVersion } from "../../kernel/storage/bounded-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import {
	ContinuousChatLegacyContentError,
	type ContinuousChatLegacyEntrySource,
} from "./continuous-chat-legacy-import.ts";

export type LegacySourceIdentity =
	| { kind: "header"; header: SessionHeader }
	| { kind: "headerless"; revision: Stats; sessionId: string };

const READ_BYTES = 64 * 1024;
const MAX_LOOKUP_ENTRIES = 64;
const MAX_LOOKUP_BYTES = 4 * 1024 * 1024;

interface EntryLocation {
	readonly offset: number;
	readonly length: number;
	readonly parentId: string | null | undefined;
}

/** Strict whole-record parsing differs from SessionManager's permissive candidate-ID cold-payload index. */
function parseEntry(path: string, line: string, lineNumber: number): SessionEntry {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new ContinuousChatLegacyContentError(path, `${basename(path)}:${lineNumber} is not JSON`);
	}
	if (
		!isPlainRecord(value) ||
		typeof value.type !== "string" ||
		typeof value.id !== "string" ||
		value.type === "session" ||
		value.id.length === 0 ||
		value.id.length > MAX_SESSION_EVIDENCE_ID_CHARS
	)
		throw new ContinuousChatLegacyContentError(path, `${basename(path)}:${lineNumber} is not one session entry`);
	return value as unknown as SessionEntry;
}

/** Byte offsets, CR/LF/CRLF support and one bounded line; no session bodies survive a scan. */
async function* readLines(file: FileHandle, size: number, signal?: AbortSignal) {
	const buffer = Buffer.allocUnsafe(READ_BYTES);
	let offset = 0;
	let start = 0;
	let length = 0;
	let parts: Buffer[] = [];
	let afterCr = false;
	const finish = () => {
		const bytes = Buffer.concat(parts, length);
		const line = { offset: start, length, text: bytes.toString("utf8") };
		if (line.text.length > MAX_SESSION_LINE_CHARS) throw new Error("Legacy session line exceeds the read limit.");
		parts = [];
		length = 0;
		return line;
	};
	while (offset < size) {
		signal?.throwIfAborted();
		const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
		if (bytesRead === 0) throw new Error("Legacy session ended before its pinned size.");
		let segmentStart = 0;
		for (let index = 0; index < bytesRead; index++) {
			const byte = buffer[index];
			if (afterCr) {
				afterCr = false;
				if (byte === 10) {
					segmentStart = index + 1;
					start = offset + index + 1;
					continue;
				}
			}
			if (byte !== 10 && byte !== 13) continue;
			const piece = buffer.subarray(segmentStart, index);
			parts.push(Buffer.from(piece));
			length += piece.length;
			yield finish();
			segmentStart = index + 1;
			start = offset + index + 1;
			afterCr = byte === 13;
		}
		const tail = buffer.subarray(segmentStart, bytesRead);
		if (tail.length > 0) parts.push(Buffer.from(tail));
		length += tail.length;
		if (length > MAX_SESSION_LINE_CHARS * 4) throw new Error("Legacy session line exceeds the read limit.");
		offset += bytesRead;
	}
	if (length > 0) yield finish();
}

/** Opens one revision for iteration and exact-ID lookup. No lookup reopens the path or rescans the source. */
export async function openLegacySessionEntries(
	path: string,
	identity: LegacySourceIdentity,
	signal?: AbortSignal,
): Promise<ContinuousChatLegacyEntrySource> {
	signal?.throwIfAborted();
	const before = await stat(path);
	if (!before.isFile()) throw new Error(`Legacy session ${path} is not a regular file.`);
	const file = await open(path, "r");
	let closed = false;
	try {
		const revision = await file.stat();
		if (!sameFileVersion(before, revision)) throw new Error(`Legacy session ${path} changed while opening it.`);
		if (identity.kind === "headerless") {
			if (!sameFileVersion(identity.revision, revision))
				throw new Error(`Headerless legacy session ${path} changed after validation.`);
		} else {
			const read = readSessionHeaderFromDescriptor(file.fd, MAX_SESSION_HEADER_BYTES);
			const expected = identity.header;
			if (
				!read.ok ||
				read.header.id !== expected.id ||
				read.header.timestamp !== expected.timestamp ||
				read.header.cwd !== expected.cwd ||
				read.header.version !== expected.version ||
				read.header.parentSession !== expected.parentSession
			)
				throw new Error(`Legacy session ${path} no longer matches its listed header.`);
		}
		const assertCurrent = async (readSignal?: AbortSignal) => {
			signal?.throwIfAborted();
			readSignal?.throwIfAborted();
			if (closed) throw new Error("Legacy session source is closed.");
			const current = await file.stat();
			const currentPath = await stat(path);
			signal?.throwIfAborted();
			readSignal?.throwIfAborted();
			if (!sameFileVersion(revision, current) || !sameFileVersion(revision, currentPath))
				throw new Error(`Legacy session ${path} changed during its read; retry the import.`);
		};
		const locations = new Map<string, EntryLocation>();
		const evidenceIndex = new SessionEntryEvidenceIndex();
		const records = async function* () {
			await assertCurrent();
			let header = identity.kind === "header";
			let lineNumber = 0;
			for await (const line of readLines(file, revision.size, signal)) {
				lineNumber++;
				if (!line.text.trim()) continue;
				if (header) {
					header = false;
					continue;
				}
				let entry: SessionEntry;
				try {
					entry = parseEntry(path, line.text, lineNumber);
				} catch (error) {
					await assertCurrent();
					throw error;
				}
				yield { entry, offset: line.offset, length: line.length };
			}
			await assertCurrent();
		};
		for await (const { entry, offset, length } of records()) {
			if (locations.has(entry.id)) {
				await assertCurrent();
				throw new ContinuousChatLegacyContentError(path, `duplicate entry id ${entry.id}`);
			}
			if (locations.size >= MAX_SESSION_EVIDENCE_ENTRIES)
				throw new Error("Legacy session entry index exceeds its limit.");
			evidenceIndex.add(entry);
			locations.set(entry.id, { offset, length, parentId: sessionEvidenceParentId(entry) });
		}
		await assertCurrent();
		return {
			sessionId: identity.kind === "header" ? identity.header.id : identity.sessionId,
			entries: {
				async *[Symbol.asyncIterator]() {
					for await (const record of records()) yield record.entry;
				},
			},
			readEntries: async (ids, readSignal) => {
				if (ids.length > MAX_LOOKUP_ENTRIES) throw new Error("Legacy source lookup exceeds its entry limit.");
				await assertCurrent(readSignal);
				const found = new Map<string, SessionEntry>();
				let total = 0;
				for (const id of new Set(ids)) {
					const location = locations.get(id);
					if (!location) continue;
					total += location.length;
					if (total > MAX_LOOKUP_BYTES) throw new Error("Legacy source lookup exceeds its byte limit.");
					const bytes = Buffer.allocUnsafe(location.length);
					let read = 0;
					while (read < bytes.length) {
						signal?.throwIfAborted();
						readSignal?.throwIfAborted();
						const result = await file.read(
							bytes,
							read,
							Math.min(READ_BYTES, bytes.length - read),
							location.offset + read,
						);
						if (!result.bytesRead) throw new Error("Legacy source entry is incomplete.");
						read += result.bytesRead;
					}
					const entry = parseEntry(path, bytes.toString("utf8"), 0);
					if (entry.id !== id || sessionEvidenceParentId(entry) !== location.parentId)
						throw new Error("Legacy source entry identity changed.");
					found.set(id, entry);
				}
				await assertCurrent(readSignal);
				return found;
			},
			isAncestor: async (ancestorId, descendantId, readSignal) => {
				await assertCurrent(readSignal);
				return evidenceIndex.isAncestor(ancestorId, descendantId);
			},
			findAncestors: async (descendantId, query, readSignal) => {
				await assertCurrent(readSignal);
				return evidenceIndex.findAncestors(descendantId, query);
			},
			close: async () => {
				if (!closed) {
					closed = true;
					await file.close();
				}
			},
		};
	} catch (error) {
		await file.close();
		throw error;
	}
}

export async function* streamLegacySessionEntries(path: string, identity: LegacySourceIdentity, signal?: AbortSignal) {
	const source = await openLegacySessionEntries(path, identity, signal);
	try {
		yield* source.entries;
	} finally {
		await source.close();
	}
}
