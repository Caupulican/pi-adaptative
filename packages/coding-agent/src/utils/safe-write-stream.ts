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

/**
 * End a write stream and resolve only once its buffered data has been flushed and the file closed, so
 * a subsequent read of the path sees the COMPLETE content. `stream.end()` alone is fire-and-forget:
 * the flush runs asynchronously, so returning a temp-file path right after `.end()` lets a fast reader
 * observe a partial (or empty) file. Resolves (never rejects) on "error" too — best-effort artifact
 * writes must not hang or crash the caller; the caller drops the artifact on error separately.
 */
export function endWriteStream(stream: WriteStream): Promise<void> {
	return new Promise((resolve) => {
		// A stream that already reached a terminal state (finished, destroyed, closed, or
		// errored) before this call will never re-emit "close"/"finish"/"error": EventEmitter
		// does not replay past events, so listeners attached below would wait forever. Resolve
		// immediately instead of racing events that already happened.
		if (stream.writableFinished || stream.destroyed || stream.closed || stream.errored !== null) {
			resolve();
			return;
		}
		let settled = false;
		const done = () => {
			if (settled) return;
			settled = true;
			resolve();
		};
		stream.once("close", done);
		stream.once("finish", done);
		stream.once("error", done);
		if (!stream.writableEnded) {
			stream.end();
		}
	});
}
