import {
	type ChildProcess,
	type ChildProcessByStdio,
	spawn as nodeSpawn,
	spawnSync as nodeSpawnSync,
	type SpawnOptions,
	type SpawnOptionsWithStdioTuple,
	type SpawnSyncOptionsWithStringEncoding,
	type SpawnSyncReturns,
	type StdioNull,
	type StdioPipe,
} from "node:child_process";
import type { Readable } from "node:stream";
import { isPositiveSafePid, killTree } from "@caupulican/pi-agent-core/process-tree";
import crossSpawn from "cross-spawn";

const EXIT_STDIO_GRACE_MS = 100;

/**
 * Bind immediately after spawning, with Node's native `signal` option omitted. A failed spawn
 * can retain a native handle before ENOENT is emitted; calling its kill() in that window can
 * signal the caller's process group. Only the child's own successful spawn event grants a kill.
 */
export function bindChildProcessAbort(
	child: ChildProcess,
	signal: AbortSignal,
	options: { onDiagnostic?: (message: string) => void } = {},
): void {
	let spawned = false;
	let requested = false;
	const onAbort = () => {
		if (
			!spawned ||
			requested ||
			!isPositiveSafePid(child.pid) ||
			child.exitCode !== null ||
			child.signalCode !== null
		)
			return;
		requested = true;
		try {
			if (child.kill()) return;
		} catch {
			// An abort listener runs on EventTarget: propagating a signal error would crash the host.
		}
		(options.onDiagnostic ?? console.error)("Child process cancellation could not deliver its termination signal.");
	};
	const onSpawn = () => {
		spawned = true;
		if (signal.aborted) onAbort();
	};
	const cleanup = () => {
		signal.removeEventListener("abort", onAbort);
		child.off("spawn", onSpawn);
		child.off("error", onError);
		child.off("exit", cleanup);
		child.off("close", cleanup);
	};
	const onError = () => {
		// Spawn failure grants no process ownership. A later IPC/signal error is not an exit.
		if (!spawned) cleanup();
	};
	child.once("spawn", onSpawn);
	child.on("error", onError);
	child.once("exit", cleanup);
	child.once("close", cleanup);
	signal.addEventListener("abort", onAbort, { once: true });
}

export function spawnProcess(
	command: string,
	args: string[],
	options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
): ChildProcessByStdio<null, Readable, Readable>;
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess;
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess {
	return process.platform === "win32" ? crossSpawn(command, args, options) : nodeSpawn(command, args, options);
}

export function spawnProcessSync(
	command: string,
	args: string[],
	options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
	return process.platform === "win32"
		? crossSpawn.sync(command, args, options)
		: nodeSpawnSync(command, args, options);
}

type ForceChildProcessSettlement = (code?: number | null) => void;

/**
 * Wait for a child process to terminate without hanging on inherited stdio handles.
 *
 * On Windows, daemonized descendants can inherit the child's stdout/stderr pipe
 * handles. In that case the child emits `exit`, but `close` can hang forever even
 * though the original process is already gone. We wait briefly for stdio to end,
 * then forcibly stop tracking the inherited handles.
 */
function waitForChildProcessInternal(
	child: ChildProcess,
	onForce?: (force: ForceChildProcessSettlement) => void,
): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null || child.stdout.readableEnded || child.stdout.destroyed;
		let stderrEnded = child.stderr === null || child.stderr.readableEnded || child.stderr.destroyed;

		const cleanup = () => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
		};

		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};
		onForce?.((code = child.exitCode) => {
			child.unref();
			finalize(code);
		});

		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) {
				finalize(exitCode);
			}
		};

		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};

		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};

		const onError = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		const onExit = (code: number | null) => {
			if (settled || exited) return;
			exited = true;
			exitCode = code;
			maybeFinalizeAfterExit();
			if (!settled) {
				postExitTimer = setTimeout(() => finalize(code), EXIT_STDIO_GRACE_MS);
			}
		};

		const onClose = (code: number | null) => {
			finalize(code);
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);

		// ChildProcess events are not replayed. Some callers legitimately attach after other async
		// setup, so a fast child may already have emitted exit/close before this waiter is created.
		if (child.exitCode !== null || child.signalCode !== null) {
			onExit(child.exitCode);
		}
	});
}

export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return waitForChildProcessInternal(child);
}

export interface ChildProcessTerminationOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	killGraceMs?: number;
	/**
	 * Diagnostics sink for a non-fatal kill-tree failure (e.g. a missing or failing Windows
	 * taskkill, F8). Defaults to `console.error` so a failure is never silently reported as a
	 * false "killed" -- callers that already have a session/UI diagnostic surface can override it.
	 */
	onDiagnostic?: (message: string) => void;
}

export interface ChildProcessTerminationResult {
	code: number | null;
	reason: "exited" | "aborted" | "timeout";
}

/**
 * Wait for a child terminal event while converting abort/deadline events into a
 * tracked process-tree termination. No PID polling or detached killer process is used.
 */
export async function waitForChildProcessWithTermination(
	child: ChildProcess,
	options: ChildProcessTerminationOptions = {},
): Promise<ChildProcessTerminationResult> {
	let forceSettle: ForceChildProcessSettlement = () => {};
	const terminal = waitForChildProcessInternal(child, (force) => {
		forceSettle = force;
	});
	let reason: ChildProcessTerminationResult["reason"] | undefined;
	let timeout: NodeJS.Timeout | undefined;
	const onDiagnostic = options.onDiagnostic ?? ((message: string) => console.error(message));
	const requestTermination = (nextReason: "aborted" | "timeout") => {
		if (reason !== undefined || child.exitCode !== null || child.signalCode !== null) return;
		reason = nextReason;
		void killTree(child, { graceMs: options.killGraceMs, onDiagnostic }).then(
			() => forceSettle(),
			() => forceSettle(),
		);
	};
	const onAbort = () => requestTermination("aborted");
	if (options.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}
	if (options.timeoutMs !== undefined) {
		timeout = setTimeout(() => requestTermination("timeout"), Math.max(0, options.timeoutMs));
		timeout.unref();
	}
	try {
		const code = await terminal;
		return { code, reason: reason ?? "exited" };
	} finally {
		if (timeout) clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onAbort);
	}
}
