import { createHash } from "node:crypto";
import { AgentToolExecutionError } from "@caupulican/pi-agent-core/types";
import { ENCODING_EVIDENCE_REQUIRED, PythonCodecUnavailableError } from "./file-codec-runner.ts";
import { createFileCodecReadSession } from "./file-codec-stream.ts";
import { firstInvalidUtf8Offset } from "./file-encoding-policy.ts";

const DECODE_CHUNK_BYTES = 1024 * 1024;
const EMPTY = Buffer.alloc(0);

export const READ_ENCODING_REQUIRED_MARKER = "PI_READ_ENCODING_REQUIRED";
export const READ_ENCODING_REQUIRED_FAILURE_CODE = "read_encoding_required";

/** Where decoding first failed, in whole-stream coordinates. */
interface UndecodableByte {
	/** 0-based byte offset from the start of the file. */
	offset: number;
	/** 1-based line the offset falls on. */
	line: number;
}

function countNewlines(bytes: Buffer): number {
	let total = 0;
	for (let index = bytes.indexOf(10); index !== -1; index = bytes.indexOf(10, index + 1)) total++;
	return total;
}

/**
 * The trailing bytes of a chunk that begin a sequence the chunk does not finish. The streaming
 * decoder holds them for the next chunk, so a failure reported there really starts here.
 */
function incompleteUtf8Tail(bytes: Buffer): Buffer {
	for (let back = 1; back <= 3 && back <= bytes.length; back++) {
		const byte = bytes[bytes.length - back];
		if (byte < 0x80) return EMPTY;
		if ((byte & 0xc0) === 0x80) continue;
		const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
		// Copy: the caller may reuse its read buffer for the next chunk.
		return length > back ? Buffer.from(bytes.subarray(bytes.length - back)) : EMPTY;
	}
	return EMPTY;
}

/**
 * Resolving the encoding is the harness's job, not the model's, so this failure exists only when
 * the managed codec itself cannot run: without Python nothing can decode the bytes, and the only
 * remedies left are provisioning the runtime or naming the encoding in the call.
 */
function readEncodingRequiredError(path: string, evidence: UndecodableByte, reason: string): AgentToolExecutionError {
	return new AgentToolExecutionError(
		`${READ_ENCODING_REQUIRED_MARKER}: ${path} is not valid UTF-8 (first invalid byte at line ${evidence.line}, byte offset ${evidence.offset}) and the managed Python codec is unavailable (${reason}). Run pi doctor to provision Python, or pass encoding.`,
		READ_ENCODING_REQUIRED_FAILURE_CODE,
		createHash("sha256").update(`${path}\0${evidence.offset}`).digest("base64url"),
		"tool_failure",
	);
}

/**
 * Python ran and still found no encoding that decodes these bytes as text: the source is binary or
 * genuinely ambiguous. That is the edit contract's corruption class, told where to look.
 */
function encodingEvidenceError(path: string, evidence: UndecodableByte): Error {
	return new Error(
		`${ENCODING_EVIDENCE_REQUIRED} First undecodable byte in ${path} at line ${evidence.line}, byte offset ${evidence.offset}.`,
	);
}

