/**
 * The orchestration homes of an agent directory (the owner's, then one per bot home that has an orchestration directory)
 * and which of them holds a session. A session file's home is decided by where the file lies: one in a bot's
 * `sessions/` is that bot's, any other the owner's, so opening a file never enumerates the bot homes. A reference to
 * another session by id (its lease, its parent context, a specialist it built) is read in the home that holds that
 * session, and a session follows one only when that home is its own: a root or away controller never takes an attempt
 * from a bot's home, and a bot's controller never one from the owner's or another bot's.
 */
import { type Dirent, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { orchestrationHomeHoldsSession } from "../kernel/session/session-bundle-lifecycle.ts";
import {
	botHomeOrchestrationHome,
	type OrchestrationHome,
	ownerOrchestrationHome,
	ownerSessionStorageRoots,
	type SessionStorageRoots,
	sameOrchestrationHome,
} from "../kernel/session/session-bundle-paths.ts";
import { readSessionHeaderResult } from "../kernel/session/session-header.ts";
import { isMissingFileError } from "../kernel/storage/atomic-file.ts";
import { botHomeSessionsDir, botsDir } from "./agent-paths.ts";

/**
 * The owner's home, then the home of every bot directory that has an orchestration directory (with or without a
 * profile: a home whose profile is gone still holds its sessions' state). The bot homes are read once; a missing
 * `bots/` holds none, and any other failure to read it is thrown to the reader, which cannot know what it holds.
 */
export function orchestrationHomes(agentDir: string): OrchestrationHome[] {
	const homes = [ownerOrchestrationHome(agentDir)];
	const bots = botsDir(agentDir);
	let entries: Dirent[];
	try {
		entries = readdirSync(bots, { withFileTypes: true });
	} catch (error) {
		if (isMissingFileError(error)) return homes;
		throw error;
	}
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory()) continue;
		const home = botHomeOrchestrationHome(join(bots, entry.name));
		if (existsSync(home.root)) homes.push(home);
	}
	return homes;
}

/**
 * The home that holds the session: the owner's when it holds the session's bundle, tombstone or leases, else the bot
 * home that does, else the owner's (the home of every session no bot's holds). The owner's is asked first, so an owner
 * session's lookup never reads the bot homes.
 */
export function orchestrationHomeOfSession(agentDir: string, sessionId: string): OrchestrationHome {
	const owner = ownerOrchestrationHome(agentDir);
	if (orchestrationHomeHoldsSession(owner, sessionId)) return owner;
	return orchestrationHomes(agentDir).find((home) => orchestrationHomeHoldsSession(home, sessionId)) ?? owner;
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

/**
 * The storage roots of the sessions written to `sessionDir`: a bot's (`<agentDir>/bots/<name>/sessions`, its home's
 * orchestration directory) or else the owner's. Decided by the path alone, so it reads nothing and cannot fail: the roots
 * a new session in that directory is created in.
 */
export function sessionStorageRootsOfDir(agentDir: string, sessionDir: string): SessionStorageRoots {
	const dir = resolve(sessionDir);
	const homeDir = dirname(dir);
	if (dirname(homeDir) === resolve(botsDir(agentDir)) && botHomeSessionsDir(homeDir) === dir)
		return { agentDir, orchestrationHome: botHomeOrchestrationHome(homeDir) };
	return ownerSessionStorageRoots(agentDir);
}

/**
 * The storage roots of the session file `file`: those of the directory it lies in ({@link sessionStorageRootsOfDir}),
 * and for a bot's file the ones {@link botSessionStorageRoots} finds for the session its header names (a file whose
 * header does not read is opened in its bot's, where the open itself refuses it).
 */
export function sessionStorageRootsOfFile(agentDir: string, file: string): SessionStorageRoots {
	const roots = sessionStorageRootsOfDir(agentDir, dirname(resolve(file)));
	if (sameOrchestrationHome(roots.orchestrationHome, ownerOrchestrationHome(agentDir))) return roots;
	const header = readSessionHeaderResult(resolve(file));
	return header.ok ? botSessionStorageRoots(agentDir, roots.orchestrationHome, header.header.id) : roots;
}

/**
 * The storage roots of bot session `sessionId`, whose bot's home is `botHome`: the bot's, unless only the owner's home
 * holds the session (its bundle, tombstone or leases), as a bot session's state an earlier build kept there does until its
 * host moves it (`moveBotSessionBundle`), and as one whose move failed across devices keeps it. Every opener of a bot
 * session, its host and another process alike, asks this, so all take its lease in the same home.
 */
export function botSessionStorageRoots(
	agentDir: string,
	botHome: OrchestrationHome,
	sessionId: string,
): SessionStorageRoots {
	if (
		!orchestrationHomeHoldsSession(botHome, sessionId) &&
		orchestrationHomeHoldsSession(ownerOrchestrationHome(agentDir), sessionId)
	)
		return ownerSessionStorageRoots(agentDir);
	return { agentDir, orchestrationHome: botHome };
}
