import { closeSync, fstatSync, opendirSync, openSync, readSync, type Stats } from "node:fs";
import { type FileHandle, open as openAsync } from "node:fs/promises";

const READ_CHUNK_BYTES = 64 * 1024;

function validateByteLimit(maxBytes: number): void {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
		throw new TypeError("Bounded file reads require a non-negative safe-integer byte limit.");
	}
}

/** Compare the filesystem identity and mutation-sensitive metadata captured around a bounded read. */
export function sameFileVersion(left: Stats, right: Stats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

async function readFileHandleBounded(fileHandle: FileHandle, maxBytes: number): Promise<Buffer | undefined> {
	validateByteLimit(maxBytes);
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	while (totalBytes < maxBytes) {
		const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes - totalBytes));
		const { bytesRead } = await fileHandle.read(chunk, 0, chunk.length, totalBytes);
		if (bytesRead === 0) return Buffer.concat(chunks, totalBytes);
		chunks.push(chunk.subarray(0, bytesRead));
		totalBytes += bytesRead;
	}
	const overflowProbe = Buffer.allocUnsafe(1);
	if ((await fileHandle.read(overflowProbe, 0, 1, totalBytes)).bytesRead > 0) return undefined;
	return Buffer.concat(chunks, totalBytes);
}

/** Read at most `maxBytes`, then probe one byte so a growing file cannot escape the bound. */
export function readFileDescriptorBoundedSync(fileDescriptor: number, maxBytes: number): Buffer | undefined {
	validateByteLimit(maxBytes);
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	while (totalBytes < maxBytes) {
		const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes - totalBytes));
		const bytesRead = readSync(fileDescriptor, chunk, 0, chunk.length, null);
		if (bytesRead === 0) return Buffer.concat(chunks, totalBytes);
		chunks.push(chunk.subarray(0, bytesRead));
		totalBytes += bytesRead;
	}
	const overflowProbe = Buffer.allocUnsafe(1);
	if (readSync(fileDescriptor, overflowProbe, 0, 1, null) > 0) return undefined;
	return Buffer.concat(chunks, totalBytes);
}

/** Bounded, version-stable text read for small durable state files. */
export function readBoundedTextFileSync(filePath: string, maxBytes: number, label: string): string {
	validateByteLimit(maxBytes);
	const fileDescriptor = openSync(filePath, "r");
	try {
		const before = fstatSync(fileDescriptor);
		if (!before.isFile()) throw new Error(`${label} is not a regular file.`);
		if (before.size > maxBytes) throw new Error(`${label} exceeds its byte limit.`);
		const content = readFileDescriptorBoundedSync(fileDescriptor, maxBytes);
		if (!content) throw new Error(`${label} exceeds its byte limit.`);
		const after = fstatSync(fileDescriptor);
		if (!sameFileVersion(before, after) || content.byteLength !== before.size) {
			throw new Error(`${label} changed while it was being read.`);
		}
		return content.toString("utf-8");
	} finally {
		closeSync(fileDescriptor);
	}
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
export async function readBoundedTextFile(filePath: string, maxBytes: number, label: string): Promise<string> {
	validateByteLimit(maxBytes);
	const fileHandle = await openAsync(filePath, "r");
	try {
		const before = await fileHandle.stat();
		if (!before.isFile()) throw new Error(`${label} is not a regular file.`);
		if (before.size > maxBytes) throw new Error(`${label} exceeds its byte limit.`);
		const content = await readFileHandleBounded(fileHandle, maxBytes);
		if (!content) throw new Error(`${label} exceeds its byte limit.`);
		const after = await fileHandle.stat();
		if (!sameFileVersion(before, after) || content.byteLength !== before.size) {
			throw new Error(`${label} changed while it was being read.`);
		}
		return content.toString("utf-8");
	} finally {
		await fileHandle.close();
	}
}
