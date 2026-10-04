/**
 * Process signal handling, shutdown, and crash/suspend lifecycle extracted from
 * interactive-mode.
 *
 * These register SIGTERM/SIGHUP/uncaughtException/dead-terminal handlers, run the
 * graceful and emergency shutdown paths (preserving the #4144/#5080 ordering
 * where signal-triggered shutdown emits extension cleanup before terminal
 * writes), and implement Ctrl+Z suspend/resume. They operate through a
 * `SignalLifecycle` class that owns the lifecycle state (`isShuttingDown`, the
 * registered listeners' cleanup handlers) and reaches the host only through a
 * small `SignalLifecyclePort` of closures.
 */

import type { TUI } from "@caupulican/pi-tui";
import chalk from "chalk";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { disposeUnclaimedCliPowerShellWarmStart } from "../../core/tools/early-powershell-session.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";

const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN"]);

function isDeadTerminalError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

/** What the signal lifecycle needs from the interactive host; everything else it owns itself. */
export interface SignalLifecyclePort {
	readonly runtimeHost: Pick<AgentSessionRuntime, "dispose">;
	readonly ui: TUI;
	isShutdownRequested(): boolean;
	stop(): void;
	formatResumeCommand(): string | undefined;
	showStatus(message: string): void;
	showError(message: string): void;
}

/** Longest rejection detail rendered into the transcript; enough for a stack, short of flooding it. */
const MAX_REJECTION_DETAIL = 2_000;

/**
 * Owns the process-level lifecycle state of an interactive session: whether shutdown has begun and the
 * cleanup handlers for every process listener it registered. Only this class writes either.
 */
export class SignalLifecycle {
	private shuttingDown = false;
	private cleanupHandlers: Array<() => void> = [];
	private readonly port: SignalLifecyclePort;

	constructor(port: SignalLifecyclePort) {
		this.port = port;
	}

	get isShuttingDown(): boolean {
		return this.shuttingDown;
	}

	async shutdown(options?: { fromSignal?: boolean }): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		this.unregisterSignalHandlers();

		// The CLI warm-starts a PowerShell host before the runtime graph loads. A session that never
		// runs a shell command never claims it, and nothing else reaps it — without this it outlives pi.
		await disposeUnclaimedCliPowerShellWarmStart();

		if (options?.fromSignal) {
			// Signal-triggered shutdown (SIGTERM/SIGHUP). Emit extension cleanup
			// (session_shutdown) BEFORE touching the terminal. Extension teardown
			// such as removing sockets does not write to the tty, so it must not be
			// skipped if a later terminal-restore write fails on a dead or stalled
			// terminal. If the terminal is gone, the restore writes below emit EIO,
			// which the stdout/stderr error handler turns into emergencyTerminalExit;
			// the render loop is already idle, so this cannot hot-spin (see #4144).
			await this.port.runtimeHost.dispose();
			await this.port.ui.terminal.drainInput(1000);
			this.port.stop();
			process.exit(0);
		}

		// Interactive quit (Ctrl+D, Ctrl+C, /quit, extension shutdown()). Stop the
		// TUI before emitting shutdown events so extension UI cleanup cannot repaint
		// the final frame while the process is exiting.
		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.port.ui.terminal.drainInput(1000);

		this.port.stop();
		await this.port.runtimeHost.dispose();

		const resumeCommand = this.port.formatResumeCommand();
		if (resumeCommand) {
			process.stdout.write(`${chalk.dim("To resume this session:")} ${resumeCommand}\n`);
		}

		process.exit(0);
	}

	emergencyTerminalExit(): never {
		this.shuttingDown = true;
		this.unregisterSignalHandlers();
		killTrackedDetachedChildren();
		// The terminal is gone. Do not run normal shutdown because TUI and
		// extension cleanup can write restore sequences and re-trigger EIO.
		process.exit(129);
	}

	/**
	 * Report an unhandled promise rejection WITHOUT ending the session.
	 *
	 * Node's default (`--unhandled-rejections=throw`) turns one into an uncaughtException, which the
	 * handler below treats as fatal. That is right for a synchronous throw, where process state may be
	 * unsound — but wrong for an isolated async failure. An extension that leaves a single
	 * fire-and-forget promise rejected (`void report()` whose transport is down) would otherwise take
	 * the whole session with it, losing work the operator cannot recover, for a fault that is not
	 * pi's and not fatal.
	 *
	 * Reporting is deliberately loud rather than silent: swallowing these would hide real harness bugs,
	 * which is worse than the crash it replaces. The message and stack land in the transcript every
	 * time one occurs.
	 */
	reportUnhandledRejection(reason: unknown): void {
		if (this.shuttingDown) return;
		const error = reason instanceof Error ? reason : new Error(String(reason));
		const detail = (error.stack ?? error.message).slice(0, MAX_REJECTION_DETAIL);
		this.port.showError(`Unhandled promise rejection — session kept alive. ${detail}`);
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
	uncaughtCrash(error: Error): never {
		if (this.shuttingDown) {
			process.exit(1);
		}
		this.shuttingDown = true;
		try {
			this.unregisterSignalHandlers();
		} catch {}
		try {
			killTrackedDetachedChildren();
		} catch {}
		try {
			this.port.ui.stop();
		} catch {}
		console.error("pi exiting due to uncaughtException:");
		console.error(error);
		process.exit(1);
	}

	/** Performs shutdown if the host has requested it. */
	async checkShutdownRequested(): Promise<void> {
		if (!this.port.isShutdownRequested()) return;
		await this.shutdown();
	}

	registerSignalHandlers(): void {
		this.unregisterSignalHandlers();

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
				void this.shutdown({ fromSignal: true });
			};
			process.prependListener(signal, handler);
			this.cleanupHandlers.push(() => process.off(signal, handler));
		}

		const terminalErrorHandler = (error: Error) => {
			if (isDeadTerminalError(error)) {
				this.emergencyTerminalExit();
			}
			throw error;
		};
		process.stdout.on("error", terminalErrorHandler);
		process.stderr.on("error", terminalErrorHandler);
		this.cleanupHandlers.push(() => process.stdout.off("error", terminalErrorHandler));
		this.cleanupHandlers.push(() => process.stderr.off("error", terminalErrorHandler));

		// Restore the terminal before the process dies on any uncaught throw.
		// Without this, an unhandled exception from extension code (or anywhere
		// in pi) leaves the terminal in raw mode with no cursor.
		const uncaughtExceptionHandler = (error: Error) => this.uncaughtCrash(error);
		process.prependListener("uncaughtException", uncaughtExceptionHandler);
		this.cleanupHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));

		// Registering this listener also STOPS Node from escalating a rejection into an
		// uncaughtException, which is the point: an async failure must not end the session.
		const unhandledRejectionHandler = (reason: unknown) => this.reportUnhandledRejection(reason);
		process.prependListener("unhandledRejection", unhandledRejectionHandler);
		this.cleanupHandlers.push(() => process.off("unhandledRejection", unhandledRejectionHandler));
	}

	unregisterSignalHandlers(): void {
		for (const cleanup of this.cleanupHandlers) {
			cleanup();
		}
		this.cleanupHandlers = [];
	}
}

export function handleCtrlZ(host: Pick<SignalLifecyclePort, "showStatus" | "ui">): void {
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
