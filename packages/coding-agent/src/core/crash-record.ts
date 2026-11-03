import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { writeFileAtomicSync } from "./util/atomic-file.ts";

/**
 * A crash record is a fault (an uncaught exception, a failed shutdown, an undeclared end, a survived rejection); a routine record is an
 * end with an ordinary outside cause (a termination signal, a terminal or reader that went away, a refused invocation). Each class is
 * retained on its own, so routine ends can never rotate crash records out.
 */
export type CrashRecordClass = "crash" | "routine";

/** Records kept per class; the oldest of a class go first. */
const MAX_RECORDS: Record<CrashRecordClass, number> = { crash: 100, routine: 20 };
/** Longest record kept: a crash has room for a stack and its causes, short of a runaway message; a routine record is compact. */
const MAX_RECORD_CHARS: Record<CrashRecordClass, number> = { crash: 16_000, routine: 2_000 };
/** File-name ending per class. A crash record is any other `.txt`; in-flight atomic-write temporaries end in `.tmp` and are neither. */
const ROUTINE_SUFFIX = ".routine.txt";
const CRASH_SUFFIX = ".txt";

function recordClassOf(name: string): CrashRecordClass | undefined {
	if (name.endsWith(ROUTINE_SUFFIX)) return "routine";
	if (name.endsWith(CRASH_SUFFIX)) return "crash";
	return undefined;
}

/**
 * Unhandled-rejection records one process writes at most. A rejection the session survives is recorded too, but a storm of them must
 * neither flood the directory nor rotate the records of real process ends out of the retention above.
 */
const MAX_REJECTION_RECORDS_PER_PROCESS = 5;

/** Records this process wrote, so two records in the same millisecond get distinct names instead of the later replacing the earlier. */
let recordSequence = 0;
/** Unhandled-rejection records this process wrote, against MAX_REJECTION_RECORDS_PER_PROCESS. */
let rejectionRecordsWritten = 0;

/** Where process ends are recorded, outside the terminal the end may have erased. */
export function getCrashRecordDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, "state", "crashes");
}

/**
 * Persists why this process is ending before any cleanup touches the terminal. The interactive UI draws on the alternate
 * screen, and leaving it erases whatever was printed there, so a crash report written during the crash can vanish with
 * the screen; this file is the copy that cannot. Synchronous so it completes before a reentrant crash or an exit.
 * Returns the written path, or the failure text when nothing could be written.
 */
export function writeCrashRecord(
	recordClass: CrashRecordClass,
	kind: string,
	detail: string,
	agentDir: string = getAgentDir(),
): string {
	try {
		const dir = getCrashRecordDir(agentDir);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		recordSequence++;
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const suffix = recordClass === "routine" ? ROUTINE_SUFFIX : CRASH_SUFFIX;
		const path = join(dir, `${stamp}-${process.pid}-${recordSequence}${suffix}`);
		const body = `${kind}\npid ${process.pid}\nat ${new Date().toISOString()}\n\n${detail}\n`.slice(
			0,
			MAX_RECORD_CHARS[recordClass],
		);
		writeFileAtomicSync(path, body, { mode: 0o600 });
		const sameClass = readdirSync(dir)
			.filter((name) => recordClassOf(name) === recordClass)
			.sort();
		for (const stale of sameClass.slice(0, -MAX_RECORDS[recordClass])) rmSync(join(dir, stale), { force: true });
		return path;
	} catch (error) {
		return `crash record not written: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/**
 * Records an unhandled rejection the session survived, as a crash record, up to the per-process cap; the last admitted record says the
 * cap was reached. Returns the written path (or the failure text), or undefined once the cap is spent.
 */
export function writeRejectionRecord(detail: string): string | undefined {
	if (rejectionRecordsWritten >= MAX_REJECTION_RECORDS_PER_PROCESS) return undefined;
	rejectionRecordsWritten++;
	const capReached =
		rejectionRecordsWritten === MAX_REJECTION_RECORDS_PER_PROCESS
			? `; per-process cap of ${MAX_REJECTION_RECORDS_PER_PROCESS} reached, later rejections are not recorded`
			: "";
	return writeCrashRecord("crash", `unhandledRejection; session kept alive${capReached}`, detail);
}
