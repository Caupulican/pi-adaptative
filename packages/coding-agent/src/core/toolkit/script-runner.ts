import { execFile } from "node:child_process";
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

/** Default executor: real process spawn, no shell interpolation, bounded output and time. */
export const spawnScriptExecutor: ScriptExecutor = (command, argv, cwd, timeoutMs) =>
	new Promise((resolve) => {
		const started = Date.now();
		execFile(
			command,
			argv,
			{ cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf-8" },
			(error, stdout, stderr) => {
				const durationMs = Date.now() - started;
				const err = error as (Error & { killed?: boolean; code?: number | string }) | null;
				// error.code is a NUMBER for a non-zero exit but a STRING for spawn-level failures
				// (ENOENT, EACCES) and for the maxBuffer kill — which also sets killed=true and must
				// not be mislabeled as a timeout.
				const maxBufferExceeded = err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
				const timedOut = Boolean(err?.killed) && !maxBufferExceeded;
				const exitCode = err ? (typeof err.code === "number" ? err.code : null) : 0;
				// Spawn-level failures never produce their own stderr; surface the error message so
				// the cause (missing runner, permission, output overflow) is never silently dropped.
				let capturedStderr = stderr ?? "";
				if (err && !timedOut && typeof err.code !== "number" && capturedStderr.length === 0) {
					capturedStderr = err.message;
				}
				resolve({
					exitCode,
					stdout: stdout ?? "",
					stderr: capturedStderr,
					durationMs,
					timedOut,
				});
			},
		);
	});

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
