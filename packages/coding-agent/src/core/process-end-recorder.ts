import { writeSync } from "node:fs";
import { type CrashRecordClass, writeCrashRecord } from "./crash-record.ts";
import { describeCause } from "./terminal-warnings.ts";

/** A thrown value's stack, or its cause text when it has none; never throws. The detail an end's record carries. */
export function thrownDetail(thrown: unknown): string {
	try {
		if (thrown instanceof Error && thrown.stack) return thrown.stack;
	} catch {}
	return describeCause(thrown);
}

/**
 * Why the process ends, declared by the code that ends it. The reason alone decides what the end leaves under `state/crashes`
 * (see processEndRecordClass): callers state intent, never a retention class.
 */
export type ProcessEndReason =
	/** The interactive session's orderly quit: every cleanup step succeeded. */
	| "quit"
	/** A command finished (or the operator cancelled it) and its outcome was shown. */
	| "completed"
	/** The restart handoff reached the supervisor, which continues in the next generation. */
	| "restart"
	/** The invocation was refused (usage, validation, missing model, ineligible lane worker); the reason was printed. */
	| "refused"
	/** A termination signal started the graceful shutdown. */
	| "signal-graceful"
	/** A second termination signal during shutdown cleanup forced the exit. */
	| "signal-forced"
	/** The terminal went away (EIO/EPIPE/ENOTCONN on stdout or stderr). */
	| "dead-terminal"
	/** Standard output failed with no owner registered for it (a reader that went away). */
	| "stdout-failed"
	/** An uncommitted restart candidate handed control back to the supervisor's previous generation. */
	| "restart-rollback"
	/** The session's supervision wound the process down (cooperative cleanup, or the parent is gone). */
	| "wind-down"
	/** An uncaught exception. */
	| "crash"
	/** An uncaught exception while a shutdown was already running. */
	| "crash-during-shutdown"
	/** The session runtime failed in a way the interactive session cannot continue from. */
	| "fatal-runtime-error"
	/** A shutdown cleanup step failed. */
	| "shutdown-failed"
	/** The restart teardown or handoff failed after the candidate was prepared. */
	| "restart-failed"
	/** The process entry's program threw. */
	| "entry-failed";

/** What an end leaves: nothing, a compact routine record, or a full crash record. The two record classes are retained apart. */
export function processEndRecordClass(reason: ProcessEndReason): CrashRecordClass | "none" {
	switch (reason) {
		case "quit":
		case "completed":
		case "restart":
			return "none";
		case "refused":
		case "signal-graceful":
		case "signal-forced":
		case "dead-terminal":
		case "stdout-failed":
		case "restart-rollback":
		case "wind-down":
			return "routine";
		case "crash":
		case "crash-during-shutdown":
		case "fatal-runtime-error":
		case "shutdown-failed":
		case "restart-failed":
		case "entry-failed":
			return "crash";
	}
}

/**
 * The process's end, owned by the process root. Declaring an end writes its record at once, before any cleanup can touch the
 * terminal or hang, and the same reason and exit code are recorded once. A declaration states intent only: the end is
 * performed by `exitProcess`, or, for a completed program, by the event loop draining.
 *
 * Once `install` ran (the interactive runtime's entry, never the supervisor parent) every end that was not performed through
 * `exitProcess` is recorded too: a `process.exit` from anywhere else, with its caller's stack, or the process ending without an exit
 * call, each with the intent declared before it. The installation is never removed: it lasts until the process ends.
 */
class ProcessEndRecorder {
	private declared: ProcessEndReason | undefined;
	private declaredCode: number | undefined;
	/** Set when the exit now running is the declared one. */
	private performed = false;
	private installed = false;
	/** The stack of the first `process.exit` call not made through `exitProcess`; the call that ends the process. */
	private undeclaredExitStack: string | undefined;
	/** The first uncaught exception, kept to explain an end nothing declared (one before the session's own handler is armed). */
	private uncaught: string | undefined;

	declareExit(reason: ProcessEndReason, detail = "", code?: number): string | undefined {
		if (reason === this.declared && code === this.declaredCode) return undefined;
		this.declared = reason;
		this.declaredCode = code;
		const recordClass = processEndRecordClass(reason);
		if (recordClass === "none") return undefined;
		return writeCrashRecord(recordClass, code === undefined ? reason : `${reason}; exit ${code}`, detail);
	}

	exitProcess(code: number, reason: ProcessEndReason, detail = ""): never {
		this.declareExit(reason, detail, code);
		this.performed = true;
		return process.exit(code);
	}

	install(): void {
		if (this.installed) return;
		this.installed = true;
		const exit = process.exit;
		process.exit = ((code) => {
			if (!this.performed) {
				const call = `process.exit(${String(code)}) called without a declared end`;
				this.undeclaredExitStack ??= new Error(call).stack ?? call;
			}
			return exit.call(process, code);
		}) as typeof process.exit;
		// A monitor only observes: whether the exception ends the process stays with the handlers (the session's own, once armed).
		process.on("uncaughtExceptionMonitor", (error: unknown) => {
			this.uncaught ??= thrownDetail(error);
		});
		process.prependListener("exit", (code) => this.recordUndeclaredEnd(code));
	}

	/** Synchronous, as the `exit` event allows nothing else. */
	private recordUndeclaredEnd(code: number): void {
		if (this.performed) return;
		if (this.undeclaredExitStack === undefined && this.declared === "completed") {
			// The program finished and the event loop drained: its own status is the outcome it already reported.
			if (code !== 0) writeCrashRecord("routine", `completed; exit ${code}`, "");
			return;
		}
		const how =
			this.undeclaredExitStack === undefined
				? "process ended without an exit call (event loop drained, or an exit reference taken before the install)"
				: "process.exit called without a declared end";
		const intent =
			this.declared === undefined ? "no end declared" : `declared end ${this.declared} did not reach its exit`;
		const detail = [this.undeclaredExitStack, this.uncaught && `uncaught exception:\n${this.uncaught}`]
			.filter((part): part is string => !!part)
			.join("\n\n");
		writeCrashRecord("crash", `${how}; exit ${code}; ${intent}`, detail);
	}
}

const processEnd = new ProcessEndRecorder();

/** Observes every end of this process from here on: the interactive runtime's entry installs it first, before the program loads. */
export function installProcessEndRecorder(): void {
	processEnd.install();
}

/**
 * Declares how the process is ending and records it now, before any cleanup (see processEndRecordClass). Returns the record's path,
 * or the failure text when it could not be written, or undefined when the reason writes nothing or was already declared.
 */
export function declareExit(reason: ProcessEndReason, detail = ""): string | undefined {
	return processEnd.declareExit(reason, detail);
}

/** Ends the process as the declared end `reason`, recording it unless it was declared already. */
export function exitProcess(code: number, reason: ProcessEndReason, detail = ""): never {
	return processEnd.exitProcess(code, reason, detail);
}

/**
 * Ends the process for a failure its entry's program threw: recorded, reported on stderr, status 1. The process entry owns this end
 * instead of the runtime's default report, which would leave no record.
 */
export function exitForEntryFailure(error: unknown): never {
	const detail = thrownDetail(error);
	const recordPath = processEnd.declareExit("entry-failed", detail);
	// Synchronous: the exit below must not cut a report still queued on a piped stderr.
	try {
		writeSync(2, `${detail}\n(record: ${recordPath})\n`);
	} catch {
		// A stderr that is gone cannot carry the report; the record written above is its trace.
	}
	return processEnd.exitProcess(1, "entry-failed");
}
