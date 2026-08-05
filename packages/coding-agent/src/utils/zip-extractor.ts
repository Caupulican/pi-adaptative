import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { inflateRaw } from "node:zlib";

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const MAX_ZIP_COMMENT_BYTES = 65_535;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 4_096;
const MAX_PATH_BYTES = 4_096;
const ZIP64_16_BIT_SENTINEL = 0xffff;
const ZIP64_32_BIT_SENTINEL = 0xffffffff;

export type ZipExtractionErrorCode =
	| "invalid_archive"
	| "limit_exceeded"
	| "unsafe_entry"
	| "unsupported_archive"
	| "write_failed";

export class ZipExtractionError extends Error {
	readonly code: ZipExtractionErrorCode;

	constructor(code: ZipExtractionErrorCode, message: string) {
		super(message);
		this.name = "ZipExtractionError";
		this.code = code;
	}
}

interface ZipEntry {
	segments: string[];
	directory: boolean;
	flags: number;
	method: number;
	checksum: number;
	compressedBytes: number;
	uncompressedBytes: number;
	localHeaderOffset: number;
}

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index++) {
	let value = index;
	for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
	CRC32_TABLE[index] = value >>> 0;
}

function crc32(value: Buffer): number {
	let checksum = 0xffffffff;
	for (const byte of value) checksum = (checksum >>> 8) ^ (CRC32_TABLE[(checksum ^ byte) & 0xff] ?? 0);
	return (checksum ^ 0xffffffff) >>> 0;
}

function invalidArchive(message: string): never {
	throw new ZipExtractionError("invalid_archive", message);
}

function assertBufferRange(buffer: Buffer, offset: number, bytes: number): void {
	if (
		!Number.isSafeInteger(offset) ||
		!Number.isSafeInteger(bytes) ||
		offset < 0 ||
		bytes < 0 ||
		offset + bytes > buffer.length
	) {
		invalidArchive("ZIP structure extends beyond the archive boundary.");
	}
}

function findEndOfCentralDirectory(archive: Buffer): number {
	const minimumOffset = Math.max(0, archive.length - END_OF_CENTRAL_DIRECTORY_BYTES - MAX_ZIP_COMMENT_BYTES);
	for (let offset = archive.length - END_OF_CENTRAL_DIRECTORY_BYTES; offset >= minimumOffset; offset--) {
		if (archive.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
		const commentBytes = archive.readUInt16LE(offset + 20);
		if (offset + END_OF_CENTRAL_DIRECTORY_BYTES + commentBytes === archive.length) return offset;
	}
	return invalidArchive("ZIP end-of-central-directory record is missing.");
}

function normalizeEntryPath(rawName: string): { segments: string[]; directory: boolean } {
	if (!rawName || rawName.includes("\0") || rawName.includes("\ufffd")) {
		throw new ZipExtractionError("unsafe_entry", "ZIP contains an invalid entry path.");
	}
	const portableName = rawName.replaceAll("\\", "/");
	if (portableName.startsWith("/") || isAbsolute(portableName) || /^[A-Za-z]:/u.test(portableName)) {
		throw new ZipExtractionError("unsafe_entry", "ZIP contains an absolute entry path.");
	}
	const directory = portableName.endsWith("/");
	const segments = portableName.split("/");
	if (directory) segments.pop();
	if (
		segments.length === 0 ||
		segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.includes(":"))
	) {
		throw new ZipExtractionError("unsafe_entry", "ZIP contains a traversal or ambiguous entry path.");
	}
	return { segments, directory };
}

