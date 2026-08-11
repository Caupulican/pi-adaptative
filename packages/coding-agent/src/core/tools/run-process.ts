import type { ChildProcess } from "node:child_process";
import type { AgentTool } from "@caupulican/pi-agent-core";
import { type Static, Type } from "typebox";
import { spawnProcess, waitForChildProcessWithTermination } from "../../utils/child-process.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	MAX_ORCHESTRATION_PROCESS_OUTPUT_BYTES,
	type OrchestrationExecutionPolicy,
} from "../orchestration/contracts.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const MAX_RUN_PROCESS_EXECUTABLE_CHARS = 4_096;
const MAX_RUN_PROCESS_ARGUMENT_CHARS = 4_096;
const MAX_RUN_PROCESS_ARGUMENTS = 64;
const MAX_RUN_PROCESS_ARGV_BYTES = 32 * 1024;
const MAX_RUN_PROCESS_WALL_CLOCK_MS = 3_600_000;
const MAX_VISIBLE_EXECUTABLES = 16;
const MAX_VISIBLE_EXECUTABLE_CHARS = 64;

const runProcessSchema = Type.Object(
	{
		executable: Type.String({
			maxLength: MAX_RUN_PROCESS_EXECUTABLE_CHARS,
			description: "Exact owner-allowed executable name or path.",
		}),
		args: Type.Optional(
			Type.Array(Type.String({ maxLength: MAX_RUN_PROCESS_ARGUMENT_CHARS }), {
				maxItems: MAX_RUN_PROCESS_ARGUMENTS,
				description: "Direct argv entries. No shell parsing occurs.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type RunProcessInput = Static<typeof runProcessSchema>;

export interface RunProcessDetails {
	outcome: "exited" | "failed" | "aborted" | "timeout" | "output_limit";
	executable: string;
	exitCode: number | null;
	durationMs: number;
	truncated: boolean;
}

export interface RunProcessToolOptions {
	policy: OrchestrationExecutionPolicy;
	maxWallClockMs: number;
	spawn?: typeof spawnProcess;
	/** Additional environment resolved for the execution cwd; the policy allowlist still applies. */
	environment?: (cwd: string) => NodeJS.ProcessEnv;
}

const SAFE_ENVIRONMENT_VARIABLES = [
	"PATH",
	"PATHEXT",
	"SystemRoot",
	"WINDIR",
	"COMSPEC",
	"TMPDIR",
	"TMP",
	"TEMP",
] as const;
const OWNER_CONTROL_PLANE_ENVIRONMENT_VARIABLES = new Set(["BW_SESSION"]);

function scopedEnvironment(allowedNames: readonly string[], additional: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const names = new Set<string>([...SAFE_ENVIRONMENT_VARIABLES, ...allowedNames]);
	const environment: NodeJS.ProcessEnv = {};
	for (const name of names) {
		if (OWNER_CONTROL_PLANE_ENVIRONMENT_VARIABLES.has(name)) continue;
		const value = additional[name] ?? process.env[name];
		if (value !== undefined) environment[name] = value;
	}
	return environment;
}

function executableCatalogDescription(allowedExecutables: readonly string[]): string {
	const visible = allowedExecutables
		.slice(0, MAX_VISIBLE_EXECUTABLES)
		.map((executable) => executable.slice(0, MAX_VISIBLE_EXECUTABLE_CHARS));
	const omitted = allowedExecutables.length - visible.length;
	return `${allowedExecutables.length} configured: ${visible.join(", ")}${omitted > 0 ? `; ${omitted} omitted` : ""}`;
}

function resolveProcessPolicy(options: RunProcessToolOptions): { maxOutputBytes: number; timeoutMs: number } {
	if (
		!Number.isSafeInteger(options.policy.maxOutputBytes) ||
		options.policy.maxOutputBytes <= 0 ||
		!Number.isSafeInteger(options.maxWallClockMs) ||
		options.maxWallClockMs < 0
	) {
		throw new TypeError("process_policy_invalid: output and wall-clock limits must be bounded integers.");
	}
	return {
		maxOutputBytes: Math.min(options.policy.maxOutputBytes, MAX_ORCHESTRATION_PROCESS_OUTPUT_BYTES),
		// A zero lane-level budget disables that budget, not the execution-plane safety ceiling.
		timeoutMs:
			options.maxWallClockMs === 0
				? MAX_RUN_PROCESS_WALL_CLOCK_MS
				: Math.min(options.maxWallClockMs, MAX_RUN_PROCESS_WALL_CLOCK_MS),
	};
}

function validateProcessInput(input: RunProcessInput): string[] {
	if (
		typeof input.executable !== "string" ||
		input.executable.length === 0 ||
		input.executable.length > MAX_RUN_PROCESS_EXECUTABLE_CHARS ||
		input.executable.includes("\0")
	) {
		throw new Error("process_argument_invalid: executable is empty, oversized, or contains a NUL byte.");
	}
	if (
		input.args !== undefined &&
		(!Array.isArray(input.args) ||
			input.args.length > MAX_RUN_PROCESS_ARGUMENTS ||
			input.args.some(
				(argument) =>
					typeof argument !== "string" ||
					argument.length > MAX_RUN_PROCESS_ARGUMENT_CHARS ||
					argument.includes("\0"),
			))
	) {
		throw new Error("process_argument_invalid: argv exceeds its count/size bound or contains a NUL byte.");
	}
	const args = input.args ?? [];
	let argvBytes = Buffer.byteLength(input.executable, "utf-8");
	for (const argument of args) {
		argvBytes += 1 + Buffer.byteLength(argument, "utf-8");
		if (argvBytes > MAX_RUN_PROCESS_ARGV_BYTES) {
			throw new Error(`process_argument_invalid: executable and argv exceed ${MAX_RUN_PROCESS_ARGV_BYTES} bytes.`);
		}
	}
	return args;
}

function collectBoundedOutput(
	child: ChildProcess,
	maxBytes: number,
	abort: () => void,
): {
	read(): { stdout: string; stderr: string; truncated: boolean };
} {
	let remaining = maxBytes;
	let truncated = false;
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	const collect = (target: Buffer[]) => (chunk: Buffer) => {
		if (remaining <= 0) return;
		const retained = chunk.subarray(0, remaining);
		target.push(retained);
		remaining -= retained.length;
		if (retained.length < chunk.length || remaining === 0) {
			truncated = true;
			abort();
		}
	};
	child.stdout?.on("data", collect(stdout));
	child.stderr?.on("data", collect(stderr));
	return {
		read: () => ({
			stdout: Buffer.concat(stdout).toString("utf-8"),
			stderr: Buffer.concat(stderr).toString("utf-8"),
			truncated,
		}),
	};
}

export function createRunProcessToolDefinition(cwd: string, options: RunProcessToolOptions): ToolDefinition {
	const processPolicy = resolveProcessPolicy(options);
	const allowedExecutables = new Set(options.policy.allowedExecutables);
	return {
		name: "run_process",
		label: "Run Process",
		description: `Run one owner-allowed executable using direct argv without a shell. Allowed executables: ${executableCatalogDescription(options.policy.allowedExecutables)}.`,
		promptSnippet: "Run owner-allowed executable via constrained direct argv; not OS isolation.",
		promptGuidelines: [
			"Executable must be profile-listed. Arguments literal; no shell operators/interpolation.",
			"Project credentials inject only when execution profile also allows variable names.",
			"Nonzero exit/timeout/abort/output-limit means failure.",
		],
		parameters: runProcessSchema,
		async execute(_toolCallId, input: RunProcessInput, signal) {
			const args = validateProcessInput(input);
			if (!allowedExecutables.has(input.executable)) {
				throw new Error(`process_executable_denied: '${input.executable}' is not owner-allowed.`);
			}
			const startedAt = Date.now();
			const outputLimitAbort = new AbortController();
			let outputLimitReached = false;
			const child = (options.spawn ?? spawnProcess)(input.executable, [...args], {
				cwd,
				env: scopedEnvironment(options.policy.allowedEnvironmentVariables, options.environment?.(cwd) ?? {}),
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			const output = collectBoundedOutput(child, processPolicy.maxOutputBytes, () => {
				outputLimitReached = true;
				outputLimitAbort.abort();
			});
			const combinedAbort = new AbortController();
			const abort = () => combinedAbort.abort();
			if (signal?.aborted || outputLimitAbort.signal.aborted) abort();
			else {
				signal?.addEventListener("abort", abort, { once: true });
				outputLimitAbort.signal.addEventListener("abort", abort, { once: true });
			}
			try {
				const terminal = await waitForChildProcessWithTermination(child, {
					signal: combinedAbort.signal,
					timeoutMs: processPolicy.timeoutMs,
					killGraceMs: 2_000,
				});
				const captured = output.read();
				const outcome: RunProcessDetails["outcome"] = outputLimitReached
					? "output_limit"
					: terminal.reason === "timeout"
						? "timeout"
						: terminal.reason === "aborted"
							? "aborted"
							: terminal.code === 0
								? "exited"
								: "failed";
				const body = [
					`outcome: ${outcome}`,
					`exitCode: ${terminal.code ?? "null"}`,
					captured.stdout ? `stdout:\n${captured.stdout}` : "stdout: (empty)",
					captured.stderr ? `stderr:\n${captured.stderr}` : "stderr: (empty)",
				].join("\n");
				return {
					content: [{ type: "text" as const, text: body }],
					...(outcome === "exited" ? {} : { isError: true }),
					details: {
						outcome,
						executable: input.executable,
						exitCode: terminal.code,
						durationMs: Date.now() - startedAt,
						truncated: captured.truncated,
					} satisfies RunProcessDetails,
				};
			} finally {
				signal?.removeEventListener("abort", abort);
				outputLimitAbort.signal.removeEventListener("abort", abort);
			}
		},
	};
}

export function createRunProcessTool(cwd: string, options: RunProcessToolOptions): AgentTool {
	return wrapToolDefinition(createRunProcessToolDefinition(cwd, options));
}
