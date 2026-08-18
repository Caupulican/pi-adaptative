/**
 * Persistent Windows Python shell-engine sessions.
 *
 * One coordinator process is keyed to each agent session. Requests are serialized as JSON lines;
 * Node remains the sole owner of cwd/environment state and derives each request only after the
 * preceding terminal frame has been applied. Command bytes stream on stdout, followed by a
 * request-specific output barrier. A correlated control frame arrives on stderr. Requiring both
 * channels before settlement prevents cross-pipe tail loss and stale-frame reuse.
 *
 * Timeout, abort, protocol failure, or coordinator death resets the whole process tree. The next
 * request starts a clean coordinator from the last state Node actually acknowledged.
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { getBundledResourcesDir } from "../../config.ts";
import { spawnProcess } from "../../utils/child-process.ts";
import { getShellConfig, getShellEnv } from "../../utils/shell.ts";
import { ensurePythonRuntime, type PythonRuntimeOutcome } from "../python-runtime.ts";
import { isRecordObject } from "../util/value-guards.ts";
import type { BashOperations } from "./bash.ts";
import { PersistentProcessCoordinator } from "./persistent-process-coordinator.ts";
import { tokenizeShellCommand } from "./shell-command-parser.ts";
import {
	applyEngineFrame,
	getOrCreateWindowsShellState,
	mergeEffectiveEnv,
	resolveEffectiveCwd,
	type WindowsShellState,
} from "./windows-shell-state.ts";

const ENGINE_FRAME_SENTINEL = 0x1e;
const MAX_CONTROL_FRAME_BYTES = 64 * 1024;
const SOFT_DEADLINE_HEADSTART_MS = 100;

/** State/result fields returned for every completed engine command. */
export interface WindowsShellEngineFrame {
	exitCode: number;
	cwd: string;
	envDelta: Record<string, string | null>;
	unsupported: { code: "unsupported"; construct: string; message: string } | null;
}

interface WindowsShellEngineControlFrame extends WindowsShellEngineFrame {
	requestId: string;
}

interface WindowsShellEngineRequest {
	requestId: string;
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	powershellPath?: string;
	timeoutMs?: number;
}

interface ParsedControlFrame {
	kind: "frame";
	frame: WindowsShellEngineControlFrame;
	frameStart: number;
	frameEnd: number;
}

interface InvalidControlFrame {
	kind: "invalid";
}

interface ActiveEngineExec {
	onStdout(data: Buffer): void;
	onStderr(data: Buffer): void;
	onChildClose(code: number | null): void;
	fail(error: Error): void;
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

function invokesPowerShellScript(command: string): boolean {
	const tokens = tokenizeShellCommand(command);
	// An unparseable command is already heading to the authoritative Python parser;
	// resolve conservatively so script adaptation cannot lose an explicit host choice.
	if (!tokens) return /\.ps1\b/iu.test(command);

	let atCommandStart = true;
	let skipRedirectTarget = false;
	for (const token of tokens) {
		if (token.kind === "operator" || token.kind === "pipe") {
			atCommandStart = true;
			skipRedirectTarget = false;
			continue;
		}
		if (token.kind === "redirect") {
			skipRedirectTarget = !/^\d*[<>]&[\d-]+$/u.test(token.value);
			continue;
		}
		if (skipRedirectTarget) {
			skipRedirectTarget = false;
			continue;
		}
		if (!atCommandStart || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token.value)) continue;
		if (token.value.toLowerCase().endsWith(".ps1")) return true;
		atCommandStart = false;
	}
	return false;
}

function parseControlFrame(buffer: Buffer): ParsedControlFrame | InvalidControlFrame | undefined {
	const frameStart = buffer.indexOf(ENGINE_FRAME_SENTINEL);
	if (frameStart === -1) return undefined;
	const closeIndex = buffer.indexOf(ENGINE_FRAME_SENTINEL, frameStart + 1);
	if (closeIndex === -1) return undefined;
	try {
		const raw: unknown = JSON.parse(buffer.subarray(frameStart + 1, closeIndex).toString("utf8"));
		if (
			isRecordObject(raw) &&
			typeof raw.requestId === "string" &&
			/^[0-9a-f]{16}$/u.test(raw.requestId) &&
			typeof raw.exitCode === "number" &&
			Number.isInteger(raw.exitCode) &&
			typeof raw.cwd === "string" &&
			isRecordObject(raw.envDelta) &&
			(raw.unsupported === null || isRecordObject(raw.unsupported)) &&
			(raw.unsupported === null ||
				(raw.unsupported.code === "unsupported" &&
					typeof raw.unsupported.construct === "string" &&
					typeof raw.unsupported.message === "string")) &&
			Object.values(raw.envDelta).every((value) => value === null || typeof value === "string")
		) {
			return {
				kind: "frame",
				frame: raw as unknown as WindowsShellEngineControlFrame,
				frameStart,
				frameEnd: closeIndex + 1,
			};
		}
	} catch {
		// A complete delimited record that is not JSON is a terminal protocol fault.
	}
	return { kind: "invalid" };
}

