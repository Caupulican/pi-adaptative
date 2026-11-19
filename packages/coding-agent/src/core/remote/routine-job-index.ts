/** Exact placed-job references of a bot's scheduled occurrence. The canonical job still owns all state and results. */

import { existsSync, type FSWatcher, mkdirSync, opendirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readOptionalBoundedTextFileSync } from "../../kernel/storage/bounded-file.ts";
import { watchPath } from "../../utils/fs-watch.ts";
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

export class RoutineOccurrenceStopped extends Error {
	constructor() {
		super("The owner stopped this scheduled task occurrence.");
	}
}

/** Admission takes a temporary per-occurrence lock in one of 16 fixed directories. Only stops and jobs allocate occurrence directories. */
function admissionLock(dir: string): string {
	const scope = basename(dir);
	return join(dirname(dir), "admission", scope[0]!, scope);
}

function requireOpen(dir: string): void {
	if (existsSync(join(dir, "stopped"))) throw new RoutineOccurrenceStopped();
}

/** Every writer and submitter shares the canonical marker that prior builds check under the membership lock. */
export function withRoutineScopeAdmission<T>(jobsDir: string, scope: string, admit: (dir: string) => T): T {
	const dir = scopeDir(jobsDir, scope);
	return withFileLockSync(admissionLock(dir), () => {
		requireOpen(dir);
		return admit(dir);
	});
}

/** Watch one directory. If this bot-only occurrence has no job directory, observe its creation before opening the exact watch. */
function watchOccurrenceStop(dir: string, abort: AbortController): () => void {
	let watcher: FSWatcher | undefined;
	const failed = (error: unknown) => abort.abort(error);
	const check = () => {
		if (existsSync(join(dir, "stopped"))) abort.abort(new RoutineOccurrenceStopped());
	};
	const follow = () => {
		if (!existsSync(dir)) return;
		try {
			const exact = watchPath(dir, { persistent: false }, (_event, file) => {
				if (file === null || file.toString() === "stopped") check();
			}).on("error", failed);
			watcher?.close();
			watcher = exact;
			check();
		} catch (error) {
			failed(error);
		}
	};
	watcher = watchPath(dirname(dir), { persistent: false }, (_event, file) => {
		if (file === null || file.toString() === basename(dir)) follow();
	}).on("error", failed);
	follow();
	return () => watcher?.close();
}

/** Arm cancellation before releasing admission. An in-flight stop also interrupts asynchronous prompt preparation. */
export function submitRoutineScope<T>(
	jobsDir: string,
	scope: string,
	submit: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	return withRoutineScopeAdmission(jobsDir, scope, (dir) => {
		const abort = new AbortController();
		const close = watchOccurrenceStop(dir, abort);
		try {
			return submit(abort.signal).finally(close);
		} catch (error) {
			close();
			throw error;
		}
	});
}

/** Record membership before creating the canonical record. A crash before creation leaves a harmless reference. */
export function createRoutineJob<T>(jobsDir: string, scope: string, name: string, create: () => T): T {
	if (!splitRecordName(name)) throw new Error("Invalid scheduled job reference.");
	return withRoutineScopeAdmission(jobsDir, scope, () => {
		const dir = scopeDir(jobsDir, scope);
		const members = join(dir, "members");
		const head = join(dir, "recent");
		mkdirSync(members, { recursive: true });
		return withFileLockSync(head, () => {
			requireOpen(dir); // A concurrent holder on an earlier build uses this membership lock.
			const previous = recent(dir);
			writeFileSync(join(members, recordFileName(name)), "", { mode: 0o600 });
			if (!previous.includes(name))
				writeFileAtomicSync(head, `${[name, ...previous].slice(0, MAX_RECENT).join("\n")}\n`, { mode: 0o600 });
			return create();
		});
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
	withFileLockSync(admissionLock(dir), () =>
		withFileLockSync(join(dir, "recent"), () => {
			writeFileAtomicSync(join(dir, "stopped"), "stopped\n", { mode: 0o600 });
		}),
	);
	const members = join(dir, "members");
	if (!existsSync(members)) return;
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
