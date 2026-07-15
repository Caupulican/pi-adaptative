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
import { killTree } from "@caupulican/pi-agent-core/node";
import crossSpawn from "cross-spawn";

const EXIT_STDIO_GRACE_MS = 100;

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
	const requestTermination = (nextReason: "aborted" | "timeout") => {
		if (reason !== undefined || child.exitCode !== null || child.signalCode !== null) return;
		reason = nextReason;
		void killTree(child, { graceMs: options.killGraceMs }).then(
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
