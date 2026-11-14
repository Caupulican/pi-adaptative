/**
 * The one-file-per-record directories of a bot's home (`inbox/`, `notices/`): listing a kind of record by its name,
 * reading each, setting aside one that does not read, and keeping only the newest of a kind. Every record is written by an
 * atomic replace, so a reader never sees a partial one; the names sort oldest first.
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/** A record as its directory holds it: the file it is in and what it says. */
export interface BotHomeRecord<T> {
	readonly file: string;
	readonly message: T;
}

/** The names in `dir` that `pattern` matches, oldest first; none when the directory does not exist. */
export function homeRecordNames(dir: string, pattern: RegExp): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => pattern.test(name))
		.sort();
}

/**
 * Reads the files `pattern` names in `dir`, oldest first. A file that does not read as a record is set aside (renamed
 * `.unreadable`) and reported through `unreadable`: it would otherwise hold a queue, or be counted, forever.
 */
export function readHomeRecords<T>(
	dir: string,
	pattern: RegExp,
	parse: (value: unknown) => T | undefined,
	unreadable: (file: string, reason: string) => void,
): BotHomeRecord<T>[] {
	const records: BotHomeRecord<T>[] = [];
	for (const name of homeRecordNames(dir, pattern)) {
		const file = join(dir, name);
		let message: T | undefined;
		let reason = "not a record";
		try {
			message = parse(JSON.parse(readFileSync(file, "utf8")));
		} catch (error) {
			// Taken (deleted) by its host while it was listed: it is gone, not unreadable.
			if (!existsSync(file)) continue;
			reason = error instanceof Error ? error.message : String(error);
		}
		if (message) {
			records.push({ file, message });
			continue;
		}
		try {
			renameSync(file, `${file}.unreadable`);
		} catch {
			if (!existsSync(file)) continue;
		}
		unreadable(file, reason);
	}
	return records;
}

/** Deletes all but the newest `keep` of the records `pattern` names in `dir`. */
export function keepNewestHomeRecords(dir: string, pattern: RegExp, keep: number): void {
	const names = homeRecordNames(dir, pattern);
	for (const name of names.slice(0, Math.max(0, names.length - keep))) rmSync(join(dir, name), { force: true });
}
