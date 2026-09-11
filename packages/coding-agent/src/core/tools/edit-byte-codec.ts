import { splitBom } from "../../utils/text.ts";
import type { EditSourceSplice } from "./edit-diff.ts";
import { createFileCodecRunner } from "./file-codec-runner.ts";
import { decodeUtf8ForEdit } from "./file-encoding-policy.ts";

const MAX_SOURCE_BYTES = 16 * 1024 * 1024;

/** Pure codec port: receives bytes, never a filesystem path or model-authored program. */
export interface EditByteCodec {
	decode(
		source: Buffer,
		encoding: string | undefined,
		signal?: AbortSignal,
	): Promise<{
		text: string;
		encoding: string;
		/** True when the codec resolved the encoding itself, with nothing declaring it. */
		detected: boolean;
		encode(splices: readonly EditSourceSplice[]): Promise<Buffer>;
	}>;
}

/** Preview and execution use the same decoding decision; only execution may encode/write. */
export async function decodeEditDocument(source: Buffer, path: string, encoding?: string, signal?: AbortSignal) {
	if (encoding === undefined) {
		try {
			const native = splitBom(decodeUtf8ForEdit(source, path));
			return { ...native, recovery: undefined };
		} catch {
			// The native text operation is unsupported, not the user's edit task.
		}
	}
	const recovery = await pythonEditByteCodec.decode(source, encoding, signal);
	return { text: recovery.text, bom: "", recovery };
}

export const pythonEditByteCodec: EditByteCodec = {
	async decode(source, encoding, signal) {
		if (signal?.aborted) throw new Error("Encoding recovery aborted");
		if (source.length > MAX_SOURCE_BYTES) throw new Error("Encoding recovery exceeds the 16 MiB source bound.");
		const original = source.toString("base64");
		const run = await createFileCodecRunner(signal);
		const decoded = await run({ operation: "decode", source: original, encoding });
		if (!("text" in decoded) || typeof decoded.text !== "string" || !decoded.text.isWellFormed())
			throw new Error("Invalid decoded text");
		return {
			text: decoded.text,
			encoding: decoded.encoding,
			detected: decoded.detected,
			async encode(splices) {
				const encoded = await run({ operation: "splice", source: original, encoding, splices });
				if (!("bytes" in encoded) || typeof encoded.bytes !== "string" || encoded.encoding !== decoded.encoding)
					throw new Error("Invalid encoded recovery result");
				const bytes = Buffer.from(encoded.bytes, "base64");
				if (bytes.length > MAX_SOURCE_BYTES || bytes.toString("base64") !== encoded.bytes)
					throw new Error("Invalid encoded recovery bytes");
				return bytes;
			},
		};
	},
};
