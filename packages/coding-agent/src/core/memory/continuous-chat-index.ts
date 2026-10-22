/**
 * Durable storage primitives and fixed-width indexes for the permanent chat. An index entry is written only after the
 * bytes it names are fsynced, and readers trust an entry only below the published root count. Nothing here keeps a
 * resident catalog: each lookup is a positioned read or a hash probe.
 */

import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isMissingFileError } from "../util/atomic-file.ts";

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

async function withDurableStagingFile(filePath: string, write: (handle: FileHandle) => Promise<void>): Promise<void> {
	await ensureDurableDirectory(dirname(filePath));
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	let handle: FileHandle | undefined;
	let renamed = false;
	try {
		handle = await open(temporaryPath, "wx", 0o600);
		await write(handle);
		await handle.sync();
		await handle.close();
		handle = undefined;
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
		const { bytesRead } = await handle.read(buffer, 0, bytes, position);
		return bytesRead === bytes ? buffer : undefined;
	} finally {
		await handle.close();
	}
}

/** Writes one fixed-width record at `position`, creating the file when it is new. Fsyncs before returning. */
export async function writeRecordAt(filePath: string, position: number, record: Buffer): Promise<void> {
	if (await missingFile(filePath)) await appendDurably(filePath, "");
	const handle = await open(filePath, "r+");
	try {
		await handle.write(record, 0, record.length, position);
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
	let capacity = KEYS_MIN_CAPACITY;
	while (count * 2 >= capacity) capacity *= 2;
	return capacity;
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
	const { bytesRead } = await handle.read(slot, 0, KEYS_SLOT_BYTES, slotPosition(index));
	if (bytesRead !== KEYS_SLOT_BYTES) {
		throw new ContinuousChatCorruptError(filePath, `Key index slot ${index} is truncated`);
	}
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
			let index = entry.digest % header.capacity;
			for (let probes = 0; ; probes++) {
				if (probes === header.capacity) throw new ContinuousChatCorruptError(filePath, "Key index is full");
				const slot = await readKeysSlot(handle, filePath, index);
				if (slot.readUIntLE(6, 6) === 0) break;
				index = (index + 1) % header.capacity;
			}
			const slot = Buffer.alloc(KEYS_SLOT_BYTES);
			writeSlot(slot, 0, entry);
			await handle.write(slot, 0, KEYS_SLOT_BYTES, slotPosition(index));
		}
		const count = Buffer.alloc(6);
		count.writeUIntLE(header.count + entries.length, 0, 6);
		await handle.write(count, 0, 6, 6);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** Every occupied slot of a keys table. Used only when the table grows or is rebuilt. */
export async function readKeysEntries(filePath: string): Promise<ContinuousChatKeyEntry[]> {
	const image = await readFile(filePath);
	const entries: ContinuousChatKeyEntry[] = [];
	for (let position = KEYS_HEADER_BYTES; position + KEYS_SLOT_BYTES <= image.length; position += KEYS_SLOT_BYTES) {
		const idPlusOne = image.readUIntLE(position + 6, 6);
		if (idPlusOne !== 0) entries.push({ digest: image.readUIntLE(position, 6), id: idPlusOne - 1 });
	}
	return entries;
}

/** A complete keys table holding `entries`, sized for their count, with every entry placed by linear probing. */
export function buildKeysImage(entries: readonly ContinuousChatKeyEntry[]): Buffer {
	const capacity = keysCapacityFor(entries.length);
	const image = Buffer.alloc(KEYS_HEADER_BYTES + capacity * KEYS_SLOT_BYTES);
	image.writeUIntLE(capacity, 0, 6);
	image.writeUIntLE(entries.length, 6, 6);
	for (const entry of entries) {
		let index = entry.digest % capacity;
		while (image.readUIntLE(slotPosition(index) + 6, 6) !== 0) index = (index + 1) % capacity;
		writeSlot(image, slotPosition(index), entry);
	}
	return image;
}
