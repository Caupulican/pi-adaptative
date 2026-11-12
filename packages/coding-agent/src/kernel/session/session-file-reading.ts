/** Session transcript file reading: entry parsing, bounded strict snapshot recovery, streamed and offset-indexed loading, and header reads with parent lineage checks. */
import { closeSync, existsSync, fstatSync, openSync, readSync, type Stats, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { StreamingLineDecoder } from "@caupulican/pi-ai/streaming-lines";
import { isMissingFileError } from "../storage/atomic-file.ts";
import { FileSnapshotChangedError, sameFileVersion } from "../storage/bounded-file.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { validateLoadedLifecycleEntries } from "./lifecycle-ledger.ts";
import type { SessionEntry } from "./session-entries.ts";
import { MAX_SESSION_LINE_CHARS } from "./session-entry-limits.ts";
import { readSessionHeaderFromDescriptor, readSessionHeaderResult, type SessionHeader } from "./session-header.ts";
import { assertValidSessionId, MAX_SESSION_HEADER_BYTES } from "./session-identity.ts";
import type { FileEntry } from "./session-manager-types.ts";

const MAX_SESSION_LINEAGE_DEPTH = 64;

/** Decode captured session bytes without reopening the path. Recovery callers require every row. */
export function parseSessionEntries(
	content: string,
	options?: { requireComplete?: boolean; allowFragment?: boolean },
): FileEntry[] {
	const entries: FileEntry[] = [];
	if (options?.requireComplete && content.length > 0 && !content.endsWith("\n"))
		throw new Error("Session history ends with an incomplete JSONL record.");
	const lines = content.trim().split("\n");

	for (const line of lines) {
		if (!line.trim()) continue;
		if (options?.requireComplete) {
			if (line.length > MAX_SESSION_LINE_CHARS) throw new Error("Session record exceeds its size limit.");
			const entry = parseSessionEntryLine(line, true);
			if (entry) entries.push(entry);
			continue;
		}
		try {
			const entry = JSON.parse(line) as FileEntry;
			entries.push(entry);
		} catch {
			// Skip malformed lines
		}
	}
	if (options?.requireComplete) {
		const header = entries[0];
		if (header?.type !== "session") {
			if (!options.allowFragment) throw new Error("Session snapshot has no valid header.");
		} else assertValidSessionId(header.id);
		validateLoadedLifecycleEntries(entries);
	}

	return entries;
}

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;

export function parseSessionEntryLine(line: string, requireComplete = false): FileEntry | null {
	if (!line.trim()) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		if (requireComplete) throw new Error("Session history contains a malformed JSONL record.", { cause: error });
		// Ordinary history viewing may retain its readable records.
		return null;
	}
	if (requireComplete && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)))
		throw new Error("Session history contains a non-object JSONL record.");
	return parsed as FileEntry;
}

export interface SessionEntryFileLocation {
	offset: number;
	length: number;
}

