import { join } from "node:path";
import { getBundledResourcesDir } from "../../config.ts";
import { splitBom } from "../../utils/text.ts";
import { execCommand } from "../exec.ts";
import { ensurePythonRuntime } from "../python-runtime.ts";
import type { EditSourceSplice } from "./edit-diff.ts";
import { decodeUtf8ForEdit } from "./file-encoding-policy.ts";

const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_PROTOCOL_UNITS = 64 * 1024 * 1024;

/** Pure codec port: receives bytes, never a filesystem path or model-authored program. */
export interface EditByteCodec {
	decode(
		source: Buffer,
		encoding: string | undefined,
		signal?: AbortSignal,
	): Promise<{
		text: string;
		encoding: string;
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
		const runtime = await ensurePythonRuntime({ silent: true });
		if (runtime.status !== "ready") throw new Error(`Encoding recovery requires Python: ${runtime.reason}`);
		const resources = getBundledResourcesDir();
		const run = async (operation: "decode" | "splice", splices?: readonly EditSourceSplice[]) => {
			if (signal?.aborted) throw new Error("Encoding recovery aborted");
			const stdin = JSON.stringify({ operation, source: original, encoding, splices });
			if (Buffer.byteLength(stdin) > MAX_PROTOCOL_UNITS)
				throw new Error("Encoding recovery request exceeds its bound.");
			const result = await execCommand(
				runtime.pythonPath,
				["-I", "-S", "-B", join(resources, "runtimes", "file-edit-codec.py")],
				resources,
				{
					stdin,
					signal,
					timeout: 30_000,
					maxBuffer: MAX_PROTOCOL_UNITS,
				},
			);
			if (signal?.aborted) throw new Error("Encoding recovery aborted");
			let response: unknown;
			try {
				response = JSON.parse(result.stdout);
			} catch {
				/* A malformed/truncated response is never evidence. */
			}
			if (
				result.code === 1 &&
				!result.killed &&
				!result.errorMessage &&
				!result.stdoutTruncated &&
				response &&
				typeof response === "object" &&
				"error" in response &&
				response.error === "encoding_required"
			) {
				throw new Error(
					"PI_FILE_ENCODING_CORRUPTION: Source encoding is unknown. Establish its encoding from authoritative project metadata or ask the user, then call edit with encoding. No file write was attempted.",
				);
			}
			if (
				result.code !== 0 ||
				result.killed ||
				result.errorMessage ||
				result.stdoutTruncated ||
				result.stderrTruncated
			) {
				throw new Error(
					"PI_FILE_ENCODING_CORRUPTION: Python codec recovery could not verify preservation. Check source encoding/BOM and replacement representability; no file write was attempted.",
				);
			}
			if (
				!response ||
				typeof response !== "object" ||
				!("encoding" in response) ||
				typeof response.encoding !== "string"
			) {
				throw new Error("Invalid encoding recovery response");
			}
			return {
				encoding: response.encoding,
				text: "text" in response ? response.text : undefined,
				bytes: "bytes" in response ? response.bytes : undefined,
			};
		};
		const decoded = await run("decode");
		if (!("text" in decoded) || typeof decoded.text !== "string" || !decoded.text.isWellFormed())
			throw new Error("Invalid decoded text");
		return {
			text: decoded.text,
			encoding: decoded.encoding,
			async encode(splices) {
				const encoded = await run("splice", splices);
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
