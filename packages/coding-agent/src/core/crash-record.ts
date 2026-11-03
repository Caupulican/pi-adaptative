import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { writeFileAtomicSync } from "./util/atomic-file.ts";

/** Longest crash record kept: enough for a stack and its causes, short of a runaway message. */
const MAX_CRASH_RECORD_CHARS = 16_000;
/** Crash records kept on disk; the oldest go first. */
const MAX_CRASH_RECORDS = 100;
/**
 * Unhandled-rejection records one process writes at most. A rejection the session survives is recorded too, but a storm of them must
 * neither flood the directory nor rotate the records of real process ends out of the retention above.
 */
const MAX_REJECTION_RECORDS_PER_PROCESS = 5;

/** Records this process wrote, so two records in the same millisecond get distinct names instead of the later replacing the earlier. */
let recordSequence = 0;
/** Unhandled-rejection records this process wrote, against MAX_REJECTION_RECORDS_PER_PROCESS. */
let rejectionRecordsWritten = 0;

/** Where abnormal process ends are recorded, outside the terminal the end may have erased. */
export function getCrashRecordDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, "state", "crashes");
}

/**
 * Persists why this process is ending before any cleanup touches the terminal. The interactive UI draws on the alternate
 * screen, and leaving it erases whatever was printed there, so a crash report written during the crash can vanish with
 * the screen; this file is the copy that cannot. Synchronous so it completes before a reentrant crash or an exit.
 * Returns the written path, or the failure text when nothing could be written.
 */
export function writeCrashRecord(kind: string, detail: string, agentDir: string = getAgentDir()): string {
	try {
		const dir = getCrashRecordDir(agentDir);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		recordSequence++;
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const path = join(dir, `${stamp}-${process.pid}-${recordSequence}.txt`);
		const body = `${kind}\npid ${process.pid}\nat ${new Date().toISOString()}\n\n${detail}\n`.slice(
			0,
			MAX_CRASH_RECORD_CHARS,
		);
		writeFileAtomicSync(path, body, { mode: 0o600 });
		for (const stale of readdirSync(dir).sort().slice(0, -MAX_CRASH_RECORDS))
			rmSync(join(dir, stale), { force: true });
		return path;
	} catch (error) {
		return `crash record not written: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/**
 * Records an unhandled rejection the session survived, through `write`, up to the per-process cap; the last admitted record says the
 * cap was reached. Returns the written path (or the failure text), or undefined once the cap is spent.
 */
export function writeRejectionRecord(
	detail: string,
	write: (kind: string, detail: string) => string = writeCrashRecord,
): string | undefined {
	if (rejectionRecordsWritten >= MAX_REJECTION_RECORDS_PER_PROCESS) return undefined;
	rejectionRecordsWritten++;
	const capReached =
		rejectionRecordsWritten === MAX_REJECTION_RECORDS_PER_PROCESS
			? `; per-process cap of ${MAX_REJECTION_RECORDS_PER_PROCESS} reached, later rejections are not recorded`
			: "";
	return write(`unhandledRejection; session kept alive${capReached}`, detail);
}
