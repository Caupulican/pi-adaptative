/**
 * What is charged to the away spend bound (`routines.away.maxUsdPerDay`) besides the routines' runs away: every channel's
 * turns while no session was open (`away-channels.ts`) and the metered spend of the bots the daemon hosted
 * (`bot-away-charges.ts`). One reader for every host and view of the bound, so none admits or shows less than another.
 * Bot charges that cannot be read count as the whole day's bound until they read again: spend that cannot be read is no
 * room. Each read reads them again, and the owner is told once per cause (`tell`: a root's warning, the daemon's lease
 * report) while they do not read. A bot charge file that does not parse is set aside by the read that meets it, which
 * tells the owner once.
 */

import { resolve } from "node:path";
import { botAwayChargesFile } from "../agent-paths.ts";
import { readBotAwayCharges } from "../bots/bot-away-charges.ts";
import { readAwayChannelCharges } from "../channels/away-channels.ts";
import { interfaceText } from "../language/interface-text.ts";
import { awaySpendMicros, type RoutineAwayCharge } from "./routine-away-spend.ts";

/** The away bounds the charges are read under. */
export interface AwaySpendBounds {
	readonly maxUsdPerRun: number;
	readonly maxUsdPerDay: number;
}

/**
 * Per agent directory, what this process told of its bot charges not reading: one owner per agent directory, told by
 * whichever of the process's readers meets a cause first, and forgotten once they read again, so a new cause is told.
 */
const toldUnreadable = new Map<string, string>();

/** The charges on the away spend bound now other than the routines' runs (see the module comment). */
export function readAwayCharges(
	agentDir: string,
	away: AwaySpendBounds,
	nowMs: number,
	tell: (message: string) => void,
): RoutineAwayCharge[] {
	const words = interfaceText().botTeam;
	const bots = readBotAwayCharges(agentDir, nowMs);
	const place = resolve(agentDir);
	if ("unreadable" in bots) {
		const message = words.botAwayChargesUnreadable(botAwayChargesFile(agentDir), bots.unreadable);
		if (toldUnreadable.get(place) !== message) tell(message);
		toldUnreadable.set(place, message);
	} else {
		toldUnreadable.delete(place);
		if (bots.setAside) tell(words.botAwayChargesSetAside(bots.setAside.file, bots.setAside.to, bots.setAside.reason));
	}
	return [
		...readAwayChannelCharges(agentDir, away.maxUsdPerRun, nowMs),
		...("charges" in bots ? bots.charges : [{ micros: awaySpendMicros(away.maxUsdPerDay) }]),
	];
}
