import { createHash } from "node:crypto";
import { readSync, type Stats } from "node:fs";
import { currentSynchronousFileLockScope } from "../storage/atomic-file.ts";
import { withStableFileDescriptorSync } from "../storage/bounded-file.ts";

const CONFIRMATION_CHUNK_BYTES = 64 * 1024;

/** Confirm the whole attempted suffix while its original admitted writer still owns the file lock. */
export function confirmSessionFileWrite(file: string, before: Stats, content: string): Stats {
	if (!currentSynchronousFileLockScope(file))
		throw new Error("Session write confirmation requires the original file lock.");
	const contentBytes = Buffer.byteLength(content);
	const expectedSize = before.size + contentBytes;
	if (!Number.isSafeInteger(expectedSize)) throw new Error("Session write confirmation exceeds safe byte bounds.");
	return withStableFileDescriptorSync(file, "Session write confirmation", (fd, observed) => {
		if (observed.dev !== before.dev || observed.ino !== before.ino || observed.size !== expectedSize)
			throw new Error("Session write confirmation found a different file or incomplete suffix.");
		const actual = createHash("sha256");
		const chunk = Buffer.allocUnsafe(Math.min(CONFIRMATION_CHUNK_BYTES, Math.max(contentBytes, 1)));
		let readBytes = 0;
		while (readBytes < contentBytes) {
			const count = readSync(
				fd,
				chunk,
				0,
				Math.min(chunk.length, contentBytes - readBytes),
				before.size + readBytes,
			);
			if (count === 0) throw new Error("Session write confirmation reached an incomplete suffix.");
			actual.update(chunk.subarray(0, count));
			readBytes += count;
		}
		if (actual.digest("hex") !== createHash("sha256").update(content).digest("hex"))
			throw new Error("Session write confirmation found different suffix bytes.");
		return observed;
	});
}
