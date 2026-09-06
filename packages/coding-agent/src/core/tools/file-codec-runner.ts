import { join } from "node:path";
import { getBundledResourcesDir } from "../../config.ts";
import { execCommand } from "../exec.ts";
import { awaitPreflight } from "../preflight.ts";
import { ensurePythonRuntime } from "../python-runtime.ts";

const MAX_PROTOCOL_UNITS = 64 * 1024 * 1024;

export const ENCODING_EVIDENCE_REQUIRED =
	"PI_FILE_ENCODING_CORRUPTION: Source encoding is unknown or malformed. Establish its encoding from authoritative project metadata or ask the user, then call read or edit with encoding. No file write was attempted.";

/** One transport for the packaged, path-free codec. Consumers validate operation-specific fields. */
export async function createFileCodecRunner(signal?: AbortSignal) {
	if (signal?.aborted) throw new Error("Encoding recovery aborted");
	const runtime = await awaitPreflight(() => ensurePythonRuntime({ silent: true }), signal);
	if (runtime.status !== "ready") throw new Error(`Encoding recovery requires Python: ${runtime.reason}`);
	const resources = getBundledResourcesDir();
	return async (request: Record<string, unknown>) => {
		if (signal?.aborted) throw new Error("Encoding recovery aborted");
		const stdin = JSON.stringify(request);
		if (Buffer.byteLength(stdin) > MAX_PROTOCOL_UNITS)
			throw new Error("Encoding recovery request exceeds its bound.");
		const result = await execCommand(
			runtime.pythonPath,
			["-I", "-S", "-B", join(resources, "runtimes", "file-edit-codec.py")],
			resources,
			{ stdin, signal, timeout: 30_000, maxBuffer: MAX_PROTOCOL_UNITS },
		);
		if (signal?.aborted) throw new Error("Encoding recovery aborted");
		let response: unknown;
		try {
			response = JSON.parse(result.stdout);
		} catch {
			/* A malformed/truncated response is never evidence. */
		}
		const complete = !result.killed && !result.errorMessage && !result.stdoutTruncated && !result.stderrTruncated;
		if (
			result.code === 1 &&
			complete &&
			response &&
			typeof response === "object" &&
			"error" in response &&
			response.error === "encoding_required"
		)
			throw new Error(ENCODING_EVIDENCE_REQUIRED);
		if (result.code !== 0 || !complete) {
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
			state: "state" in response ? response.state : undefined,
		};
	};
}
