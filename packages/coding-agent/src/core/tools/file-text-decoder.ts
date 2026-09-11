import { createHash } from "node:crypto";
import { AgentToolExecutionError } from "@caupulican/pi-agent-core/types";
import { ENCODING_EVIDENCE_REQUIRED } from "./file-codec-runner.ts";
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
 * A read that cannot decode its bytes is a read problem with a read remedy: name the encoding, or
 * declare it once for the file type. It is not the edit contract's "replacement is unsafe", and it
 * never means the model should abandon the tool for a hand-rolled decode in a shell.
 */
function readEncodingRequiredError(path: string, evidence: UndecodableByte): AgentToolExecutionError {
	return new AgentToolExecutionError(
		`${READ_ENCODING_REQUIRED_MARKER}: ${path} is not valid UTF-8 (first invalid byte at line ${evidence.line}, byte offset ${evidence.offset}). Re-read with encoding (for example "windows-1252" for Delphi/Windows sources) or declare it once in .editorconfig ([*.pas] charset = latin1). No edit was attempted.`,
		READ_ENCODING_REQUIRED_FAILURE_CODE,
		createHash("sha256").update(`${path}\0${evidence.offset}`).digest("base64url"),
		"tool_failure",
	);
}

/** Read-only decoding. Unlike edits, reads need no canonical byte round-trip or splice proof. */
export async function* decodeTextChunks(
	chunks: AsyncIterable<Buffer> | Iterable<Buffer>,
	path: string,
	encoding?: string,
	signal?: AbortSignal,
): AsyncGenerator<string> {
	if (signal?.aborted) throw new Error("Encoding recovery aborted");
	const native = new TextDecoder("utf-8", { fatal: true });
	let consumedBytes = 0;
	let consumedNewlines = 0;
	let heldTail: Buffer = EMPTY;
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
			consumedBytes += bytes.length;
			consumedNewlines += countNewlines(bytes);
			heldTail = final ? EMPTY : incompleteUtf8Tail(bytes);
			return text;
		} catch {
			evidence ??= locate(bytes, final);
			throw new Error(ENCODING_EVIDENCE_REQUIRED);
		}
	};
	let selected = false;
	let prefix: Buffer = Buffer.alloc(0);
	let run: Awaited<ReturnType<typeof createFileCodecReadSession>> | undefined;
	let decoded = false;
	let selectedEncoding = encoding;
	const decode = async (bytes: Buffer, final: boolean): Promise<string> => {
		if (signal?.aborted) throw new Error("Encoding recovery aborted");
		if (!selected) {
			selected = true;
			if (encoding === undefined) {
				try {
					return decodeNative(bytes, final);
				} catch {
					// BOM-marked input can recover; ambiguous input requires explicit evidence.
				}
			}
			run = await createFileCodecReadSession(signal);
		}
		if (!run) return decodeNative(bytes, final);
		const result = await run.decode(bytes, selectedEncoding, final);
		if (decoded && result.encoding !== selectedEncoding) {
			throw new Error("Invalid incremental encoding response");
		}
		decoded = true;
		selectedEncoding = result.encoding;
		return result.text;
	};
	try {
		for await (const chunk of chunks) {
			if (signal?.aborted) throw new Error("Encoding recovery aborted");
			for (let start = 0; start < chunk.length; start += DECODE_CHUNK_BYTES) {
				let bytes = chunk.subarray(start, start + DECODE_CHUNK_BYTES);
				if (!selected) {
					bytes = Buffer.concat([prefix, bytes]);
					if (bytes.length < 4) {
						prefix = bytes;
						continue;
					}
					prefix = Buffer.alloc(0);
				}
				yield await decode(bytes, false);
				if (signal?.aborted) throw new Error("Encoding recovery aborted");
			}
		}
		yield await decode(prefix, true);
	} catch (error) {
		// Only an unnamed encoding is a read-encoding problem: with a named codec the failure is the
		// codec's own, and the edit contract's diagnostic stands.
		throw encoding === undefined &&
			evidence !== undefined &&
			error instanceof Error &&
			error.message === ENCODING_EVIDENCE_REQUIRED
			? readEncodingRequiredError(path, evidence)
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
): Promise<string> {
	const parts: string[] = [];
	for await (const text of decodeTextChunks([source], path, encoding, signal)) parts.push(text);
	return parts.join("");
}
