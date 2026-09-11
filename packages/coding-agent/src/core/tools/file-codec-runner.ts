import { join } from "node:path";
import { getBundledResourcesDir } from "../../config.ts";
import { execCommand } from "../exec.ts";
import { awaitPreflight } from "../preflight.ts";
import { ensurePythonRuntime } from "../python-runtime.ts";

export const MAX_FILE_CODEC_PROTOCOL_BYTES = 64 * 1024 * 1024;
export const FILE_CODEC_TIMEOUT_MS = 30_000;

export const ENCODING_EVIDENCE_REQUIRED =
	"PI_FILE_ENCODING_CORRUPTION: Source encoding is unknown or malformed. Establish its encoding from authoritative project metadata or ask the user, then call read or edit with encoding. No file write was attempted.";

/**
 * The managed interpreter is missing, so the codec cannot resolve or preserve anything. Callers
 * that can still describe a remedy (read naming the file it could not decode) need the reason, not
 * a prose message they would have to parse.
 */
export class PythonCodecUnavailableError extends Error {
	readonly reason: string;

	constructor(reason: string) {
		super(`Encoding recovery requires Python: ${reason}`);
		this.name = "PythonCodecUnavailableError";
		this.reason = reason;
	}
}

export async function resolveFileCodecLaunch(signal?: AbortSignal) {
	if (signal?.aborted) throw new Error("Encoding recovery aborted");
	const runtime = await awaitPreflight(() => ensurePythonRuntime({ silent: true }), signal);
	if (runtime.status !== "ready") throw new PythonCodecUnavailableError(runtime.reason);
	const resources = getBundledResourcesDir();
	return {
		command: runtime.pythonPath,
		args: ["-I", "-S", "-B", join(resources, "runtimes", "file-edit-codec.py")],
		cwd: resources,
	};
}

/** The one replacement character the resolved codec has no bytes for, when the helper named it. */
function unrepresentableReplacement(detail: unknown): { character: string; encoding: string } | undefined {
	if (!detail || typeof detail !== "object") return undefined;
	const { character, encoding } = detail as { character?: unknown; encoding?: unknown };
	return typeof character === "string" && character.length > 0 && typeof encoding === "string"
		? { character, encoding }
		: undefined;
}

export function fileCodecRecoveryError(reason?: unknown, detail?: unknown): Error {
	if (reason === "encoding_required") return new Error(ENCODING_EVIDENCE_REQUIRED);
	if (reason === "replacement_unrepresentable") {
		const named = unrepresentableReplacement(detail);
		return new Error(
			`PI_FILE_ENCODING_CORRUPTION: The replacement cannot be represented in ${
				named ? `${named.encoding} (first offending character "${named.character}")` : "the file's encoding"
			}. Keep the replacement within that encoding, or convert the file first. No file write was attempted.`,
		);
	}
	if (reason === "codec_unavailable")
		return new Error(
			"PI_FILE_ENCODING_CORRUPTION: Python lacks the requested codec and iconv is unavailable. Make iconv available to Pi; only change the encoding name if authoritative metadata shows it was incorrect. No file write was attempted.",
		);
	return new Error(
		"PI_FILE_ENCODING_CORRUPTION: Python codec recovery could not verify preservation. Check source encoding/BOM and replacement representability; no file write was attempted.",
	);
}

/** One-shot edit transport. Read streams own a separate, explicitly closed process lifecycle. */
export async function createFileCodecRunner(signal?: AbortSignal) {
	const launch = await resolveFileCodecLaunch(signal);
	return async (request: Record<string, unknown>) => {
		if (signal?.aborted) throw new Error("Encoding recovery aborted");
		const stdin = JSON.stringify(request);
		if (Buffer.byteLength(stdin) > MAX_FILE_CODEC_PROTOCOL_BYTES)
			throw new Error("Encoding recovery request exceeds its bound.");
		const result = await execCommand(launch.command, launch.args, launch.cwd, {
			stdin,
			signal,
			timeout: FILE_CODEC_TIMEOUT_MS,
			maxBuffer: MAX_FILE_CODEC_PROTOCOL_BYTES,
		});
		if (signal?.aborted) throw new Error("Encoding recovery aborted");
		let response: unknown;
		try {
			response = JSON.parse(result.stdout);
		} catch {
			/* A malformed/truncated response is never evidence. */
		}
		const complete = !result.killed && !result.errorMessage && !result.stdoutTruncated && !result.stderrTruncated;
		if (result.code === 1 && complete && response && typeof response === "object" && "error" in response) {
			throw fileCodecRecoveryError(response.error, "detail" in response ? response.detail : undefined);
		}
		if (result.code !== 0 || !complete) {
			throw fileCodecRecoveryError();
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
			detected: "detected" in response && response.detected === true,
			text: "text" in response ? response.text : undefined,
			bytes: "bytes" in response ? response.bytes : undefined,
		};
	};
}
