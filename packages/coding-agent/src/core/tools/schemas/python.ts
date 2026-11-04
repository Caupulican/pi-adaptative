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
				description: "Python source run on stdin; exactly one of code or scriptPath.",
				maxLength: 200_000,
			}),
		),
		scriptPath: Type.Optional(
			Type.String({
				description: "Script path relative to cwd (a leading @ is ignored in local execution).",
				maxLength: 32_768,
			}),
		),
		args: Type.Optional(
			Type.Array(Type.String({ maxLength: 16_384 }), {
				description: "Arguments passed as argv; no shell interpolation.",
				maxItems: 256,
			}),
		),
		cwd: Type.Optional(
			Type.String({
				description: "Working directory (default: Pi's cwd).",
				maxLength: 32_768,
			}),
		),
		timeoutSeconds: Type.Optional(
			Type.Number({
				description: `Wall-clock timeout in seconds. Default ${DEFAULT_PYTHON_TIMEOUT_SECONDS} (${MAX_PYTHON_TIMEOUT_SECONDS} for a background run), capped at ${MAX_PYTHON_TIMEOUT_SECONDS}; raise only for bounded work.`,
			}),
		),
		background: Type.Optional(
			Type.Boolean({
				description:
					"Start as a session task and return its task id without waiting; the result arrives in the completion wake-up. Runs in its own process (working directory and environment changes do not persist) and waits only for file writes emitted earlier in this message. Use only when other work can proceed meanwhile, never followed by an immediate tool_task wait; without the tool_task tool it runs in the foreground.",
			}),
		),
		fullOutput: Type.Optional(
			Type.Boolean({
				description:
					"Return complete raw stdout with no output filters; the persisted file named in a filtered notice is usually enough.",
			}),
		),
		maxOutputBytes: Type.Optional(
			Type.Number({
				description: `Maximum returned bytes per stream before output spills to a work artifact (limit ${MAX_PYTHON_OUTPUT_BYTES}).`,
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