/** Read-only decoding. Unlike edits, reads need no canonical byte round-trip or splice proof. */
export async function* decodeTextChunks(
	chunks: AsyncIterable<Buffer> | Iterable<Buffer>,
	path: string,
	encoding?: string,
	signal?: AbortSignal,
	onEncodingDetected?: (encoding: string) => void,
): AsyncGenerator<string> {
	if (signal?.aborted) throw new Error("Encoding recovery aborted");
	const native = new TextDecoder("utf-8", { fatal: true });
	let consumedBytes = 0;
	let consumedNewlines = 0;
	let heldTail: Buffer = EMPTY;
	/**
	 * Every byte handed to the consumer so far was 7-bit. While that holds, the native decode can
	 * still be abandoned for the codec: ASCII means the same text under every codec the helper can
	 * resolve, so the delivered prefix stays correct whatever the rest of the file turns out to be.
	 */
	let asciiOnly = true;
	let evidence: UndecodableByte | undefined;
	const locate = (bytes: Buffer, final: boolean): UndecodableByte => {
		const scanned = heldTail.length > 0 ? Buffer.concat([heldTail, bytes]) : bytes;
		const base = consumedBytes - heldTail.length;
		const invalid = firstInvalidUtf8Offset(scanned, { allowIncompleteTail: !final });
		const nul = scanned.indexOf(0);
		const at = invalid === -1 ? nul : nul === -1 ? invalid : Math.min(invalid, nul);
		const prefix = at === -1 ? scanned : scanned.subarray(0, at);
		return { offset: base + prefix.length, line: consumedNewlines + countNewlines(prefix) + 1 };
	};
	const decodeNative = (bytes: Buffer, final: boolean) => {
		try {
			if (bytes.includes(0)) throw new Error("NUL-bearing input");
			const text = native.decode(bytes, { stream: !final });
			const tail = final ? EMPTY : incompleteUtf8Tail(bytes);
			// Only bytes that became text count: a sequence the decoder is still holding has been
			// delivered to nobody, so it cannot make an already-delivered prefix wrong.
			if (asciiOnly) asciiOnly = !bytes.subarray(0, bytes.length - tail.length).some((byte) => byte >= 0x80);
			consumedBytes += bytes.length;
			consumedNewlines += countNewlines(bytes);
			heldTail = tail;
			return text;
		} catch {
			evidence ??= locate(bytes, final);
			throw new Error(ENCODING_EVIDENCE_REQUIRED);
		}
	};
	// Native UTF-8 is only the fast path, and only when nothing named an encoding. Everything else
	// belongs to the managed codec, which owns BOM handling and detection alike.
	let nativePath = encoding === undefined;
	let run: Awaited<ReturnType<typeof createFileCodecReadSession>> | undefined;
	let selectedEncoding = encoding;
	let decoded = false;
	const openSession = async (): Promise<void> => {
		try {
			run = await createFileCodecReadSession(signal);
		} catch (error) {
			if (error instanceof PythonCodecUnavailableError && encoding === undefined && evidence !== undefined)
				throw readEncodingRequiredError(path, evidence, error.reason);
			throw error;
		}
	};
	const decodeThroughCodec = async (bytes: Buffer, final: boolean): Promise<string> => {
		if (!run) await openSession();
		if (!run) throw new Error("Encoding recovery session unavailable");
		const result = await run.decode(bytes, selectedEncoding, final);
		if (decoded && result.encoding !== selectedEncoding) throw new Error("Invalid incremental encoding response");
		if (!decoded && result.detected) onEncodingDetected?.(result.encoding);
		decoded = true;
		selectedEncoding = result.encoding;
		return result.text;
	};
	/** BOM selection needs the first four bytes, so nothing is decoded before the stream has them. */
	let pending: Buffer = EMPTY;
	let started = false;
	/** Bytes the native decoder was still holding when the codec took over; theirs to decode now. */
	const handOver = (bytes: Buffer): Buffer => {
		if (heldTail.length === 0) return bytes;
		const carried = Buffer.concat([heldTail, bytes]);
		heldTail = EMPTY;
		return carried;
	};
	try {
		for await (const chunk of chunks) {
			if (signal?.aborted) throw new Error("Encoding recovery aborted");
			const source = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
			pending = EMPTY;
			if (!started && source.length < 4) {
				pending = Buffer.from(source);
				continue;
			}
			let start = 0;
			while (start < source.length) {
				if (signal?.aborted) throw new Error("Encoding recovery aborted");
				if (!nativePath) {
					// One frame per source chunk: detection is only as good as the bytes it sees, and a
					// whole-file read hands the helper the whole file.
					const text = await decodeThroughCodec(handOver(source.subarray(start)), false);
					start = source.length;
					started = true;
					yield text;
					break;
				}
				const bytes = source.subarray(start, start + DECODE_CHUNK_BYTES);
				let text: string;
				try {
					text = decodeNative(bytes, false);
				} catch (error) {
					if (!asciiOnly) throw error;
					nativePath = false;
					continue;
				}
				start += bytes.length;
				started = true;
				yield text;
			}
			if (signal?.aborted) throw new Error("Encoding recovery aborted");
		}
		if (nativePath) {
			try {
				yield decodeNative(pending, true);
			} catch (error) {
				if (!asciiOnly) throw error;
				nativePath = false;
				yield await decodeThroughCodec(handOver(pending), true);
			}
		} else {
			yield await decodeThroughCodec(handOver(pending), true);
		}
	} catch (error) {
		// With a named codec the failure is that codec's own and the edit contract's diagnostic
		// stands. Without one, the harness has exhausted UTF-8, declarations and detection, so the
		// source is binary or ambiguous — say where it stops being text.
		throw encoding === undefined &&
			evidence !== undefined &&
			error instanceof Error &&
			error.message === ENCODING_EVIDENCE_REQUIRED
			? encodingEvidenceError(path, evidence)
			: error;
	} finally {
		await run?.close();
	}
}

export async function decodeReadText(
	source: Buffer,
	path: string,
	encoding?: string,
	signal?: AbortSignal,
	onEncodingDetected?: (encoding: string) => void,
): Promise<string> {
	const parts: string[] = [];
	for await (const text of decodeTextChunks([source], path, encoding, signal, onEncodingDetected)) parts.push(text);
	return parts.join("");
}
