import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { getAgentDir } from "../config.ts";
import { stateFile } from "../core/agent-paths.ts";
import { OllamaRuntime } from "../core/models/local-runtime.ts";
import { redactKnownSecrets } from "../core/security/secret-text.ts";
import { writeFileAtomicSync } from "../core/util/atomic-file.ts";

export async function runLfm3BlobImport(args: string[]): Promise<void> {
	const values = new Map<string, string>();
	for (let i = 0; i < args.length; i++) {
		const key = args[i];
		if (!key || !["--file", "--sha256", "--size"].includes(key) || values.has(key))
			throw new Error(`Unknown or duplicate argument: ${key}`);
		const value = args[++i];
		if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
		values.set(key, value);
	}
	const file = values.get("--file");
	const digest = values.get("--sha256");
	const rawSize = values.get("--size");
	if (!file || !digest || !rawSize || !/^[1-9][0-9]*$/.test(rawSize) || !/^[0-9a-f]{64}$/.test(digest))
		throw new Error("Usage: pi lfm3 import-blob --file PATH --sha256 LOWERCASE_HEX --size BYTES");
	const size = Number(rawSize);
	if (!Number.isSafeInteger(size)) throw new Error("Blob size exceeds safe integer range");
	const agentDir = getAgentDir();
	const runtime = new OllamaRuntime({ agentDir });
	const controller = new AbortController();
	const abort = () => controller.abort(new Error("Blob import interrupted"));
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	let outcome = "failed";
	let failure: unknown;
	try {
		const status = await runtime.detect();
		controller.signal.throwIfAborted();
		if (status.serverUp)
			throw new Error("An Ollama server is already running and its ownership cannot be established; stop it first");
		if (status.binarySource !== "pi-owned") throw new Error("Pi-managed Ollama is not installed");
		const started = await runtime.start({ retainForOperation: true });
		controller.signal.throwIfAborted();
		if (!started.started) throw new Error(`Ollama start: ${started.reason}`);
		await runtime.importVerifiedBlob({
			file: resolve(file),
			sha256: digest,
			size,
			signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)]),
		});
		outcome = "imported";
	} catch (error) {
		failure = error;
	} finally {
		process.removeListener("SIGINT", abort);
		process.removeListener("SIGTERM", abort);
		try {
			await runtime.stopAndWait();
		} catch (error) {
			failure = failure ? new AggregateError([failure, error], "Blob import and runtime shutdown failed") : error;
			outcome = "failed";
		}
		const describe = (error: unknown): string => {
			if (error instanceof Error && "code" in error && typeof error.code === "string")
				return `${error.name}: ${error.code.slice(0, 64)}`;
			const message =
				error instanceof AggregateError
					? error.errors.map(describe).join("; ")
					: error instanceof Error
						? error.message
						: String(error);
			return redactKnownSecrets(message.replaceAll(resolve(file), "[source path]")).slice(0, 2048);
		};
		try {
			writeFileAtomicSync(
				stateFile(agentDir, "lfm3-blob-import.json"),
				`${JSON.stringify({ at: new Date().toISOString(), status: outcome, filePathSha256: createHash("sha256").update(resolve(file)).digest("hex"), sha256: digest, size, ...(failure ? { error: describe(failure) } : {}) })}\n`,
				{ mode: 0o600 },
			);
		} catch (error) {
			failure = failure ? new AggregateError([failure, error], "Blob import and handoff persistence failed") : error;
		}
	}
	if (failure) throw failure;
	process.stdout.write(
		`Blob imported and verified: sha256:${digest} (${size} bytes). Model installation and fitness are separate.\n`,
	);
}
