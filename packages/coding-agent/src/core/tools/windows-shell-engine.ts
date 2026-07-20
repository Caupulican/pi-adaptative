/**
 * The `python-engine` tier: per-command spawn of the bundled `pi-shell-engine` (D3 in the
 * blueprint). Wires the frozen §1.2/§1.3 stdin-JSON-request / 0x1e-framed-stdout protocol into a
 * `BashOperations`, threads `WindowsShellState` through both directions (D4), and degrades to a
 * named, actionable error when the Python runtime is not ready — the PowerShell floor keeps
 * working regardless (the router never routes simple commands here when the engine is off).
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { join } from "node:path";
import { getBundledResourcesDir } from "../../config.ts";
import { spawnProcess, waitForChildProcessWithTermination } from "../../utils/child-process.ts";
import { getShellEnv, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import { ensurePythonRuntime, type PythonRuntimeOutcome } from "../python-runtime.ts";
import type { BashOperations } from "./bash.ts";
import {
	applyEngineFrame,
	getOrCreateWindowsShellState,
	mergeEffectiveEnv,
	resolveEffectiveCwd,
	type WindowsShellState,
} from "./windows-shell-state.ts";

const ENGINE_FRAME_SENTINEL = 0x1e;

/** The full §1.3 control-frame shape. */
export interface WindowsShellEngineFrame {
	exitCode: number;
	cwd: string;
	envDelta: Record<string, string | null>;
	unsupported: { code: "unsupported"; construct: string; message: string } | null;
}

export class WindowsShellEngineFailure extends Error {
	readonly capturedOutput: string;

	constructor(message: string, capturedOutput: string) {
		super(message);
		this.name = "WindowsShellEngineFailure";
		this.capturedOutput = capturedOutput;
	}
}

function resolveEngineScriptPath(): string {
	return join(getBundledResourcesDir(), "runtimes", "pi-shell-engine", "main.py");
}

const MAX_CONTROL_FRAME_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the terminal frame from the dedicated control stream. Command output is never retained here. */
function parseControlFrame(buffer: Buffer): WindowsShellEngineFrame | undefined {
	if (buffer.length < 2 || buffer[buffer.length - 1] !== ENGINE_FRAME_SENTINEL) return undefined;
	const openIndex = buffer.lastIndexOf(ENGINE_FRAME_SENTINEL, buffer.length - 2);
	if (openIndex === -1) return undefined;
	try {
		const raw: unknown = JSON.parse(buffer.subarray(openIndex + 1, buffer.length - 1).toString("utf8"));
		if (!isRecord(raw)) return undefined;
		if (typeof raw.exitCode !== "number" || !Number.isInteger(raw.exitCode)) return undefined;
		if (typeof raw.cwd !== "string" || !isRecord(raw.envDelta)) return undefined;
		if (raw.unsupported !== null && !isRecord(raw.unsupported)) return undefined;
		if (
			raw.unsupported !== null &&
			(raw.unsupported.code !== "unsupported" ||
				typeof raw.unsupported.construct !== "string" ||
				typeof raw.unsupported.message !== "string")
		)
			return undefined;
		for (const value of Object.values(raw.envDelta)) {
			if (value !== null && typeof value !== "string") return undefined;
		}
		return raw as unknown as WindowsShellEngineFrame;
	} catch {
		return undefined;
	}
}

