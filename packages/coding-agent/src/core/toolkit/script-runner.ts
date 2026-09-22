import { spawnProcess, waitForChildProcessWithTermination } from "../../utils/child-process.ts";
import { awaitOwnedProcessGroup } from "../../utils/process-group-wait.ts";
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
	signal?: AbortSignal,
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
export const spawnScriptExecutor: ScriptExecutor = async (command, argv, cwd, timeoutMs, signal) => {
	const started = Date.now();
	if (signal?.aborted) {
		return { exitCode: null, stdout: "", stderr: "aborted", durationMs: 0, timedOut: false };
	}
	const terminationController = new AbortController();
	const abort = () => terminationController.abort();
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	let stdoutBytes = 0;
	let stderrBytes = 0;
	let outputExceeded = false;
	const renderStderr = (failure?: string): string => {
		const diagnostics = [Buffer.concat(stderrChunks).toString("utf8")];
		if (outputExceeded) diagnostics.push(`Command output exceeded maxBuffer (${MAX_OUTPUT_BYTES} bytes)`);
		if (failure !== undefined) diagnostics.push(failure);
		return diagnostics.filter((diagnostic) => diagnostic.length > 0).join("\n");
	};
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
		signal?.addEventListener("abort", abort, { once: true });
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
		await awaitOwnedProcessGroup(child.pid, cwd, terminationController.signal);
		const stdout = Buffer.concat(stdoutChunks).toString("utf8");
		return {
			// A cooperative child can exit zero after termination was requested. Preserve the
			// waiter's reason: only an ordinary exit establishes the script's own exit status.
			exitCode: outputExceeded || terminal.reason !== "exited" ? null : terminal.code,
			stdout,
			stderr: renderStderr(),
			durationMs: Date.now() - started,
			timedOut: terminal.reason === "timeout",
		};
	} catch (error) {
		return {
			exitCode: null,
			stdout: Buffer.concat(stdoutChunks).toString("utf8"),
			stderr: renderStderr(error instanceof Error ? error.message : String(error)),
			durationMs: Date.now() - started,
			timedOut: false,
		};
	} finally {
		signal?.removeEventListener("abort", abort);
	}
};

export async function executeToolkitScript(args: {
	script: ToolkitScript;
	scriptArgs: readonly string[];
	cwd: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	executor?: ScriptExecutor;
}): Promise<ScriptExecution> {
	const { command, argv } = buildScriptArgv(args.script, args.scriptArgs);
	const executor = args.executor ?? spawnScriptExecutor;
	return executor(command, argv, args.cwd, args.timeoutMs ?? 120_000, args.signal);
}
