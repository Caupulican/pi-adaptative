/**
 * Process signal handling, shutdown, and crash/suspend lifecycle extracted from
 * interactive-mode.
 *
 * These register SIGTERM/SIGHUP/uncaughtException/dead-terminal handlers, run the
 * graceful and emergency shutdown paths (preserving the #4144/#5080 ordering
 * where signal-triggered shutdown emits extension cleanup before terminal
 * writes), and implement Ctrl+Z suspend/resume. Every end they perform is
 * declared to the process-end recorder with its reason (see process-end-recorder.ts),
 * which owns the observation of every other end. They operate through a
 * `SignalLifecycle` class that owns the lifecycle state (`isShuttingDown`, the
 * registered listeners' cleanup handlers) and reaches the host only through a
 * small `SignalLifecyclePort` of closures.
 */

import type { TUI } from "@caupulican/pi-tui";
import chalk from "chalk";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { writeRejectionRecord } from "../../core/crash-record.ts";
import { disposeHttpDispatcher } from "../../core/http-dispatcher.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import { declareExit, exitProcess, type ProcessEndReason } from "../../core/process-end-recorder.ts";
import { causeHeadline, describeCause, errorDetail, neutralizeControls } from "../../core/terminal-warnings.ts";
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

/** The value as an Error for a report that reads a stack: a non-Error, or a value whose class check throws, is wrapped by its cause text. */
function asError(value: unknown): Error {
	try {
		if (value instanceof Error) return value;
	} catch {}
	return new Error(describeCause(value));
}

/** The termination signals the lifecycle listens to. SIGHUP is not delivered on Windows. */
function terminationSignals(): NodeJS.Signals[] {
	return process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
}

/** The terminal UI members the signal lifecycle drives: the input drain on shutdown, and the stop/start/render pair Ctrl+Z uses. */
export type SignalLifecycleUi = Pick<TUI, "start" | "stop" | "requestRender"> & {
	readonly terminal: Pick<TUI["terminal"], "drainInput">;
};

/** What the signal lifecycle needs from the interactive host; everything else it owns itself. */
export interface SignalLifecyclePort {
	readonly runtimeHost: Pick<AgentSessionRuntime, "dispose">;
	readonly ui: SignalLifecycleUi;
	isShutdownRequested(): boolean;
	stop(): void;
	formatResumeCommand(): string | undefined;
	showStatus(message: string): void;
	showError(message: string): void;
}

/** Node's listener type: the lifecycle's handlers each read only the arguments their own event passes. */
type ProcessListener = Parameters<NodeJS.EventEmitter["on"]>[1];

/** The process effects of a shutdown. The defaults are the process itself; a harness supplies its own. */
export interface SignalLifecycleIo {
	/** Ends the process as the declared end `reason`. */
	exit(code: number, reason: ProcessEndReason): void;
	stderr(text: string): void;
	stdout(text: string): void;
	/**
	 * Declares how the process is ending and records it before any cleanup touches the terminal. Returns the record's path (or the
	 * failure text), or undefined when the reason writes nothing or was already declared.
	 */
	declareExit(reason: ProcessEndReason, detail: string): string | undefined;
	/** Records an unhandled rejection the session survived. */
	recordRejection(detail: string): void;
	/** Adds a process listener at the front of its queue and returns the function that removes it. */
	prependListener(
		event: NodeJS.Signals | "uncaughtException" | "unhandledRejection",
		handler: ProcessListener,
	): () => void;
	/** Adds an error listener to a standard stream and returns the function that removes it. */
	onStreamError(stream: "stdout" | "stderr", handler: (error: Error) => void): () => void;
}

const PROCESS_IO: SignalLifecycleIo = {
	exit: (code, reason) => exitProcess(code, reason),
	stderr: (text) => process.stderr.write(text),
	stdout: (text) => process.stdout.write(text),
	declareExit,
	recordRejection: (detail) => {
		writeRejectionRecord(detail);
	},
	prependListener: (event, handler) => {
		const events: Pick<NodeJS.EventEmitter, "off" | "prependListener"> = process;
		events.prependListener(event, handler);
		return () => events.off(event, handler);
	},
	onStreamError: (stream, handler) => {
		const target = stream === "stdout" ? process.stdout : process.stderr;
		target.on("error", handler);
		return () => target.off("error", handler);
	},
};

