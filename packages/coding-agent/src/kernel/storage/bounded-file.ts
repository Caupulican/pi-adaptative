import {
	type BigIntStats,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	opendirSync,
	openSync,
	readSync,
	type Stats,
} from "node:fs";
import { type FileHandle, lstat as lstatAsync, open as openAsync } from "node:fs/promises";
import { isMissingFileError } from "./atomic-file.ts";

const READ_CHUNK_BYTES = 64 * 1024;
const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

/** Cooperative cancellation at each bounded I/O step; an in-flight OS read settles before returning. */
export interface BoundedReadOptions {
	readonly signal?: AbortSignal;
	readonly deadlineAt?: number;
}

/** Expected inability to complete a bounded read; never evidence that stored content is corrupt. */
export class BoundedReadError extends Error {
	readonly reason: "deadline" | "limit" | "not_regular";
	constructor(message: string, reason: "deadline" | "limit" | "not_regular") {
		super(message);
		this.name = "BoundedReadError";
		this.reason = reason;
	}
}

export function assertBoundedReadActive(options?: BoundedReadOptions): void {
	options?.signal?.throwIfAborted();
	if (options?.deadlineAt !== undefined && (!Number.isFinite(options.deadlineAt) || Date.now() >= options.deadlineAt))
		throw new BoundedReadError("Bounded read deadline expired.", "deadline");
}

/** The source changed during an optimistic read; retry against a later settled revision. */
export class FileSnapshotChangedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FileSnapshotChangedError";
	}
}

function validateByteLimit(maxBytes: number): void {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
		throw new TypeError("Bounded file reads require a non-negative safe-integer byte limit.");
	}
}

/** Compare the filesystem identity and mutation-sensitive metadata captured around a bounded read. */
export function sameFileVersion(left: Stats | BigIntStats, right: Stats | BigIntStats): boolean {
	const sameMutationTimes =
		"mtimeNs" in left && "mtimeNs" in right
			? left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
			: left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
	return left.dev === right.dev && left.ino === right.ino && left.size === right.size && sameMutationTimes;
}

function assertRegularFile(version: Stats, label: string): void {
	if (!version.isFile() || version.isSymbolicLink()) {
		throw new BoundedReadError(`${label} is not a regular file.`, "not_regular");
	}
}

function assertOpenedPathVersion(pathVersion: Stats, openedVersion: Stats, label: string): void {
	assertRegularFile(openedVersion, label);
	if (!sameFileVersion(pathVersion, openedVersion)) {
		throw new FileSnapshotChangedError(`${label} changed while it was being opened.`);
	}
}

function assertStableReadVersion(
	pathBefore: Stats,
	openedBefore: Stats,
	openedAfter: Stats,
	pathAfter: Stats,
	label: string,
): void {
	if (!sameFileVersion(openedBefore, openedAfter) || !sameFileVersion(pathBefore, pathAfter)) {
		throw new FileSnapshotChangedError(`${label} changed while it was being read.`);
	}
}

/** Safe regular-file acquisition, including a replacement between lstat and open; callers own read consistency. */
export function withRegularFileDescriptorSync<T>(
	filePath: string,
	label: string,
	read: (fileDescriptor: number, openedVersion: Stats) => T,
	options?: BoundedReadOptions,
): T {
	assertBoundedReadActive(options);
	const pathBefore = lstatSync(filePath);
	// Opening a FIFO can wait forever before fstat is reached. Reject non-files before acquisition.
	assertRegularFile(pathBefore, label);
	const fileDescriptor = openSync(filePath, READ_FLAGS);
	try {
		const openedBefore = fstatSync(fileDescriptor);
		assertOpenedPathVersion(pathBefore, openedBefore, label);
		assertBoundedReadActive(options);
		return read(fileDescriptor, openedBefore);
	} finally {
		closeSync(fileDescriptor);
	}
}

export function withStableFileDescriptorSync<T>(
	filePath: string,
	label: string,
	read: (fileDescriptor: number, openedVersion: Stats) => T,
	options?: BoundedReadOptions,
): T {
	return withRegularFileDescriptorSync(
		filePath,
		label,
		(fileDescriptor, openedBefore) => {
			const result = read(fileDescriptor, openedBefore);
			assertBoundedReadActive(options);
			assertStableReadVersion(openedBefore, openedBefore, fstatSync(fileDescriptor), lstatSync(filePath), label);
			return result;
		},
		options,
	);
}