export interface WindowsShellEngineOptions {
	/** Override for tests: resolves the Python runtime outcome. Default: `ensurePythonRuntime`. */
	resolveRuntime?: () => Promise<PythonRuntimeOutcome>;
	/** Override for tests: absolute path to the engine's `main.py`. Default: the bundled runtime. */
	engineScriptPath?: string;
	/** Override for tests: the per-session state store lookup. Default: the shared module store. */
	getState?: (sessionKey: string) => WindowsShellState;
	/** Override for tests: spawns the engine child process. Default: `spawnProcess` (cross-spawn on win32). */
	spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

function degradationError(
	outcome: Extract<PythonRuntimeOutcome, { status: "offline" | "uv-unavailable" | "python-unavailable" }>,
) {
	return new Error(
		`The Windows shell engine (Python) is unavailable: ${outcome.reason} The simple-command PowerShell floor still works; fix the Python runtime (uv/network) to restore pipelines, redirection, expansion, and chaining.`,
	);
}

/**
 * Create the `python-engine` tier `BashOperations` for one bash-tool session. `exec`'s `command`
 * argument is the RAW Bash source from the `python-engine` route (never PowerShell-translated).
 */
export function createWindowsShellEngineOperations(
	sessionKey: string,
	options: WindowsShellEngineOptions = {},
): BashOperations {
	const resolveRuntime = options.resolveRuntime ?? (() => ensurePythonRuntime({ silent: true }));
	const engineScriptPath = options.engineScriptPath ?? resolveEngineScriptPath();
	const getState = options.getState ?? getOrCreateWindowsShellState;
	const spawn = options.spawn ?? spawnProcess;

	return {
		async exec(command, cwd, { onData, signal, timeout, env }) {
			const runtime = await resolveRuntime();
			if (runtime.status !== "ready") throw degradationError(runtime);

			const state = getState(sessionKey);
			const effectiveCwd = resolveEffectiveCwd(state, cwd);
			const effectiveEnv = mergeEffectiveEnv(state, env ?? getShellEnv());
			const timeoutMs = timeout !== undefined && timeout > 0 ? timeout * 1000 : undefined;
			// The engine's own soft deadline must fire and emit its cooperative exit-124 frame (which
			// preserves partial output) BEFORE the hard tree-kill backstop below, or the hard kill
			// always wins the race and the soft path never gets to run. Give it a head start; the hard
			// kill still bounds a hung engine that never reads its own deadline.
			const requestTimeoutMs = timeoutMs !== undefined ? Math.max(timeoutMs - 500, 500) : undefined;

			const request = {
				command,
				cwd: effectiveCwd,
				env: effectiveEnv,
				...(requestTimeoutMs !== undefined ? { timeoutMs: requestTimeoutMs } : {}),
			};

			const child = spawn(runtime.pythonPath, ["-B", engineScriptPath], {
				cwd: effectiveCwd,
				env: {
					...effectiveEnv,
					PYTHONDONTWRITEBYTECODE: "1",
					PYTHONIOENCODING: "utf-8",
					PYTHONUNBUFFERED: "1",
					PYTHONUTF8: "1",
				},
				stdio: ["pipe", "pipe", "pipe"],
			});
			if (child.pid) trackDetachedChildPid(child.pid);

			let controlBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
			let controlOverflow = false;

			// Command output is the data stream: forward it immediately and never retain a
			// second full copy merely to find the terminal frame.
			child.stdout?.on("data", (chunk: Buffer) => {
				onData(chunk);
			});
			// stderr is the bounded control stream. The Python engine routes command stderr
			// into stdout, so this channel contains only the terminal frame/diagnostics.
			child.stderr?.on("data", (chunk: Buffer) => {
				if (controlOverflow) return;
				if (controlBuffer.length + chunk.length > MAX_CONTROL_FRAME_BYTES) {
					controlOverflow = true;
					return;
				}
				controlBuffer = Buffer.concat([controlBuffer, chunk]);
			});

			try {
				child.stdin?.end(JSON.stringify(request), "utf8");
				const terminal = await waitForChildProcessWithTermination(child, {
					signal,
					timeoutMs,
					killGraceMs: 2_000,
				});
				if (signal?.aborted) throw new Error("aborted");

				const frame = controlOverflow ? undefined : parseControlFrame(controlBuffer);
				if (!frame) {
					const capturedOutput = controlOverflow
						? `control frame exceeded ${MAX_CONTROL_FRAME_BYTES} bytes`
						: controlBuffer.toString("utf8");
					throw new WindowsShellEngineFailure(
						`Windows shell engine failed (process exit ${terminal.code ?? "null"}) without a parseable control frame.\n${capturedOutput}`,
						capturedOutput,
					);
				}

				applyEngineFrame(state, frame);
				if (frame.unsupported) throw new Error(frame.unsupported.message);
				return { exitCode: frame.exitCode };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
			}
		},
	};
}
