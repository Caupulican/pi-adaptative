import { resolve } from "node:path";
import { detectSupportedImageMimeType, IMAGE_TYPE_SNIFF_BYTES } from "../../utils/mime.ts";
import { type FileEncodingRule, resolveFileEncoding } from "./file-encoding-metadata.ts";
import { decodeReadText } from "./file-text-decoder.ts";
import type { LocalReadSession } from "./local-read-io.ts";

/** Decode only captured source bytes; metadata and codec work share the observation's budget. */
export async function readBoundedLocalText(
	io: LocalReadSession,
	path: string,
	cwd: string,
	options?: { encoding?: string; fileEncodings?: readonly FileEncodingRule[] },
) {
	const prefix = await io.readFile(path, IMAGE_TYPE_SNIFF_BYTES);
	if (detectSupportedImageMimeType(prefix)) throw new Error("Proactive local reads support text sources, not images");
	const declared = await resolveFileEncoding(path, cwd, {
		argument: options?.encoding,
		fileEncodings: options?.fileEncodings,
		stopAt: resolve(cwd),
		signal: io.operation.signal,
		readFile: async (candidate) => {
			if (!(await io.stat(candidate)))
				throw Object.assign(new Error("Encoding metadata is absent"), { code: "ENOENT" });
			return io.readFile(candidate);
		},
	});
	const bytes = await io.readFile(path);
	let detected: string | undefined;
	const text = await decodeReadText(
		bytes,
		path,
		declared?.encoding,
		io.operation.signal,
		(name) => {
			detected = name;
		},
		io.operation,
	);
	io.operation.assertCurrent();
	return { text, declared, detected };
}
