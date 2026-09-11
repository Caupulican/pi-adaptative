import { spawnProcess, waitForChildProcessWithTermination } from "../../utils/child-process.ts";
import {
	FILE_CODEC_TIMEOUT_MS,
	fileCodecRecoveryError,
	MAX_FILE_CODEC_PROTOCOL_BYTES,
	resolveFileCodecLaunch,
} from "./file-codec-runner.ts";

interface CodecFrame {
	sequence: number;
	final: boolean;
	encoding?: unknown;
	detected?: unknown;
	text?: unknown;
	error?: unknown;
	detail?: unknown;
}

/** A read owns one helper. Frames are correlated, serialized, bounded, and never replayed. */
export async function createFileCodecReadSession(signal?: AbortSignal) {
	const launch = await resolveFileCodecLaunch(signal);
	signal?.throwIfAborted();
	const stop = new AbortController();
	const child = spawnProcess(launch.command, [...launch.args, "--read-stream"], {
		cwd: launch.cwd,
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	let failure: Error | undefined;
	let closed = false;
	let exited = false;
	let endingFrame = false;
	let frameReceived = false;
	let sequence = 0;
	let storage: Buffer = Buffer.alloc(0);
	let retained = 0;
	let pending:
		| {
				sequence: number;
				final: boolean;
				/** Whether this frame's `final` ends the helper process, or only one phase of the read. */
				endsProcess: boolean;
				resolve(frame: CodecFrame): void;
				reject(error: Error): void;
		  }
		| undefined;
	const fail = (error: Error) => {
		failure ??= error;
		pending?.reject(failure);
		stop.abort();
	};
	const onAbort = () => fail(new Error("Encoding recovery aborted"));
	const terminal = waitForChildProcessWithTermination(child, {
		signal: stop.signal,
		killGraceMs: 2_000,
		onDiagnostic: () => fail(new Error("Encoding recovery process termination failed")),
	}).then(
		(result) => {
			exited = true;
			if (!closed && (!endingFrame || result.reason !== "exited")) fail(fileCodecRecoveryError());
			return result;
		},
		() => {
			exited = true;
			fail(fileCodecRecoveryError());
			return { code: null, reason: "exited" as const };
		},
	);
	child.stdout?.on("data", (data: Buffer) => {
		if (closed || failure || data.length === 0) return;
		if (!pending || frameReceived || retained + data.length > MAX_FILE_CODEC_PROTOCOL_BYTES) {
			fail(fileCodecRecoveryError());
			return;
		}
		const newline = data.indexOf(10);
		if (newline !== -1 && newline !== data.length - 1) {
			fail(fileCodecRecoveryError());
			return;
		}
		const needed = retained + data.length;
		if (needed > storage.length) {
			const grown = Buffer.allocUnsafe(
				Math.min(MAX_FILE_CODEC_PROTOCOL_BYTES, Math.max(4096, needed, storage.length * 2)),
			);
			storage.copy(grown, 0, 0, retained);
			storage = grown;
		}
		data.copy(storage, retained);
		retained = needed;
		if (newline === -1) return;
		try {
			const frame: unknown = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(storage.subarray(0, retained - 1)),
			);
			if (
				!frame ||
				typeof frame !== "object" ||
				!("sequence" in frame) ||
				frame.sequence !== pending.sequence ||
				!("final" in frame) ||
				frame.final !== pending.final
			)
				throw fileCodecRecoveryError();
			frameReceived = true;
			endingFrame = (pending.final && pending.endsProcess) || "error" in frame;
			retained = 0;
			pending.resolve(frame as CodecFrame);
		} catch {
			fail(fileCodecRecoveryError());
		}
	});
	child.stderr?.on("data", () => fail(fileCodecRecoveryError()));
	for (const stream of [child.stdin, child.stdout, child.stderr]) {
		stream?.on("error", () => fail(fileCodecRecoveryError()));
	}
	if (!child.stdin || !child.stdout || !child.stderr) fail(fileCodecRecoveryError());
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();
	/**
	 * One correlated request/response. `endsProcess` says whether this frame's `final` ends the
	 * helper: the decode stream's final frame does, a detection pass's final frame only ends that
	 * phase, because the decode frames it resolved the encoding for still have to run.
	 */
	const exchange = async (
		body: Record<string, unknown>,
		final: boolean,
		endsProcess: boolean,
	): Promise<CodecFrame> => {
		if (failure) throw failure;
		if (closed || exited || endingFrame || pending) throw new Error("Encoding read session is not available");
		const request = JSON.stringify({ sequence, final, ...body });
		if (Buffer.byteLength(request) + 1 > MAX_FILE_CODEC_PROTOCOL_BYTES) throw fileCodecRecoveryError();
		const response = Promise.withResolvers<CodecFrame>();
		pending = { sequence: sequence++, final, endsProcess, resolve: response.resolve, reject: response.reject };
		frameReceived = false;
		const deadline = setTimeout(() => fail(new Error("Encoding recovery timed out")), FILE_CODEC_TIMEOUT_MS);
		try {
			try {
				child.stdin?.write(`${request}\n`, (error) => {
					if (error) fail(fileCodecRecoveryError());
				});
			} catch {
				fail(fileCodecRecoveryError());
			}
			const frame = await response.promise;
			if (endingFrame) {
				child.stdin?.end();
				const result = await terminal;
				if (failure) throw failure;
				if (result.code !== ("error" in frame ? 1 : 0)) throw fileCodecRecoveryError();
			}
			if ("error" in frame) throw fileCodecRecoveryError(frame.error, frame.detail);
			if (failure) throw failure;
			return frame;
		} catch (error) {
			fail(error instanceof Error ? error : fileCodecRecoveryError());
			throw failure;
		} finally {
			clearTimeout(deadline);
			pending = undefined;
		}
	};
	/** A response that violates the protocol ends the session: nothing about it is evidence. */
	const invalid = (): never => {
		fail(fileCodecRecoveryError());
		throw failure ?? fileCodecRecoveryError();
	};
	return {
		/**
		 * Resolve the encoding from the WHOLE source before a byte of it is decoded. A streamed
		 * decode sees one bounded chunk at a time, so a codec chosen from the first chunk can be
		 * contradicted by the last one; the helper keeps counters and decoder state here, never the
		 * bytes, so this stays bounded however large the source is.
		 */
		async detect(chunks: AsyncIterable<Buffer> | Iterable<Buffer>): Promise<{ encoding: string; detected: boolean }> {
			for await (const chunk of chunks) {
				const frame = await exchange({ operation: "detect", source: chunk.toString("base64") }, false, false);
				// An encoding before the source has ended would be a verdict on bytes nobody has read.
				if ("encoding" in frame && frame.encoding !== undefined) invalid();
			}
			const frame = await exchange({ operation: "detect", source: "" }, true, false);
			if (typeof frame.encoding !== "string" || frame.encoding.length === 0 || typeof frame.detected !== "boolean")
				invalid();
			return { encoding: frame.encoding as string, detected: frame.detected === true };
		},
		async decode(
			source: Buffer,
			encoding: string | undefined,
			final: boolean,
		): Promise<{ text: string; encoding: string; detected: boolean }> {
			const frame = await exchange(
				{ operation: "decode", encoding, source: source.toString("base64") },
				final,
				true,
			);
			if (typeof frame.text !== "string" || !frame.text.isWellFormed() || typeof frame.encoding !== "string")
				invalid();
			return {
				text: frame.text as string,
				encoding: frame.encoding as string,
				detected: frame.detected === true,
			};
		},
		async close(): Promise<void> {
			closed = true;
			if (!exited) fail(new Error("Encoding read session closed"));
			child.stdin?.destroy();
			await terminal;
			child.stdout?.destroy();
			child.stderr?.destroy();
			signal?.removeEventListener("abort", onAbort);
			storage = Buffer.alloc(0);
		},
	};
}
