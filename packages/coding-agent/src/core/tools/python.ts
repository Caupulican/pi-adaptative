import { stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type { AgentTool } from "@caupulican/pi-agent-core";
import type { TruncationResult } from "@caupulican/pi-agent-core/node";
import { Text } from "@caupulican/pi-tui";
import { type Static, Type } from "typebox";
import { spawnProcess, waitForChildProcessWithTermination } from "../../utils/child-process.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { ensurePythonRuntime, type PythonRuntimeOutcome } from "../python-runtime.ts";
import { withExclusiveMutationBarrier } from "./file-mutation-queue.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const DEFAULT_PYTHON_TIMEOUT_SECONDS = 30;
export const MAX_PYTHON_TIMEOUT_SECONDS = 300;
export const MAX_PYTHON_OUTPUT_BYTES = 200_000;
const MIN_PYTHON_OUTPUT_BYTES = 1_000;
const PYTHON_KILL_GRACE_MS = 2_000;

const pythonSchema = Type.Object(
	{
		code: Type.Optional(
			Type.String({
				description: "Python code to execute on stdin. Provide exactly one of code or scriptPath.",
				maxLength: 200_000,
			}),
		),
		scriptPath: Type.Optional(
			Type.String({
				description: "Python script path. Relative paths resolve from cwd; one leading @ is ignored.",
				maxLength: 32_768,
			}),
		),
		args: Type.Optional(
			Type.Array(Type.String({ maxLength: 16_384 }), {
				description: "Arguments passed directly to Python after '-' or scriptPath; no shell interpolation.",
				maxItems: 256,
			}),
		),
		cwd: Type.Optional(
			Type.String({
				description: "Working directory. Defaults to Pi's cwd; relative paths resolve from Pi's cwd.",
				maxLength: 32_768,
			}),
		),
		timeoutSeconds: Type.Optional(
			Type.Number({
				description: `Wall-clock timeout. Defaults to ${DEFAULT_PYTHON_TIMEOUT_SECONDS} seconds and is capped at ${MAX_PYTHON_TIMEOUT_SECONDS}.`,
			}),
		),
		maxOutputBytes: Type.Optional(
			Type.Number({
				description: `Maximum returned bytes per stream before full output spills to a work artifact. Maximum ${MAX_PYTHON_OUTPUT_BYTES}.`,
			}),
		),
	},
	{ additionalProperties: false },
);

export type PythonToolInput = Static<typeof pythonSchema>;

export interface PythonToolDetails {
	mode: "code" | "script";
	cwd: string;
	uvPath: string;
	pythonPath: string;
	scriptPath?: string;
	args: string[];
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	stdoutTruncation?: TruncationResult;
	stderrTruncation?: TruncationResult;
	stdoutOutputPath?: string;
	stderrOutputPath?: string;
	stdoutOutputError?: string;
	stderrOutputError?: string;
}

export interface PythonExecutionRequest {
	python: string;
	args: string[];
	cwd: string;
	stdin?: string;
	timeoutMs: number;
	signal?: AbortSignal;
	env: NodeJS.ProcessEnv;
	onStdout: (chunk: Buffer) => void;
	onStderr: (chunk: Buffer) => void;
}

export interface PythonExecutionResult {
	exitCode: number | null;
	reason: "exited" | "aborted" | "timeout";
	signal: string | null;
}

export interface PythonOperations {
	exec(request: PythonExecutionRequest): Promise<PythonExecutionResult>;
}

export interface PythonToolOptions {
	resolveRuntime?: () => Promise<PythonRuntimeOutcome>;
	operations?: PythonOperations;
	/** Override only for tests or embedded runtimes; production uses the process work directory. */
	outputDirectory?: string;
}

function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

export function resolvePythonToolPath(
	base: string,
	requested: string,
	platform: NodeJS.Platform = process.platform,
): string {
	return (platform === "win32" ? win32 : posix).resolve(base, stripAtPrefix(requested));
}

async function resolveWorkingDirectory(baseCwd: string, requested?: string): Promise<string> {
	const cwd = requested ? resolvePythonToolPath(baseCwd, requested) : baseCwd;
	const entry = await stat(cwd).catch(() => {
		throw new Error(`cwd does not exist: ${cwd}`);
	});
	if (!entry.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
	return cwd;
}

async function resolveScriptPath(cwd: string, requested: string): Promise<string> {
	const scriptPath = resolvePythonToolPath(cwd, requested);
	const entry = await stat(scriptPath).catch(() => {
		throw new Error(`scriptPath does not exist: ${scriptPath}`);
	});
	if (!entry.isFile()) throw new Error(`scriptPath is not a file: ${scriptPath}`);
	return scriptPath;
}

function clampInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function createLocalPythonOperations(): PythonOperations {
	return {
		async exec(request) {
			if (request.signal?.aborted) throw new Error("Python execution aborted before start");
			const child = spawnProcess(request.python, request.args, {
				cwd: request.cwd,
				detached: process.platform !== "win32",
				env: request.env,
				stdio: ["pipe", "pipe", "pipe"],
			});
			child.stdout?.on("data", (chunk: Buffer) => request.onStdout(chunk));
			child.stderr?.on("data", (chunk: Buffer) => request.onStderr(chunk));
			child.stdin?.end(request.stdin ?? "");
			const terminal = await waitForChildProcessWithTermination(child, {
				killGraceMs: PYTHON_KILL_GRACE_MS,
				signal: request.signal,
				timeoutMs: request.timeoutMs,
			});
			return { exitCode: terminal.code, reason: terminal.reason, signal: child.signalCode };
		},
	};
}

function renderStreamNotice(label: string, path: string | undefined, error: string | undefined): string | undefined {
	if (path) return `[${label} truncated; full output: ${path}]`;
	if (error) return `[${label} truncated; full-output artifact failed: ${error}]`;
	return undefined;
}

export function createPythonToolDefinition(
	baseCwd: string,
	options: PythonToolOptions = {},
): ToolDefinition<typeof pythonSchema, PythonToolDetails> {
	const resolveRuntime = options.resolveRuntime ?? (() => ensurePythonRuntime({ silent: true }));
	const operations = options.operations ?? createLocalPythonOperations();
	return {
		name: "python",
		label: "python",
		description: `Run a bounded Python snippet or script without a shell. Pi resolves Python through uv, defaults to a ${DEFAULT_PYTHON_TIMEOUT_SECONDS}-second wall-clock timeout (maximum ${MAX_PYTHON_TIMEOUT_SECONDS}), streams bounded stdout/stderr, and spills truncated full output to the process work directory rather than the repository.`,
		promptSnippet: "Run bounded Python snippets or scripts through Pi's uv-managed runtime.",
		promptGuidelines: [
			"Prefer python for bounded scripts, data shaping, structured transformations, and cross-platform logic when it is clearer than a shell pipeline.",
			"Prefer read/edit/write for small exact source edits. For Python file transformations, preserve encoding and newline style, write atomically, and verify the resulting diff.",
			"Keep work scoped: avoid recursive home/filesystem scans, pass explicit roots and filters, and request a larger timeout only when the bounded workload justifies it.",
			"Do not use python for destructive deletion, credentials, publish/push/release, or long-running services without explicit user approval.",
		],
		parameters: pythonSchema,
		async execute(_toolCallId, input, signal) {
			const hasCode = typeof input.code === "string";
			const hasScript = typeof input.scriptPath === "string" && input.scriptPath.trim().length > 0;
			if (hasCode === hasScript) throw new Error("Provide exactly one of code or scriptPath.");
			const cwd = await resolveWorkingDirectory(baseCwd, input.cwd);
			const scriptPath = hasScript ? await resolveScriptPath(cwd, input.scriptPath as string) : undefined;
			const runtime = await resolveRuntime();
			if (runtime.status !== "ready") throw new Error(runtime.reason);
			const args = input.args ? [...input.args] : [];
			const timeoutSeconds = clampInteger(
				input.timeoutSeconds,
				DEFAULT_PYTHON_TIMEOUT_SECONDS,
				1,
				MAX_PYTHON_TIMEOUT_SECONDS,
			);
			const maxOutputBytes = clampInteger(
				input.maxOutputBytes,
				50 * 1024,
				MIN_PYTHON_OUTPUT_BYTES,
				MAX_PYTHON_OUTPUT_BYTES,
			);
			const accumulatorOptions = {
				maxBytes: maxOutputBytes,
				...(options.outputDirectory ? { tempDirectory: options.outputDirectory } : {}),
			};
			const stdout = new OutputAccumulator({ ...accumulatorOptions, tempFilePrefix: "pi-python-stdout" });
			const stderr = new OutputAccumulator({ ...accumulatorOptions, tempFilePrefix: "pi-python-stderr" });
			const finishStreams = () => {
				stdout.finish();
				stderr.finish();
				return {
					stdout: stdout.snapshot({ persistIfTruncated: true }),
					stderr: stderr.snapshot({ persistIfTruncated: true }),
				};
			};
			let execution: PythonExecutionResult;
			try {
				execution = await withExclusiveMutationBarrier(() =>
					operations.exec({
						python: runtime.pythonPath,
						args: scriptPath ? ["-B", scriptPath, ...args] : ["-B", "-", ...args],
						cwd,
						stdin: hasCode ? input.code : undefined,
						timeoutMs: timeoutSeconds * 1000,
						signal,
						env: {
							...process.env,
							PI_PYTHON_TOOL: "1",
							PYTHONDONTWRITEBYTECODE: "1",
							PYTHONIOENCODING: "utf-8",
							PYTHONUNBUFFERED: "1",
							PYTHONUTF8: "1",
						},
						onStdout: (chunk) => stdout.append(chunk),
						onStderr: (chunk) => stderr.append(chunk),
					}),
				);
				const snapshots = finishStreams();
				const sections: string[] = [];
				if (snapshots.stdout.content) sections.push(snapshots.stdout.content.trimEnd());
				if (snapshots.stderr.content) sections.push(`[stderr]\n${snapshots.stderr.content.trimEnd()}`);
				const stdoutNotice = renderStreamNotice(
					"stdout",
					snapshots.stdout.fullOutputPath,
					snapshots.stdout.fullOutputError,
				);
				const stderrNotice = renderStreamNotice(
					"stderr",
					snapshots.stderr.fullOutputPath,
					snapshots.stderr.fullOutputError,
				);
				if (stdoutNotice) sections.push(stdoutNotice);
				if (stderrNotice) sections.push(stderrNotice);
				const status = `[python exitCode=${execution.exitCode ?? "null"}${execution.signal ? `; signal=${execution.signal}` : ""}]`;
				sections.push(status);
				const text = sections.join("\n\n");
				if (execution.reason === "timeout")
					throw new Error(`${text}\n\nPython timed out after ${timeoutSeconds} seconds`);
				if (execution.reason === "aborted") throw new Error(`${text}\n\nPython execution aborted`);
				if (execution.exitCode !== 0) {
					const termination = execution.signal
						? `signal ${execution.signal}`
						: `code ${execution.exitCode ?? "unknown"}`;
					throw new Error(`${text}\n\nPython exited with ${termination}`);
				}
				return {
					content: [{ type: "text", text }],
					details: {
						mode: scriptPath ? "script" : "code",
						cwd,
						uvPath: runtime.uvPath,
						pythonPath: runtime.pythonPath,
						scriptPath,
						args,
						exitCode: execution.exitCode,
						signal: execution.signal,
						timedOut: false,
						...(snapshots.stdout.truncation.truncated ? { stdoutTruncation: snapshots.stdout.truncation } : {}),
						...(snapshots.stderr.truncation.truncated ? { stderrTruncation: snapshots.stderr.truncation } : {}),
						stdoutOutputPath: snapshots.stdout.fullOutputPath,
						stderrOutputPath: snapshots.stderr.fullOutputPath,
						stdoutOutputError: snapshots.stdout.fullOutputError,
						stderrOutputError: snapshots.stderr.fullOutputError,
					},
				};
			} finally {
				await Promise.all([stdout.closeTempFile(), stderr.closeTempFile()]);
			}
		},
		renderCall(args, theme) {
			const mode = args.scriptPath ? args.scriptPath : "code";
			return new Text(`${theme.fg("toolTitle", theme.bold("python"))} ${theme.fg("muted", mode)}`, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "python running"), 0, 0);
			const details = result.details as PythonToolDetails | undefined;
			if (!details) return new Text(theme.fg("dim", "python done"), 0, 0);
			const status =
				details.exitCode === 0 && !details.timedOut ? "python ok" : `python exit ${details.exitCode ?? "unknown"}`;
			let text = theme.fg(details.exitCode === 0 ? "success" : "warning", status);
			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					const lines = content.text.split("\n").slice(-20);
					for (const line of lines) text += `\n${theme.fg("dim", line)}`;
				}
				for (const outputPath of [details.stdoutOutputPath, details.stderrOutputPath]) {
					if (outputPath) text += `\n${theme.fg("muted", `full output: ${outputPath}`)}`;
				}
			}
			return new Text(text, 0, 0);
		},
	};
}

export function createPythonTool(baseCwd: string, options?: PythonToolOptions): AgentTool<typeof pythonSchema> {
	return wrapToolDefinition(createPythonToolDefinition(baseCwd, options));
}
