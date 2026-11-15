/**
 * The orchestration homes of an agent directory (the owner's, then one per bot home that has an orchestration directory)
 * and the one rule that says which of them a session's state lives in ({@link resolveSessionHome}), asked by every
 * opener, lease and by-id lookup alike: a bot's home whenever it holds anything of the session, else the owner's when it
 * does (a bot session's state an earlier build kept there, until its host moves it), else the home the session's file or
 * bundle lies in. Where a path lies is judged by its real path (a symlinked agent directory, the case of a Windows path),
 * while the homes are spelled from the caller's agent directory, so they compare with the homes the hosts spell. A
 * session follows a reference into another home only when that home is its own: a root or away controller never takes an
 * attempt from a bot's home, and a bot's controller never one from the owner's or another bot's.
 */
import { type Dirent, existsSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { orchestrationHomeHoldsSession, type SessionHomeNow } from "../kernel/session/session-bundle-lifecycle.ts";
import {
	botHomeOrchestrationHome,
	type OrchestrationHome,
	ownerOrchestrationHome,
	ownerSessionStorageRoots,
	type SessionStorageRoots,
	sameOrchestrationHome,
} from "../kernel/session/session-bundle-paths.ts";
import { readSessionHeaderResult } from "../kernel/session/session-header.ts";
import { SessionManager } from "../kernel/session/session-manager.ts";
import { isMissingFileError } from "../kernel/storage/atomic-file.ts";
import { botsDir } from "./agent-paths.ts";
import { safeRealpathSync } from "./autonomy/path-scope.ts";
import { sessionHomeChangeOf } from "./session-switch-failures.ts";

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

/** A path's real spelling, case-folded where the file system ignores case: two spellings of one directory compare equal. */
export function canonicalPath(path: string): string {
	const real = safeRealpathSync(path, { native: true });
	return process.platform === "win32" ? real.toLowerCase() : real;
}

/**
 * The bot home whose `sessions/` directory is `dir`, or whose `orchestration/` holds it (a bundle and its workers'
 * transcripts), judged by real path and spelled from `agentDir`; undefined for any other directory.
 */
function botHomeOfDir(agentDir: string, dir: string): OrchestrationHome | undefined {
	const bots = botsDir(agentDir);
	const real = safeRealpathSync(dir, { native: true });
	const offset = relative(canonicalPath(bots), canonicalPath(dir));
	if (offset === "" || offset.startsWith("..") || isAbsolute(offset)) return undefined;
	const depth = offset.split(sep).length;
	// The real path's own segments keep the bot directory's spelling; the folded ones only locate it.
	const [name, area] = real.split(sep).slice(-depth);
	if (name === undefined || !((area === "sessions" && depth === 2) || area === "orchestration")) return undefined;
	return botHomeOrchestrationHome(join(bots, name));
}

/**
 * The one rule for which home holds session `sessionId`. `place` is the bot home its file or bundle lies in, if any
 * (undefined for a lookup by id alone, or a file outside every bot home). A bot's home that holds anything of the
 * session (`place`, or for a lookup by id any bot home) is its home; else the owner's when it holds anything of it; else
 * `place`, or the owner's for a session no home holds and no bot home contains.
 */
export function resolveSessionHome(
	agentDir: string,
	sessionId: string,
	place: OrchestrationHome | undefined,
): OrchestrationHome {
	const owner = ownerOrchestrationHome(agentDir);
	const bot =
		place ??
		orchestrationHomes(agentDir)
			.slice(1)
			.find((home) => orchestrationHomeHoldsSession(home, sessionId));
	if (bot && orchestrationHomeHoldsSession(bot, sessionId)) return bot;
	if (orchestrationHomeHoldsSession(owner, sessionId)) return owner;
	return bot ?? owner;
}

/** The home that holds the session, by its id alone ({@link resolveSessionHome}). */
export function orchestrationHomeOfSession(agentDir: string, sessionId: string): OrchestrationHome {
	return resolveSessionHome(agentDir, sessionId, undefined);
}

/**
 * `own` when the session is `own`'s by {@link resolveSessionHome}, else undefined: a reference into another home is not
 * followed, so a session's workers stay inside its own ceiling and spend window. A session no home holds any more is
 * still `own`'s: a reference to it was written in `own`, by a session of that home.
 */
export function followedOrchestrationHome(
	agentDir: string,
	own: OrchestrationHome,
	sessionId: string,
): OrchestrationHome | undefined {
	const place = sameOrchestrationHome(own, ownerOrchestrationHome(agentDir)) ? undefined : own;
	return sameOrchestrationHome(resolveSessionHome(agentDir, sessionId, place), own) ? own : undefined;
}

/**
 * The storage roots of a new session written to `sessionDir`: a bot's (its `sessions/`, or under its
 * `orchestration/`) or else the owner's.
 */
export function sessionStorageRootsOfDir(agentDir: string, sessionDir: string): SessionStorageRoots {
	const place = botHomeOfDir(agentDir, sessionDir);
	return place ? { agentDir, orchestrationHome: place } : ownerSessionStorageRoots(agentDir);
}

/**
 * The storage roots of the session file `file`: the owner's for a file outside every bot home; for one inside a bot's,
 * the home {@link resolveSessionHome} finds for the session its header names (a file whose header does not read is
 * opened in its bot's, where the open itself refuses it).
 */
export function sessionStorageRootsOfFile(agentDir: string, file: string): SessionStorageRoots {
	const place = botHomeOfDir(agentDir, dirname(resolve(file)));
	if (!place) return ownerSessionStorageRoots(agentDir);
	const header = readSessionHeaderResult(resolve(file));
	const home = header.ok ? resolveSessionHome(agentDir, header.header.id, place) : place;
	return { agentDir, orchestrationHome: home };
}

/**
 * The home the session of `sessionFile`, opened in `roots`, belongs in now, derived again as its open derived it: a
 * file inside a bot's home by {@link resolveSessionHome}, any other in `roots` (a session outside every bot home never
 * moves, so nothing is read). A lease is taken only while this still names the home it is taken in.
 */
export function sessionHomeNow(roots: SessionStorageRoots, sessionFile: string, sessionId: string): OrchestrationHome {
	const place = botHomeOfDir(roots.agentDir, dirname(resolve(sessionFile)));
	return place ? resolveSessionHome(roots.agentDir, sessionId, place) : roots.orchestrationHome;
}

/**
 * The storage roots of a new session written to `sessionDir` by a session opened in `roots` (its /new, fork or clone):
 * a directory inside a bot's home gives that bot's, as {@link sessionHomeNow} derives for a session no home holds yet;
 * any other keeps `roots`.
 */
export function newSessionStorageRoots(roots: SessionStorageRoots, sessionDir: string): SessionStorageRoots {
	const place = botHomeOfDir(roots.agentDir, sessionDir);
	return place ? { agentDir: roots.agentDir, orchestrationHome: place } : roots;
}

/** {@link sessionHomeNow} of a persisted session's manager, for its lease (`acquireSessionBundleLease`'s `homeNow`). */
export function managerSessionHomeNow(
	manager: Pick<SessionManager, "getStorageRoots" | "getSessionFile" | "getSessionId">,
): SessionHomeNow {
	const file = manager.getSessionFile();
	if (file === undefined) throw new Error(`Session ${manager.getSessionId()} has no file to lease.`);
	return () => sessionHomeNow(manager.getStorageRoots(), file, manager.getSessionId());
}

/**
 * The storage roots of bot session `sessionId`, whose bot's home is `botHome` ({@link resolveSessionHome}). Its host and
 * every other opener ask this, and ask it again under the lease's lock (`sessionHomeNow`), so all take its lease in the
 * same home: an opener that chose the owner's just before the host moved the state is refused
 * (`SessionHomeChangedError`) and opens it again.
 */
export function botSessionStorageRoots(
	agentDir: string,
	botHome: OrchestrationHome,
	sessionId: string,
): SessionStorageRoots {
	return { agentDir, orchestrationHome: resolveSessionHome(agentDir, sessionId, botHome) };
}

/**
 * Runs `attempt` (an AgentSession's creation, or a switch's preparation and commit, which take the session's lease) on
 * `manager`, and once more on the same file opened again in the roots it derives now, when the lease was refused because
 * the session's state moved between the open and the lease (`sessionHomeChangeOf`: a bot session's host moved it into
 * the bot's home). The refused attempt wrote nothing and closed nothing; the second open keeps the first's session id,
 * session directory and working directory, and a file not written yet stays the session's to start. A second refusal,
 * or any other failure, is thrown.
 */
export async function retryOnSessionHomeChange<T>(
	manager: SessionManager,
	attempt: (manager: SessionManager) => Promise<T>,
): Promise<T> {
	try {
		return await attempt(manager);
	} catch (error) {
		const file = manager.getSessionFile();
		if (sessionHomeChangeOf(error)?.sessionId !== manager.getSessionId() || !file) throw error;
		const roots = sessionStorageRootsOfFile(manager.getStorageRoots().agentDir, file);
		return attempt(
			SessionManager.openOrStart(file, roots, manager.getSessionId(), manager.getSessionDir(), manager.getCwd()),
		);
	}
}
