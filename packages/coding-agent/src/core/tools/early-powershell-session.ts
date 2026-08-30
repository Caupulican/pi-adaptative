import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { setChildProcessLoopRef } from "../../utils/child-process-ref.ts";
import {
	createPowerShellHostEnvironment,
	POWERSHELL_ARGS,
	POWERSHELL_BOOTSTRAP,
	POWERSHELL_SESSION_READY_MARKER,
	POWERSHELL_SESSION_STDERR_READY_MARKER,
	POWERSHELL_STARTUP_PROBE_TIMEOUT_MS,
} from "../../utils/powershell-session-protocol.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";

const MAX_STARTUP_DIAGNOSTIC_BYTES = 16 * 1024;
const READY_BYTES = Buffer.from(POWERSHELL_SESSION_READY_MARKER, "latin1");
const STDERR_READY_BYTES = Buffer.from(POWERSHELL_SESSION_STDERR_READY_MARKER, "latin1");
const DEFAULT_CANDIDATES = ["pwsh.exe"];

export interface CliPowerShellWarmStartOptions {
	platform?: NodeJS.Platform;
	cwd: string;
	env: NodeJS.ProcessEnv;
	candidates?: readonly string[];
	spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	startupTimeoutMs?: number;
}

export interface ReadyCliPowerShellSession {
	child: ChildProcess;
	cwd: string;
	env: NodeJS.ProcessEnv;
	releaseStartupListeners(): void;
}

let warmStart: Promise<ReadyCliPowerShellSession | null> | null = null;
let warmStartClaimed = false;

function waitForReady(
	child: ChildProcess,
	cwd: string,
	env: NodeJS.ProcessEnv,
	startupTimeoutMs: number,
): Promise<ReadyCliPowerShellSession> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let stdout: Buffer = Buffer.alloc(0);
		let stderr: Buffer = Buffer.alloc(0);
		let stdoutReady = false;
		let stderrReady = false;
		let timeoutTimer: NodeJS.Timeout | undefined;

		const diagnostic = (): string => {
			const text = Buffer.concat([stdout, stderr]).toString("utf8").trim();
			return text ? `: ${text}` : "";
		};
		const releaseStartupListeners = (): void => {
			child.stdout?.off("data", onStdout);
			child.stderr?.off("data", onStderr);
			child.off("error", onError);
			child.off("exit", onExit);
		};
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			if (timeoutTimer) clearTimeout(timeoutTimer);
			releaseStartupListeners();
			child.kill();
			reject(error);
		};
		const resolveWhenReady = (): void => {
			if (settled || !stdoutReady || !stderrReady) return;
			settled = true;
			if (timeoutTimer) clearTimeout(timeoutTimer);
			resolve({ child, cwd, env, releaseStartupListeners });
		};
		const onStdout = (data: Buffer): void => {
			if (settled) return;
			stdout = stdout.length === 0 ? data : Buffer.concat([stdout, data]).subarray(-MAX_STARTUP_DIAGNOSTIC_BYTES);
			stdoutReady ||= stdout.indexOf(READY_BYTES) !== -1;
			resolveWhenReady();
		};
		const onStderr = (data: Buffer): void => {
			if (settled) return;
			stderr = stderr.length === 0 ? data : Buffer.concat([stderr, data]).subarray(-MAX_STARTUP_DIAGNOSTIC_BYTES);
			stderrReady ||= stderr.indexOf(STDERR_READY_BYTES) !== -1;
			resolveWhenReady();
		};
		const onError = (error: Error): void => fail(new Error(`${error.message}${diagnostic()}`));
		const onExit = (code: number | null): void =>
			fail(new Error(`exited with code ${code ?? "null"} before readiness${diagnostic()}`));

		child.stdout?.on("data", onStdout);
		child.stderr?.on("data", onStderr);
		child.on("error", onError);
		child.on("exit", onExit);
		timeoutTimer = setTimeout(
			() => fail(new Error(`startup timed out after ${startupTimeoutMs}ms${diagnostic()}`)),
			startupTimeoutMs,
		);
		timeoutTimer.unref();
	});
}

