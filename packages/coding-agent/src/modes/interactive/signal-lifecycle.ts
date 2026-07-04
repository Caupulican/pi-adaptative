/**
 * Process signal handling, shutdown, and crash/suspend lifecycle extracted from
 * interactive-mode.
 *
 * These register SIGTERM/SIGHUP/uncaughtException/dead-terminal handlers, run the
 * graceful and emergency shutdown paths (preserving the #4144/#5080 ordering
 * where signal-triggered shutdown emits extension cleanup before terminal
 * writes), and implement Ctrl+Z suspend/resume. They operate through a
 * `SignalLifecycleHost` seam: `isShuttingDown`/`signalCleanupHandlers` are
 * threaded via get/set, and the cross-cluster calls (shutdown, unregister,
 * emergency, crash) go through host seams so interactive-mode's thin wrappers —
 * and the #5080/suspend behaviour tests that stub them — keep working.
 */

import type { TUI } from "@caupulican/pi-tui";
import chalk from "chalk";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";

const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN"]);

function isDeadTerminalError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

export interface SignalLifecycleHost {
	isShuttingDown: boolean;
	signalCleanupHandlers: Array<() => void>;
	readonly shutdownRequested: boolean;
	readonly runtimeHost: Pick<AgentSessionRuntime, "dispose">;
	readonly ui: TUI;
	stop(): void;
	formatResumeCommand(): string | undefined;
	showStatus(message: string): void;
	shutdown(options?: { fromSignal?: boolean }): Promise<void>;
	unregisterSignalHandlers(): void;
	emergencyTerminalExit(): never;
	uncaughtCrash(error: Error): never;
}

export async function shutdown(host: SignalLifecycleHost, options?: { fromSignal?: boolean }): Promise<void> {
	if (host.isShuttingDown) return;
	host.isShuttingDown = true;
	host.unregisterSignalHandlers();

	if (options?.fromSignal) {
		// Signal-triggered shutdown (SIGTERM/SIGHUP). Emit extension cleanup
		// (session_shutdown) BEFORE touching the terminal. Extension teardown
		// such as removing sockets does not write to the tty, so it must not be
		// skipped if a later terminal-restore write fails on a dead or stalled
		// terminal. If the terminal is gone, the restore writes below emit EIO,
		// which the stdout/stderr error handler turns into emergencyTerminalExit;
		// the render loop is already idle, so this cannot hot-spin (see #4144).
		await host.runtimeHost.dispose();
		await host.ui.terminal.drainInput(1000);
		host.stop();
		process.exit(0);
	}

	// Interactive quit (Ctrl+D, Ctrl+C, /quit, extension shutdown()). Stop the
	// TUI before emitting shutdown events so extension UI cleanup cannot repaint
	// the final frame while the process is exiting.
	// Drain any in-flight Kitty key release events before stopping.
	// This prevents escape sequences from leaking to the parent shell over slow SSH.
	await host.ui.terminal.drainInput(1000);

	host.stop();
	await host.runtimeHost.dispose();

	const resumeCommand = host.formatResumeCommand();
	if (resumeCommand) {
		process.stdout.write(`${chalk.dim("To resume this session:")} ${resumeCommand}\n`);
	}

	process.exit(0);
}

export function emergencyTerminalExit(host: SignalLifecycleHost): never {
	host.isShuttingDown = true;
	host.unregisterSignalHandlers();
	killTrackedDetachedChildren();
	// The terminal is gone. Do not run normal shutdown because TUI and
	// extension cleanup can write restore sequences and re-trigger EIO.
	process.exit(129);
}

/**
 * Last-resort handler for uncaught exceptions. The TUI puts stdin into raw
 * mode and hides the cursor; without this handler, an uncaught throw from
 * anywhere (e.g. an extension's async `ChildProcess.on("exit")` callback)
 * tears down the process while leaving the terminal in raw mode with no
 * cursor, requiring `stty sane && reset` to recover.
 *
 * Unlike emergencyTerminalExit, the terminal is still alive here, so we
 * call ui.stop() to restore cooked mode, the cursor, and disable bracketed
 * paste / Kitty / modifyOtherKeys sequences.
 */
