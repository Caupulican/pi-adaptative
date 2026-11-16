/**
 * What is charged to the away spend bound (`routines.away.maxUsdPerDay`) besides the routines' runs away: every channel's
 * turns while no session was open (`away-channels.ts`) and the metered spend of the bots the daemon hosted
 * (`bot-away-charges.ts`). The one reader for every host and view of the bound, so none admits or shows less than another:
 * charges that do not read are `unread` with their path and cause (`RoutineAwayChargesRead`), and the bound has no room
 * until they read again (`routineAwaySpendRoom`); a channel journal reset or a bot charge record set aside within the last
 * day charges the whole day bound (`dayAllowanceUntil`). The owner is told once per process and agent directory (`tell`:
 * a root's warning, the daemon's lease report): a failed read once per path and cause, until one reads again; each
 * channel journal reset that charges the bound once, until
 * its charge ends (held in memory: a restarted daemon tells it again); a bot charge file that did not parse, which the read
 * that meets it sets aside, once, with when its whole-day charge ends.
 * With `setsAside` (the daemon, which hosts the channels away) a channel journal that does not parse is set aside where
 * it is read (`readAwayChannelCharges` with its `resets`); without it (a root's status, which writes nothing to a journal
 * a serving session or the daemon owns) such a journal reads as `unread` until one of them sets it aside.
 */

import { resolve } from "node:path";
import { botAwayChargesFile } from "../agent-paths.ts";
import { readBotAwayCharges } from "../bots/bot-away-charges.ts";
import { readAwayChannelCharges } from "../channels/away-channels.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { RoutineAwayChargesRead } from "./routine-away-spend.ts";

/** The away bounds the charges are read under. */
export interface AwaySpendBounds {
	readonly maxUsdPerRun: number;
	readonly maxUsdPerDay: number;
}

/**
 * What this process told of an agent directory's charges: the failed read (path and cause) and the resets, by journal and
 * gap, each until its charge ends (a reset dated ahead of this clock ends later at each read).
 */
interface AwayChargesTold {
	unread?: string;
	readonly resets: Map<string, number>;
}

/** Per agent directory (resolved): one telling for every reader of the process. */
const toldByPlace = new Map<string, AwayChargesTold>();

/** The charges on the away spend bound now other than the routines' runs (see the module comment). */
export function readAwayCharges(
	agentDir: string,
	away: AwaySpendBounds,
	nowMs: number,
	tell: (message: string) => void,
	options: { readonly setsAside?: boolean } = {},
): RoutineAwayChargesRead {
	const place = resolve(agentDir);
	const told = toldByPlace.get(place) ?? { resets: new Map<string, number>() };
	toldByPlace.set(place, told);
	for (const [key, until] of told.resets) if (until <= nowMs) told.resets.delete(key);
	const text = interfaceText();
	const channels = readAwayChannelCharges(
		agentDir,
		away.maxUsdPerRun,
		nowMs,
		options.setsAside
			? (path, until, gapId) => {
					const key = `${path}#${gapId}`;
					if (told.resets.has(key)) return;
					told.resets.set(key, until);
					const at = text.reports.formats.dateTime(new Date(until).toISOString());
					tell(text.sessions.awayMeteredRuns.journalReset(path, at));
				}
			: undefined,
	);
	const bots = readBotAwayCharges(agentDir, nowMs);
	if ("setAside" in bots && bots.setAside) {
		const until = text.reports.formats.dateTime(new Date(bots.setAside.until).toISOString());
		tell(text.botTeam.botAwayChargesSetAside(bots.setAside.file, bots.setAside.to, bots.setAside.reason, until));
	}
	const read: RoutineAwayChargesRead =
		"unread" in channels
			? channels
			: "unreadable" in bots
				? { unread: { path: botAwayChargesFile(agentDir), cause: bots.cause } }
				: {
						charges: [...channels.charges, ...bots.charges],
						dayAllowanceUntil: [...(channels.dayAllowanceUntil ?? []), ...bots.dayAllowanceUntil],
					};
	if (!("unread" in read)) {
		told.unread = undefined;
		return read;
	}
	const key = `${read.unread.path}\u0000${read.unread.cause}`;
	if (told.unread !== key) {
		told.unread = key;
		const words = text.sessions.awayMeteredRuns;
		tell(
			"unread" in channels
				? words.chargesUnread(words.chargeRecords.channelTurns, read.unread.path, read.unread.cause)
				: words.chargesUnread(
						words.chargeRecords.botSpend,
						read.unread.path,
						"unreadable" in bots ? bots.unreadable : read.unread.cause,
					),
		);
	}
	return read;
}
