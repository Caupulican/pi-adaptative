/** Retains the profile's diagnostic JSONL segments under one cross-process lock. */
import {
	closeSync,
	constants,
	existsSync,
	lstatSync,
	openSync,
	readdirSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isMissingFileError, withFileLockSync } from "../util/atomic-file.ts";

const FILE_BYTES = 8 * 1024 * 1024;
const DIRECTORY_BYTES = 32 * 1024 * 1024;
const DAY_MS = 86_400_000;
const SEGMENT = /^harness-(\d{4}-\d{2}-\d{2})\.jsonl(?:\.1)?$/;
const NO_LOCK_WAIT = { retries: 0 };

function fileSize(file: string, requireRegular = false): number | undefined {
	try {
		const stats = lstatSync(file);
		if (stats.isFile()) return stats.size;
		if (requireRegular) throw new Error("Harness log requires a regular file");
		return undefined;
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
		return undefined;
	}
}

function utcDate(time: number): string {
	return new Date(time).toISOString().slice(0, 10);
}

export function openHarnessLogFiles(dir: string, maxFileMb = 8, retainDays = 14) {
	const maxFileBytes = Math.max(1, Math.min(FILE_BYTES, Math.floor(maxFileMb * 1024 * 1024)));
	const lock = join(dir, ".harness-log");
	let maintainedDay: string | undefined;

	function maintain(active: string, now: number): void {
		const earliest = utcDate(now - (Math.ceil(retainDays) - 1) * DAY_MS);
		// Reserve space for the active segment so appends between scans cannot overrun the profile budget.
		let remaining = DIRECTORY_BYTES - FILE_BYTES;
		for (const name of readdirSync(dir).sort(
			(a, b) => b.slice(8, 18).localeCompare(a.slice(8, 18)) || a.localeCompare(b),
		)) {
			const date = SEGMENT.exec(name)?.[1];
			if (!date) continue;
			const path = join(dir, name);
			const size = fileSize(path);
			if (size === undefined) continue;
			if (name === active && size <= FILE_BYTES) continue;
			if (date < earliest || size > FILE_BYTES || size > remaining) unlinkSync(path);
			else remaining -= size;
		}
	}

	if (existsSync(dir)) {
		try {
			withFileLockSync(
				lock,
				() => {
					const now = Date.now();
					const day = utcDate(now);
					maintain(`harness-${day}.jsonl`, now);
					maintainedDay = day;
				},
				NO_LOCK_WAIT,
			);
		} catch {
			// Contention or filesystem errors must never prevent the harness from starting.
		}
	}

	return {
		maxFileBytes,
		append(batch: string, bytes: number): void {
			if (bytes > maxFileBytes) return;
			withFileLockSync(
				lock,
				() => {
					const now = Date.now();
					const day = utcDate(now);
					const name = `harness-${day}.jsonl`;
					const file = join(dir, name);
					const size = fileSize(file, true);
					const rotate = size !== undefined && size + bytes > maxFileBytes;
					if (rotate) renameSync(file, `${file}.1`);
					if (rotate || size === undefined || maintainedDay !== day) {
						maintain(name, now);
						maintainedDay = day;
					}
					const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);
					const fd = openSync(file, flags, 0o600);
					try {
						writeFileSync(fd, batch);
					} finally {
						closeSync(fd);
					}
				},
				NO_LOCK_WAIT,
			);
		},
	};
}
