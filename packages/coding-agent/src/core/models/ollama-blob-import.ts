/**
 * Verifies a model blob file's size and SHA-256 in bounded memory and imports it into Ollama through a private staged copy, upload and cache verification.
 */
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sameFileVersion } from "../../kernel/storage/bounded-file.ts";

/** Stable, bounded-memory verification; optionally makes the private upload copy. */
export async function verifyOllamaBlobFile(
	path: string,
	expectedSize: number,
	digest: string,
	signal: AbortSignal,
	copyTo?: string,
): Promise<void> {
	const initial = await lstat(path);
	if (!initial.isFile() || initial.isSymbolicLink() || initial.size !== expectedSize)
		throw new Error("Blob source is not a regular file of the expected size");
	const source = await open(path, "r");
	let target: FileHandle | undefined;
	let failure: unknown;
	try {
		const before = await source.stat();
		if (!sameFileVersion(initial, before)) throw new Error("Blob source changed while opening");
		target = copyTo ? await open(copyTo, "wx", 0o600) : undefined;
		const buffer = Buffer.allocUnsafe(1024 * 1024);
		const hash = createHash("sha256");
		let position = 0;
		while (position < expectedSize) {
			signal.throwIfAborted();
			const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, expectedSize - position), position);
			if (!bytesRead) throw new Error("Blob source ended early");
			hash.update(buffer.subarray(0, bytesRead));
			if (target) {
				let written = 0;
				while (written < bytesRead) {
					const result = await target.write(buffer, written, bytesRead - written, position + written);
					if (!result.bytesWritten) throw new Error("Blob staging write made no progress");
					written += result.bytesWritten;
				}
			}
			position += bytesRead;
		}
		if (hash.digest("hex") !== digest) throw new Error("Blob SHA-256 does not match expected digest");
		if (!sameFileVersion(before, await source.stat()) || !sameFileVersion(initial, await lstat(path)))
			throw new Error("Blob source changed during verification");
	} catch (error) {
		failure = error;
	}
	for (const handle of [target, source]) {
		if (!handle) continue;
		try {
			await handle.close();
		} catch (error) {
			failure = failure ? new AggregateError([failure, error], "Blob verification and file close failed") : error;
		}
	}
	if (failure) throw failure;
}

/** Ollama owns publication; the actual cached file is verified even when POST reports an existing blob. */
export async function importOllamaBlob(args: {
	port: {
		upload: (path: string, digest: string, signal: AbortSignal) => Promise<void>;
		verifyCache: (digest: string, size: number, signal: AbortSignal) => Promise<void>;
	};
	file: string;
	sha256: string;
	size: number;
	signal: AbortSignal;
}): Promise<void> {
	if (!/^[0-9a-f]{64}$/.test(args.sha256) || !Number.isSafeInteger(args.size) || args.size <= 0)
		throw new Error("Expected a lowercase SHA-256 and positive safe-integer byte count");
	const directory = await mkdtemp(join(tmpdir(), "pi-ollama-blob-"));
	let failure: unknown;
	try {
		const staged = join(directory, "blob");
		await verifyOllamaBlobFile(await realpath(args.file), args.size, args.sha256, args.signal, staged);
		args.signal.throwIfAborted();
		await args.port.upload(staged, args.sha256, args.signal);
		args.signal.throwIfAborted();
		await args.port.verifyCache(args.sha256, args.size, args.signal);
	} catch (error) {
		failure = error;
	}
	try {
		await rm(directory, { recursive: true, force: true });
	} catch (error) {
		failure = failure
			? new AggregateError([failure, error], "Blob import and private staging cleanup failed")
			: error;
	}
	if (failure) throw failure;
}
