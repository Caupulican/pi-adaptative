/**
 * Durable storage primitives and fixed-width indexes for the permanent chat. An index entry is written only after the
 * bytes it names are fsynced, and readers trust an entry only below the published root count. Nothing here keeps a
 * resident catalog: each lookup is a positioned read or a hash probe.
 */

import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, lstat, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { sameFileVersion } from "../../kernel/storage/bounded-file.ts";
import { readFileRangeInto, writeFileRangeFrom } from "../../kernel/storage/positioned-file.ts";
import { isMissingFileError } from "../util/atomic-file.ts";
import { checkpointContinuousChatRecovery } from "./continuous-chat-recovery.ts";

/** Message entry: day number (4 bytes), line offset (6), line length (4), sourceKey digest (6). */
export const CONTINUOUS_CHAT_MESSAGE_INDEX_ENTRY_BYTES = 20;
/** Node slot: day number (4 bytes), line offset (6), line length (4). A zero length marks a node never written. */
export const CONTINUOUS_CHAT_NODE_INDEX_ENTRY_BYTES = 16;
/** Most messages an index can address: message ids and id-plus-one values both fit six bytes. */
export const CONTINUOUS_CHAT_MAX_MESSAGES = 2 ** 48 - 1;

/** Keys table header: capacity, count (6 bytes each). Slot: sourceKey digest, message id plus one (6 bytes each). */
const KEYS_HEADER_BYTES = 12;
const KEYS_SLOT_BYTES = 12;
const KEYS_MIN_CAPACITY = 1024;
const DIGEST_HEX_DIGITS = 12;

export class ContinuousChatCorruptError extends Error {
	readonly filePath: string;

	constructor(filePath: string, message: string) {
		super(`${message}: ${filePath}`);
		this.name = "ContinuousChatCorruptError";
		this.filePath = filePath;
	}
}

/** The parsed JSON of a state file, or undefined when it was never written. Malformed JSON is corruption. */
export async function readJsonFile(filePath: string, label: string): Promise<unknown> {
	let content: string;
	try {
		content = await readFile(filePath, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		throw error;
	}
	try {
		return JSON.parse(content);
	} catch {
		throw new ContinuousChatCorruptError(filePath, `Malformed ${label}`);
	}
}

/** Where one JSON line lives: its segment day (YYYYMMDD), its byte offset, and its length without the newline. */
export interface ContinuousChatSegmentLocation {
	dayNo: number;
	offset: number;
	length: number;
}

export interface ContinuousChatMessageLocation extends ContinuousChatSegmentLocation {
	digest: number;
}

export interface ContinuousChatKeyEntry {
	digest: number;
	id: number;
}

export interface ContinuousChatKeysHeader {
	capacity: number;
	count: number;
}

export function continuousChatDayNumber(day: string): number {
	return Number(day.replaceAll("-", ""));
}

export function continuousChatDayName(dayNo: number): string {
	const digits = String(dayNo).padStart(8, "0");
	return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

/** A 48-bit digest of a sourceKey. Equal digests can come from different keys, so a hit is always verified. */
export function continuousChatSourceKeyDigest(sourceKey: string): number {
	const hex = createHash("sha256").update(sourceKey).digest("hex").slice(0, DIGEST_HEX_DIGITS);
	return Number.parseInt(hex, 16);
}

export function encodeMessageIndexEntry(location: ContinuousChatMessageLocation): Buffer {
	const buffer = Buffer.alloc(CONTINUOUS_CHAT_MESSAGE_INDEX_ENTRY_BYTES);
	buffer.writeUInt32LE(location.dayNo, 0);
	buffer.writeUIntLE(location.offset, 4, 6);
	buffer.writeUInt32LE(location.length, 10);
	buffer.writeUIntLE(location.digest, 14, 6);
	return buffer;
}

export function decodeMessageIndexEntry(buffer: Buffer): ContinuousChatMessageLocation {
	return {
		dayNo: buffer.readUInt32LE(0),
		offset: buffer.readUIntLE(4, 6),
		length: buffer.readUInt32LE(10),
		digest: buffer.readUIntLE(14, 6),
	};
}

export function encodeNodeIndexEntry(location: ContinuousChatSegmentLocation): Buffer {
	const buffer = Buffer.alloc(CONTINUOUS_CHAT_NODE_INDEX_ENTRY_BYTES);
	buffer.writeUInt32LE(location.dayNo, 0);
	buffer.writeUIntLE(location.offset, 4, 6);
	buffer.writeUInt32LE(location.length, 10);
	return buffer;
}

/** The node's line location, or undefined for a slot that was never written. */
export function decodeNodeIndexEntry(buffer: Buffer): ContinuousChatSegmentLocation | undefined {
	const length = buffer.readUInt32LE(10);
	if (length === 0) return undefined;
	return { dayNo: buffer.readUInt32LE(0), offset: buffer.readUIntLE(4, 6), length };
}

export async function fsyncDirectory(directory: string): Promise<void> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(directory, "r");
		await handle.sync();
	} catch (error) {
		if (process.platform !== "win32") throw error;
	} finally {
		await handle?.close();
	}
}

