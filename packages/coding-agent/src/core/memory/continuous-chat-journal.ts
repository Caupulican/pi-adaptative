import type { Stats } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { sameFileVersion } from "../../kernel/storage/bounded-file.ts";
import { isMissingFileError } from "../util/atomic-file.ts";
import { checkpointContinuousChatRecovery } from "./continuous-chat-recovery.ts";

const READ_BYTES = 64 * 1024;
const LINE_FEED = 0x0a;

export interface ContinuousChatJournalLine {
	text: string;
	/** Physical byte position and byte length, excluding the LF separator. */
	offset: number;
	length: number;
}

async function readExactly(
	handle: FileHandle,
	buffer: Buffer,
	length: number,
	position: number,
	signal?: AbortSignal,
): Promise<void> {
	let filled = 0;
	while (filled < length) {
		signal?.throwIfAborted();
		const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
		signal?.throwIfAborted();
		if (bytesRead === 0) throw new Error("Continuous-chat journal changed while being read.");
		filled += bytesRead;
	}
}

async function assertUnchanged(path: string, handle: FileHandle, revision: Stats, signal?: AbortSignal): Promise<void> {
	const current = await handle.stat();
	const currentPath = await lstat(path);
	signal?.throwIfAborted();
	if (!sameFileVersion(revision, current) || !sameFileVersion(revision, currentPath)) {
		throw new Error(`Continuous-chat journal ${path} changed while being read.`);
	}
}

/**
 * Visits complete, nonempty LF-delimited records under the caller's writer lease. Text residency is one 64 KiB
 * chunk plus the largest complete line, never the whole journal. CR bytes remain part of each record. An incomplete
 * tail is found backwards without retaining it and is truncated only after every visitor and version check succeeds.
 */
export async function recoverContinuousChatJournal(
	path: string,
	fromBytes: number,
	visit: (line: ContinuousChatJournalLine) => void | Promise<void>,
	signal?: AbortSignal,
): Promise<{ bytes: number; records: number }> {
	signal?.throwIfAborted();
	if (!Number.isSafeInteger(fromBytes) || fromBytes < 0) {
		throw new TypeError("Continuous-chat journal offset must be a non-negative safe integer.");
	}
	let before: Stats;
	try {
		before = await lstat(path);
	} catch (error) {
		signal?.throwIfAborted();
		if (!isMissingFileError(error)) throw error;
		if (fromBytes > 0) throw new Error(`Continuous-chat journal ${path} disappeared.`);
		return { bytes: 0, records: 0 };
	}
	signal?.throwIfAborted();
	if (!before.isFile()) throw new Error(`Continuous-chat journal ${path} is not a regular file.`);
	if (before.size < fromBytes) throw new Error(`Continuous-chat journal ${path} is shorter than its indexed bytes.`);
	if (before.size === fromBytes) return { bytes: fromBytes, records: 0 };
	const handle = await open(path, "r");
	try {
		const revision = await handle.stat();
		if (!sameFileVersion(before, revision)) throw new Error(`Continuous-chat journal ${path} changed while opening.`);
		const buffer = Buffer.allocUnsafe(READ_BYTES);
		let complete = fromBytes;
		for (let end = revision.size; end > fromBytes; ) {
			const length = Math.min(READ_BYTES, end - fromBytes);
			const start = end - length;
			await readExactly(handle, buffer, length, start, signal);
			const newline = buffer.subarray(0, length).lastIndexOf(LINE_FEED);
			if (newline !== -1) {
				complete = start + newline + 1;
				break;
			}
			end = start;
		}

		let position = fromBytes;
		let lineOffset = fromBytes;
		let lineLength = 0;
		let fragments: Buffer[] = [];
		let records = 0;
		while (position < complete) {
			const length = Math.min(READ_BYTES, complete - position);
			await readExactly(handle, buffer, length, position, signal);
			let start = 0;
			while (start < length) {
				const next = buffer.subarray(start, length).indexOf(LINE_FEED);
				const end = next === -1 ? length : start + next;
				const fragment = buffer.subarray(start, end);
				lineLength += fragment.length;
				if (next === -1) {
					// The input buffer is reused by the next read; only owned copies may survive it.
					if (fragment.length > 0) fragments.push(Buffer.from(fragment));
					break;
				}
				if (lineLength > 0) {
					await checkpointContinuousChatRecovery(signal, records);
					const text =
						fragments.length === 0
							? fragment.toString("utf8")
							: Buffer.concat([...fragments, fragment], lineLength).toString("utf8");
					await visit({ text, offset: lineOffset, length: lineLength });
					records++;
				}
				fragments = [];
				lineLength = 0;
				start = end + 1;
				lineOffset = position + start;
			}
			position += length;
		}
		await assertUnchanged(path, handle, revision, signal);
		if (complete < revision.size) {
			// Healthy journals need only read access. A separate, revalidated descriptor owns tail repair.
			const writer = await open(path, "r+");
			try {
				await assertUnchanged(path, writer, revision, signal);
				await writer.truncate(complete);
			} finally {
				await writer.close();
			}
		}
		signal?.throwIfAborted();
		return { bytes: complete, records };
	} finally {
		await handle.close();
	}
}