export function loadEntriesFromFileInternal(
	filePath: string,
	options?: { maxLineChars?: number; requireComplete?: boolean },
	onEntry?: (entry: FileEntry, offset: number | undefined, length: number | undefined) => void,
): { entries: FileEntry[]; indexedBytes: number; unterminatedTail?: boolean; revision?: Stats } {
	const resolvedFilePath = normalizePath(filePath);
	let revision: Stats;
	try {
		revision = statSync(resolvedFilePath);
	} catch (error) {
		if (isMissingFileError(error)) return { entries: [], indexedBytes: 0 };
		throw error;
	}
	if (!revision.isFile()) throw new Error("Session history is not a regular file.");

	// Bound every row before parsing. Ordinary viewing can skip an unusable row;
	// canonical recovery must report it rather than infer absence from a partial view.
	const maxLineChars = options?.maxLineChars ?? MAX_SESSION_LINE_CHARS;

	const entries: FileEntry[] = [];
	const appendLine = (line: string, offset?: number, length?: number): void => {
		const entry = parseSessionEntryLine(line, options?.requireComplete);
		if (!entry) return;
		onEntry?.(entry, offset, length);
		entries.push(entry);
	};
	const fd = openSync(resolvedFilePath, "r");
	let indexedBytes = 0;
	let lineOffset = 0;
	let lineLength = 0;
	let unterminatedTail = false;
	try {
		if (!sameFileVersion(revision, fstatSync(fd)))
			throw new FileSnapshotChangedError("Session file changed while opening it.");
		// The preliminary path check can observe a different file. Validate the first
		// physical record on this descriptor before the permissive row parser runs.
		if (revision.size > 0 && !readSessionHeaderFromDescriptor(fd, MAX_SESSION_HEADER_BYTES).ok) {
			return { entries: [], indexedBytes: revision.size, revision };
		}
		const decoder = new StringDecoder("utf8");
		const strictDecoder = options?.requireComplete
			? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
			: undefined;
		const lines = new StreamingLineDecoder(maxLineChars, {
			overflow: options?.requireComplete ? "throw" : "skip",
			lineEndings: "lf",
		});
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);

		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			unterminatedTail = buffer[bytesRead - 1] !== 0x0a;
			const chunkOffset = indexedBytes;
			indexedBytes += bytesRead;
			const offsets: number[] = [];
			const lengths: number[] = [];
			let segmentStart = 0;
			while (segmentStart < bytesRead) {
				const newlineIndex = buffer.indexOf(0x0a, segmentStart);
				if (newlineIndex === -1 || newlineIndex >= bytesRead) break;
				lineLength += newlineIndex - segmentStart;
				offsets.push(lineOffset);
				lengths.push(lineLength);
				lineOffset = chunkOffset + newlineIndex + 1;
				lineLength = 0;
				segmentStart = newlineIndex + 1;
			}
			lineLength += bytesRead - segmentStart;
			const bytes = buffer.subarray(0, bytesRead);
			const decodedLines = lines.push(
				strictDecoder ? strictDecoder.decode(bytes, { stream: true }) : decoder.write(bytes),
			);
			const locationsMatch = decodedLines.length === offsets.length;
			for (let index = 0; index < decodedLines.length; index++) {
				appendLine(
					decodedLines[index],
					locationsMatch ? offsets[index] : undefined,
					locationsMatch ? lengths[index] : undefined,
				);
			}
		}

		for (const line of lines.push(strictDecoder ? strictDecoder.decode() : decoder.end())) appendLine(line);
		const finalLine = lines.finish();
		if (finalLine !== undefined) appendLine(finalLine, lineOffset, lineLength);
		if (!sameFileVersion(revision, fstatSync(fd)) || !sameFileVersion(revision, statSync(resolvedFilePath)))
			throw new FileSnapshotChangedError("Session file changed while reading it; reopen it before retrying.");
		if (options?.requireComplete && unterminatedTail)
			throw new Error("Session history ends with an incomplete JSONL record; its write remains unresolved.");
	} finally {
		closeSync(fd);
	}

	// Validate session header
	if (entries.length === 0) return { entries, indexedBytes, unterminatedTail, revision };
	const header = entries[0];
	if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
		return { entries: [], indexedBytes, unterminatedTail, revision };
	}

	return { entries, indexedBytes, unterminatedTail, revision };
}

/** Exported for testing */
export function loadEntriesFromFile(filePath: string, options?: { maxLineChars?: number }): FileEntry[] {
	const entries = loadEntriesFromFileInternal(filePath, options).entries;
	validateLoadedLifecycleEntries(entries);
	return entries;
}

/** Read-only streaming visitor; strict mode validates a complete stable snapshot for bounded recovery. */
export interface VisitSessionEntriesOptions {
	/** Recovery mode: every row and the final newline must be valid; malformed rows are not skipped. */
	readonly requireComplete?: boolean;
	/** Optional total-file byte ceiling for a one-off recovery scan. */
	readonly maxBytes?: number;
	/** Optional per-row ceiling for bounded recovery fixtures; production defaults to the session format maximum. */
	readonly maxLineChars?: number;
}

