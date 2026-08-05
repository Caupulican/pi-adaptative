import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnProcess, spawnProcessSync, waitForChildProcessWithTermination } from "../../utils/child-process.ts";
import { sleep } from "../../utils/sleep.ts";
import { extractZipFile } from "../../utils/zip-extractor.ts";
import { createRollingOutputBuffer } from "../exec.ts";

export interface RuntimeCommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	code?: number | null;
	error?: string;
}

export interface RuntimeCommandOptions {
	env?: NodeJS.ProcessEnv;
	onOutput?: (chunk: string) => void;
}

export type RuntimeCommandRunner = (
	command: string,
	args: string[],
	options?: RuntimeCommandOptions,
) => Promise<RuntimeCommandResult>;

export interface RuntimeCommandRunnerLimits {
	timeoutMs: number;
	killGraceMs: number;
	maxOutputUnits?: number;
}

const DEFAULT_RUNTIME_OUTPUT_UNITS = 1024 * 1024;

/**
 * Build a runtime-management command runner with one bounded process lifecycle.
 * Output is retained as chunk tails and flattened once, after the child reaches a terminal state.
 */
export function createRuntimeCommandRunner(limits: RuntimeCommandRunnerLimits): RuntimeCommandRunner {
	const requestedOutputUnits = limits.maxOutputUnits ?? DEFAULT_RUNTIME_OUTPUT_UNITS;
	const maxOutputUnits =
		Number.isFinite(requestedOutputUnits) && requestedOutputUnits > 0
			? Math.floor(requestedOutputUnits)
			: DEFAULT_RUNTIME_OUTPUT_UNITS;
	return async (command, args, options = {}) => {
		try {
			const proc = spawnProcess(command, args, {
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
				env: options.env ? { ...process.env, ...options.env } : process.env,
			});
			const stdout = createRollingOutputBuffer(maxOutputUnits);
			const stderr = createRollingOutputBuffer(maxOutputUnits);
			proc.stdout.setEncoding("utf8");
			proc.stderr.setEncoding("utf8");
			proc.stdout.on("data", (chunk: string) => {
				stdout.push(chunk);
				options.onOutput?.(chunk);
			});
			proc.stderr.on("data", (chunk: string) => {
				stderr.push(chunk);
				options.onOutput?.(chunk);
			});
			const terminal = await waitForChildProcessWithTermination(proc, {
				timeoutMs: limits.timeoutMs,
				killGraceMs: limits.killGraceMs,
			});
			const stdoutText = stdout.text();
			const stderrText = stderr.text();
			return {
				ok: terminal.code === 0,
				stdout: stdoutText,
				stderr: stderrText,
				code: terminal.code,
				...(terminal.code === 0
					? {}
					: {
							error:
								terminal.reason === "timeout"
									? `${command} timed out after ${limits.timeoutMs}ms`
									: stderrText.trim() || stdoutText.trim() || `exit code ${terminal.code ?? "unknown"}`,
						}),
			};
		} catch (error) {
			return {
				ok: false,
				stdout: "",
				stderr: "",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	};
}

type RuntimeCommandProbe = (
	command: string,
	args: string[],
	options: { encoding: "utf8"; timeout: number },
) => { error?: unknown };

export function runtimeCommandAvailable(command: string, probe: RuntimeCommandProbe = spawnProcessSync): boolean {
	// Node returns `undefined` on success; cross-spawn normalizes that field to `null` on Windows.
	// Both are the absence of an error. A strict undefined check made every Windows probe fail.
	return probe(command, ["--version"], { encoding: "utf8", timeout: 5_000 }).error == null;
}

export function runtimeSleep(ms: number): Promise<void> {
	return sleep(ms);
}

export type ManagedRuntimeChild = Pick<ChildProcess, "pid" | "kill" | "unref" | "on">;
export interface ManagedRuntimeSpawnOptions {
	detached?: boolean;
	stdio?: "ignore";
	env: NodeJS.ProcessEnv;
}
export type ManagedRuntimeSpawn = (
	command: string,
	args: string[],
	options: ManagedRuntimeSpawnOptions,
) => ManagedRuntimeChild;

export function spawnManagedRuntime(
	command: string,
	args: string[],
	options: ManagedRuntimeSpawnOptions,
): ManagedRuntimeChild {
	return spawn(command, args, { ...options, stdio: "ignore" });
}

export interface RuntimeLifecycleDependencyOverrides {
	fetchFn?: typeof fetch;
	spawnFn?: ManagedRuntimeSpawn;
	existsFn?: (path: string) => boolean;
	sleepFn?: (ms: number) => Promise<void>;
}

export type RuntimeLifecycleDependencies = readonly [
	fetchFn: typeof fetch,
	spawnFn: ManagedRuntimeSpawn,
	existsFn: (path: string) => boolean,
	sleepFn: (ms: number) => Promise<void>,
];

/** Resolve the common runtime lifecycle boundary once, during construction. */
export function resolveRuntimeLifecycleDependencies(
	overrides?: RuntimeLifecycleDependencyOverrides,
): RuntimeLifecycleDependencies {
	return [
		overrides?.fetchFn ?? fetch,
		overrides?.spawnFn ?? spawnManagedRuntime,
		overrides?.existsFn ?? existsSync,
		overrides?.sleepFn ?? runtimeSleep,
	];
}

export type RuntimeDownloadResult =
	| { ok: true; response: Response; body: ReadableStream<Uint8Array> }
	| { ok: false; error: string };

type RuntimeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Validate a runtime download without consuming, decoding, or copying its response body. */
export async function fetchRuntimeDownload(
	fetchFn: RuntimeFetch,
	url: string,
	init?: RequestInit,
): Promise<RuntimeDownloadResult> {
	let response: Response;
	try {
		response = await fetchFn(url, init);
	} catch (error) {
		return { ok: false, error: `download-fail: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!response.ok || !response.body) return { ok: false, error: `download-fail: HTTP ${response.status}` };
	return { ok: true, response, body: response.body };
}

/** Download and extract a runtime archive without materializing or copying its body. */
export async function installRuntimeArchive<TInput extends NodeJS.ReadableStream, TKind extends string>(
	fetchFn: RuntimeFetch,
	downloadUrl: string,
	destDir: string,
	asset: { name: string; kind: TKind },
	extractArchive: (input: TInput, destDir: string, kind: TKind) => Promise<{ ok: boolean; error?: string }>,
	onProgress?: (status: string) => void,
): Promise<{ ok: boolean; error?: string }> {
	onProgress?.(`Downloading ${asset.name}…`);
	const download = await fetchRuntimeDownload(fetchFn, downloadUrl);
	if (!download.ok) return download;
	mkdirSync(destDir, { recursive: true });
	onProgress?.(`Extracting ${asset.name}…`);
	return extractArchive(download.body as unknown as TInput, destDir, asset.kind);
}

export function tryFileSizeBytes(path: string): number | undefined {
	try {
		return statSync(path).size;
	} catch {
		return undefined;
	}
}

export function removePartialDownload(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {
		// best-effort cleanup
	}
}

/** Wait for a failed pipeline's file descriptor to close before deleting its partial output. */
export function waitForWritableClosed(stream: Writable & { closed?: boolean }): Promise<void> {
	if (stream.closed) return Promise.resolve();
	return new Promise((resolve) => {
		stream.once("close", resolve);
		stream.destroy();
	});
}

/** Stream a runtime payload to disk, closing and deleting partial output on any failure. */
export async function writeRuntimeDownload(
	input: Readable,
	destPath: string,
	transform?: Transform,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const writeStream = createWriteStream(destPath);
	try {
		if (transform) await pipeline(input, transform, writeStream);
		else await pipeline(input, writeStream);
		return { ok: true };
	} catch (error) {
		await waitForWritableClosed(writeStream);
		removePartialDownload(destPath);
		return { ok: false, error: `download-fail: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export function requireRuntimeStdin(proc: ChildProcess, label: string): Writable {
	if (!proc.stdin) throw new Error(`${label}: no stdin pipe`);
	return proc.stdin;
}

export interface ExtractZipArchiveOptions {
	input: Readable;
	destDir: string;
	tempPrefix: string;
	platform: () => string;
	hasCommand: (command: string) => boolean;
	timeoutMs: number;
	killGraceMs: number;
}

/** Shared seekable-file extraction path for managed runtime zip archives. */
export async function extractZipArchive(options: ExtractZipArchiveOptions): Promise<{ ok: boolean; error?: string }> {
	const zipPath = join(options.destDir, "..", `${options.tempPrefix}-${process.pid}-${Date.now()}.zip`);
	try {
		await pipeline(options.input, createWriteStream(zipPath));
		await extractZipFile(zipPath, options.destDir);
		return { ok: true };
	} catch (error) {
		return { ok: false, error: `extract-fail: ${error instanceof Error ? error.message : String(error)}` };
	} finally {
		removePartialDownload(zipPath);
	}
}
