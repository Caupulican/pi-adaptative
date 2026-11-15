/**
 * The one-file-per-record directories of a bot's home (`inbox/`, `notices/`): listing a kind of record by its name,
 * reading each, setting aside one that does not read (and telling the owner whether its rename took), and keeping only
 * the newest of a kind. Every record is written by an atomic replace, so a reader never sees a partial one; the names
 * sort oldest first.
 *
 * A record that neither reads nor can be set aside (a file this process may not read in a directory it may not write, a
 * Windows sharing lock) is a leftover of this process ({@link leftovers}): told once, then listed by no names-only reader
 * (it is not counted as waiting, holds no queue, opens no bot and keeps no session loaded) while it stays the same file
 * and its next read is not due. It is read again on a backoff that doubles from `BOT_OPEN_RETRY_FIRST_MS` to
 * `BOT_OPEN_RETRY_MAX_MS` (a sharing lock passes on its own and leaves the file as it was): once due, or once the file
 * changed (its device, inode, size, modification or status-change time), it is listed again, so the reader its listing
 * drives reads it; a read that fails again tells nothing more. It is forgotten once it reads, is set aside or is gone.
 */
import { readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { isPlainRecord } from "../../kernel/utils/value-guards.ts";
import { interfaceText } from "../language/interface-text.ts";
import { BOT_OPEN_RETRY_FIRST_MS, BOT_OPEN_RETRY_MAX_MS } from "./bot-open-retry.ts";

/** The fields every inbox message and notice opens with: version 1, its id, the bot it is for, its words and time. */
export interface BotHomeRecordHead {
	readonly version: 1;
	readonly id: string;
	readonly agentId: string;
	readonly text: string;
	readonly at: number;
}

/** The head of a parsed record for `agentId` with the fields every kind shares, and the record; undefined when it lacks one. */
export function parseHomeRecordHead(
	value: unknown,
	agentId: string,
): { readonly head: BotHomeRecordHead; readonly record: Record<string, unknown> } | undefined {
	if (
		!isPlainRecord(value) ||
		value.version !== 1 ||
		typeof value.id !== "string" ||
		value.agentId !== agentId ||
		typeof value.text !== "string" ||
		typeof value.at !== "number"
	)
		return undefined;
	return { head: { version: 1, id: value.id, agentId, text: value.text, at: value.at }, record: value };
}

/** A record as its directory holds it: the file it is in and what it says. */
export interface BotHomeRecord<T> {
	readonly file: string;
	readonly message: T;
}

/**
 * A file's device, inode, size, modification and status-change time (a `chmod` changes the last); undefined when it does
 * not exist, and a stat that fails otherwise names its error code.
 */
export function fileIdentity(file: string): string | undefined {
	try {
		const stat = statSync(file, { throwIfNoEntry: false });
		return stat && `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
	} catch (error) {
		return `!${(error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error))}`;
	}
}

/** A leftover record (see the module comment): the file it was, and when it is read again. */
interface Leftover {
	readonly identity: string;
	readonly delayMs: number;
	readonly dueAt: number;
}

/** The longest backoff of a leftover's reads, in the minutes the owner is told. */
export const LEFTOVER_REREAD_MAX_MINUTES = BOT_OPEN_RETRY_MAX_MS / 60_000;

/** This process's leftover records, by directory and name. */
const leftovers = new Map<string, Map<string, Leftover>>();

/**
 * The names in `dir` that `pattern` matches, oldest first; none when the directory does not exist. A leftover still the
 * same file is listed only once its read is due (see the module comment); the leftovers of the names `pattern` matches
 * that are gone are forgotten.
 */
export function homeRecordNames(dir: string, pattern: RegExp): string[] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => pattern.test(name));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		names = [];
	}
	const kept = leftovers.get(dir);
	if (!kept) return names.sort();
	const listed = new Set(names);
	for (const name of kept.keys()) if (pattern.test(name) && !listed.has(name)) kept.delete(name);
	const now = Date.now();
	const shown = names.filter((name) => {
		const leftover = kept.get(name);
		if (!leftover) return true;
		if (leftover.identity === fileIdentity(join(dir, name))) return now >= leftover.dueAt;
		// Another file now, or gone between the listing and the stat: read as a new one.
		kept.delete(name);
		return true;
	});
	if (kept.size === 0) leftovers.delete(dir);
	return shown.sort();
}

/**
 * The record `name` of `dir` neither read nor could be set aside: kept as a leftover with its next read due after the
 * backoff, doubled when it was one already and is still the same file. Whether it is new, and so told.
 */
function keepLeftover(dir: string, name: string): boolean {
	const identity = fileIdentity(join(dir, name));
	if (identity === undefined) {
		forgetLeftover(dir, name);
		return false;
	}
	const kept = leftovers.get(dir) ?? new Map<string, Leftover>();
	leftovers.set(dir, kept);
	const known = kept.get(name);
	const again = known?.identity === identity;
	const delayMs = again ? Math.min(known.delayMs * 2, BOT_OPEN_RETRY_MAX_MS) : BOT_OPEN_RETRY_FIRST_MS;
	kept.set(name, { identity, delayMs, dueAt: Date.now() + delayMs });
	return !again;
}

/** The record `name` of `dir` read, was set aside or is gone: it is no leftover. */
function forgetLeftover(dir: string, name: string): void {
	const kept = leftovers.get(dir);
	if (!kept?.delete(name) || kept.size > 0) return;
	leftovers.delete(dir);
}

/**
 * Reads the files `pattern` names in `dir` ({@link homeRecordNames}), oldest first. A file that does not read as a record
 * is set aside (renamed `.unreadable`) and reported through `unreadable`: it would otherwise hold a queue, or be counted,
 * forever. `setAside` says whether the rename took: one that failed leaves the file where `pattern` names it, as a
 * leftover reported once and read again on its backoff (see the module comment).
 */
export function readHomeRecords<T>(
	dir: string,
	pattern: RegExp,
	parse: (value: unknown) => T | undefined,
	unreadable: (file: string, reason: string, setAside: boolean) => void,
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
			if (fileIdentity(file) === undefined) {
				forgetLeftover(dir, name);
				continue;
			}
			reason = error instanceof Error ? error.message : String(error);
		}
		if (message) {
			forgetLeftover(dir, name);
			records.push({ file, message });
			continue;
		}
		try {
			renameSync(file, `${file}.unreadable`);
		} catch {
			// Gone, or left in place: a leftover is told only when it is new.
			if (keepLeftover(dir, name)) unreadable(file, reason, false);
			continue;
		}
		forgetLeftover(dir, name);
		unreadable(file, reason, true);
	}
	return records;
}

/** The kinds of record of a bot's home the owner is told about when one does not read. */
export type BotHomeRecordKind = keyof ReturnType<typeof interfaceText>["botTeam"]["homeRecordKinds"];

/**
 * The `unreadable` reporter of {@link readHomeRecords} for bot `agentId`'s records of `kind`: tells the owner, through
 * `warn`, that one was set aside, or that it could not be and stays where it is.
 */
export function tellUnreadableHomeRecord(
	agentId: string,
	kind: BotHomeRecordKind,
	warn: (message: string) => void,
): (file: string, reason: string, setAside: boolean) => void {
	return (file, reason, setAside) => {
		const words = interfaceText().botTeam;
		const record = words.homeRecordKinds[kind];
		warn(
			setAside
				? words.botHomeRecordSetAside(agentId, record, file, reason)
				: words.botHomeRecordNotSetAside(agentId, record, file, reason, LEFTOVER_REREAD_MAX_MINUTES),
		);
	};
}

/** Deletes all but the newest `keep` of the records `pattern` names in `dir`. */
export function keepNewestHomeRecords(dir: string, pattern: RegExp, keep: number): void {
	const names = homeRecordNames(dir, pattern);
	for (const name of names.slice(0, Math.max(0, names.length - keep))) rmSync(join(dir, name), { force: true });
}