/** One byte-bound/overflow policy for both synchronous and asynchronous descriptor adapters. */
function* boundedFileChunks(
	maxBytes: number,
): Generator<{ buffer: Buffer; position: number }, Buffer | undefined, number> {
	validateByteLimit(maxBytes);
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	while (totalBytes < maxBytes) {
		const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes - totalBytes));
		const bytesRead = yield { buffer: chunk, position: totalBytes };
		if (bytesRead === 0) return Buffer.concat(chunks, totalBytes);
		chunks.push(chunk.subarray(0, bytesRead));
		totalBytes += bytesRead;
	}
	if ((yield { buffer: Buffer.allocUnsafe(1), position: totalBytes }) > 0) return undefined;
	return Buffer.concat(chunks, totalBytes);
}

async function readFileHandleBounded(
	fileHandle: FileHandle,
	maxBytes: number,
	options?: BoundedReadOptions,
): Promise<Buffer | undefined> {
	const chunks = boundedFileChunks(maxBytes);
	let next = chunks.next();
	while (!next.done) {
		assertBoundedReadActive(options);
		const { buffer, position } = next.value;
		const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, position);
		assertBoundedReadActive(options);
		next = chunks.next(bytesRead);
	}
	return next.value;
}

/** Read at most `maxBytes`, then probe one byte so a growing file cannot escape the bound. */
export function readFileDescriptorBoundedSync(
	fileDescriptor: number,
	maxBytes: number,
	options?: BoundedReadOptions,
): Buffer | undefined {
	const chunks = boundedFileChunks(maxBytes);
	let next = chunks.next();
	while (!next.done) {
		assertBoundedReadActive(options);
		const buffer = next.value.buffer;
		next = chunks.next(readSync(fileDescriptor, buffer, 0, buffer.length, null));
	}
	assertBoundedReadActive(options);
	return next.value;
}

/** Bounded, version-stable text read for small durable state files. */
export function readBoundedFileSync(
	filePath: string,
	maxBytes: number,
	label: string,
	options?: BoundedReadOptions,
): Buffer {
	validateByteLimit(maxBytes);
	return withStableFileDescriptorSync(
		filePath,
		label,
		(fileDescriptor, before) => {
			if (before.size > maxBytes) throw new BoundedReadError(`${label} exceeds its byte limit.`, "limit");
			const content = readFileDescriptorBoundedSync(fileDescriptor, maxBytes, options);
			if (!content) throw new BoundedReadError(`${label} exceeds its byte limit.`, "limit");
			if (content.byteLength !== before.size) {
				throw new FileSnapshotChangedError(`${label} changed while it was being read.`);
			}
			return content;
		},
		options,
	);
}

export function readBoundedTextFileSync(
	filePath: string,
	maxBytes: number,
	label: string,
	options?: BoundedReadOptions,
): string {
	return readBoundedFileSync(filePath, maxBytes, label, options).toString("utf-8");
}

/** Only absence at initial lookup is empty; unavailable paths and interrupted reads remain errors. */
export function readOptionalBoundedTextFileSync(filePath: string, maxBytes: number, label: string): string | undefined {
	validateByteLimit(maxBytes);
	try {
		lstatSync(filePath);
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		throw error;
	}
	return readBoundedTextFileSync(filePath, maxBytes, label);
}

export interface BoundedFilePrefix {
	content: Buffer;
	truncated: boolean;
}

/** Read one stable bounded slice from the beginning or end of a regular file. */
function readFileSliceSync(filePath: string, maxBytes: number, label: string, tail: boolean): BoundedFilePrefix {
	validateByteLimit(maxBytes);
	return withStableFileDescriptorSync(filePath, label, (fileDescriptor, before) => {
		if (!Number.isSafeInteger(before.size) || before.size < 0)
			throw new BoundedReadError(`${label} has an invalid size.`, "limit");
		const expectedBytes = Math.min(before.size, maxBytes);
		const position = tail ? before.size - expectedBytes : 0;
		const content = Buffer.allocUnsafe(expectedBytes);
		let totalBytes = 0;
		while (totalBytes < expectedBytes) {
			const bytesRead = readSync(
				fileDescriptor,
				content,
				totalBytes,
				expectedBytes - totalBytes,
				position + totalBytes,
			);
			if (bytesRead === 0) break;
			totalBytes += bytesRead;
		}
		if (totalBytes !== expectedBytes) {
			throw new FileSnapshotChangedError(`${label} changed while it was being read.`);
		}
		return { content, truncated: before.size > maxBytes };
	});
}

/** Read one stable file prefix without allocating or reading beyond `maxBytes`. */
export function readFilePrefixSync(filePath: string, maxBytes: number, label: string): BoundedFilePrefix {
	return readFileSliceSync(filePath, maxBytes, label, false);
}

