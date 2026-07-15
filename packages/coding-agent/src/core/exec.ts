/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { waitForChildProcessWithTermination } from "../utils/child-process.ts";

/** Default per-stream retention for command output, in UTF-16 code units (~bytes for ASCII). */
const DEFAULT_EXEC_MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60_000;
const EXEC_KILL_GRACE_MS = 5_000;

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
	/** Environment for the child process. Defaults to process.env. */
	env?: NodeJS.ProcessEnv;
	/**
	 * Maximum output retained per stream, in UTF-16 code units (~bytes for ASCII).
	 * Output is kept as a rolling tail; when exceeded, the oldest output is dropped
	 * and the matching truncation flag is set on the result. Defaults to 16 MiB.
	 */
	maxBuffer?: number;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
	/** True when stdout exceeded maxBuffer and only its tail was retained. */
	stdoutTruncated: boolean;
	/** True when stderr exceeded maxBuffer and only its tail was retained. */
	stderrTruncated: boolean;
	/** Present when the process failed to spawn (e.g. ENOENT); code is 1 in that case. */
	errorMessage?: string;
}

export interface RollingOutputBuffer {
	push(chunk: string): void;
	text(): string;
	truncated(): boolean;
}

/** Bounded child-process output accumulator: keeps a rolling tail of at most maxUnits UTF-16 units. */
export function createRollingOutputBuffer(maxUnits: number): RollingOutputBuffer {
	const chunks: string[] = [];
	let units = 0;
	let truncated = false;
	return {
		push(chunk: string): void {
			chunks.push(chunk);
			units += chunk.length;
			while (units > maxUnits && chunks.length > 1) {
				units -= chunks.shift()?.length ?? 0;
				truncated = true;
			}
			if (units > maxUnits) {
				chunks[0] = chunks[0].slice(-maxUnits);
				units = chunks[0].length;
				truncated = true;
			}
		},
		text(): string {
			return chunks.join("");
		},
		truncated(): boolean {
			return truncated;
		},
	};
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal. Output retention per stream is bounded
 * (rolling tail, see ExecOptions.maxBuffer) so a chatty child process cannot
 * grow the host heap without bound.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			env: options?.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});

		let spawnError: string | undefined;
		proc.once("error", (err) => {
			spawnError = err.message;
		});

		const maxBuffer =
			options?.maxBuffer !== undefined && options.maxBuffer > 0 ? options.maxBuffer : DEFAULT_EXEC_MAX_BUFFER;
		const stdout = createRollingOutputBuffer(maxBuffer);
		const stderr = createRollingOutputBuffer(maxBuffer);
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");

		proc.stdout?.on("data", (data: Buffer) => {
			stdout.push(stdoutDecoder.write(data));
		});

		proc.stderr?.on("data", (data: Buffer) => {
			stderr.push(stderrDecoder.write(data));
		});

		// Settle from the child's terminal event or a bounded abort/timeout escalation.
		// This never waits for a second close event after termination has been acknowledged.
		waitForChildProcessWithTermination(proc, {
			signal: options?.signal,
			timeoutMs: options?.timeout && options.timeout > 0 ? options.timeout : DEFAULT_EXEC_TIMEOUT_MS,
			killGraceMs: EXEC_KILL_GRACE_MS,
		})
			.then((terminal) => {
				stdout.push(stdoutDecoder.end());
				stderr.push(stderrDecoder.end());
				resolve({
					stdout: stdout.text(),
					stderr: stderr.text(),
					code: terminal.code ?? 1,
					killed: terminal.reason !== "exited",
					stdoutTruncated: stdout.truncated(),
					stderrTruncated: stderr.truncated(),
					...(spawnError !== undefined ? { errorMessage: spawnError } : {}),
				});
			})
			.catch((err) => {
				stdout.push(stdoutDecoder.end());
				stderr.push(stderrDecoder.end());
				if (spawnError === undefined) {
					spawnError = err instanceof Error ? err.message : String(err);
				}
				resolve({
					stdout: stdout.text(),
					stderr: stderr.text(),
					code: 1,
					killed: false,
					stdoutTruncated: stdout.truncated(),
					stderrTruncated: stderr.truncated(),
					errorMessage: spawnError,
				});
			});
	});
}