export function uncaughtCrash(host: SignalLifecycleHost, error: Error): never {
	if (host.isShuttingDown) {
		process.exit(1);
	}
	host.isShuttingDown = true;
	try {
		host.unregisterSignalHandlers();
	} catch {}
	try {
		killTrackedDetachedChildren();
	} catch {}
	try {
		host.ui.stop();
	} catch {}
	console.error("pi exiting due to uncaughtException:");
	console.error(error);
	process.exit(1);
}

/**
 * Check if shutdown was requested and perform shutdown if so.
 */
export async function checkShutdownRequested(host: SignalLifecycleHost): Promise<void> {
	if (!host.shutdownRequested) return;
	await host.shutdown();
}

export function registerSignalHandlers(host: SignalLifecycleHost): void {
	host.unregisterSignalHandlers();

	const signals: NodeJS.Signals[] = ["SIGTERM"];
	if (process.platform !== "win32") {
		signals.push("SIGHUP");
	}

	for (const signal of signals) {
		const handler = () => {
			// SIGHUP no longer hard-exits: graceful shutdown emits session_shutdown
			// first, then attempts terminal restore. A genuinely dead terminal
			// surfaces as an EIO on the restore writes, which the stdout/stderr
			// error handler converts into emergencyTerminalExit (see #4144, #5080).
			killTrackedDetachedChildren();
			void host.shutdown({ fromSignal: true });
		};
		process.prependListener(signal, handler);
		host.signalCleanupHandlers.push(() => process.off(signal, handler));
	}

	const terminalErrorHandler = (error: Error) => {
		if (isDeadTerminalError(error)) {
			host.emergencyTerminalExit();
		}
		throw error;
	};
	process.stdout.on("error", terminalErrorHandler);
	process.stderr.on("error", terminalErrorHandler);
	host.signalCleanupHandlers.push(() => process.stdout.off("error", terminalErrorHandler));
	host.signalCleanupHandlers.push(() => process.stderr.off("error", terminalErrorHandler));

	// Restore the terminal before the process dies on any uncaught throw.
	// Without this, an unhandled exception from extension code (or anywhere
	// in pi) leaves the terminal in raw mode with no cursor.
	const uncaughtExceptionHandler = (error: Error) => host.uncaughtCrash(error);
	process.prependListener("uncaughtException", uncaughtExceptionHandler);
	host.signalCleanupHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));
}

export function unregisterSignalHandlers(host: SignalLifecycleHost): void {
	for (const cleanup of host.signalCleanupHandlers) {
		cleanup();
	}
	host.signalCleanupHandlers = [];
}

export function handleCtrlZ(host: Pick<SignalLifecycleHost, "showStatus" | "ui">): void {
	if (process.platform === "win32") {
		host.showStatus("Suspend to background is not supported on Windows");
		return;
	}

	// Keep the event loop alive while suspended. Without this, stopping the TUI
	// can leave Node with no ref'ed handles, causing the process to exit on fg
	// before the SIGCONT handler gets a chance to restore the terminal.
	const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

	// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
	// kill the backgrounded process. The handler is removed on resume.
	const ignoreSigint = () => {};
	process.on("SIGINT", ignoreSigint);

	// Set up handler to restore TUI when resumed
	process.once("SIGCONT", () => {
		clearInterval(suspendKeepAlive);
		process.removeListener("SIGINT", ignoreSigint);
		host.ui.start();
		host.ui.requestRender(true);
	});

	try {
		// Stop the TUI (restore terminal to normal mode)
		host.ui.stop();

		// Send SIGTSTP to process group (pid=0 means all processes in group)
		process.kill(0, "SIGTSTP");
	} catch (error) {
		clearInterval(suspendKeepAlive);
		process.removeListener("SIGINT", ignoreSigint);
		throw error;
	}
}
