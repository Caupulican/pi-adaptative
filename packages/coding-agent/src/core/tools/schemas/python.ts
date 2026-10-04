import { type Static, Type } from "typebox";
import type { TruncationResult } from "../../../kernel/node.ts";
import type { ExecutionEnvironment } from "../../execution-environment.ts";

export const DEFAULT_PYTHON_TIMEOUT_SECONDS = 30;
export const MAX_PYTHON_TIMEOUT_SECONDS = 300;
export const MAX_PYTHON_OUTPUT_BYTES = 200_000;

export const pythonSchema = Type.Object(
	{
		code: Type.Optional(
			Type.String({
				description: "Python code to execute on stdin. Provide exactly one of code or scriptPath.",
				maxLength: 200_000,
			}),
		),
		scriptPath: Type.Optional(
			Type.String({
				description:
					"Python script path relative to cwd. Native CLI input ignores one leading @; custom backends retain literal names.",
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
				description: `Wall-clock timeout. Defaults to ${DEFAULT_PYTHON_TIMEOUT_SECONDS} seconds (${MAX_PYTHON_TIMEOUT_SECONDS} for a background run) and is capped at ${MAX_PYTHON_TIMEOUT_SECONDS}.`,
			}),
		),
		background: Type.Optional(
			Type.Boolean({
				description:
					"Run as a session task at once and return its task id instead of waiting. It runs in its own process (its working directory and environment changes do not persist), waits only for file writes emitted before it in this message, and never blocks other commands. Use only when you will do other work before you need the result; a background start followed immediately by tool_task wait costs an extra request and is slower than a foreground call with a timeout. Its result arrives in the completion wake-up; tool_task wait is only for an omitted output (needs the tool_task tool; without it the code runs in the foreground). Omit to wait for the code (default, bounded by the timeout).",
			}),
		),
		fullOutput: Type.Optional(
			Type.Boolean({
				description:
					"Return the complete raw stdout for this call: no output filters (generic cleaning, rules). The persisted full output named in a filtered notice is usually enough.",
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
	/** Inspect the executing backend, not the operator filesystem. Preserve filesystem error codes. */
	stat(path: string, signal?: AbortSignal): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
	/** Return the backend's complete base environment and its variable-name case policy. */
	getEnvironment(cwd: string, signal?: AbortSignal): Promise<ExecutionEnvironment>;
	/** Read a backend JSON rules document; preserve missing-path errors. Schema validation is shared. */
	readOutputRules(path: string, signal?: AbortSignal): Promise<unknown>;
	exec(request: PythonExecutionRequest): Promise<PythonExecutionResult>;
}