/** Longest rejection detail rendered into the transcript; enough for a stack, short of flooding it. */
const MAX_REJECTION_DETAIL = 2_000;

/**
 * Owns the process-level lifecycle state of an interactive session: whether shutdown has begun and the
 * cleanup handlers for every process listener it registered. Only this class writes either.
 */
export class SignalLifecycle {
	private shuttingDown = false;
	private cleanupHandlers: Array<() => void> = [];
	/** The SIGTERM/SIGHUP listeners alone: the one group an orderly shutdown removes (see unregisterTerminationSignals). */
	private signalListenerCleanup: Array<() => void> = [];
	private readonly port: SignalLifecyclePort;
	private readonly io: SignalLifecycleIo;
	/** Set when the port's stop has been started, so no path (cleanup, forced exit, crash during shutdown) runs it a second time. */
	private stopStarted = false;

	constructor(port: SignalLifecyclePort, io: Partial<SignalLifecycleIo> = {}) {
		this.port = port;
		// Each member resolves on its own: a member given as undefined keeps the process default instead of replacing it.
		this.io = {
			exit: io.exit ?? PROCESS_IO.exit,
			stderr: io.stderr ?? PROCESS_IO.stderr,
			stdout: io.stdout ?? PROCESS_IO.stdout,
			declareExit: io.declareExit ?? PROCESS_IO.declareExit,
			recordRejection: io.recordRejection ?? PROCESS_IO.recordRejection,
			prependListener: io.prependListener ?? PROCESS_IO.prependListener,
			onStreamError: io.onStreamError ?? PROCESS_IO.onStreamError,
		};
	}

	/**
	 * Ends the process as the declared end `reason`. An end that leaves a record declared it before its cleanup (the record must exist if
	 * the cleanup hangs or the terminal dies); the same reason at the exit is not recorded again.
	 */
	private exitProcess(code: number, reason: ProcessEndReason): void {
		this.io.exit(code, reason);
	}

	get isShuttingDown(): boolean {
		return this.shuttingDown;
	}

	/**
	 * Ends the session and the process. A failure inside the shutdown is reported and ends the process with status 1: every
	 * caller fires it without awaiting a rejection, so a rejection would otherwise surface as an unhandled one. On the signal path
	 * the process-level guards (dead terminal, uncaught exception, unhandled rejection) stay armed while the cleanup steps run, and on
	 * both paths they stay armed until the process exits: `stop()` leaves them to a shutdown in progress.
	 */
	async shutdown(options?: { fromSignal?: boolean }): Promise<void> {
		if (this.shuttingDown) return;
		try {
			await this.runShutdown(options);
		} catch (error: unknown) {
			this.io.declareExit(
				"shutdown-failed",
				`${describeCause(error)}\n\n${errorDetail(asError(error), MAX_REJECTION_DETAIL)}`,
			);
			this.io.stderr(`${neutralizeControls(`Shutdown failed: ${describeCause(error)}`)}\n`);
			this.exitProcess(1, "shutdown-failed");
		}
	}

	private async runShutdown(options?: { fromSignal?: boolean }): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		// Only the termination-signal listeners go: the dead-terminal, uncaught-exception and rejection guards stay armed while the
		// cleanup steps run, because a terminal that dies during the drain or stop, or a stray rejection during the bounded dispose,
		// must still reach them (the process ends at the exit below).
		this.unregisterTerminationSignals();

