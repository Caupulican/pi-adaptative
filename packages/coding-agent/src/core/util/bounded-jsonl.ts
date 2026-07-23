import { appendFileSync, promises as fsPromises, readFileSync, statSync } from "node:fs";
import { withFileLock, withFileLockSync, writeFileAtomic, writeFileAtomicSync } from "./atomic-file.ts";

export interface BoundedJsonlLimits {
	maxBytes: number;
	targetBytes: number;
	maxRecords: number;
}

const asyncAppendTails = new Map<string, Promise<void>>();

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

/** Append one JSON record and rotate to the newest low-water tail under one exclusive lock. */
export function appendBoundedJsonLineSync(filePath: string, value: unknown, limits: BoundedJsonlLimits): void {
	validateLimits(limits);
	const line = serializeLine(value);
	withFileLockSync(filePath, () => {
		appendFileSync(filePath, line, "utf-8");
		if (statSync(filePath).size <= limits.maxBytes) return;
		writeFileAtomicSync(filePath, retainedContent(readFileSync(filePath, "utf-8"), limits));
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
	const previous = asyncAppendTails.get(filePath) ?? Promise.resolve();
	const operation = previous
		.catch(() => undefined)
		.then(async () => {
			await withFileLock(filePath, async () => {
				await fsPromises.appendFile(filePath, line, "utf-8");
				if ((await fsPromises.stat(filePath)).size <= limits.maxBytes) return;
				await writeFileAtomic(filePath, retainedContent(await fsPromises.readFile(filePath, "utf-8"), limits));
			});
		});
	asyncAppendTails.set(filePath, operation);
	try {
		await operation;
	} finally {
		if (asyncAppendTails.get(filePath) === operation) asyncAppendTails.delete(filePath);
	}
}