/** Creates `directory` and any missing parents. Each parent whose entry for a new directory changed is fsynced. */
export async function ensureDurableDirectory(directory: string): Promise<void> {
	const firstCreated = await mkdir(directory, { recursive: true });
	if (firstCreated === undefined) return;
	for (let current = directory; ; current = dirname(current)) {
		await fsyncDirectory(dirname(current));
		if (current === firstCreated || dirname(current) === current) return;
	}
}

async function missingFile(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return false;
	} catch (error) {
		if (isMissingFileError(error)) return true;
		throw error;
	}
}

async function withDurableStagingFile(
	filePath: string,
	write: (handle: FileHandle) => Promise<void>,
	options?: { readWrite?: boolean; beforePublish?: () => Promise<void> },
): Promise<void> {
	await ensureDurableDirectory(dirname(filePath));
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	let handle: FileHandle | undefined;
	let renamed = false;
	try {
		handle = await open(temporaryPath, options?.readWrite ? "wx+" : "wx", 0o600);
		await write(handle);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await options?.beforePublish?.();
		await rename(temporaryPath, filePath);
		renamed = true;
		await fsyncDirectory(dirname(filePath));
	} finally {
		await handle?.close();
		if (!renamed) {
			try {
				await unlink(temporaryPath);
			} catch {
				// The staging path was never created or was already consumed by rename.
			}
		}
	}
}

/** Writes `content` to a staging file, fsyncs it, renames it over `filePath`, and fsyncs the directory. */
export async function writeDurableAtomic(filePath: string, content: string | Buffer): Promise<void> {
	await withDurableStagingFile(filePath, (handle) =>
		handle.writeFile(content, typeof content === "string" ? "utf8" : undefined),
	);
}

const NODE_INDEX_CHUNK_ENTRIES = 4096;

/**
 * Writes fixed-width node index entries atomically in bounded 4096-entry (64 KiB) chunks.
 * When highest < 0, writes an empty (0-byte) file.
 */
export async function writeNodeIndexAtomic(
	filePath: string,
	highest: number,
	entries: ReadonlyMap<number, { location: ContinuousChatSegmentLocation }>,
): Promise<void> {
	await withDurableStagingFile(filePath, async (handle) => {
		if (highest < 0) return;
		for (let startOrdinal = 0; startOrdinal <= highest; startOrdinal += NODE_INDEX_CHUNK_ENTRIES) {
			const count = Math.min(NODE_INDEX_CHUNK_ENTRIES, highest + 1 - startOrdinal);
			const chunk = Buffer.alloc(count * CONTINUOUS_CHAT_NODE_INDEX_ENTRY_BYTES);
			for (let i = 0; i < count; i++) {
				const entry = entries.get(startOrdinal + i);
				if (entry !== undefined) {
					encodeNodeIndexEntry(entry.location).copy(chunk, i * CONTINUOUS_CHAT_NODE_INDEX_ENTRY_BYTES);
				}
			}
			await handle.writeFile(chunk);
		}
	});
}

