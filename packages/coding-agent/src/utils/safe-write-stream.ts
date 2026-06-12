import { createWriteStream, type WriteStream } from "node:fs";

/**
 * Create a WriteStream whose "error" event is always handled.
 *
 * Best-effort artifact writes (full-output temp files, overflow spills) must never
 * crash the host process: an fs.WriteStream "error" event with no listener becomes
 * an uncaught exception. Errors are reported through the optional callback instead.
 */
export function createSafeWriteStream(path: string, onError?: (error: Error) => void): WriteStream {
	const stream = createWriteStream(path);
	stream.on("error", (error: Error) => {
		onError?.(error);
	});
	return stream;
}