export async function visitSessionEntriesAsync(
	filePath: string,
	selectLine: (line: string) => boolean,
	visit: (entry: SessionEntry) => void,
	options?: VisitSessionEntriesOptions,
): Promise<SessionHeader> {
	const file = await open(filePath, "r");
	try {
		const before = await file.stat();
		if (!before.isFile()) throw new Error("Session history is not a regular file.");
		if (
			options?.maxBytes !== undefined &&
			(!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || before.size > options.maxBytes)
		)
			throw new Error("Session history exceeds its recovery scan bound.");
		if (
			options?.maxLineChars !== undefined &&
			(!Number.isSafeInteger(options.maxLineChars) ||
				options.maxLineChars < 1 ||
				options.maxLineChars > MAX_SESSION_LINE_CHARS)
		)
			throw new TypeError("Session line limit must be within its format bound.");
		const maxLineChars = options?.maxLineChars ?? MAX_SESSION_LINE_CHARS;
		const scanLimit = options?.requireComplete ? before.size : options?.maxBytes;
		if (!sameFileVersion(before, await stat(filePath)))
			throw new FileSnapshotChangedError("Session file changed while opening it.");
		const headerResult = readSessionHeaderFromDescriptor(file.fd, MAX_SESSION_HEADER_BYTES);
		if (!headerResult.ok) throw new Error("Session file header is invalid.");
		const decoder = options?.requireComplete
			? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
			: new StringDecoder("utf8");
		const lines = new StreamingLineDecoder(maxLineChars, {
			overflow: options?.requireComplete ? "throw" : "skip",
			lineEndings: "lf",
		});
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
		let position = 0;
		const consume = (line: string): void => {
			const selected = selectLine(line);
			if (!selected && !options?.requireComplete) return;
			const entry = parseSessionEntryLine(line, options?.requireComplete);
			if (selected && entry && entry.type !== "session") visit(entry);
		};
		for (;;) {
			const remaining = scanLimit === undefined ? buffer.length : scanLimit - position + 1;
			const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, remaining), position);
			if (bytesRead === 0) break;
			if (scanLimit !== undefined && position + bytesRead > scanLimit)
				throw new Error("Session history exceeds its recovery scan bound.");
			position += bytesRead;
			const chunk = buffer.subarray(0, bytesRead);
			for (const line of lines.push(
				decoder instanceof TextDecoder ? decoder.decode(chunk, { stream: true }) : decoder.write(chunk),
			))
				consume(line);
		}
		const decodedTail = decoder instanceof TextDecoder ? decoder.decode() : decoder.end();
		for (const line of lines.push(decodedTail)) consume(line);
		const tail = lines.finish();
		if (tail !== undefined) {
			if (options?.requireComplete) throw new Error("Session history ends with an incomplete JSONL record.");
			consume(tail);
		}
		if (!sameFileVersion(before, await file.stat()) || !sameFileVersion(before, await stat(filePath)))
			throw new FileSnapshotChangedError("Session file changed while reading it; reopen it before retrying.");
		return headerResult.header;
	} finally {
		await file.close();
	}
}

export const ENTRY_ID_PREFIX_BYTES = 64 * 1024;
export const COMPACTED_PAYLOAD_RELEASE_MIN_CHARS = 16 * 1024;

export function indexSessionEntryFileLocations(
	filePath: string,
	startOffset: number,
	locations: Map<string, SessionEntryFileLocation>,
	retainedIds: ReadonlySet<string>,
	limitOffset?: number,
): number {
	const pendingIds = new Set<string>();
	for (const id of retainedIds) {
		if (!locations.has(id)) pendingIds.add(id);
	}
	if (pendingIds.size === 0) return startOffset;
	const fd = openSync(filePath, "r");
	const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
	let position = startOffset;
	let lineOffset = startOffset;
	let lineLength = 0;
	let prefixLength = 0;
	let prefixParts: Buffer[] = [];

	const finishLine = (): boolean => {
		if (prefixLength > 0) {
			const prefix =
				prefixParts.length === 1
					? prefixParts[0].toString("utf8")
					: Buffer.concat(prefixParts, prefixLength).toString("utf8");
			for (const match of prefix.matchAll(/"id"\s*:\s*"([A-Za-z0-9_-]+)"/g)) {
				const id = match[1];
				if (id && pendingIds.delete(id)) {
					locations.set(id, { offset: lineOffset, length: lineLength });
					break;
				}
			}
		}
		lineLength = 0;
		prefixLength = 0;
		prefixParts = [];
		return pendingIds.size === 0;
	};

	try {
		while (true) {
			// A read budget ends the scan at `limitOffset` however far the file has grown: the bytes read are what is bounded.
			const readLength = limitOffset === undefined ? buffer.length : Math.min(buffer.length, limitOffset - position);
			if (readLength <= 0) break;
			const bytesRead = readSync(fd, buffer, 0, readLength, position);
			if (bytesRead === 0) break;
			const chunkOffset = position;
			position += bytesRead;
			let segmentStart = 0;
			while (segmentStart < bytesRead) {
				const newlineIndex = buffer.indexOf(0x0a, segmentStart);
				const segmentEnd = newlineIndex === -1 || newlineIndex >= bytesRead ? bytesRead : newlineIndex;
				const segmentLength = segmentEnd - segmentStart;
				lineLength += segmentLength;
				const prefixRemaining = ENTRY_ID_PREFIX_BYTES - prefixLength;
				if (prefixRemaining > 0 && segmentLength > 0) {
					const retainedLength = Math.min(prefixRemaining, segmentLength);
					prefixParts.push(Buffer.from(buffer.subarray(segmentStart, segmentStart + retainedLength)));
					prefixLength += retainedLength;
				}
				if (newlineIndex === -1 || newlineIndex >= bytesRead) break;
				const nextLineOffset = chunkOffset + newlineIndex + 1;
				if (finishLine()) return nextLineOffset;
				lineOffset = nextLineOffset;
				segmentStart = newlineIndex + 1;
			}
		}
		if (lineLength > 0) finishLine();
		return position;
	} finally {
		closeSync(fd);
	}
}

