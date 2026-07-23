import type { ChildProcess } from "node:child_process";
import type { AgentTool } from "@caupulican/pi-agent-core";
import { type Static, Type } from "typebox";
import { spawnProcess, waitForChildProcessWithTermination } from "../../utils/child-process.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { OrchestrationExecutionPolicy } from "../orchestration/contracts.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const runProcessSchema = Type.Object(
	{
		executable: Type.String({ description: "Exact owner-allowed executable name or path." }),
		args: Type.Optional(Type.Array(Type.String(), { description: "Direct argv entries. No shell parsing occurs." })),
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

function scopedEnvironment(allowedNames: readonly string[]): NodeJS.ProcessEnv {
	const names = new Set<string>([...SAFE_ENVIRONMENT_VARIABLES, ...allowedNames]);
	const environment: NodeJS.ProcessEnv = {};
	for (const name of names) {
		const value = process.env[name];
		if (value !== undefined) environment[name] = value;
	}
	return environment;
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
	const allowedExecutables = new Set(options.policy.allowedExecutables);
	return {
		name: "run_process",
		label: "Run Process",
		description: `Run one owner-allowed executable using direct argv without a shell. Allowed: ${options.policy.allowedExecutables.join(", ")}.`,
		promptSnippet: "Run an owner-allowed executable through a constrained direct-argv launcher (not OS isolation).",
		promptGuidelines: [
			"Use only an executable listed by the profile. Arguments are passed literally; shell operators and interpolation are unavailable.",
			"Treat a non-zero exit code, timeout, abort, or output-limit termination as failure.",
		],
		parameters: runProcessSchema,
		async execute(_toolCallId, input: RunProcessInput, signal) {
			if (!allowedExecutables.has(input.executable)) {
				throw new Error(`process_executable_denied: '${input.executable}' is not owner-allowed.`);
			}
			const args = input.args ?? [];
			if (input.executable.includes("\0") || args.some((argument) => argument.includes("\0"))) {
				throw new Error("process_argument_invalid: executable and argv must not contain NUL bytes.");
			}
			const startedAt = Date.now();
			const outputLimitAbort = new AbortController();
			let outputLimitReached = false;
			const child = (options.spawn ?? spawnProcess)(input.executable, [...args], {
				cwd,
				env: scopedEnvironment(options.policy.allowedEnvironmentVariables),
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			const output = collectBoundedOutput(child, options.policy.maxOutputBytes, () => {
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
					timeoutMs: options.maxWallClockMs > 0 ? options.maxWallClockMs : undefined,
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