function parseEntries(archive: Buffer): ZipEntry[] {
	const endOffset = findEndOfCentralDirectory(archive);
	const diskNumber = archive.readUInt16LE(endOffset + 4);
	const centralDiskNumber = archive.readUInt16LE(endOffset + 6);
	const entriesOnDisk = archive.readUInt16LE(endOffset + 8);
	const entryCount = archive.readUInt16LE(endOffset + 10);
	const centralBytes = archive.readUInt32LE(endOffset + 12);
	const centralOffset = archive.readUInt32LE(endOffset + 16);
	if (
		diskNumber !== 0 ||
		centralDiskNumber !== 0 ||
		entriesOnDisk !== entryCount ||
		entryCount === ZIP64_16_BIT_SENTINEL ||
		centralBytes === ZIP64_32_BIT_SENTINEL ||
		centralOffset === ZIP64_32_BIT_SENTINEL
	) {
		throw new ZipExtractionError("unsupported_archive", "Multi-disk and ZIP64 archives are unsupported.");
	}
	if (entryCount > MAX_ENTRIES) {
		throw new ZipExtractionError("limit_exceeded", `ZIP contains more than ${MAX_ENTRIES} entries.`);
	}
	assertBufferRange(archive, centralOffset, centralBytes);
	if (centralOffset + centralBytes > endOffset) invalidArchive("ZIP central directory overlaps its footer.");

	const entries: ZipEntry[] = [];
	const seenPaths = new Set<string>();
	let totalBytes = 0;
	let cursor = centralOffset;
	for (let index = 0; index < entryCount; index++) {
		assertBufferRange(archive, cursor, 46);
		if (archive.readUInt32LE(cursor) !== CENTRAL_FILE_SIGNATURE) {
			invalidArchive("ZIP central directory entry is malformed.");
		}
		const versionMadeBy = archive.readUInt16LE(cursor + 4);
		const flags = archive.readUInt16LE(cursor + 8);
		const method = archive.readUInt16LE(cursor + 10);
		const checksum = archive.readUInt32LE(cursor + 16);
		const compressedBytes = archive.readUInt32LE(cursor + 20);
		const uncompressedBytes = archive.readUInt32LE(cursor + 24);
		const nameBytes = archive.readUInt16LE(cursor + 28);
		const extraBytes = archive.readUInt16LE(cursor + 30);
		const commentBytes = archive.readUInt16LE(cursor + 32);
		const startingDisk = archive.readUInt16LE(cursor + 34);
		const externalAttributes = archive.readUInt32LE(cursor + 38);
		const localHeaderOffset = archive.readUInt32LE(cursor + 42);
		const variableBytes = nameBytes + extraBytes + commentBytes;
		assertBufferRange(archive, cursor + 46, variableBytes);
		if (
			startingDisk !== 0 ||
			compressedBytes === ZIP64_32_BIT_SENTINEL ||
			uncompressedBytes === ZIP64_32_BIT_SENTINEL ||
			localHeaderOffset === ZIP64_32_BIT_SENTINEL
		) {
			throw new ZipExtractionError("unsupported_archive", "ZIP64 entries are unsupported.");
		}
		if ((flags & 0x0001) !== 0) {
			throw new ZipExtractionError("unsupported_archive", "Encrypted ZIP entries are unsupported.");
		}
		if (method !== 0 && method !== 8) {
			throw new ZipExtractionError("unsupported_archive", "ZIP compression method is unsupported.");
		}
		if (nameBytes === 0 || nameBytes > MAX_PATH_BYTES) {
			throw new ZipExtractionError("limit_exceeded", "ZIP entry path exceeds its bound.");
		}
		const rawName = archive.subarray(cursor + 46, cursor + 46 + nameBytes).toString("utf8");
		const normalized = normalizeEntryPath(rawName);
		const hostSystem = versionMadeBy >>> 8;
		const unixMode = hostSystem === 3 ? (externalAttributes >>> 16) & 0xffff : 0;
		const unixType = unixMode & 0xf000;
		const directory = normalized.directory || unixType === 0x4000 || (externalAttributes & 0x10) !== 0;
		if (unixType !== 0 && unixType !== 0x4000 && unixType !== 0x8000) {
			throw new ZipExtractionError("unsafe_entry", "ZIP contains a non-file entry.");
		}
		if (uncompressedBytes > MAX_ENTRY_BYTES) {
			throw new ZipExtractionError("limit_exceeded", "ZIP entry exceeds its uncompressed-size bound.");
		}
		totalBytes += uncompressedBytes;
		if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
			throw new ZipExtractionError("limit_exceeded", "ZIP exceeds its total uncompressed-size bound.");
		}
		const identity = normalized.segments.join("/");
		const collisionKey = process.platform === "win32" ? identity.toLowerCase() : identity;
		if (seenPaths.has(collisionKey)) {
			throw new ZipExtractionError("unsafe_entry", "ZIP contains duplicate entry paths.");
		}
		seenPaths.add(collisionKey);
		entries.push({
			segments: normalized.segments,
			directory,
			flags,
			method,
			checksum,
			compressedBytes,
			uncompressedBytes,
			localHeaderOffset,
		});
		cursor += 46 + variableBytes;
	}
	if (cursor > centralOffset + centralBytes) invalidArchive("ZIP central directory exceeds its declared size.");
	return entries;
}