export function retainedStringChars(value: unknown, stopAfter: number): number {
	const pending: unknown[] = [value];
	const seen = new WeakSet<object>();
	let chars = 0;
	while (pending.length > 0) {
		const item = pending.pop();
		if (typeof item === "string") {
			chars += item.length;
			if (chars >= stopAfter) return chars;
			continue;
		}
		if (!item || typeof item !== "object" || seen.has(item)) continue;
		seen.add(item);
		if (Array.isArray(item)) {
			pending.push(...item);
		} else {
			pending.push(...Object.values(item));
		}
	}
	return chars;
}

/**
 * A session file a manager adopts must begin with a valid session header whose id is a valid session id. The id is later
 * a file name (journal sidecars, owner follow-up files), so it is judged here, before anything adopts it or touches the
 * file. The first JSONL record is authoritative: a later valid header must not launder a malformed prefix. An empty file
 * has no header to judge.
 */
export function assertAdoptableSessionHeader(filePath: string): void {
	if (!existsSync(filePath) || statSync(filePath).size === 0) return;
	const result = readSessionHeaderResult(filePath);
	if (result.ok) return;
	if (result.reason === "invalid_session_id") {
		throw new Error(`Session file header id is not a valid session id: ${filePath}`);
	}
	throw new Error(`Session file does not begin with a valid session header: ${filePath}`);
}

export function readSessionHeader(filePath: string): SessionHeader | null {
	const result = readSessionHeaderResult(filePath);
	return result.ok ? result.header : null;
}

/** Resolve the bounded parent-file chain that authoritatively defines a fork's session lineage. */
export function collectParentSessionIds(parentSession: unknown, relativeToDir: string): Set<string> {
	const sessionIds = new Set<string>();
	const visitedPaths = new Set<string>();
	let nextPath =
		typeof parentSession === "string" && parentSession.length > 0
			? normalizePath(resolve(relativeToDir, parentSession))
			: undefined;
	for (let depth = 0; nextPath && depth < MAX_SESSION_LINEAGE_DEPTH; depth++) {
		if (visitedPaths.has(nextPath)) break;
		visitedPaths.add(nextPath);
		const header = readSessionHeader(nextPath);
		if (!header || header.id.length === 0) break;
		sessionIds.add(header.id);
		nextPath =
			typeof header.parentSession === "string" && header.parentSession.length > 0
				? normalizePath(resolve(dirname(nextPath), header.parentSession))
				: undefined;
	}
	return sessionIds;
}

export function getSessionHeaderCwd(header: SessionHeader): string | undefined {
	const cwd = (header as { cwd?: unknown }).cwd;
	return typeof cwd === "string" ? cwd : undefined;
}

export function sessionCwdMatches(cwd: string | undefined, resolvedCwd: string): boolean {
	return cwd !== undefined && cwd !== "" && resolvePath(cwd) === resolvedCwd;
}
