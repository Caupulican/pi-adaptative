import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { writeFileAtomicSync } from "./util/atomic-file.ts";

/** Longest crash record kept: enough for a stack and its causes, short of a runaway message. */
const MAX_CRASH_RECORD_CHARS = 16_000;
/** Crash records kept on disk; the oldest go first. */
const MAX_CRASH_RECORDS = 20;

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
		const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.txt`);
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