async function startFirstUsableSession(
	options: Required<Pick<CliPowerShellWarmStartOptions, "cwd" | "env" | "candidates" | "startupTimeoutMs">> & {
		spawnProcess: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	},
): Promise<ReadyCliPowerShellSession | null> {
	for (const candidate of options.candidates) {
		let child: ChildProcess;
		try {
			child = options.spawnProcess(candidate, [...POWERSHELL_ARGS, POWERSHELL_BOOTSTRAP], {
				cwd: options.cwd,
				env: options.env,
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch {
			continue;
		}
		setChildProcessLoopRef(child, false);
		// A warm start is spawned before anything owns it, and it is unreferenced so it cannot hold
		// the loop open — which also means nothing would ever reap it. Track it so shutdown kills it
		// like any other detached child; the claimer untracks it when it takes ownership.
		if (child.pid) trackDetachedChildPid(child.pid);
		try {
			return await waitForReady(child, options.cwd, options.env, options.startupTimeoutMs);
		} catch {
			// This host is a dead end. Kill its process before trying the next one, or every failed
			// candidate leaves a live shell behind for the lifetime of the CLI.
			releaseWarmStartChild(child);
		}
	}
	return null;
}

/** Begin one unclaimed native PowerShell session while the CLI imports its main runtime graph. */
export function startCliPowerShellWarmStart(options: CliPowerShellWarmStartOptions): void {
	if ((options.platform ?? process.platform) !== "win32" || warmStart) return;
	warmStartClaimed = false;
	warmStart = startFirstUsableSession({
		cwd: options.cwd,
		env: createPowerShellHostEnvironment(options.env),
		candidates: options.candidates ?? DEFAULT_CANDIDATES,
		startupTimeoutMs: options.startupTimeoutMs ?? POWERSHELL_STARTUP_PROBE_TIMEOUT_MS,
		spawnProcess: options.spawn ?? spawn,
	});
}

/** Claim the CLI warm start exactly once; callers attach ownership before releasing its listeners. */
export async function claimCliPowerShellWarmStart(): Promise<ReadyCliPowerShellSession | null> {
	if (!warmStart || warmStartClaimed) return null;
	warmStartClaimed = true;
	const pending = warmStart;
	const ready = await pending;
	if (warmStart === pending) warmStart = null;
	if (!ready) return null;
	if (ready.child.exitCode !== null || ready.child.signalCode !== null || ready.child.killed) {
		ready.releaseStartupListeners();
		if (ready.child.pid) untrackDetachedChildPid(ready.child.pid);
		return null;
	}
	// Ownership transfers to the caller, which tracks the child itself.
	if (ready.child.pid) untrackDetachedChildPid(ready.child.pid);
	return ready;
}

/** Kill an unowned warm-start child and stop tracking it. Safe to call more than once. */
function releaseWarmStartChild(child: ChildProcess): void {
	if (child.pid) untrackDetachedChildPid(child.pid);
	try {
		if (child.exitCode === null && child.signalCode === null && child.pid) killProcessTree(child.pid);
	} catch {
		// Best-effort reaping of a process nothing owns.
	}
}

/**
 * Kill a warm start nobody claimed. The CLI starts one before the runtime graph loads, and a
 * session that never runs a shell command (a `/new` or `/quit` first) would otherwise leave the
 * host process alive after pi exits.
 */
export async function disposeUnclaimedCliPowerShellWarmStart(): Promise<void> {
	const pending = warmStart;
	if (!pending || warmStartClaimed) return;
	warmStart = null;
	const ready = await pending;
	if (!ready) return;
	ready.releaseStartupListeners();
	releaseWarmStartChild(ready.child);
}

export async function resetCliPowerShellWarmStartForTests(): Promise<void> {
	const pending = warmStart;
	warmStart = null;
	warmStartClaimed = false;
	if (!pending) return;
	const ready = await pending;
	if (!ready) return;
	ready.releaseStartupListeners();
	ready.child.kill();
}
