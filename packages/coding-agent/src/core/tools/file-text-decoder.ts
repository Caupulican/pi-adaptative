import { ENCODING_EVIDENCE_REQUIRED } from "./file-codec-runner.ts";
import { createFileCodecReadSession } from "./file-codec-stream.ts";

const DECODE_CHUNK_BYTES = 1024 * 1024;

/** Read-only decoding. Unlike edits, reads need no canonical byte round-trip or splice proof. */
export async function* decodeTextChunks(
	chunks: AsyncIterable<Buffer> | Iterable<Buffer>,
	encoding?: string,
	signal?: AbortSignal,
): AsyncGenerator<string> {
	if (signal?.aborted) throw new Error("Encoding recovery aborted");
	const native = new TextDecoder("utf-8", { fatal: true });
	const decodeNative = (bytes: Buffer, final: boolean) => {
		try {
			if (bytes.includes(0)) throw new Error("NUL-bearing input");
			return native.decode(bytes, { stream: !final });
		} catch {
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
	} finally {
		await run?.close();
	}
}

export async function decodeReadText(source: Buffer, encoding?: string, signal?: AbortSignal): Promise<string> {
	const parts: string[] = [];
	for await (const text of decodeTextChunks([source], encoding, signal)) parts.push(text);
	return parts.join("");
}
