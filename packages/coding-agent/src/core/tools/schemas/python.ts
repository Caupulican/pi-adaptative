import { type Static, Type } from "typebox";
import type { TruncationResult } from "../../../kernel/node.ts";
import type { ExecutionEnvironment } from "../../execution-environment.ts";
import type { ToolBridgeReport } from "../tool-bridge.ts";
import {
	DEFAULT_TOOL_BRIDGE_MAX_CALLS,
	MAX_TOOL_BRIDGE_CALLS,
	TOOL_BRIDGE_CLIENT_MODULE,
	TOOL_BRIDGE_TOOL_NAMES,
} from "../tool-bridge-policy.ts";

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
		tools: Type.Optional(
			Type.Array(Type.Union(TOOL_BRIDGE_TOOL_NAMES.map((name) => Type.Literal(name))), {
				minItems: 1,
				maxItems: TOOL_BRIDGE_TOOL_NAMES.length,
				uniqueItems: true,
				description: `Pi tools the script may call: \`import ${TOOL_BRIDGE_CLIENT_MODULE}\`, then \`${TOOL_BRIDGE_CLIENT_MODULE}.read(path=...)\`, \`.grep(pattern=..., path=...)\`, \`.edit(path=..., edits=[...])\` etc. with that tool's own argument names. Each call is admitted like a direct call and returns the tool's text, or raises ${TOOL_BRIDGE_CLIENT_MODULE}.ToolError (ToolRefused, ToolFailed, ToolLimit); relative paths resolve as in your direct calls, not against the script's cwd; only what the script prints comes back. Foreground runs only.`,
			}),
		),
		maxToolCalls: Type.Optional(
			Type.Number({
				description: `Most tool calls this run may make (default ${DEFAULT_TOOL_BRIDGE_MAX_CALLS}, limit ${MAX_TOOL_BRIDGE_CALLS}).`,
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
	/** The calls the script made through `pi_tools`, when it named `tools`. */
	toolBridge?: ToolBridgeReport;
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
