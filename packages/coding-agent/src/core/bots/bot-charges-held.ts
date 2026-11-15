/**
 * How far the root sessions of the process hold a bot session's charges, read back from the roots' own records when the
 * bot's spend ledger lost its watermark (`BotTurnAccounting`): every `spawned_usage` charge labelled `bot-session` from
 * that bot session. A charge names the cumulative usage its range ends at (`through`), and the roots hold the session's
 * charges up to the furthest of them their files hold, field by field: charges are delivered in range order, a later
 * range only once every earlier one reached a root, so the furthest end held covers every range before it.
 *
 * Only a session file holds a charge for good. The session files are read as they were written (an accounting projection
 * overlays a file without changing it, and may show a grouped charge under another type), only those changed since
 * `since` (when the bot session began, or its transcript's last charge mark): a file not written since holds none of its
 * charges past what the mark holds. A live root's file is not read: its
 * entries are, each charge counted held once the root's file holds it exactly (`persisted`), and the ones it holds
 * unwritten are taken back as charges still to deliver (`unwritten`), since a root that ends unwritten drops them; one
 * held unwritten that does not name its whole range is counted neither: its range is charged again, and the readers take
 * an overlapping range once (`ChargedRanges`). A file that only grows while it is read (a writer appending) is read as
 * it was when opened; one that changes otherwise is read again; one that is no session file (no valid header) holds no
 * charge; one removed since it was listed holds none any more. A file or directory that cannot be read (or stat'ed, or
 * listed) is read as holding none and named (`unread`): the watermark starts lower, its ranges are charged again, and
 * the readers take an overlapping range once. A charge an earlier build reported without a range end counts as its usage, once by
 * report id, all of them together reaching as far as their sum.
 */

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Usage } from "@caupulican/pi-ai";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { InvalidSessionHeaderError, visitSessionEntriesAsync } from "../../kernel/session/session-file-reading.ts";
import { FileSnapshotChangedError } from "../../kernel/storage/bounded-file.ts";
import { combineUsage, createEmptyUsage } from "../../kernel/usage.ts";
import { isUsage } from "../cost/session-usage.ts";
import { usageReach } from "../cost/usage-delta.ts";
import { BOT_SESSION_USAGE_LABEL, SPAWNED_USAGE_CUSTOM_TYPE } from "../cost/usage-records.ts";
import { isMissingFileError } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";

/**
 * How many times a session file that changes while it is read is read again before it is read as holding none (and
 * named): skipping it under-reads how far the roots hold the charges, so its ranges are charged again.
 */
const MAX_FILE_READS = 3;

/**
 * How much coarser than the header's milliseconds a file system may keep modification times (two seconds on FAT): a file
 * written in the bot session's first moments is still read.
 */
const MTIME_GRANULARITY_MS = 2_000;

/** A live root session of the process: its file, and its entries (the ones not written to its file yet included). */
export interface BotChargeLiveRoot {
	/** Its file, which its entries stand for; undefined when it has none. */
	readonly file: string | undefined;
	/** Its session when it keeps no file: the charges it holds unwritten are held by it alone (`BotCharge.heldBy`). */
	readonly heldBy: string | undefined;
	readonly entries: readonly SessionEntry[];
	/** Whether the root's file holds `entry` exactly as it is (`classifyCustomEntryPersisted`). */
	persisted(entry: SessionEntry): boolean;
}

/** Where one root's charges are read: the session files it keeps, and the live root itself. */
export interface BotChargeHolder {
	/** The directory of every project's session directories (`root`), or the one session directory the root uses. */
	readonly scope: string;
	readonly root: boolean;
	readonly live: BotChargeLiveRoot;
}

/** A charge of the bot session a live root holds unwritten: what delivers it again under its own identity. */
export interface UnwrittenBotCharge {
	readonly usage: Usage;
	readonly reportId: string;
	readonly provider: string;
	readonly model: string;
	readonly from: Usage;
	readonly through: Usage;
	readonly recordedAt: string;
	/** The root that keeps no file holding it, when one does (`BotCharge.heldBy`). */
	readonly heldBy: string | undefined;
}

/** A root's session file or directory the read-back could not read, and why. */
export interface BotChargeUnread {
	readonly path: string;
	readonly reason: string;
}

/**
 * How far the roots' files hold a bot session's charges, the charges the live roots hold unwritten, oldest first, and the
 * files and directories that could not be read (read as holding none).
 */
export interface BotChargesHeld {
	readonly through: Usage;
	readonly unwritten: readonly UnwrittenBotCharge[];
	readonly unread: readonly BotChargeUnread[];
}

function unreadOf(path: string, error: unknown): BotChargeUnread {
	return { path, reason: error instanceof Error ? error.message : String(error) };
}

/** The names in `directory`; none when it does not exist yet, or cannot be listed (named in `unread`). */
async function namesIn(directory: string, directories: boolean, unread: BotChargeUnread[]): Promise<string[]> {
	try {
		const found = await readdir(directory, { withFileTypes: true });
		return found
			.filter((entry) => (directories ? entry.isDirectory() : entry.name.endsWith(".jsonl")))
			.map((entry) => entry.name);
	} catch (error) {
		if (!isMissingFileError(error)) unread.push(unreadOf(directory, error));
		return [];
	}
}

