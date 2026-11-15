/**
 * How far the roots hold a bot session's charges, kept in the bot's own transcript: once a root's file holds the
 * session's charges up to a range end, that end is appended as a `bot-charge-mark-v1` entry. The mark lives as long as
 * the usage it measures, so a watermark read back after the root files that held the charges were removed (session
 * retention) still starts past them (`BotTurnAccounting`). The mark lives in the session's file, so it measures that file
 * instance's usage only: a file created again under the same session id holds none of the earlier one's marks. A transcript that copies another's entries copies its marks
 * with the usage they measure. The entry is a custom one: no model reads it, and a spend window walks past it to the input
 * before it.
 */

import type { Usage } from "@caupulican/pi-ai";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import { isUsage } from "../cost/session-usage.ts";
import { usageReach } from "../cost/usage-delta.ts";
import { isPlainRecord } from "../util/value-guards.ts";

export const BOT_CHARGE_MARK_CUSTOM_TYPE = "bot-charge-mark-v1";

/**
 * The instance of the bot session's file: when its header was written (`SessionHeader.timestamp`). A file created again
 * under the same session id (its recorded file was lost) is another instance: its recorded usage starts at zero, its
 * transcript holds none of the earlier file's marks, and its charges are ranges of their own.
 */
export function botSessionInstance(transcript: Pick<SessionManager, "getHeader">): string {
	const header = transcript.getHeader();
	if (!header) throw new Error("The bot session has no header: its file instance is unknown.");
	return header.timestamp;
}

/** Whether every field of `a` and `b` is the same. */
function sameReading(a: Usage, b: Usage): boolean {
	return (
		a.input === b.input &&
		a.output === b.output &&
		a.cacheRead === b.cacheRead &&
		a.cacheWrite === b.cacheWrite &&
		a.totalTokens === b.totalTokens &&
		a.cost.input === b.cost.input &&
		a.cost.output === b.cost.output &&
		a.cost.cacheRead === b.cost.cacheRead &&
		a.cost.cacheWrite === b.cost.cacheWrite &&
		a.cost.total === b.cost.total
	);
}

/** What the marks of one session file instance hold. */
interface MarkRead {
	readonly sessionId: string;
	readonly instance: string;
	/** How far its marks reach; undefined: it holds none. */
	reach: Usage | undefined;
	/** When the last was written (ms since the epoch); undefined: it holds none. */
	at: number | undefined;
}

/** The bot session's charge mark (see the module comment), read from its transcript once per session file instance. */
export class BotChargeMark {
	private readonly transcript: Pick<SessionManager, "getHeader" | "getEntries" | "getSessionId" | "appendCustomEntry">;
	/** The session file instance the reach was read for, and what its marks hold. */
	private read: MarkRead | undefined;

	constructor(transcript: BotChargeMark["transcript"]) {
		this.transcript = transcript;
	}

	/** How far the transcript's marks reach together, field by field; undefined when it holds none. */
	reach(): Usage | undefined {
		return this.marks().reach;
	}

	/**
	 * When the transcript's last mark was written (ms since the epoch); undefined when it holds none. A root's file not
	 * written since holds no charge past `reach` the roots held then.
	 */
	markedAt(): number | undefined {
		return this.marks().at;
	}

	private marks(): MarkRead {
		const sessionId = this.transcript.getSessionId();
		const instance = botSessionInstance(this.transcript);
		if (this.read?.sessionId === sessionId && this.read.instance === instance) return this.read;
		let reach: Usage | undefined;
		let at: number | undefined;
		for (const entry of this.transcript.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== BOT_CHARGE_MARK_CUSTOM_TYPE) continue;
			if (!isPlainRecord(entry.data) || !isUsage(entry.data.through)) continue;
			reach = reach ? usageReach(reach, entry.data.through) : entry.data.through;
			const written = Date.parse(entry.timestamp);
			if (Number.isFinite(written)) at = Math.max(at ?? written, written);
		}
		this.read = { sessionId, instance, reach, at };
		return this.read;
	}

	/** Records that the roots hold the session's charges through `through`, when that reaches past the mark. */
	advance(through: Usage): void {
		const read = this.marks();
		const reach = read.reach;
		const next = reach ? usageReach(reach, through) : through;
		if (reach && sameReading(reach, next)) return;
		const at = Date.now();
		this.transcript.appendCustomEntry(BOT_CHARGE_MARK_CUSTOM_TYPE, { through: structuredClone(next) });
		read.reach = next;
		read.at = at;
	}
}
