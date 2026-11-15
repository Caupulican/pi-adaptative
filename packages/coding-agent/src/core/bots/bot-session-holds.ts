/**
 * Which sessions the bot homes hold now, read once per startup retention sweep (`session-bundle-retention.ts`): each
 * home's current session (the one its pointer records, `bot-session-pointer.ts`, or else the newest session file its
 * host's first load would choose) and the session a live host holds (`readBotHomeHost`). A home holds its current
 * session as long as it exists, profile or not, and a live host its session until the host ends. A home whose current
 * session, or whose live host's session, cannot be told is marked with why, so the sweep only resumes what an earlier
 * run reserved there. Each home is named to the owner by its profile's display name, or its directory name without one.
 */
import { type Dirent, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import { isMissingFileError } from "../../kernel/storage/atomic-file.ts";
import { botsDir } from "../agent-paths.ts";
import { type BotHome, botHomeAt, readBotProfileDisplayName } from "./bot-home.ts";
import { readBotHomeHost } from "./bot-host-state.ts";
import { type BotSessionChoice, botSessionChoice } from "./bot-session-pointer.ts";

/** Why a home's sessions cannot be told; the owner is told it in their language, the details go to the harness log. */
export type BotHomeUnknown =
	| { readonly kind: "host-state-unreadable" }
	| { readonly kind: "current-session-unknown" }
	| { readonly kind: "host-session-unnamed" };

/** What one bot home holds. */
export type BotHomeHold = {
	/** The home's directory name under `bots/`. */
	readonly name: string;
	/** How the owner is told of the home: its profile's display name, else its directory name. */
	readonly displayName: string;
	readonly home: BotHome;
	/** The session the bot keeps its conversation in; undefined when the home has none yet or it cannot be told. */
	readonly currentSessionId: string | undefined;
	/** The session a pointer the host will set aside still names (its file holds another session); held until it does. */
	readonly setAsideSessionId: string | undefined;
	/** The session a live host holds, as far as it is known; undefined when no live host holds the home's lock. */
	readonly liveSessionId: string | undefined;
} & ({ readonly kind: "held" } | { readonly kind: "undetermined"; readonly unknown: BotHomeUnknown });

/** What every bot home holds, from one read of `bots/`. */
export interface BotSessionHolds {
	/** Every home, in directory name order. */
	readonly homes: readonly BotHomeHold[];
	/**
	 * The homes whose symbolic link under `bots/` does not resolve (named by directory name): what they hold is unknown, so
	 * they count as homes whose session files did not list.
	 */
	readonly unresolvedHomes: readonly { readonly name: string; readonly home: BotHome }[];
	/** Each home's current session, the session a pointer to be set aside names, and each live host's session. */
	readonly heldSessionIds: ReadonlySet<string>;
}

type CurrentSession =
	| { readonly ok: true; readonly sessionId: string | undefined; readonly setAsideSessionId: string | undefined }
	| { readonly ok: false; readonly unknown: BotHomeUnknown };

/**
 * The session the bot keeps its conversation in: the recorded one, else the newest file the host's first load chooses.
 * A pointer that does not count (`setAside`: not a pointer, not its session's file) is content the host sets aside, not a
 * reason the session is unknown: the newest file is then the one it chooses. A pointer, file or tombstone that could not
 * be read leaves the session unknown, since the pointer may still name the session the bot keeps. Judging which session
 * the home holds only reads, so a symlinked pointer or session file is followed to what it names.
 */
function currentSession(agentDir: string, home: BotHome): CurrentSession {
	let choice: BotSessionChoice;
	try {
		choice = botSessionChoice(agentDir, home, "follow");
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		harnessLog.warn("bots", "a bot's session pointer does not read", { home: home.dir, detail });
		return { ok: false, unknown: { kind: "current-session-unknown" } };
	}
	if (choice.kind === "recorded")
		return { ok: true, sessionId: choice.pointer.sessionId, setAsideSessionId: undefined };
	// A pointer to a file that holds another session still names the session the bot recorded: held until set aside.
	const setAsideSessionId = choice.setAside?.kind === "other-session" ? choice.setAside.sessionId : undefined;
	return { ok: true, sessionId: choice.newest?.sessionId, setAsideSessionId };
}

function holdOf(agentDir: string, name: string, home: BotHome): BotHomeHold {
	const displayName = readBotProfileDisplayName(home) ?? name;
	const current = currentSession(agentDir, home);
	const currentSessionId = current.ok ? current.sessionId : undefined;
	const setAsideSessionId = current.ok ? current.setAsideSessionId : undefined;
	const known = { name, displayName, home, currentSessionId, setAsideSessionId };
	let live: { readonly botSessionId: string | undefined } | undefined;
	try {
		live = readBotHomeHost(home.dir);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		harnessLog.warn("bots", "a bot's host state does not read", { home: home.dir, detail });
		const unknown: BotHomeUnknown = { kind: "host-state-unreadable" };
		return { kind: "undetermined", ...known, liveSessionId: undefined, unknown };
	}
	const published = live?.botSessionId;
	if (!current.ok) return { kind: "undetermined", ...known, liveSessionId: published, unknown: current.unknown };
	// A host records the pointer before it builds the session, so until it publishes, the session it holds is the current one.
	const liveSessionId = live ? (published ?? currentSessionId) : undefined;
	if (live && liveSessionId === undefined) {
		const unknown: BotHomeUnknown = { kind: "host-session-unnamed" };
		return { kind: "undetermined", ...known, liveSessionId, unknown };
	}
	return { kind: "held", ...known, liveSessionId };
}

/**
 * Reads every bot home once. A missing `bots/` holds none; any other failure to read it is thrown, since the sessions
 * the homes hold are then unknown.
 */
export function readBotSessionHolds(agentDir: string): BotSessionHolds {
	const bots = botsDir(agentDir);
	let entries: Dirent[];
	try {
		entries = readdirSync(bots, { withFileTypes: true });
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
		entries = [];
	}
	const homes: BotHomeHold[] = [];
	const unresolvedHomes: { name: string; home: BotHome }[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		// A symlinked bot directory is a home, as `sessionHomes` counts it; a link to anything else is not.
		const dir = join(bots, entry.name);
		if (entry.isSymbolicLink()) {
			const target = linkTarget(dir);
			if (target === "unresolved") unresolvedHomes.push({ name: entry.name, home: botHomeAt(dir) });
			if (target !== "directory") continue;
		} else if (!entry.isDirectory()) continue;
		homes.push(holdOf(agentDir, entry.name, botHomeAt(dir)));
	}
	const heldSessionIds = new Set<string>();
	for (const hold of homes) {
		if (hold.currentSessionId !== undefined) heldSessionIds.add(hold.currentSessionId);
		if (hold.liveSessionId !== undefined) heldSessionIds.add(hold.liveSessionId);
		if (hold.setAsideSessionId !== undefined) heldSessionIds.add(hold.setAsideSessionId);
	}
	return { homes, unresolvedHomes, heldSessionIds };
}

/** What a symbolic link under `bots/` names: a directory, something else, or nothing that can be read. */
function linkTarget(dir: string): "directory" | "other" | "unresolved" {
	try {
		return statSync(dir).isDirectory() ? "directory" : "other";
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		harnessLog.warn("bots", "a bot home's symbolic link does not resolve", { home: dir, detail });
		return "unresolved";
	}
}
