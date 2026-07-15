import { spawnProcess, waitForChildProcessWithTermination } from "../../utils/child-process.ts";
import type { ToolkitScript } from "./script-registry.ts";

/**
 * Toolkit script invocation: the harness owns execution. Fixed argv per runner (never a shell
 * string), captured exit/stdout/stderr ALWAYS — the structural error contract that makes
 * false-success impossible regardless of what the model narrates.
 */

export interface ScriptExecution {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
}

export type ScriptExecutor = (
	command: string,
	argv: string[],
	cwd: string,
	timeoutMs: number,
) => Promise<ScriptExecution>;

export function buildScriptArgv(script: ToolkitScript, args: readonly string[]): { command: string; argv: string[] } {
	switch (script.runner) {
		case "uv":
			return { command: "uv", argv: ["run", script.path, ...args] };
		case "powershell":
			return {
				command: "powershell.exe",
				argv: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script.path, ...args],
			};
		case "bash":
			return { command: "bash", argv: [script.path, ...args] };
	}
}

const MAX_OUTPUT_BYTES = 512 * 1024;
const SCRIPT_KILL_GRACE_MS = 2_000;

/** Default executor: real process spawn, no shell interpolation, bounded output and time. */
export const spawnScriptExecutor: ScriptExecutor = async (command, argv, cwd, timeoutMs) => {
	const started = Date.now();
	const terminationController = new AbortController();
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	let stdoutBytes = 0;
	let stderrBytes = 0;
	let outputExceeded = false;
	const appendChunk = (chunks: Buffer[], chunk: Buffer, streamBytes: number): number => {
		const remaining = Math.max(0, MAX_OUTPUT_BYTES - streamBytes);
		if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
		const nextBytes = streamBytes + chunk.length;
		if (nextBytes > MAX_OUTPUT_BYTES) {
			outputExceeded = true;
			terminationController.abort();
		}
		return nextBytes;
	};

	try {
		const child = spawnProcess(command, argv, {
			cwd,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutBytes = appendChunk(stdoutChunks, chunk, stdoutBytes);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrBytes = appendChunk(stderrChunks, chunk, stderrBytes);
		});
		const terminal = await waitForChildProcessWithTermination(child, {
			signal: terminationController.signal,
			timeoutMs,
			killGraceMs: SCRIPT_KILL_GRACE_MS,
		});
		const stdout = Buffer.concat(stdoutChunks).toString("utf8");
		let stderr = Buffer.concat(stderrChunks).toString("utf8");
		if (outputExceeded) {
			stderr = `${stderr}${stderr ? "\n" : ""}Command output exceeded maxBuffer (${MAX_OUTPUT_BYTES} bytes)`;
		}
		return {
			exitCode: outputExceeded ? null : terminal.code,
			stdout,
			stderr,
			durationMs: Date.now() - started,
			timedOut: terminal.reason === "timeout",
		};
	} catch (error) {
		return {
			exitCode: null,
			stdout: Buffer.concat(stdoutChunks).toString("utf8"),
			stderr: error instanceof Error ? error.message : String(error),
			durationMs: Date.now() - started,
			timedOut: false,
		};
	}
};

export async function executeToolkitScript(args: {
	script: ToolkitScript;
	scriptArgs: readonly string[];
	cwd: string;
	timeoutMs?: number;
	executor?: ScriptExecutor;
}): Promise<ScriptExecution> {
	const { command, argv } = buildScriptArgv(args.script, args.scriptArgs);
	const executor = args.executor ?? spawnScriptExecutor;
	return executor(command, argv, args.cwd, args.timeoutMs ?? 120_000);
}