		// Both paths run the same cleanup steps, each attempted once. The first is the CLI's PowerShell warm-start disposal: the CLI
		// warm-starts a host before the runtime graph loads, and a session that never runs a shell command never claims it, so
		// nothing else reaps it. Without this it outlives pi.
		if (options?.fromSignal) {
			// Signal-triggered shutdown (SIGTERM/SIGHUP). Emit extension cleanup
			// (session_shutdown) BEFORE touching the terminal. Extension teardown
			// such as removing sockets does not write to the tty, so it must not be
			// skipped if a later terminal-restore write fails on a dead or stalled
			// terminal. If the terminal is gone, the restore writes below emit EIO,
			// which the stdout/stderr error handler turns into emergencyTerminalExit;
			// the render loop is already idle, so this cannot hot-spin (see #4144).
			// A cleanup failure must not skip the terminal restore: stop() also releases the closing warnings the dispose collected, so
			// skipping it would lose those disclosures and leave the terminal in raw mode. Every step runs and every failure is reported.
			const forceRemovals = this.installForceListeners();
			try {
				await this.runCleanupSteps([
					() => disposeUnclaimedCliPowerShellWarmStart(),
					() => this.port.runtimeHost.dispose(),
					() => disposeHttpDispatcher(),
					() => this.port.ui.terminal.drainInput(1000),
					() => this.stopOnce(),
				]);
			} finally {
				for (const remove of forceRemovals) remove();
			}
			// The signal that started this path was declared, and recorded, when it arrived (registerSignalHandlers).
			this.exitProcess(0, "signal-graceful");
			// An injected exit returns: the interactive quit below must not run after a signal shutdown.
			return;
		}

		// Interactive quit (Ctrl+D, Ctrl+C, /quit, extension shutdown()). Stop the
		// TUI before emitting shutdown events so extension UI cleanup cannot repaint
		// the final frame while the process is exiting.
		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		// A failing drain or stop must not skip the runtime dispose, and the resume command is written only when every step succeeded.
		// The terminal is restored before the dispose, so Ctrl+C there arrives as SIGINT: it is forced like the termination signals.
		const forceRemovals = this.installForceListeners([...terminationSignals(), "SIGINT"]);
		try {
			await this.runCleanupSteps([
				() => disposeUnclaimedCliPowerShellWarmStart(),
				() => this.port.ui.terminal.drainInput(1000),
				() => this.stopOnce(),
				() => this.port.runtimeHost.dispose(),
				() => disposeHttpDispatcher(),
			]);
		} finally {
			for (const remove of forceRemovals) remove();
		}

		const resumeCommand = this.port.formatResumeCommand();
		if (resumeCommand) {
			this.io.stdout(`${chalk.dim(interfaceText().notices.resumeThisSession)} ${resumeCommand}\n`);
		}

