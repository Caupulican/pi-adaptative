import { appendFileSync, promises as fsPromises, type Stats, statSync } from "node:fs";
import { withFileLock, withFileLockSync, writeFileAtomic, writeFileAtomicSync } from "./atomic-file.ts";
import { readBoundedTextFile, readBoundedTextFileSync } from "./bounded-file.ts";

export interface BoundedJsonlLimits {
	maxBytes: number;
	targetBytes: number;
	maxRecords: number;
}

const asyncAppendTails = new Map<string, Promise<void>>();
const MAX_CACHED_FILES = 128;

interface JsonlFileState {
	stats: Stats;
	recordCount: number;
}

const fileStates = new Map<string, JsonlFileState>();

function sameFileState(left: Stats, right: Stats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

function cachedRecordCount(filePath: string, stats: Stats): number | undefined {
	const cached = fileStates.get(filePath);
	if (!cached || !sameFileState(cached.stats, stats)) return undefined;
	fileStates.delete(filePath);
	fileStates.set(filePath, cached);
	return cached.recordCount;
}

function rememberFileState(filePath: string, stats: Stats, recordCount: number): void {
	fileStates.delete(filePath);
	fileStates.set(filePath, { stats, recordCount });
	while (fileStates.size > MAX_CACHED_FILES) {
		const oldest = fileStates.keys().next().value;
		if (oldest === undefined) break;
		fileStates.delete(oldest);
	}
}

function recordCount(content: string): number {
	let count = 0;
	for (const line of content.split("\n")) {
		if (line.trim().length > 0) count++;
	}
	return count;
}

function validateLimits(limits: BoundedJsonlLimits): void {
	if (
		!Number.isSafeInteger(limits.maxBytes) ||
		!Number.isSafeInteger(limits.targetBytes) ||
		!Number.isSafeInteger(limits.maxRecords) ||
		limits.maxBytes <= 0 ||
		limits.targetBytes <= 0 ||
		limits.targetBytes > limits.maxBytes ||
		limits.maxRecords <= 0
	) {
		throw new TypeError("Bounded JSONL limits require positive integers and targetBytes <= maxBytes.");
	}
}

function retainedContent(content: string, limits: BoundedJsonlLimits): string {
	const lines = content.split("\n").filter((line) => line.trim().length > 0);
	const retained: string[] = [];
	let retainedBytes = 0;
	for (let index = lines.length - 1; index >= 0 && retained.length < limits.maxRecords; index--) {
		const line = lines[index]!;
		const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
		if (lineBytes > limits.maxBytes) continue;
		if (retained.length > 0 && retainedBytes + lineBytes > limits.targetBytes) break;
		retained.push(line);
		retainedBytes += lineBytes;
		if (retainedBytes >= limits.targetBytes) break;
	}
	retained.reverse();
	return retained.length > 0 ? `${retained.join("\n")}\n` : "";
}

function serializeLine(value: unknown): string {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new TypeError("Bounded JSONL records must be JSON-serializable values.");
	return `${encoded}\n`;
}

function assertLineFits(line: string, limits: BoundedJsonlLimits): number {
	const bytes = Buffer.byteLength(line, "utf-8");
	if (bytes > limits.maxBytes) throw new Error("Bounded JSONL record exceeds maxBytes.");
	return bytes;
}

function existingStatsSync(filePath: string): Stats | undefined {
	try {
		return statSync(filePath);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function existingStats(filePath: string): Promise<Stats | undefined> {
	try {
		return await fsPromises.stat(filePath);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

/** Append one JSON record and rotate to the newest low-water tail under one exclusive lock. */
export function appendBoundedJsonLineSync(filePath: string, value: unknown, limits: BoundedJsonlLimits): void {
	validateLimits(limits);
	const line = serializeLine(value);
	const lineBytes = assertLineFits(line, limits);
	withFileLockSync(filePath, () => {
		try {
			const before = existingStatsSync(filePath);
			if (!before || before.size > limits.maxBytes) {
				writeFileAtomicSync(filePath, line);
				rememberFileState(filePath, statSync(filePath), 1);
				return;
			}
			let content: string | undefined;
			let count = cachedRecordCount(filePath, before);
			if (count === undefined) {
				content = readBoundedTextFileSync(filePath, limits.maxBytes, "Bounded JSONL file");
				count = recordCount(content);
			}
			if (before.size + lineBytes <= limits.maxBytes && count + 1 <= limits.maxRecords) {
				appendFileSync(filePath, line, "utf-8");
				rememberFileState(filePath, statSync(filePath), count + 1);
				return;
			}
			content ??= readBoundedTextFileSync(filePath, limits.maxBytes, "Bounded JSONL file");
			const retained = retainedContent(`${content}${line}`, limits);
			writeFileAtomicSync(filePath, retained);
			rememberFileState(filePath, statSync(filePath), recordCount(retained));
		} catch (error) {
			fileStates.delete(filePath);
			throw error;
		}
	});
}

/** Async counterpart of {@link appendBoundedJsonLineSync}. */
export async function appendBoundedJsonLine(
	filePath: string,
	value: unknown,
	limits: BoundedJsonlLimits,
): Promise<void> {
	validateLimits(limits);
	const line = serializeLine(value);
	const lineBytes = assertLineFits(line, limits);
	const previous = asyncAppendTails.get(filePath) ?? Promise.resolve();
	const operation = previous
		.catch(() => undefined)
		.then(async () => {
			await withFileLock(filePath, async () => {
				try {
					const before = await existingStats(filePath);
					if (!before || before.size > limits.maxBytes) {
						await writeFileAtomic(filePath, line);
						rememberFileState(filePath, await fsPromises.stat(filePath), 1);
						return;
					}
					let content: string | undefined;
					let count = cachedRecordCount(filePath, before);
					if (count === undefined) {
						content = await readBoundedTextFile(filePath, limits.maxBytes, "Bounded JSONL file");
						count = recordCount(content);
					}
					if (before.size + lineBytes <= limits.maxBytes && count + 1 <= limits.maxRecords) {
						await fsPromises.appendFile(filePath, line, "utf-8");
						rememberFileState(filePath, await fsPromises.stat(filePath), count + 1);
						return;
					}
					content ??= await readBoundedTextFile(filePath, limits.maxBytes, "Bounded JSONL file");
					const retained = retainedContent(`${content}${line}`, limits);
					await writeFileAtomic(filePath, retained);
					rememberFileState(filePath, await fsPromises.stat(filePath), recordCount(retained));
				} catch (error) {
					fileStates.delete(filePath);
					throw error;
				}
			});
		});
	asyncAppendTails.set(filePath, operation);
	try {
		await operation;
	} finally {
		if (asyncAppendTails.get(filePath) === operation) asyncAppendTails.delete(filePath);
	}
}
