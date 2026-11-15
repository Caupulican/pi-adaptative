/**
 * Which sessions the bot homes hold now, read once per startup retention sweep (`session-bundle-retention.ts`): each
 * home's current session (the one its pointer records, `bot-session-pointer.ts`, or else the newest session file its
 * host's first load would choose) and the session a live host holds (`readBotHomeHost`). A home holds its current
 * session as long as it exists, profile or not, and a live host its session until the host ends. A home whose current
 * session, or whose live host's session, cannot be told is named with why, so the sweep leaves its bundles alone.
 */
import { type Dirent, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isMissingFileError } from "../../kernel/storage/atomic-file.ts";
import { botsDir } from "../agent-paths.ts";
import { type BotHome, botHomeAt } from "./bot-home.ts";
import { readBotHomeHost } from "./bot-host-state.ts";
import { botSessionChoice } from "./bot-session-pointer.ts";

/** What one bot home holds. */
export type BotHomeHold = {
	/** The home's directory name under `bots/`. */
	readonly name: string;
	readonly home: BotHome;
	/** The session a live host holds, as far as it is known; undefined when no live host holds the home's lock. */
	readonly liveSessionId: string | undefined;
} & (
	| {
			readonly kind: "held";
			/** The session the bot keeps its conversation in; undefined when the home has none yet. */
			readonly currentSessionId: string | undefined;
	  }
	| {
			readonly kind: "undetermined";
			readonly reason: string;
			/** Whether a live host may hold a session `liveSessionId` does not name (its lock is held, or could not be read). */
			readonly maybeLive: boolean;
	  }
);

/** What every bot home holds, from one read of `bots/`. */
export interface BotSessionHolds {
	/** Every home, in directory name order. */
	readonly homes: readonly BotHomeHold[];
	/** Each home's current session and each live host's session: none is a session no process will open again. */
	readonly heldSessionIds: ReadonlySet<string>;
	/** Whether a live host may hold a session no hold names (its home's sessions could not be told). */
	readonly liveSessionUnknown: boolean;
	/** The hold of the home whose directory is `homeDir`; undefined for a home the read did not find. */
	holdAt(homeDir: string): BotHomeHold | undefined;
}

type CurrentSession =
	| { readonly ok: true; readonly sessionId: string | undefined }
	| { readonly ok: false; readonly reason: string };

/**
 * The session the bot keeps its conversation in: the recorded one, else the newest file the host's first load chooses.
 * A read that only judges which session the home holds follows a symlinked pointer or session file to what it names.
 */
function currentSession(agentDir: string, home: BotHome): CurrentSession {
	const choice = botSessionChoice(agentDir, home, "follow");
	if (choice.kind === "recorded") return { ok: true, sessionId: choice.pointer.sessionId };
	return { ok: true, sessionId: choice.newest?.sessionId };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function holdOf(agentDir: string, name: string, home: BotHome): BotHomeHold {
	let live: { readonly botSessionId: string | undefined } | undefined;
	try {
		live = readBotHomeHost(home.dir);
	} catch (error) {
		const reason = `its host state cannot be read (${describe(error)})`;
		return { kind: "undetermined", name, home, liveSessionId: undefined, maybeLive: true, reason };
	}
	const published = live?.botSessionId;
	const current = currentSession(agentDir, home);
	if (!current.ok) {
		const maybeLive = live !== undefined && published === undefined;
		return { kind: "undetermined", name, home, liveSessionId: published, maybeLive, reason: current.reason };
	}
	// A host records the pointer before it builds the session, so until it publishes, the session it holds is the current one.
	const liveSessionId = live ? (published ?? current.sessionId) : undefined;
	if (live && liveSessionId === undefined) {
		const reason = "its host has not yet named the session it holds";
		return { kind: "undetermined", name, home, liveSessionId, maybeLive: true, reason };
	}
	return { kind: "held", name, home, currentSessionId: current.sessionId, liveSessionId };
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
	const byDir = new Map<string, BotHomeHold>();
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory()) continue;
		const dir = join(bots, entry.name);
		byDir.set(resolve(dir), holdOf(agentDir, entry.name, botHomeAt(dir)));
	}
	const homes = [...byDir.values()];
	const heldSessionIds = new Set<string>();
	for (const hold of homes) {
		if (hold.kind === "held" && hold.currentSessionId !== undefined) heldSessionIds.add(hold.currentSessionId);
		if (hold.liveSessionId !== undefined) heldSessionIds.add(hold.liveSessionId);
	}
	return {
		homes,
		heldSessionIds,
		liveSessionUnknown: homes.some((hold) => hold.kind === "undetermined" && hold.maybeLive),
		holdAt: (homeDir) => byDir.get(resolve(homeDir)),
	};
}