		// The orderly quit: every cleanup step succeeded, so it writes no record.
		this.exitProcess(0, "quit");
	}

	private stopOnce(): void {
		if (this.stopStarted) return;
		this.stopStarted = true;
		this.port.stop();
	}

	/**
	 * Runs each cleanup step once, in order, whatever the earlier steps did: a failing step never skips a later one. Every failure is
	 * kept. One is rethrown as it is; several are thrown together so `shutdown` reports each cause.
	 */
	private async runCleanupSteps(steps: ReadonlyArray<() => unknown>): Promise<void> {
		const failures: unknown[] = [];
		for (const step of steps) {
			try {
				await step();
			} catch (error: unknown) {
				failures.push(error);
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			// The message is the first failure's own text, converted safely: a first failure whose conversion throws must not replace the collected causes.
			throw new AggregateError(failures, causeHeadline(failures[0]));
		}
	}

	/**
	 * Listeners for a second termination signal while either path's cleanup runs. The first signal's listeners are already removed, so
	 * without these Node ends the process by default: the terminal stays raw, the held warnings go unwritten and the tracked children live
	 * on. The forced exit kills the tracked children, restores the terminal and releases the warnings, then exits with the signal's status.
	 */
	private installForceListeners(signals: readonly NodeJS.Signals[] = terminationSignals()): Array<() => void> {
		return signals.map((signal) =>
			this.io.prependListener(signal, () => {
				const status = signal === "SIGHUP" ? 129 : signal === "SIGINT" ? 130 : 143;
				this.io.declareExit("signal-forced", `${signal} during shutdown cleanup; forced exit ${status}`);
				killTrackedDetachedChildren();
				try {
					this.stopOnce();
				} catch (stopError: unknown) {
					this.io.stderr(
						`${neutralizeControls(`Stop failed during forced shutdown: ${describeCause(stopError)}`)}\n`,
					);
				}
				this.exitProcess(status, "signal-forced");
			}),
		);
	}

	emergencyTerminalExit(): void {
		this.shuttingDown = true;
		// Nothing can be shown on a dead terminal, so the record is the only trace of this exit.
		this.io.declareExit("dead-terminal", "EIO/EPIPE/ENOTCONN on stdout or stderr; exit 129");
		this.unregisterSignalHandlers();
		killTrackedDetachedChildren();
		// The terminal is gone. Do not run normal shutdown because TUI and
		// extension cleanup can write restore sequences and re-trigger EIO.
		this.exitProcess(129, "dead-terminal");
	}

	/**
	 * Ends the process for a runtime failure the interactive session cannot continue from (a session replacement that left no usable
	 * session). The record is written first; the host is released and the terminal restored, each step attempted whatever the others
	 * did, and the report is printed only after the restore (the alternate screen would erase it), then the process exits 1 whatever
	 * the teardown threw.
	 */
	fatalRuntimeError(message: string, detail: string, releaseHost: () => void): void {
		// Set first: a second fatal failure or a signal now finds the process ending, and stop() leaves the guards armed until the exit.
		this.shuttingDown = true;
		const recordPath = this.io.declareExit("fatal-runtime-error", detail);
		try {
			try {
				// A termination signal during this teardown must not start a graceful shutdown of a runtime that is already ending.
				this.unregisterTerminationSignals();
			} catch {}
			try {
				killTrackedDetachedChildren();
			} catch {}
			for (const step of [releaseHost, () => this.stopOnce()]) {
				try {
					step();
				} catch (stopError: unknown) {
					this.io.stderr(
						`${neutralizeControls(`Stop failed during fatal runtime error: ${describeCause(stopError)}`)}\n`,
					);
				}
			}
		} finally {
			this.io.stderr(`${neutralizeControls(message)}\n(record: ${recordPath})\n`);
			this.exitProcess(1, "fatal-runtime-error");
		}
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
	 * time one occurs, and in a crash record up to the per-process cap (the transcript is erased with the
	 * alternate screen if the process later ends).
	 */
	reportUnhandledRejection(reason: unknown): void {
		const error = asError(reason);
		const detail = errorDetail(error, MAX_REJECTION_DETAIL);
		this.io.recordRejection(this.shuttingDown ? `during shutdown\n\n${detail}` : detail);
		if (this.shuttingDown) {
			// The UI is going away: the rejection is reported on stderr, escaped, and the shutdown keeps running.
			this.io.stderr(`${neutralizeControls(`Unhandled promise rejection during shutdown. ${detail}`)}\n`);
			return;
		}
		this.port.showError(interfaceText().notices.unhandledRejection(causeHeadline(error)));
	}

	/**
	 * Last-resort handler for uncaught exceptions. The TUI puts stdin into raw
	 * mode and hides the cursor; without this handler, an uncaught throw from
	 * anywhere (e.g. an extension's async `ChildProcess.on("exit")` callback)
	 * tears down the process while leaving the terminal in raw mode with no
	 * cursor, requiring `stty sane && reset` to recover.
	 *
	 * Unlike emergencyTerminalExit, the terminal is still alive here, so we
	 * stop the host once to restore cooked mode, the cursor, and disable bracketed
	 * paste / Kitty / modifyOtherKeys sequences while releasing held warnings.
	 */
	uncaughtCrash(thrown: unknown): void {
		// Any value can reach uncaughtException (`throw "x"`, `throw null`), and the report reads a stack: a non-Error is wrapped first.
		const error = asError(thrown);
		if (this.shuttingDown) {
			// A throw during an orderly shutdown is still a crash: report it (the orderly path is already unwinding), restore the
			// terminal if it is not restored yet, and end the process.
			// port.stop() restores the terminal AND releases the closing warnings held for it (ui.stop alone would drop them).
			// A stop failure is reported too: it is the only record of a teardown that did not finish.
			try {
				this.stopOnce();
			} catch (stopError: unknown) {
				this.io.stderr(`${neutralizeControls(`Stop failed during shutdown: ${describeCause(stopError)}`)}\n`);
			}
			try {
				killTrackedDetachedChildren();
			} catch {}
			const detail = errorDetail(error, MAX_REJECTION_DETAIL);
			this.io.declareExit("crash-during-shutdown", detail);
			this.io.stderr(`${neutralizeControls(`pi exiting due to uncaughtException during shutdown: ${detail}`)}\n`);
			this.exitProcess(1, "crash-during-shutdown");
			// An injected exit returns: the crash must not fall through to the non-shutdown path below.
			return;
		}
		this.shuttingDown = true;
		const detail = errorDetail(error, MAX_REJECTION_DETAIL);
		// The record goes first and synchronously, so a reentrant crash or an exit cannot lose it. The screen report goes AFTER the
		// terminal is restored: the interactive UI draws on the alternate screen, and leaving it erases what was printed there.
		const recordPath = this.io.declareExit("crash", detail);
		try {
			try {
				// Fatal cleanup can also reject pending work. Keep the process guards armed until exit,
				// just as orderly shutdown does, so those failures retain their reporting owner.
				this.unregisterTerminationSignals();
			} catch {}
			try {
				killTrackedDetachedChildren();
			} catch {}
			try {
				this.stopOnce();
			} catch (stopError: unknown) {
				this.io.stderr(`${neutralizeControls(`Stop failed during fatal shutdown: ${describeCause(stopError)}`)}\n`);
			}
		} finally {
			this.io.stderr(
				`${neutralizeControls(`pi exiting due to uncaughtException: ${detail}\n(record: ${recordPath})`)}\n`,
			);
			this.exitProcess(1, "crash");
		}
	}

	/** Performs shutdown if the host has requested it. */
	async checkShutdownRequested(): Promise<void> {
		if (!this.port.isShutdownRequested()) return;
		await this.shutdown();
	}

	registerSignalHandlers(): void {
		this.unregisterSignalHandlers();

		for (const signal of terminationSignals()) {
			const handler = () => {
				// SIGHUP no longer hard-exits: graceful shutdown emits session_shutdown
				// first, then attempts terminal restore. A genuinely dead terminal
				// surfaces as an EIO on the restore writes, which the stdout/stderr
				// error handler converts into emergencyTerminalExit (see #4144, #5080).
				// Declared, and recorded, on arrival: a graceful path that then hangs and is killed leaves this as its only trace.
				this.io.declareExit("signal-graceful", `${signal} received; graceful shutdown started`);
				killTrackedDetachedChildren();
				void this.shutdown({ fromSignal: true });
			};
			const remove = this.io.prependListener(signal, handler);
			this.cleanupHandlers.push(remove);
			this.signalListenerCleanup.push(remove);
		}

		const terminalErrorHandler = (error: Error) => {
			if (isDeadTerminalError(error)) {
				this.emergencyTerminalExit();
			}
			throw error;
		};
		this.cleanupHandlers.push(this.io.onStreamError("stdout", terminalErrorHandler));
		this.cleanupHandlers.push(this.io.onStreamError("stderr", terminalErrorHandler));

		// Restore the terminal before the process dies on any uncaught throw.
		// Without this, an unhandled exception from extension code (or anywhere
		// in pi) leaves the terminal in raw mode with no cursor.
		const uncaughtExceptionHandler = (error: unknown) => this.uncaughtCrash(error);
		this.cleanupHandlers.push(this.io.prependListener("uncaughtException", uncaughtExceptionHandler));

		// Registering this listener also STOPS Node from escalating a rejection into an
		// uncaughtException, which is the point: an async failure must not end the session.
		const unhandledRejectionHandler = (reason: unknown) => this.reportUnhandledRejection(reason);
		this.cleanupHandlers.push(this.io.prependListener("unhandledRejection", unhandledRejectionHandler));
	}

	unregisterSignalHandlers(): void {
		for (const cleanup of this.cleanupHandlers) {
			cleanup();
		}
		this.cleanupHandlers = [];
		this.signalListenerCleanup = [];
	}

	/** Removes the SIGTERM/SIGHUP listeners only; the process-level guards stay registered. */
	unregisterTerminationSignals(): void {
		for (const cleanup of this.signalListenerCleanup) {
			cleanup();
		}
		this.signalListenerCleanup = [];
	}
}

export function handleCtrlZ(host: Pick<SignalLifecyclePort, "showStatus" | "ui">): void {
	if (process.platform === "win32") {
		host.showStatus(interfaceText().notices.suspendUnsupported);
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
