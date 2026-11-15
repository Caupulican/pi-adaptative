/**
 * How far a root session holds a bot session's charges, read back from the root's own records when the bot's spend ledger
 * lost its watermark (`BotTurnAccounting`): every `spawned_usage` charge labelled `bot-session` from that bot session,
 * in the root's session files as they were written (an accounting projection overlays a file without changing it, and
 * may show a grouped charge under another type) and in the live root's entries (the ones not written yet included), which
 * stand for the live root's own file. A charge names the
 * cumulative usage its range ends at (`through`), and the root holds the session's charges up to the furthest of them,
 * field by field. A charge an earlier build reported without a range end counts as its usage, once by report id, all of
 * them together reaching as far as their sum. Charges are delivered in range order, a later range only once every earlier
 * one reached the root, so the furthest end held covers every range before it.
 */

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Usage } from "@caupulican/pi-ai";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { visitSessionEntriesAsync } from "../../kernel/session/session-manager.ts";
import { combineUsage, createEmptyUsage } from "../../kernel/usage.ts";
import { isUsage } from "../cost/session-usage.ts";
import { usageReach } from "../cost/usage-delta.ts";
import { SPAWNED_USAGE_CUSTOM_TYPE } from "../cost/usage-records.ts";
import { isMissingFileError } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";

/** Where a root's charges are read: its session files and the live root's entries. */
export interface BotChargeHolder {
	/** The directory of every project's session directories (`root`), or the one session directory the root uses. */
	readonly scope: string;
	readonly root: boolean;
	/** The live root session's file, which its entries stand for; undefined when it has none. */
	readonly file: string | undefined;
	/** The live root session's entries, the ones not written to its file yet included. */
	readonly entries: readonly SessionEntry[];
}

/** The names in `directory`; none when it does not exist yet. */
async function namesIn(directory: string, directories: boolean): Promise<string[]> {
	try {
		const found = await readdir(directory, { withFileTypes: true });
		return found
			.filter((entry) => (directories ? entry.isDirectory() : entry.name.endsWith(".jsonl")))
			.map((entry) => entry.name);
	} catch (error) {
		if (isMissingFileError(error)) return [];
		throw error;
	}
}

/** The cumulative usage of bot session `sessionId` the root `holder` holds charges for (see the module comment). */
export async function botChargesHeld(holder: BotChargeHolder, sessionId: string): Promise<Usage> {
	let reach = createEmptyUsage();
	const unranged = new Map<string, Usage>();
	const take = (entry: SessionEntry): void => {
		if (entry.type !== "custom" || entry.customType !== SPAWNED_USAGE_CUSTOM_TYPE || !isPlainRecord(entry.data))
			return;
		const { label, sourceSessionId, through, usage, reportId } = entry.data;
		if (label !== "bot-session" || sourceSessionId !== sessionId) return;
		if (isUsage(through)) reach = usageReach(reach, through);
		else if (isUsage(usage) && typeof reportId === "string") unranged.set(reportId, usage);
	};
	const directories = holder.root
		? (await namesIn(holder.scope, true)).map((name) => join(holder.scope, name))
		: [holder.scope];
	const live = holder.file === undefined ? undefined : resolve(holder.file);
	for (const directory of directories)
		for (const name of await namesIn(directory, false)) {
			const file = join(directory, name);
			if (resolve(file) === live) continue;
			try {
				await visitSessionEntriesAsync(file, (line) => line.includes(sessionId), take);
			} catch (error) {
				// A file removed since the directory was listed holds no charge any more.
				if (!isMissingFileError(error)) throw error;
			}
		}
	for (const entry of holder.entries) take(entry);
	return usageReach(reach, combineUsage(...unranged.values()));
}