export interface WindowsShellEngineOptions {
	/** Override for tests: resolves the Python runtime outcome. Default: `ensurePythonRuntime`. */
	resolveRuntime?: () => Promise<PythonRuntimeOutcome>;
	/** Override for tests: absolute path to the engine's `main.py`. Default: the bundled runtime. */
	engineScriptPath?: string;
	/** Override for tests: the per-session state store lookup. Default: the shared module store. */
	getState?: (sessionKey: string) => WindowsShellState;
	/** Override for tests: spawns the persistent coordinator. Default: `spawnProcess`. */
	spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	/** Override for tests: selected PowerShell host used to adapt `.ps1` external commands. */
	resolvePowerShellPath?: () => string;
}

function degradationError(
	outcome: Extract<PythonRuntimeOutcome, { status: "offline" | "uv-unavailable" | "python-unavailable" }>,
): Error {
	return new Error(
		`The Windows shell engine (Python) is unavailable: ${outcome.reason} The simple-command PowerShell floor still works; fix the Python runtime (uv/network) to restore for loops, portable builtins such as printf, pipelines, redirection, expansion, and chaining.`,
	);
}

class PersistentWindowsShellEngineSession {
	private readonly key: string;
	private readonly resolveRuntime: () => Promise<PythonRuntimeOutcome>;
	private readonly engineScriptPath: string;
	private readonly getState: (sessionKey: string) => WindowsShellState;
	private readonly spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	private readonly resolvePowerShellPath: () => string;
	private readonly coordinator = new PersistentProcessCoordinator();
	private activeExec: ActiveEngineExec | null = null;
	private disposed = false;

	constructor(key: string, options: WindowsShellEngineOptions) {
		this.key = key;
		this.resolveRuntime = options.resolveRuntime ?? (() => ensurePythonRuntime({ silent: true }));
		this.engineScriptPath = options.engineScriptPath ?? resolveEngineScriptPath();
		this.getState = options.getState ?? getOrCreateWindowsShellState;
		this.spawn = options.spawn ?? spawnProcess;
		this.resolvePowerShellPath =
			options.resolvePowerShellPath ??
			(() => (process.platform === "win32" ? getShellConfig(undefined, "powershell").shell : "powershell"));
	}

	exec(
		command: string,
		cwd: string,
		options: Parameters<BashOperations["exec"]>[2],
	): Promise<{ exitCode: number | null }> {
		return this.coordinator.runSerialized(() => this.execNow(command, cwd, options));
	}

	get terminalPromise(): Promise<void> {
		return this.coordinator.terminalPromise;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const active = this.activeExec;
		active?.fail(new Error(`Windows shell engine session "${this.key}" is disposed`));
		this.coordinator.dispose();
	}

	disposeAndWait(timeoutMs?: number): Promise<void> {
		this.dispose();
		return this.coordinator.disposeAndWait(timeoutMs);
	}

