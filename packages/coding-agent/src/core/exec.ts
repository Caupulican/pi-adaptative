/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { spawn } from "node:child_process";
import { waitForChildProcess } from "../utils/child-process.ts";

/** Default per-stream retention for command output, in UTF-16 code units (~bytes for ASCII). */
const DEFAULT_EXEC_MAX_BUFFER = 16 * 1024 * 1024;

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
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const maxBuffer =
			options?.maxBuffer !== undefined && options.maxBuffer > 0 ? options.maxBuffer : DEFAULT_EXEC_MAX_BUFFER;
		const stdout = createRollingOutputBuffer(maxBuffer);
		const stderr = createRollingOutputBuffer(maxBuffer);
		let killed = false;
		let timeoutId: NodeJS.Timeout | undefined;

		const killProcess = () => {
			if (!killed) {
				killed = true;
				proc.kill("SIGTERM");
				// Force kill after 5 seconds if SIGTERM doesn't work
				setTimeout(() => {
					if (!proc.killed) {
						proc.kill("SIGKILL");
					}
				}, 5000);
			}
		};

		// Handle abort signal
		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		// Handle timeout
		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		proc.stdout?.on("data", (data) => {
			stdout.push(data.toString());
		});

		proc.stderr?.on("data", (data) => {
			stderr.push(data.toString());
		});

		const settle = (code: number) => {
			if (timeoutId) clearTimeout(timeoutId);
			if (options?.signal) {
				options.signal.removeEventListener("abort", killProcess);
			}
			resolve({
				stdout: stdout.text(),
				stderr: stderr.text(),
				code,
				killed,
				stdoutTruncated: stdout.truncated(),
				stderrTruncated: stderr.truncated(),
			});
		};

		// Wait for process termination without hanging on inherited stdio handles
		// held open by detached descendants.
		waitForChildProcess(proc)
			.then((code) => settle(code ?? 0))
			.catch((_err) => settle(1));
	});
}
