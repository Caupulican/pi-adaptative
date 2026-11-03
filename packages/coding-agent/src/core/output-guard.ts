import { exitProcess, thrownDetail } from "./process-end-recorder.ts";

interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;

const RAW_STDOUT_RETRY_DELAY_MS = 10;
const RAW_STDOUT_WRITE_CALLBACK_TIMEOUT_MS = 5_000;
const RAW_STDOUT_RETRY_TIMEOUT_MS = 15_000;

let rawStdoutWriteTail: Promise<void> = Promise.resolve();

function getRawStdoutWrite(): StdoutTakeoverState["rawStdoutWrite"] {
	if (stdoutTakeoverState) {
		return stdoutTakeoverState.rawStdoutWrite;
	}
	return process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
}

async function writeRawStdoutChunk(text: string): Promise<void> {
	const retryDeadline = Date.now() + RAW_STDOUT_RETRY_TIMEOUT_MS;
	while (true) {
		try {
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const timeout = setTimeout(() => {
					if (settled) return;
					settled = true;
					reject(new Error(`stdout write callback timed out after ${RAW_STDOUT_WRITE_CALLBACK_TIMEOUT_MS}ms`));
				}, RAW_STDOUT_WRITE_CALLBACK_TIMEOUT_MS);
				const settle = (error?: Error | null) => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					if (error) reject(error);
					else resolve();
				};
				try {
					getRawStdoutWrite()(text, settle);
				} catch (error) {
					settle(error instanceof Error ? error : new Error(String(error)));
				}
			});
			return;
		} catch (error) {
			const writeError = error instanceof Error ? error : new Error(String(error));
			const code = (writeError as Error & { code?: unknown }).code;
			if ((code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") || Date.now() >= retryDeadline) {
				throw writeError;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));
		}
	}
}

export function takeOverStdout(): void {
	if (stdoutTakeoverState) {
		return;
	}

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;

	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	stdoutTakeoverState = {
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
	};
}

export function restoreStdout(): void {
	if (!stdoutTakeoverState) {
		return;
	}

	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	stdoutTakeoverState = undefined;
}

export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

let rawStdoutFailureHandler: ((error: unknown) => void) | undefined;

/**
 * Registers the owner of the raw stdout stream to be told when a queued write fails or its callback times out (a client that went
 * away). With no owner registered the process records the failure under state/crashes (routine class) and exits with status 1; an owner that registers takes over the
 * shutdown (its own orderly dispose, then its own exit). Returns the unregistration.
 */
export function setRawStdoutFailureHandler(handler: (error: unknown) => void): () => void {
	rawStdoutFailureHandler = handler;
	return () => {
		if (rawStdoutFailureHandler === handler) rawStdoutFailureHandler = undefined;
	};
}

export function writeRawStdout(text: string): void {
	if (text.length === 0) {
		return;
	}
	rawStdoutWriteTail = rawStdoutWriteTail.then(() => writeRawStdoutChunk(text));
	void rawStdoutWriteTail.catch((error: unknown) => {
		if (rawStdoutFailureHandler) {
			rawStdoutFailureHandler(error);
			return;
		}
		// The stream that would carry a message is the one that failed: the record is the trace of this exit. A reader that went away
		// is an ordinary end, so it is a routine record.
		exitProcess(1, "stdout-failed", thrownDetail(error));
	});
}

export async function waitForRawStdoutBackpressure(): Promise<void> {
	while (true) {
		const tail = rawStdoutWriteTail;
		await tail;
		if (tail === rawStdoutWriteTail) {
			return;
		}
	}
}

export async function flushRawStdout(): Promise<void> {
	await waitForRawStdoutBackpressure();
	await writeRawStdoutChunk("");
}