/**
 * Appends `content` to a file and fsyncs it. A file created by this call also fsyncs its directory entry. Returns the
 * byte offset the content starts at.
 */
export async function appendDurably(filePath: string, content: string | Buffer): Promise<number> {
	const directory = dirname(filePath);
	await ensureDurableDirectory(directory);
	const created = await missingFile(filePath);
	const handle = await open(filePath, "a", 0o600);
	try {
		const { size } = await handle.stat();
		await handle.writeFile(content, typeof content === "string" ? "utf8" : undefined);
		await handle.sync();
		if (created) await fsyncDirectory(directory);
		return size;
	} finally {
		await handle.close();
	}
}

/** The bytes at `position`, or undefined when the file is missing or ends before `bytes` are available. */
export async function readRecordAt(filePath: string, position: number, bytes: number): Promise<Buffer | undefined> {
	const handle = await open(filePath, "r").catch((error: unknown) => {
		if (isMissingFileError(error)) return undefined;
		throw error;
	});
	if (handle === undefined) return undefined;
	try {
		const buffer = Buffer.alloc(bytes);
		const complete = await readFileRangeInto(handle, buffer, position, filePath, undefined, true);
		return complete ? buffer : undefined;
	} finally {
		await handle.close();
	}
}

/** Writes one fixed-width record at `position`, creating the file when it is new. Fsyncs before returning. */
export async function writeRecordAt(filePath: string, position: number, record: Buffer): Promise<void> {
	if (await missingFile(filePath)) await appendDurably(filePath, "");
	const handle = await open(filePath, "r+");
	try {
		await writeFileRangeFrom(handle, record, position, filePath);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function slotPosition(index: number): number {
	return KEYS_HEADER_BYTES + index * KEYS_SLOT_BYTES;
}

function writeSlot(buffer: Buffer, position: number, entry: ContinuousChatKeyEntry): void {
	buffer.writeUIntLE(entry.digest, position, 6);
	buffer.writeUIntLE(entry.id + 1, position + 6, 6);
}

/** The smallest capacity that keeps the table at or below half full, never below the minimum. */
function keysCapacityFor(count: number): number {
	if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("Invalid continuous-chat key count.");
	let capacity = KEYS_MIN_CAPACITY;
	while (count * 2 >= capacity) capacity *= 2;
	if (capacity > CONTINUOUS_CHAT_MAX_MESSAGES)
		throw new RangeError("Continuous-chat key capacity exceeds its format.");
	return capacity;
}

async function emptyKeysSlot(
	digest: number,
	capacity: number,
	read: (index: number) => Promise<Buffer>,
	filePath: string,
	signal?: AbortSignal,
): Promise<number> {
	let index = digest % capacity;
	for (let probes = 0; probes < capacity; probes++) {
		if (signal !== undefined) await checkpointContinuousChatRecovery(signal, probes + 1);
		const slot = await read(index);
		if (slot.readUIntLE(6, 6) === 0) return index;
		index = (index + 1) % capacity;
	}
	throw new ContinuousChatCorruptError(filePath, "Key index is full");
}

export async function readKeysHeader(filePath: string): Promise<ContinuousChatKeysHeader | undefined> {
	const header = await readRecordAt(filePath, 0, KEYS_HEADER_BYTES);
	if (header === undefined) return undefined;
	const capacity = header.readUIntLE(0, 6);
	const count = header.readUIntLE(6, 6);
	if (capacity < KEYS_MIN_CAPACITY || count * 2 > capacity) {
		throw new ContinuousChatCorruptError(filePath, "Invalid continuous-chat key index header");
	}
	return { capacity, count };
}

/** Whether `added` more entries keep the table at or below half full. */
export function keysHasRoom(header: ContinuousChatKeysHeader, added: number): boolean {
	return (header.count + added) * 2 <= header.capacity;
}

async function readKeysSlot(handle: FileHandle, filePath: string, index: number): Promise<Buffer> {
	const slot = Buffer.alloc(KEYS_SLOT_BYTES);
	await readFileRangeInto(handle, slot, slotPosition(index), filePath);
	return slot;
}

/** Ids of every entry whose digest equals `digest`. Probing runs from the home slot to the first empty slot. */
export async function findKeysIds(
	filePath: string,
	header: ContinuousChatKeysHeader,
	digest: number,
): Promise<number[]> {
	const handle = await open(filePath, "r");
	try {
		const ids: number[] = [];
		let index = digest % header.capacity;
		for (let probes = 0; probes < header.capacity; probes++) {
			const slot = await readKeysSlot(handle, filePath, index);
			const idPlusOne = slot.readUIntLE(6, 6);
			if (idPlusOne === 0) break;
			if (slot.readUIntLE(0, 6) === digest) ids.push(idPlusOne - 1);
			index = (index + 1) % header.capacity;
		}
		return ids;
	} finally {
		await handle.close();
	}
}

/** Places entries in a table that has room for them (see `keysHasRoom`) and rewrites its count. */
export async function insertKeysEntries(
	filePath: string,
	header: ContinuousChatKeysHeader,
	entries: readonly ContinuousChatKeyEntry[],
): Promise<void> {
	const handle = await open(filePath, "r+");
	try {
		for (const entry of entries) {
			const index = await emptyKeysSlot(
				entry.digest,
				header.capacity,
				(slot) => readKeysSlot(handle, filePath, slot),
				filePath,
			);
			const slot = Buffer.alloc(KEYS_SLOT_BYTES);
			writeSlot(slot, 0, entry);
			await writeFileRangeFrom(handle, slot, slotPosition(index), filePath);
		}
		const count = Buffer.alloc(6);
		count.writeUIntLE(header.count + entries.length, 0, 6);
		await writeFileRangeFrom(handle, count, 6, filePath);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

const KEYS_PAGE_SLOTS = 4096;
const KEYS_PAGE_BYTES = KEYS_PAGE_SLOTS * KEYS_SLOT_BYTES;
const KEYS_CACHED_PAGES = Math.floor((8 * 1024 * 1024) / KEYS_PAGE_BYTES);
const MESSAGE_READ_ENTRIES = 4096;

interface KeysPage {
	bytes: Buffer;
	dirty: boolean;
}

/** Bounded write-back cache for an unpublished, zero-initialized keys table. */
class KeysPageCache {
	private readonly handle: FileHandle;
	private readonly capacity: number;
	private readonly path: string;
	private readonly pages = new Map<number, KeysPage>();

	constructor(handle: FileHandle, capacity: number, path: string) {
		this.handle = handle;
		this.capacity = capacity;
		this.path = path;
	}

	async read(index: number): Promise<Buffer> {
		const page = await this.page(index);
		const offset = (index % KEYS_PAGE_SLOTS) * KEYS_SLOT_BYTES;
		return page.bytes.subarray(offset, offset + KEYS_SLOT_BYTES);
	}

	async write(index: number, entry: ContinuousChatKeyEntry): Promise<void> {
		const page = await this.page(index);
		writeSlot(page.bytes, (index % KEYS_PAGE_SLOTS) * KEYS_SLOT_BYTES, entry);
		page.dirty = true;
	}

	async flush(): Promise<void> {
		for (const [ordinal, page] of this.pages) await this.flushPage(ordinal, page);
	}

	private async flushPage(ordinal: number, page: KeysPage): Promise<void> {
		if (!page.dirty) return;
		await writeFileRangeFrom(this.handle, page.bytes, KEYS_HEADER_BYTES + ordinal * KEYS_PAGE_BYTES, this.path);
		page.dirty = false;
	}

	private async page(index: number): Promise<KeysPage> {
		const ordinal = Math.floor(index / KEYS_PAGE_SLOTS);
		const cached = this.pages.get(ordinal);
		if (cached !== undefined) {
			this.pages.delete(ordinal);
			this.pages.set(ordinal, cached);
			return cached;
		}
		if (this.pages.size >= KEYS_CACHED_PAGES) {
			const oldest = this.pages.entries().next().value;
			if (oldest !== undefined) {
				await this.flushPage(oldest[0], oldest[1]);
				this.pages.delete(oldest[0]);
			}
		}
		const slots = Math.min(KEYS_PAGE_SLOTS, this.capacity - ordinal * KEYS_PAGE_SLOTS);
		const page: KeysPage = { bytes: Buffer.alloc(slots * KEYS_SLOT_BYTES), dirty: false };
		await readFileRangeInto(this.handle, page.bytes, KEYS_HEADER_BYTES + ordinal * KEYS_PAGE_BYTES, this.path);
		this.pages.set(ordinal, page);
		return page;
	}
}

/** Rebuild the keys table from exactly the authoritative message-index prefix, with bounded resident memory. */
export async function rebuildKeysIndex(
	filePath: string,
	messageIndexPath: string,
	count: number,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	const capacity = keysCapacityFor(count);
	const expectedBytes = count * CONTINUOUS_CHAT_MESSAGE_INDEX_ENTRY_BYTES;
	const revision = await lstat(messageIndexPath).catch((error: unknown) => {
		if (count === 0 && isMissingFileError(error)) return undefined;
		throw error;
	});
	if (revision !== undefined && (!revision.isFile() || revision.size !== expectedBytes)) {
		throw new ContinuousChatCorruptError(messageIndexPath, "Message index does not match the key rebuild count");
	}
	const source = revision === undefined ? undefined : await open(messageIndexPath, "r");
	try {
		const validateSource = async (): Promise<void> => {
			signal?.throwIfAborted();
			const current = await lstat(messageIndexPath).catch((error: unknown) => {
				if (revision === undefined && isMissingFileError(error)) return undefined;
				throw error;
			});
			if (revision === undefined) {
				if (current !== undefined) throw new Error("Message index appeared during key rebuild.");
			} else if (
				source === undefined ||
				current === undefined ||
				!sameFileVersion(revision, current) ||
				!sameFileVersion(revision, await source.stat())
			) {
				throw new Error("Message index changed during key rebuild.");
			}
			signal?.throwIfAborted();
		};
		await validateSource();
		await withDurableStagingFile(
			filePath,
			async (handle) => {
				await handle.truncate(KEYS_HEADER_BYTES + capacity * KEYS_SLOT_BYTES);
				const header = Buffer.alloc(KEYS_HEADER_BYTES);
				header.writeUIntLE(capacity, 0, 6);
				header.writeUIntLE(count, 6, 6);
				await writeFileRangeFrom(handle, header, 0, filePath);
				const pages = new KeysPageCache(handle, capacity, filePath);
				const chunk = Buffer.alloc(MESSAGE_READ_ENTRIES * CONTINUOUS_CHAT_MESSAGE_INDEX_ENTRY_BYTES);
				for (let first = 0; first < count; first += MESSAGE_READ_ENTRIES) {
					if (source === undefined) throw new Error("Message index is missing during key rebuild.");
					const rows = Math.min(MESSAGE_READ_ENTRIES, count - first);
					await readFileRangeInto(
						source,
						chunk.subarray(0, rows * CONTINUOUS_CHAT_MESSAGE_INDEX_ENTRY_BYTES),
						first * CONTINUOUS_CHAT_MESSAGE_INDEX_ENTRY_BYTES,
						messageIndexPath,
						signal,
					);
					for (let row = 0; row < rows; row++) {
						await checkpointContinuousChatRecovery(signal, first + row);
						const entry = {
							digest: chunk.readUIntLE(row * CONTINUOUS_CHAT_MESSAGE_INDEX_ENTRY_BYTES + 14, 6),
							id: first + row,
						};
						const slot = await emptyKeysSlot(
							entry.digest,
							capacity,
							(index) => pages.read(index),
							filePath,
							signal,
						);
						await pages.write(slot, entry);
					}
				}
				await pages.flush();
			},
			{ readWrite: true, beforePublish: validateSource },
		);
	} finally {
		await source?.close();
	}
}