	private async execNow(
		command: string,
		cwd: string,
		{ onData, signal, timeout, env }: Parameters<BashOperations["exec"]>[2],
	): Promise<{ exitCode: number | null }> {
		if (this.disposed) throw new Error(`Windows shell engine session "${this.key}" is disposed`);
		if (signal?.aborted) throw new Error("aborted");

		const state = this.getState(this.key);
		const effectiveCwd = resolveEffectiveCwd(state, cwd);
		const effectiveEnv = mergeEffectiveEnv(state, env ?? getShellEnv());
		const child = await this.ensureChild(effectiveEnv);
		if (this.disposed) {
			this.killChild();
			throw new Error(`Windows shell engine session "${this.key}" is disposed`);
		}
		if (signal?.aborted) {
			this.killChild();
			throw new Error("aborted");
		}
		if (!child.stdin || !child.stdout || !child.stderr || child !== this.coordinator.child) {
			this.killChild();
			throw new Error("Failed to start Windows shell engine coordinator");
		}

		const timeoutMs = timeout !== undefined && timeout > 0 ? timeout * 1000 : undefined;
		const requestTimeoutMs =
			timeoutMs !== undefined ? Math.max(timeoutMs - SOFT_DEADLINE_HEADSTART_MS, 1) : undefined;
		const requestId = randomBytes(8).toString("hex");
		const request: WindowsShellEngineRequest = {
			requestId,
			command,
			cwd: effectiveCwd,
			env: effectiveEnv,
			...(invokesPowerShellScript(command) ? { powershellPath: this.resolvePowerShellPath() } : {}),
			...(requestTimeoutMs !== undefined ? { timeoutMs: requestTimeoutMs } : {}),
		};
		const outputBarrier = Buffer.from(`\x1e${requestId}\x1e`, "latin1");

		this.coordinator.setLoopRef(true);
		try {
			return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
				let settled = false;
				let pendingOutput: Buffer<ArrayBufferLike> = Buffer.alloc(0);
				let controlBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
				let controlOverflow = false;
				let sawOutputBarrier = false;
				let controlFrame: WindowsShellEngineControlFrame | undefined;
				let completionScheduled = false;
				let timeoutTimer: NodeJS.Timeout | undefined;

				const settle = (finish: () => void): void => {
					if (settled) return;
					settled = true;
					if (timeoutTimer) clearTimeout(timeoutTimer);
					if (signal) signal.removeEventListener("abort", onAbort);
					if (this.activeExec === active) this.activeExec = null;
					finish();
				};

				const emitPending = (upTo: number): void => {
					if (upTo <= 0) return;
					onData(pendingOutput.subarray(0, upTo));
					pendingOutput = pendingOutput.subarray(upTo);
				};

				const capturedControl = (): string =>
					controlOverflow
						? `control frame exceeded ${MAX_CONTROL_FRAME_BYTES} bytes`
						: controlBuffer.toString("utf8");

				const failAndReset = (error: Error): void => {
					if (settled) return;
					emitPending(pendingOutput.length);
					this.killChild();
					settle(() => reject(error));
				};

				const protocolFailure = (message: string): WindowsShellEngineFailure => {
					const capturedOutput = capturedControl();
					return new WindowsShellEngineFailure(`${message}\n${capturedOutput}`, capturedOutput);
				};

				const maybeComplete = (): void => {
					if (!sawOutputBarrier || !controlFrame || settled || completionScheduled) return;
					completionScheduled = true;
					// stdout and stderr are independent pipes. Keep this request active through the
					// next check phase so already-delivered post-barrier bytes are rejected here,
					// never forwarded into a queued request that starts in a promise microtask.
					setImmediate(() => {
						if (settled || this.activeExec !== active || !controlFrame) return;
						applyEngineFrame(state, controlFrame);
						if (controlFrame.unsupported) {
							settle(() =>
								reject(new Error(controlFrame?.unsupported?.message ?? "Unsupported shell construct")),
							);
							return;
						}
						settle(() => resolve({ exitCode: controlFrame?.exitCode ?? null }));
					});
				};

				const onAbort = (): void => failAndReset(new Error("aborted"));

				const active: ActiveEngineExec = {
					onStdout: (data) => {
						if (sawOutputBarrier) {
							failAndReset(protocolFailure("Windows shell engine emitted output after its terminal barrier."));
							return;
						}
						pendingOutput = pendingOutput.length === 0 ? data : Buffer.concat([pendingOutput, data]);
						const barrierIndex = pendingOutput.indexOf(outputBarrier);
						if (barrierIndex !== -1) {
							emitPending(barrierIndex);
							pendingOutput = pendingOutput.subarray(outputBarrier.length);
							if (pendingOutput.length > 0) {
								failAndReset(protocolFailure("Windows shell engine emitted bytes after its terminal barrier."));
								return;
							}
							sawOutputBarrier = true;
							maybeComplete();
							return;
						}
						emitPending(pendingOutput.length - (outputBarrier.length - 1));
					},
					onStderr: (data) => {
						if (controlOverflow) return;
						if (controlBuffer.length + data.length > MAX_CONTROL_FRAME_BYTES) {
							controlOverflow = true;
							failAndReset(protocolFailure("Windows shell engine control frame overflowed."));
							return;
						}
						controlBuffer = controlBuffer.length === 0 ? data : Buffer.concat([controlBuffer, data]);
						const parsed = parseControlFrame(controlBuffer);
						if (!parsed) return;
						if (parsed.kind === "invalid") {
							failAndReset(protocolFailure("Windows shell engine returned a malformed control frame."));
							return;
						}
						if (parsed.frame.requestId !== requestId) {
							failAndReset(
								protocolFailure(
									`Windows shell engine returned stale control frame ${parsed.frame.requestId}; expected ${requestId}.`,
								),
							);
							return;
						}
						if (controlBuffer.subarray(parsed.frameEnd).toString("utf8").trim().length > 0) {
							failAndReset(protocolFailure("Windows shell engine emitted trailing control bytes."));
							return;
						}
						controlFrame = parsed.frame;
						maybeComplete();
					},
					onChildClose: (code) => {
						const capturedOutput = capturedControl();
						emitPending(pendingOutput.length);
						settle(() =>
							reject(
								new WindowsShellEngineFailure(
									`Windows shell engine coordinator exited (${code ?? "null"}) before a complete terminal handoff.\n${capturedOutput}`,
									capturedOutput,
								),
							),
						);
					},
					fail: (error) => failAndReset(error),
				};

				this.activeExec = active;
				if (signal) {
					signal.addEventListener("abort", onAbort, { once: true });
					if (signal.aborted) {
						onAbort();
						return;
					}
				}
				if (timeoutMs !== undefined) {
					timeoutTimer = setTimeout(() => failAndReset(new Error(`timeout:${timeout}`)), timeoutMs);
				}

				try {
					child.stdin?.write(`${JSON.stringify(request)}\n`, "utf8", (error) => {
						if (!error) return;
						failAndReset(new Error(`Failed to write to Windows shell engine coordinator: ${error.message}`));
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					failAndReset(new Error(`Failed to write to Windows shell engine coordinator: ${message}`));
				}
			});
		} finally {
			this.coordinator.setLoopRef(false);
		}
	}

