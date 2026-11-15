/**
 * Which sessions the bot homes hold now, read once per startup retention sweep (`session-bundle-retention.ts`): each
 * home's current session (the one its pointer records, `bot-session-pointer.ts`, or else the newest session file its
 * host's first load would choose) and the session a live host holds (`readBotHomeHost`). A home holds its current
 * session as long as it exists, profile or not, and a live host its session until the host ends. A home whose current
 * session, or whose live host's session, cannot be told is marked with why, so the sweep only resumes what an earlier
 * run reserved there. Each home is named to the owner by its profile's display name, or its directory name without one.
 */
import { type Dirent, readdirSync } from "node:fs";
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
	/** The session a live host holds, as far as it is known; undefined when no live host holds the home's lock. */
	readonly liveSessionId: string | undefined;
} & (
	| { readonly kind: "held" }
	| {
			readonly kind: "undetermined";
			readonly unknown: BotHomeUnknown;
			/** Whether a live host may hold a session neither id names (its lock is held, or could not be read). */
			readonly maybeLive: boolean;
	  }
);

/** What every bot home holds, from one read of `bots/`. */
export interface BotSessionHolds {
	/** Every home, in directory name order. */
	readonly homes: readonly BotHomeHold[];
	/** Each home's current session and each live host's session, as far as they are known. */
	readonly heldSessionIds: ReadonlySet<string>;
}

type CurrentSession =
	| { readonly ok: true; readonly sessionId: string | undefined }
	| { readonly ok: false; readonly unknown: BotHomeUnknown };

/**
 * The session the bot keeps its conversation in: the recorded one, else the newest file the host's first load chooses.
 * Judging which session the home holds only reads, so a symlinked pointer or session file is followed to what it names;
 * a pointer, file or tombstone that could not be read leaves the session unknown, since the pointer may still name the
 * session the bot keeps.
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
	if (choice.kind === "recorded") return { ok: true, sessionId: choice.pointer.sessionId };
	return { ok: true, sessionId: choice.newest?.sessionId };
}

function holdOf(agentDir: string, name: string, home: BotHome): BotHomeHold {
	const displayName = readBotProfileDisplayName(home) ?? name;
	const current = currentSession(agentDir, home);
	const currentSessionId = current.ok ? current.sessionId : undefined;
	const known = { name, displayName, home, currentSessionId };
	let live: { readonly botSessionId: string | undefined } | undefined;
	try {
		live = readBotHomeHost(home.dir);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		harnessLog.warn("bots", "a bot's host state does not read", { home: home.dir, detail });
		const unknown: BotHomeUnknown = { kind: "host-state-unreadable" };
		return { kind: "undetermined", ...known, liveSessionId: undefined, maybeLive: true, unknown };
	}
	const published = live?.botSessionId;
	if (!current.ok) {
		const maybeLive = live !== undefined && published === undefined;
		return { kind: "undetermined", ...known, liveSessionId: published, maybeLive, unknown: current.unknown };
	}
	// A host records the pointer before it builds the session, so until it publishes, the session it holds is the current one.
	const liveSessionId = live ? (published ?? currentSessionId) : undefined;
	if (live && liveSessionId === undefined) {
		const unknown: BotHomeUnknown = { kind: "host-session-unnamed" };
		return { kind: "undetermined", ...known, liveSessionId, maybeLive: true, unknown };
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
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.isDirectory()) homes.push(holdOf(agentDir, entry.name, botHomeAt(join(bots, entry.name))));
	}
	const heldSessionIds = new Set<string>();
	for (const hold of homes) {
		if (hold.currentSessionId !== undefined) heldSessionIds.add(hold.currentSessionId);
		if (hold.liveSessionId !== undefined) heldSessionIds.add(hold.liveSessionId);
	}
	return { homes, heldSessionIds };
}
