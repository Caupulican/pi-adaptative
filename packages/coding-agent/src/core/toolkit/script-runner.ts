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
				const killed = Boolean(error && "killed" in error && (error as { killed?: boolean }).killed);
				const code =
					error && typeof (error as { code?: unknown }).code === "number"
						? ((error as { code: number }).code as number)
						: error
							? null
							: 0;
				resolve({
					exitCode: error ? code : 0,
					stdout: stdout ?? "",
					stderr: stderr ?? "",
					durationMs,
					timedOut: killed,
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