	private async ensureChild(env: NodeJS.ProcessEnv): Promise<ChildProcess> {
		if (this.coordinator.child) return this.coordinator.child;
		const runtime = await this.resolveRuntime();
		if (runtime.status !== "ready") throw degradationError(runtime);
		if (this.disposed) throw new Error(`Windows shell engine session "${this.key}" is disposed`);

		const child = this.spawn(runtime.pythonPath, ["-B", this.engineScriptPath, "--server"], {
			cwd: dirname(this.engineScriptPath),
			env: {
				...env,
				PYTHONDONTWRITEBYTECODE: "1",
				PYTHONIOENCODING: "utf-8",
				PYTHONUNBUFFERED: "1",
				PYTHONUTF8: "1",
			},
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.coordinator.attach(child, {
			onStdout: (data) => {
				const active = this.activeExec;
				if (active) active.onStdout(data);
				else if (data.length > 0) this.killChild();
			},
			onStderr: (data) => {
				const active = this.activeExec;
				if (active) active.onStderr(data);
				else if (data.length > 0) this.killChild();
			},
			onError: (error) => this.activeExec?.fail(error),
			onClose: (code) => this.activeExec?.onChildClose(code),
		});
		return child;
	}

	private killChild(): void {
		this.coordinator.kill();
	}
}

const engineSessions = new Map<string, PersistentWindowsShellEngineSession>();

function acquireWindowsShellEngineSession(
	key: string,
	options: WindowsShellEngineOptions,
): PersistentWindowsShellEngineSession {
	const existing = engineSessions.get(key);
	if (existing) return existing;
	const session = new PersistentWindowsShellEngineSession(key, options);
	engineSessions.set(key, session);
	return session;
}

/** Kill and forget a Python coordinator. The next call for this key starts a clean process. */
export function disposeWindowsShellEngineSession(key: string): Promise<void> {
	const session = engineSessions.get(key);
	if (!session) return Promise.resolve();
	engineSessions.delete(key);
	const terminalPromise = session.terminalPromise;
	session.dispose();
	return terminalPromise;
}

/** Awaitable disposal that guarantees the engine child process has closed before resolving. */
export function disposeWindowsShellEngineSessionAndWait(key: string, timeoutMs?: number): Promise<void> {
	const session = engineSessions.get(key);
	if (!session) return Promise.resolve();
	engineSessions.delete(key);
	return session.disposeAndWait(timeoutMs);
}

/** Create the Python-engine tier for one bash-tool session. */
export function createWindowsShellEngineOperations(
	sessionKey: string,
	options: WindowsShellEngineOptions = {},
): BashOperations {
	return {
		// Resolve through the registry for every command. Session teardown (for example after
		// credential/environment changes) deletes only this tenant's entry; an already-built tool
		// then lazily acquires a fresh coordinator instead of retaining the disposed instance.
		exec: (command, cwd, execOptions) =>
			acquireWindowsShellEngineSession(sessionKey, options).exec(command, cwd, execOptions),
	};
}
