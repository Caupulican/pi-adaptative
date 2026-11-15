/**
 * The orchestration homes of an agent directory (the owner's, then one per bot home that has a profile) and which of
 * them holds a session. A reference to another session by id (its lease, its parent context, a specialist it built) is
 * read in the home that holds that session, and a session follows one only when that home is its own: a root or away
 * controller never takes an attempt from a bot's home, and a bot's controller never one from the owner's or another bot's.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { orchestrationHomeHoldsSession, refuseHostedSession } from "../kernel/session/session-bundle-lifecycle.ts";
import {
	botHomeOrchestrationHome,
	type OrchestrationHome,
	ownerOrchestrationHome,
	sameOrchestrationHome,
} from "../kernel/session/session-bundle-paths.ts";
import { botHomeProfileFile, botsDir } from "./agent-paths.ts";

/** The owner's home, then the home of every bot directory that holds a profile (one without is an orphan, no bot's). */
export function orchestrationHomes(agentDir: string): OrchestrationHome[] {
	const homes = [ownerOrchestrationHome(agentDir)];
	const bots = botsDir(agentDir);
	if (!existsSync(bots)) return homes;
	for (const entry of readdirSync(bots, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const homeDir = join(bots, entry.name);
		if (entry.isDirectory() && existsSync(botHomeProfileFile(homeDir))) homes.push(botHomeOrchestrationHome(homeDir));
	}
	return homes;
}

/**
 * The home that holds the session: the bot home that holds its bundle, tombstone or leases, else the owner's. A bot
 * home is asked first, as the owner's is the home of every session no bot's holds.
 */
export function orchestrationHomeOfSession(agentDir: string, sessionId: string): OrchestrationHome {
	const [owner, ...bots] = orchestrationHomes(agentDir);
	return bots.find((home) => orchestrationHomeHoldsSession(home, sessionId)) ?? owner!;
}

/** Throws `SessionHostedError` when the bot daemon hosts the session, judged in the home that holds it. */
export function refuseHostedSessionInItsHome(agentDir: string, sessionId: string): void {
	refuseHostedSession(orchestrationHomeOfSession(agentDir, sessionId), sessionId);
}

/**
 * `own` unless another home holds the session, then undefined: a reference into another home is not followed, so a
 * session's workers stay inside its own ceiling and spend window. A session no home holds any more (its bundle,
 * tombstone and leases gone) is still `own`'s: a reference to it was written in `own`, by a session of that home.
 */
export function followedOrchestrationHome(
	agentDir: string,
	own: OrchestrationHome,
	sessionId: string,
): OrchestrationHome | undefined {
	if (orchestrationHomeHoldsSession(own, sessionId)) return own;
	const elsewhere = orchestrationHomes(agentDir).some(
		(home) => !sameOrchestrationHome(home, own) && orchestrationHomeHoldsSession(home, sessionId),
	);
	return elsewhere ? undefined : own;
}
