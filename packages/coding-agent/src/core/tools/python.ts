import { readFile, stat } from "node:fs/promises";
import type { AgentTool } from "@caupulican/pi-agent-core";
import type { TruncationResult } from "@caupulican/pi-agent-core/node";
import { Text } from "@caupulican/pi-tui";
import { type Static, Type } from "typebox";
import { spawnProcess, waitForChildProcessWithTermination } from "../../utils/child-process.ts";
import { type PathInputOptions, resolvePath } from "../../utils/paths.ts";
import { composeExecutionEnvironment, type ExecutionEnvironment } from "../execution-environment.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { withoutHarnessLaunchEnv } from "../harness-environment.ts";
import { awaitPreflight } from "../preflight.ts";
import { ensurePythonRuntime, type PythonRuntimeOutcome } from "../python-runtime.ts";
import { isMissingPathError } from "../util/filesystem-errors.ts";
import {
	FILE_ENCODING_RECOVERY_TARGET_KIND,
	type FileFailureRecoveryAuthority,
	selectFileFailureRecoveryAuthority,
} from "./file-failure-recovery.ts";
import { releaseExclusiveHold, withExclusiveMutationBarrier } from "./file-mutation-queue.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import {
	formatOutputReductionNotice,
	type OutputReductionDetails,
	type OutputReductionToolOptions,
	type ReduceToolOutputOptions,
	reduceToolOutput,
	resolveOutputReductionLevel,
} from "./output-reduction.ts";
import "./output-reducers.ts";
import { getAgentDir } from "../../config.ts";
import { BUNDLED_OUTPUT_RULES } from "./output-rules.bundled.ts";
import {
	compileOutputRulesDocument,
	createRuleOutputReducer,
	loadOutputRules,
	OUTPUT_RULES_FILE_NAME,
} from "./output-rules.ts";
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
				description: `Wall-clock timeout. Defaults to ${DEFAULT_PYTHON_TIMEOUT_SECONDS} seconds and is capped at ${MAX_PYTHON_TIMEOUT_SECONDS}.`,
			}),
		),
		background: Type.Optional(
			Type.Boolean({
				description:
					"Run as a session task at once and return its task id instead of waiting. It runs in its own process (its working directory and environment changes do not persist), waits only for file writes emitted before it in this message, and never blocks other commands. Use only when you will do other work before you need the result; a background start followed immediately by tool_task wait costs an extra request and is slower than a foreground call with a timeout. Collect it later with tool_task wait (needs the tool_task tool; without it the code runs in the foreground). Omit to wait for the code (default, bounded by the timeout).",
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

export interface PythonToolOptions {
	resolveRuntime?: () => Promise<PythonRuntimeOutcome>;
	operations?: PythonOperations;
	/** Selected backend syntax; a foreign dialect requires custom operations and runtime resolution. */
	pathOptions?: Pick<PathInputOptions, "flavor">;
	/** Explicit identity required to advertise encoding recovery on a custom execution backend. */
	failureRecoveryAuthority?: FileFailureRecoveryAuthority;
	/** Additional process environment resolved from the final execution cwd. */
	environment?: (cwd: string) => NodeJS.ProcessEnv;
	/** Owner-only variables that must never reach model-controlled Python. */
	omitEnvironmentVariables?: readonly string[];
	/** Override only for tests or embedded runtimes; production uses the process work directory. */
	outputDirectory?: string;
	/** Output reduction switches (settings `toolOutput`); reduction is on at the standard level by default. */
	outputReduction?: OutputReductionToolOptions;
}

export function resolvePythonToolPath(
	base: string,
	requested: string,
	options: Pick<PathInputOptions, "flavor" | "stripAtPrefix"> = {},
): string {
	return resolvePath(requested, base, { expandTilde: false, stripAtPrefix: true, ...options });
}

async function inspectPythonPath(
	path: string,
	kind: "cwd" | "scriptPath",
	operations: PythonOperations,
	signal?: AbortSignal,
): Promise<void> {
	const entry = await awaitPreflight(() => operations.stat(path, signal), signal).catch((error: unknown) => {
		if (!isMissingPathError(error)) throw error;
		throw new Error(`${kind} does not exist: ${path}`, { cause: error });
	});
	signal?.throwIfAborted();
	if (kind === "cwd" ? !entry.isDirectory() : !entry.isFile())
		throw new Error(`${kind} is not a ${kind === "cwd" ? "directory" : "file"}: ${path}`);
}

function clampInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function createLocalPythonOperations(): PythonOperations {
	return {
		stat: (path) => stat(path),
		getEnvironment: async () => ({
			variables: withoutHarnessLaunchEnv({ ...process.env }),
			caseSensitive: process.platform !== "win32",
		}),
		async readOutputRules(path, signal) {
			const text = await readFile(path, { encoding: "utf8", signal });
			try {
				return JSON.parse(text);
			} catch (cause) {
				throw new Error(`${path}: invalid output rules JSON`, { cause });
			}
		},
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
	const nativeFlavor = process.platform === "win32" ? "win32" : "posix";
	if (
		options.operations &&
		(!options.resolveRuntime ||
			typeof options.operations.stat !== "function" ||
			typeof options.operations.getEnvironment !== "function" ||
			typeof options.operations.readOutputRules !== "function")
	)
		throw new Error(
			"Custom Python operations require backend stat, environment, output-rule reads, and explicit runtime resolution.",
		);
	if (!options.operations && options.pathOptions?.flavor && options.pathOptions.flavor !== nativeFlavor)
		throw new Error("Non-native Python path semantics require custom operations.");
	const pathOptions = Object.freeze({
		flavor: options.pathOptions?.flavor ?? nativeFlavor,
		stripAtPrefix: options.operations === undefined,
	});
	const resolveRuntime = options.resolveRuntime ?? (() => ensurePythonRuntime({ silent: true }));
	const operations = options.operations ?? createLocalPythonOperations();
	const recoveryAuthority = selectFileFailureRecoveryAuthority(
		options.operations !== undefined,
		options.failureRecoveryAuthority,
	);
	// Output reduction: on unless the operator turned it off (settings or PI_TOOL_FILTER_DISABLED=1).
	const reductionEnabled = options.outputReduction?.enabled !== false && process.env.PI_TOOL_FILTER_DISABLED !== "1";
	const reductionLevel = () => resolveOutputReductionLevel(options.outputReduction?.level);
	return {
		name: "python",
		label: "python",
		description: `Run a bounded Python snippet or script without a shell. Pi resolves Python through uv, defaults to a ${DEFAULT_PYTHON_TIMEOUT_SECONDS}-second wall-clock timeout (maximum ${MAX_PYTHON_TIMEOUT_SECONDS}), streams bounded stdout/stderr, and spills truncated full output to the process work directory rather than the repository.`,
		promptSnippet: "Run bounded Python code/scripts through Pi's uv runtime.",
		promptGuidelines: [
			"Use python for bounded scripts/data transforms/cross-platform logic clearer than shell.",
			"Small exact source edits: read/edit/write. Python transforms: preserve encoding/newlines, write atomically, verify diff.",
			"Scope roots/filters; never scan home/filesystem recursively. Raise timeout only for justified bounded work.",
			"Never inspect/print credentials; use activated environment only through credential consumer.",
			"Explicit approval required: destructive deletion, publish/push/release, long-running services.",
		],
		parameters: pythonSchema,
		backgroundRequested: (input) => input.background === true,
		failureRecovery: {
			actions: recoveryAuthority
				? [
						{
							kind: "correct",
							authority: recoveryAuthority.contractAuthority,
							targetKind: FILE_ENCODING_RECOVERY_TARGET_KIND,
							instruction:
								"Use binary I/O and an explicit strict codec; preserve encoding, BOM and each newline, verify unchanged bytes. Never retry the UTF-8 edit or use lossy conversion.",
						},
					]
				: [],
		},
		async execute(toolCallId, input, signal) {
			signal?.throwIfAborted();
			const hasCode = typeof input.code === "string";
			const hasScript = typeof input.scriptPath === "string" && input.scriptPath.length > 0;
			if (hasCode === hasScript) throw new Error("Provide exactly one of code or scriptPath.");
			const cwd = resolvePythonToolPath(baseCwd, input.cwd ?? ".", pathOptions);
			await inspectPythonPath(cwd, "cwd", operations, signal);
			const scriptPath = hasScript ? resolvePythonToolPath(cwd, input.scriptPath as string, pathOptions) : undefined;
			if (scriptPath !== undefined) await inspectPythonPath(scriptPath, "scriptPath", operations, signal);
			const reduceStdout = input.fullOutput !== true && reductionEnabled;
			let reductionOptions: ReduceToolOutputOptions | undefined;
			if (reduceStdout) {
				const projectPath = resolvePythonToolPath(baseCwd, `.pi/${OUTPUT_RULES_FILE_NAME}`, pathOptions);
				const projectRules = await awaitPreflight(async () => {
					try {
						return compileOutputRulesDocument(await operations.readOutputRules(projectPath, signal), projectPath);
					} catch (error) {
						if (!isMissingPathError(error)) throw error;
						return [];
					}
				}, signal);
				signal?.throwIfAborted();
				reductionOptions = {
					extraReducers: [
						createRuleOutputReducer(
							loadOutputRules({
								projectRules,
								agentDir: options.outputReduction?.agentDir ?? getAgentDir(),
								extraFiles: options.outputReduction?.rulesFiles,
								bundled: BUNDLED_OUTPUT_RULES,
							}),
						),
					],
				};
			}
			const runtime = await awaitPreflight(resolveRuntime, signal);
			signal?.throwIfAborted();
			if (runtime.status !== "ready") throw new Error(runtime.reason);
			const backendEnvironment = await awaitPreflight(() => operations.getEnvironment(cwd, signal), signal);
			signal?.throwIfAborted();
			// Detach from mutable adapter state before waiting for the mutation barrier.
			const baseEnvironment: ExecutionEnvironment = {
				caseSensitive: backendEnvironment.caseSensitive,
				variables: composeExecutionEnvironment(backendEnvironment, []),
			};
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
				// Reduce the complete stdout before the cap so the model sees the shorter version of the
				// whole output, not of its head+tail; the raw stream is persisted when lines were dropped.
				const rawStdout = reduceStdout ? stdout.snapshot({ persistIfTruncated: true }) : undefined;
				const reduction =
					rawStdout && !rawStdout.truncation.truncated
						? reduceToolOutput(
								{
									tool: "python",
									command: "python",
									text: rawStdout.content,
									exitCode: 0,
									level: reductionLevel(),
								},
								reductionOptions,
							)
						: undefined;
				const stdoutSnapshot = reduction
					? stdout.snapshot({ persistIfTruncated: true, persistAlways: reduction.details.persistRaw })
					: (rawStdout ?? stdout.snapshot({ persistIfTruncated: true }));
				const outputReduction: OutputReductionDetails | undefined = reduction
					? {
							...reduction.details,
							...(reduction.details.persistRaw && stdoutSnapshot.fullOutputPath
								? { rawPath: stdoutSnapshot.fullOutputPath }
								: {}),
						}
					: undefined;
				// stderr carries tracebacks and compiler-style diagnostics; the same pipeline applies.
				const rawStderr = reduceStdout ? stderr.snapshot({ persistIfTruncated: true }) : undefined;
				const stderrReduction =
					rawStderr && !rawStderr.truncation.truncated && rawStderr.content
						? reduceToolOutput(
								{
									tool: "python",
									command: "python",
									text: rawStderr.content,
									exitCode: 0,
									level: reductionLevel(),
								},
								reductionOptions,
							)
						: undefined;
				const stderrSnapshot = stderrReduction
					? stderr.snapshot({ persistIfTruncated: true, persistAlways: stderrReduction.details.persistRaw })
					: (rawStderr ?? stderr.snapshot({ persistIfTruncated: true }));
				return {
					stdout: reduction ? { ...stdoutSnapshot, content: reduction.text } : stdoutSnapshot,
					stderr: stderrReduction ? { ...stderrSnapshot, content: stderrReduction.text } : stderrSnapshot,
					outputReduction,
					stderrReduction: stderrReduction
						? {
								...stderrReduction.details,
								...(stderrReduction.details.persistRaw && stderrSnapshot.fullOutputPath
									? { rawPath: stderrSnapshot.fullOutputPath }
									: {}),
							}
						: undefined,
				};
			};
			let execution: PythonExecutionResult;
			try {
				const runSnippet = () => {
					signal?.throwIfAborted();
					const environment = composeExecutionEnvironment(
						baseEnvironment,
						[
							options.environment?.(cwd) ?? {},
							{
								PI_PYTHON_TOOL: "1",
								PYTHONDONTWRITEBYTECODE: "1",
								PYTHONIOENCODING: "utf-8",
								PYTHONUNBUFFERED: "1",
								PYTHONUTF8: "1",
							},
						],
						options.omitEnvironmentVariables,
					);
					signal?.throwIfAborted();
					return operations.exec({
						python: runtime.pythonPath,
						args: scriptPath ? ["-B", scriptPath, ...args] : ["-B", "-", ...args],
						cwd,
						stdin: hasCode ? input.code : undefined,
						timeoutMs: timeoutSeconds * 1000,
						signal,
						env: environment,
						onStdout: (chunk) => stdout.append(chunk),
						onStderr: (chunk) => stderr.append(chunk),
					});
				};
				// Python cannot statically declare which files a snippet touches, so every run takes the
				// coarse exclusive barrier. A background call releases it the instant its own body
				// starts: it still runs after the writes its own message emitted before it, but nothing
				// stays parked behind a job nobody is waiting for. `holdId` also lets a later handoff
				// drop the barrier for a run that only becomes a session task after it started.
				execution = await withExclusiveMutationBarrier(
					async () => {
						if (input.background === true) releaseExclusiveHold(toolCallId);
						return runSnippet();
					},
					{ signal, holdId: toolCallId },
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
				const reductionNotice = snapshots.outputReduction
					? formatOutputReductionNotice(snapshots.outputReduction)
					: undefined;
				if (reductionNotice) sections.push(reductionNotice);
				if (stdoutNotice && !snapshots.outputReduction?.rawPath) sections.push(stdoutNotice);
				const stderrReductionNotice = snapshots.stderrReduction
					? formatOutputReductionNotice(snapshots.stderrReduction)
					: undefined;
				if (stderrReductionNotice) sections.push(`[stderr] ${stderrReductionNotice}`);
				if (stderrNotice && !snapshots.stderrReduction?.rawPath) sections.push(stderrNotice);
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
						...(snapshots.outputReduction ? { outputReduction: snapshots.outputReduction } : {}),
						...(snapshots.stderrReduction ? { stderrReduction: snapshots.stderrReduction } : {}),
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
