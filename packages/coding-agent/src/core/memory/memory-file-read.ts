import { createHash } from "node:crypto";
import { lstatSync, type Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { isMissingFileError } from "../util/atomic-file.ts";
import {
	readBoundedFile,
	readFileDescriptorBoundedSync,
	sameFileVersion,
	withStableFileDescriptorSync,
} from "../util/bounded-file.ts";
import { assertMemoryReadActive, type MemoryReadContext, type MemoryReadEvidence } from "./memory-read-context.ts";

function versionCurrent(path: string, captured: Stats | undefined): boolean {
	try {
		const current = lstatSync(path);
		return captured !== undefined && !current.isSymbolicLink() && sameFileVersion(captured, current);
	} catch (error) {
		return captured === undefined && isMissingFileError(error);
	}
}

function versionEvidence(
	path: string,
	captured: Stats | undefined,
	revision: string,
	verify?: (context: MemoryReadContext) => Promise<boolean>,
): MemoryReadEvidence {
	return Object.freeze({
		sources: Object.freeze([Object.freeze({ kind: "managed" as const, ref: path, revision })]),
		complete: true,
		isCurrent: () => versionCurrent(path, captured),
		revalidate: async (context: MemoryReadContext) => {
			assertMemoryReadActive(context);
			if (!versionCurrent(path, captured)) return false;
			try {
				const verified = verify ? await verify(context) : true;
				assertMemoryReadActive(context);
				return verified && versionCurrent(path, captured);
			} catch {
				assertMemoryReadActive(context);
				return false;
			}
		},
	});
}

/** Directory identity fences additions/removals as well as the files a bounded scan found. */
export function observeMemoryDirectory(path: string, context?: MemoryReadContext): void {
	assertMemoryReadActive(context);
	let version: Stats | undefined;
	try {
		version = lstatSync(path);
		if (!version.isDirectory() || version.isSymbolicLink())
			throw new Error("Memory directory is not a real directory.");
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
	}
	const captured = version;
	const revision = JSON.stringify([
		captured?.dev,
		captured?.ino,
		captured?.size,
		captured?.mtimeMs,
		captured?.ctimeMs,
	]);
	context?.observe?.(versionEvidence(path, captured, revision));
}

function fileEvidence(
	path: string,
	maxBytes: number,
	label: string,
	captured: Stats | undefined,
	content: Buffer | undefined,
): MemoryReadEvidence {
	const digest = content === undefined ? "absent" : createHash("sha256").update(content).digest("hex");
	const revision = createHash("sha256")
		.update(
			JSON.stringify([captured?.dev, captured?.ino, captured?.size, captured?.mtimeMs, captured?.ctimeMs, digest]),
		)
		.digest("hex");
	return versionEvidence(path, captured, revision, async (next) => {
		const reread = await readObservedMemoryFile(path, maxBytes, label, {
			signal: next.signal,
			deadlineAt: next.deadlineAt,
		});
		return (reread === undefined ? "absent" : createHash("sha256").update(reread).digest("hex")) === digest;
	});
}

export async function readObservedMemoryFile(
	path: string,
	maxBytes: number,
	label: string,
	context?: MemoryReadContext,
): Promise<string | undefined> {
	assertMemoryReadActive(context);
	let version: Stats | undefined;
	let content: Buffer | undefined;
	try {
		version = await lstat(path);
		content = await readBoundedFile(path, maxBytes, label, context);
		if (!sameFileVersion(version, await lstat(path))) throw new Error(`${label} changed during its read.`);
	} catch (error) {
		assertMemoryReadActive(context);
		if (version !== undefined || !isMissingFileError(error)) throw error;
	}
	assertMemoryReadActive(context);
	context?.observe?.(fileEvidence(path, maxBytes, label, version, content));
	return content?.toString("utf8");
}

/** A read and its version are captured through the same open file; absence is an observed state too. */
export function readObservedMemoryFileSync(
	path: string,
	maxBytes: number,
	label: string,
	context?: MemoryReadContext,
): string | undefined {
	assertMemoryReadActive(context);
	let version: Stats | undefined;
	let content: Buffer | undefined;
	try {
		content = withStableFileDescriptorSync(
			path,
			label,
			(descriptor, opened) => {
				version = opened;
				if (opened.size > maxBytes) throw new Error(`${label} exceeds its byte limit.`);
				const read = readFileDescriptorBoundedSync(descriptor, maxBytes, context);
				if (read === undefined || read.length !== opened.size) throw new Error(`${label} changed during its read.`);
				return read;
			},
			context,
		);
	} catch (error) {
		assertMemoryReadActive(context);
		if (version !== undefined || !isMissingFileError(error)) throw error;
	}
	context?.observe?.(fileEvidence(path, maxBytes, label, version, content));
	return content?.toString("utf8");
}