/** The session directories the holders keep their files in, each once. */
async function directoriesOf(holders: readonly BotChargeHolder[], unread: BotChargeUnread[]): Promise<string[]> {
	const directories = new Map<string, string>();
	for (const holder of holders) {
		const found = holder.root
			? (await namesIn(holder.scope, true, unread)).map((name) => join(holder.scope, name))
			: [holder.scope];
		for (const directory of found) directories.set(resolve(directory), directory);
	}
	return [...directories.values()];
}

/**
 * Reads one session file's charge lines, as it was when opened; false when it holds none (removed since it was listed, no
 * session file, or one that cannot be read, named in `unread`).
 */
async function readFileCharges(
	file: string,
	sessionId: string,
	take: (entry: SessionEntry) => void,
	unread: BotChargeUnread[],
): Promise<boolean> {
	for (let read = 1; ; read++) {
		const taken: SessionEntry[] = [];
		try {
			await visitSessionEntriesAsync(
				file,
				(line) => line.includes(sessionId),
				(entry) => taken.push(entry),
				{ prefixOfGrowing: true },
			);
		} catch (error) {
			if (isMissingFileError(error) || error instanceof InvalidSessionHeaderError) return false;
			if (error instanceof FileSnapshotChangedError && read < MAX_FILE_READS) continue;
			unread.push(unreadOf(file, error));
			return false;
		}
		for (const entry of taken) take(entry);
		return true;
	}
}

/** The data of a `bot-session` charge from bot session `sessionId`; undefined for any other entry. */
function chargeOf(entry: SessionEntry, sessionId: string): Record<string, unknown> | undefined {
	if (entry.type !== "custom" || entry.customType !== SPAWNED_USAGE_CUSTOM_TYPE || !isPlainRecord(entry.data))
		return undefined;
	const { label, sourceSessionId } = entry.data;
	return label === BOT_SESSION_USAGE_LABEL && sourceSessionId === sessionId ? entry.data : undefined;
}

/** A charge a live root holds unwritten, when it names everything its delivery is matched by. */
function unwrittenOf(data: Record<string, unknown>, heldBy: string | undefined): UnwrittenBotCharge | undefined {
	const { usage, reportId, provider, model, from, through, recordedAt } = data;
	if (!isUsage(usage) || !isUsage(from) || !isUsage(through)) return undefined;
	if (typeof reportId !== "string" || typeof provider !== "string" || typeof model !== "string") return undefined;
	if (typeof recordedAt !== "string") return undefined;
	return { usage, reportId, provider, model, from, through, recordedAt, heldBy };
}

/**
 * How far the roots `holders` hold the charges of bot session `sessionId` in the files changed since `since` (ms since
 * the epoch), and the charges they hold unwritten (see the module comment).
 */
export async function botChargesHeld(
	holders: readonly BotChargeHolder[],
	sessionId: string,
	since: number,
): Promise<BotChargesHeld> {
	let reach = createEmptyUsage();
	const unranged = new Map<string, Usage>();
	const held = (data: Record<string, unknown>): void => {
		if (isUsage(data.through)) reach = usageReach(reach, data.through);
		else if (isUsage(data.usage) && typeof data.reportId === "string") unranged.set(data.reportId, data.usage);
	};
	const unread: BotChargeUnread[] = [];
	const live = new Set(holders.flatMap(({ live: root }) => (root.file === undefined ? [] : [resolve(root.file)])));
	for (const directory of await directoriesOf(holders, unread))
		for (const name of await namesIn(directory, false, unread)) {
			const file = join(directory, name);
			if (live.has(resolve(file))) continue;
			const changed = await stat(file).then(
				(found) => found.mtimeMs,
				(error: unknown) => {
					if (!isMissingFileError(error)) unread.push(unreadOf(file, error));
					return undefined;
				},
			);
			if (changed === undefined || changed < since - MTIME_GRANULARITY_MS) continue;
			await readFileCharges(
				file,
				sessionId,
				(entry) => {
					const data = chargeOf(entry, sessionId);
					if (data) held(data);
				},
				unread,
			);
		}
	const unwritten = new Map<string, UnwrittenBotCharge>();
	for (const { live: root } of holders)
		for (const entry of root.entries) {
			const data = chargeOf(entry, sessionId);
			if (!data) continue;
			if (root.persisted(entry)) {
				held(data);
				continue;
			}
			// A live root holds unwritten only charges this process delivered, each naming its range: one that does not is
			// counted neither (see the module comment).
			const charge = unwrittenOf(data, root.heldBy);
			if (charge && !unwritten.has(charge.reportId)) unwritten.set(charge.reportId, charge);
		}
	return {
		through: usageReach(reach, combineUsage(...unranged.values())),
		unwritten: [...unwritten.values()],
		// A path met twice (a directory two roots keep, a file listed twice) is named once.
		unread: [...new Map(unread.map((entry) => [resolve(entry.path), entry])).values()],
	};
}
