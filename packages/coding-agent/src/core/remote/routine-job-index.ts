/** Exact placed-job references of a bot's scheduled occurrence. The canonical job still owns all state and results. */
import { existsSync, mkdirSync, opendirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readOptionalBoundedTextFileSync } from "../../kernel/storage/bounded-file.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { parseNamedFile, RECORD_EXTENSION, recordFileName, splitRecordName } from "./job-record-name.ts";
import { isRoutineJobScope } from "./routine-job-origin.ts";

const MAX_RECENT = 8;
const MAX_RECENT_BYTES = MAX_RECENT * 160;

function scopeDir(jobsDir: string, scope: string): string {
	if (!isRoutineJobScope(scope)) throw new Error("Invalid scheduled job scope.");
	return join(jobsDir, "routine", scope);
}

function recent(dir: string): string[] {
	const text = readOptionalBoundedTextFileSync(join(dir, "recent"), MAX_RECENT_BYTES, "Scheduled job references");
	if (text === undefined) return [];
	const names = text.trimEnd().split("\n");
	if (names.length > MAX_RECENT || !names.every((name) => splitRecordName(name) !== undefined))
		throw new Error("Unreadable scheduled job references.");
	return names;
}

export function recentRoutineJobNames(jobsDir: string, scope: string): string[] {
	return recent(scopeDir(jobsDir, scope));
}

/** Record membership before creating the canonical record. A crash before creation leaves a harmless reference. */
export function createRoutineJob<T>(jobsDir: string, scope: string, name: string, create: () => T): T {
	if (!splitRecordName(name)) throw new Error("Invalid scheduled job reference.");
	const dir = scopeDir(jobsDir, scope);
	const members = join(dir, "members");
	mkdirSync(members, { recursive: true });
	const head = join(dir, "recent");
	return withFileLockSync(head, () => {
		if (existsSync(join(dir, "stopped"))) throw new Error("The owner stopped this scheduled task occurrence.");
		const previous = recent(dir);
		writeFileSync(join(members, recordFileName(name)), "", { mode: 0o600 });
		if (!previous.includes(name))
			writeFileAtomicSync(head, `${[name, ...previous].slice(0, MAX_RECENT).join("\n")}\n`, { mode: 0o600 });
		return create();
	});
}

/** Release the occurrence's references with the canonical job's retention. Keep an explicit owner-stop fence. */
export function pruneRoutineJob(jobsDir: string, scope: string, name: string, remove: () => void): void {
	const dir = scopeDir(jobsDir, scope);
	const head = join(dir, "recent");
	withFileLockSync(head, () => {
		const previous = recent(dir);
		const kept = previous.filter((entry) => entry !== name);
		if (!kept.length) rmSync(head, { force: true });
		else if (previous.length !== kept.length) writeFileAtomicSync(head, `${kept.join("\n")}\n`, { mode: 0o600 });
		rmSync(join(dir, "members", recordFileName(name)), { force: true });
		remove();
	});
}

/** Fence future admissions first. A replay can finish an interrupted stop by visiting these same exact references. */
export function stopRoutineJobScope(jobsDir: string, scope: string, stop: (name: string) => void): void {
	const dir = scopeDir(jobsDir, scope);
	const members = join(dir, "members");
	mkdirSync(members, { recursive: true });
	withFileLockSync(join(dir, "recent"), () => {
		writeFileAtomicSync(join(dir, "stopped"), "stopped\n", { mode: 0o600 });
	});
	const entries = opendirSync(members);
	try {
		for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
			const parsed = parseNamedFile(entry.name);
			if (entry.isFile() && parsed?.extension === RECORD_EXTENSION) stop(parsed.name);
		}
	} finally {
		entries.closeSync();
	}
}