async function inflateEntry(compressed: Buffer, expectedBytes: number): Promise<Buffer> {
	return new Promise((resolvePromise, reject) => {
		inflateRaw(compressed, { maxOutputLength: Math.max(1, expectedBytes) }, (error, output) => {
			if (error) {
				reject(new ZipExtractionError("invalid_archive", "ZIP deflate stream is invalid."));
				return;
			}
			resolvePromise(output);
		});
	});
}

async function ensureDirectory(root: string, segments: readonly string[]): Promise<void> {
	let current = root;
	for (const segment of segments) {
		current = join(current, segment);
		try {
			const metadata = await lstat(current);
			if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
				throw new ZipExtractionError("unsafe_entry", "ZIP extraction path crosses a non-directory.");
			}
		} catch (error) {
			if (error instanceof ZipExtractionError) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await mkdir(current, { mode: 0o700 });
		}
	}
}

function resolveEntryTarget(destination: string, segments: readonly string[]): string {
	const target = resolve(destination, ...segments);
	const fromDestination = relative(destination, target);
	if (fromDestination === ".." || fromDestination.startsWith(`..${sep}`) || isAbsolute(fromDestination)) {
		throw new ZipExtractionError("unsafe_entry", "ZIP entry escapes the extraction destination.");
	}
	return target;
}

async function extractEntry(archive: Buffer, destination: string, entry: ZipEntry): Promise<void> {
	if (entry.directory) {
		await ensureDirectory(destination, entry.segments);
		return;
	}
	await ensureDirectory(destination, entry.segments.slice(0, -1));
	const target = resolveEntryTarget(destination, entry.segments);
	try {
		await lstat(target);
		throw new ZipExtractionError("unsafe_entry", "ZIP extraction refuses to overwrite an existing path.");
	} catch (error) {
		if (error instanceof ZipExtractionError) throw error;
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	assertBufferRange(archive, entry.localHeaderOffset, 30);
	if (archive.readUInt32LE(entry.localHeaderOffset) !== LOCAL_FILE_SIGNATURE) {
		invalidArchive("ZIP local file header is malformed.");
	}
	const localFlags = archive.readUInt16LE(entry.localHeaderOffset + 6);
	const localMethod = archive.readUInt16LE(entry.localHeaderOffset + 8);
	const localNameBytes = archive.readUInt16LE(entry.localHeaderOffset + 26);
	const localExtraBytes = archive.readUInt16LE(entry.localHeaderOffset + 28);
	if (localFlags !== entry.flags || localMethod !== entry.method) {
		invalidArchive("ZIP local and central headers disagree.");
	}
	const dataOffset = entry.localHeaderOffset + 30 + localNameBytes + localExtraBytes;
	assertBufferRange(archive, dataOffset, entry.compressedBytes);
	const compressed = archive.subarray(dataOffset, dataOffset + entry.compressedBytes);
	const output =
		entry.method === 0 ? Buffer.from(compressed) : await inflateEntry(compressed, entry.uncompressedBytes);
	if (output.length !== entry.uncompressedBytes || crc32(output) !== entry.checksum) {
		invalidArchive("ZIP entry size or checksum is invalid.");
	}
	await writeFile(target, output, { flag: "wx", mode: 0o600 });
}

/** Extract a bounded ordinary ZIP with no dependency on platform archive utilities. */
export async function extractZipFile(archivePath: string, destination: string): Promise<void> {
	try {
		const metadata = await lstat(archivePath);
		if (metadata.isSymbolicLink() || !metadata.isFile()) invalidArchive("ZIP source is not a regular file.");
		if (metadata.size > MAX_ARCHIVE_BYTES) {
			throw new ZipExtractionError("limit_exceeded", "ZIP archive exceeds its 512 MiB input bound.");
		}
		const archive = await readFile(archivePath);
		const entries = parseEntries(archive);
		await mkdir(destination, { recursive: true, mode: 0o700 });
		const destinationMetadata = await lstat(destination);
		if (destinationMetadata.isSymbolicLink() || !destinationMetadata.isDirectory()) {
			throw new ZipExtractionError("unsafe_entry", "ZIP destination is not a regular directory.");
		}
		for (const entry of entries) await extractEntry(archive, destination, entry);
	} catch (error) {
		if (error instanceof ZipExtractionError) throw error;
		throw new ZipExtractionError(
			"write_failed",
			`ZIP extraction failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
