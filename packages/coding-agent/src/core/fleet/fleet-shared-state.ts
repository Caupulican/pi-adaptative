/**
 * A small machine-wide fleet state file every pi process on one agent directory shares (account windows, metered spend).
 * A write never overwrites another process's newer facts: it reads the file under its lock, merges its own state into
 * what it finds, and writes the merge atomically, at most once per microtask. A reader re-reads only when the file's
 * modification time moved since its last read, at most once per microtask.
 */

import { readFileSync, statSync } from "node:fs";
import { harnessLog } from "../../kernel/harness-log.ts";
import { isMissingFileError, withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";

export class FleetSharedState<T> {
	private readonly path: string;
	private readonly parse: (value: unknown) => T | undefined;
	private readonly label: string;
	private lastMtimeMs: number | undefined;
	private checkedThisTick = false;
	private pending: ((disk: T | undefined) => T) | undefined;
	/** Commit callbacks of the pending merges: each runs once its merge reached the file, never when the write failed. */
	private committed: (() => void)[] = [];

	constructor(path: string, label: string, parse: (value: unknown) => T | undefined) {
		this.path = path;
		this.label = label;
		this.parse = parse;
	}

	/** The file's state when it changed since the last read (or on the first read); undefined when unchanged or absent. */
	readIfChanged(): T | undefined {
		if (this.checkedThisTick) return undefined;
		this.checkedThisTick = true;
		queueMicrotask(() => {
			this.checkedThisTick = false;
		});
		let mtimeMs: number;
		try {
			mtimeMs = statSync(this.path).mtimeMs;
		} catch (error) {
			if (!isMissingFileError(error)) this.warn(error);
			return undefined;
		}
		if (mtimeMs === this.lastMtimeMs) return undefined;
		this.lastMtimeMs = mtimeMs;
		return this.readUnlocked();
	}

	/**
	 * Merges this process's state into the file once the current synchronous work ends: `merge` receives what the file
	 * holds under its lock and returns what is written. Repeated calls in one microtask write once, composing their merges
	 * in order. `committed` runs only after that write succeeded; a failed write leaves the caller's state pending for the
	 * next one.
	 */
	schedule(merge: (disk: T | undefined) => T, committed?: () => void): void {
		const previous = this.pending;
		const first = previous === undefined;
		this.pending = previous ? (disk) => merge(previous(disk)) : merge;
		if (committed) this.committed.push(committed);
		if (!first) return;
		queueMicrotask(() => {
			const write = this.pending;
			const commits = this.committed;
			this.pending = undefined;
			this.committed = [];
			if (write) this.writeNow(write, commits);
		});
	}

	private writeNow(merge: (disk: T | undefined) => T, commits: readonly (() => void)[]): void {
		try {
			withFileLockSync(this.path, () => {
				const merged = merge(this.readUnlocked());
				writeFileAtomicSync(this.path, `${JSON.stringify(merged)}\n`, { mode: 0o600 });
				this.lastMtimeMs = statSync(this.path).mtimeMs;
			});
		} catch (error) {
			this.warn(error);
			return;
		}
		for (const commit of commits) commit();
	}

	private readUnlocked(): T | undefined {
		try {
			return this.parse(JSON.parse(readFileSync(this.path, "utf8")));
		} catch (error) {
			if (!isMissingFileError(error)) this.warn(error);
			return undefined;
		}
	}

	private warn(error: unknown): void {
		harnessLog.warn(
			"fleet",
			"a shared fleet state file could not be read or written; this process keeps its own",
			() => ({
				file: this.label,
				error: error instanceof Error ? error.name : typeof error,
			}),
		);
	}
}