/** Read one stable file tail without allocating or reading beyond `maxBytes`. */
export function readFileTailSync(filePath: string, maxBytes: number, label: string): BoundedFilePrefix {
	return readFileSliceSync(filePath, maxBytes, label, true);
}

/** Count text lines with constant memory and reject a file that changes during the scan. */
export function countFileLinesSync(filePath: string, label: string): number {
	return withStableFileDescriptorSync(filePath, label, (fileDescriptor, before) => {
		const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
		let bytesReadTotal = 0;
		let lineCount = 1;
		while (true) {
			const bytesRead = readSync(fileDescriptor, chunk, 0, chunk.length, null);
			if (bytesRead === 0) break;
			bytesReadTotal += bytesRead;
			for (let index = 0; index < bytesRead; index++) {
				if (chunk[index] === 0x0a) lineCount++;
			}
			if (!Number.isSafeInteger(bytesReadTotal) || !Number.isSafeInteger(lineCount)) {
				throw new Error(`${label} exceeds safe counting bounds.`);
			}
		}
		if (bytesReadTotal !== before.size) {
			throw new FileSnapshotChangedError(`${label} changed while it was being read.`);
		}
		return lineCount;
	});
}

/**
 * Enumerate a managed directory incrementally. Unlike `readdirSync`, this never allocates an
 * unbounded entry array before the caller can reject a corrupt or hostile directory.
 */
export function readBoundedDirectoryNamesSync(directoryPath: string, maxEntries: number, label: string): string[] {
	if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
		throw new TypeError("Bounded directory reads require a positive safe-integer entry limit.");
	}
	const directory = opendirSync(directoryPath);
	try {
		const names: string[] = [];
		for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
			if (names.length === maxEntries) throw new Error(`${label} exceeds its entry limit.`);
			names.push(entry.name);
		}
		return names;
	} finally {
		directory.closeSync();
	}
}

/** Async counterpart of {@link readBoundedTextFileSync}. */
export function readBoundedFile(
	filePath: string,
	maxBytes: number,
	label: string,
	options?: BoundedReadOptions,
): Promise<Buffer> {
	return readFileSnapshot(filePath, maxBytes, label, "current-path", options);
}

/**
 * Read one immutable publication through its descriptor. Its owner publishes by atomic rename;
 * another publication may replace the pathname while this coherent, bounded snapshot is read.
 */
export function readBoundedPublishedFile(
	filePath: string,
	maxBytes: number,
	label: string,
	options?: BoundedReadOptions,
): Promise<Buffer> {
	return readFileSnapshot(filePath, maxBytes, label, "published-descriptor", options);
}

async function readFileSnapshot(
	filePath: string,
	maxBytes: number,
	label: string,
	consistency: "current-path" | "published-descriptor",
	options?: BoundedReadOptions,
): Promise<Buffer> {
	validateByteLimit(maxBytes);
	assertBoundedReadActive(options);
	const pathBefore = await lstatAsync(filePath);
	assertBoundedReadActive(options);
	// Keep portable path admission: Windows does not implement O_NOFOLLOW.
	// Immutable publication permits replacement by another regular file, not a symlink.
	assertRegularFile(pathBefore, label);
	const fileHandle = await openAsync(filePath, READ_FLAGS);
	try {
		assertBoundedReadActive(options);
		const before = await fileHandle.stat();
		if (consistency === "current-path") assertOpenedPathVersion(pathBefore, before, label);
		else assertRegularFile(before, label);
		if (before.size > maxBytes) throw new BoundedReadError(`${label} exceeds its byte limit.`, "limit");
		const content = await readFileHandleBounded(fileHandle, maxBytes, options);
		if (!content) throw new BoundedReadError(`${label} exceeds its byte limit.`, "limit");
		const after = await fileHandle.stat();
		const pathAfter = await lstatAsync(filePath);
		if (consistency === "current-path") {
			assertStableReadVersion(pathBefore, before, after, pathAfter, label);
		} else {
			assertRegularFile(pathAfter, label);
			if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
				// Unlinking an old publication may change ctime; it cannot change the captured bytes.
				throw new FileSnapshotChangedError(`${label} changed while it was being read.`);
			}
		}
		assertBoundedReadActive(options);
		if (content.byteLength !== before.size) {
			throw new FileSnapshotChangedError(`${label} changed while it was being read.`);
		}
		return content;
	} finally {
		await fileHandle.close();
	}
}

export async function readBoundedTextFile(
	filePath: string,
	maxBytes: number,
	label: string,
	options?: BoundedReadOptions,
): Promise<string> {
	return (await readBoundedFile(filePath, maxBytes, label, options)).toString("utf-8");
}
