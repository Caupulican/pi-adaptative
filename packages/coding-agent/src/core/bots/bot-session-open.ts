/**
 * Opens a bot's session from its home: the session its pointer records (`bot-session-pointer.ts`), with its
 * orchestration state moved into the bot's home first when an earlier build kept it in the owner's
 * (`bot-bundle-move.ts`), in the storage roots that hold it (`botSessionStorageRoots`); or a new session in the
 * bot's roots, recorded by the pointer, when the home has none. The host opens it under the bot's `host.lock`
 * ({@link openHostedBotSession}); a session opened from another process on a bot's `sessions/` directory continues the
 * same session and moves and records nothing ({@link continueBotSession}).
 */
import { basename, join } from "node:path";
import { warmHostIdentity } from "../../kernel/reliability/host-identity.ts";
import { SessionManager } from "../../kernel/session/session-manager.ts";
import { botSessionStorageRoots, sessionStorageRootsOfFile } from "../orchestration-homes.ts";
import { type BotBundleMove, moveBotSessionBundle } from "./bot-bundle-move.ts";
import type { BotHome } from "./bot-home.ts";
import {
	type BotPointerSetAsideReason,
	type BotSessionPointer,
	botSessionChoice,
	settleBotSessionPointer,
	writeBotSessionPointer,
} from "./bot-session-pointer.ts";

/** What the host tells the owner about its bot's home while it opens the session. */
export interface BotSessionOpenNotices {
	/** The pointer did not count and was set aside as `file`. */
	pointerSetAside(file: string, reason: BotPointerSetAsideReason): void;
	/** The session's state was not moved out of the owner's home (`BotBundleMove` `kept` says which home it uses). */
	notMoved(kept: Extract<BotBundleMove, { kind: "kept" }>): void;
}

/** The session the pointer records, in the roots that hold it; a missing or empty file starts it under its id. */
function openRecorded(
	agentDir: string,
	home: BotHome,
	pointer: BotSessionPointer,
	path: string,
	cwd: string,
): SessionManager {
	const roots = botSessionStorageRoots(agentDir, home.orchestrationHome, pointer.sessionId);
	return SessionManager.openOrStart(path, roots, pointer.sessionId, home.sessionsDir, cwd);
}

/** A new session in the bot's own roots. */
function createInHome(agentDir: string, home: BotHome, cwd: string): SessionManager {
	return SessionManager.create(cwd, { agentDir, orchestrationHome: home.orchestrationHome }, home.sessionsDir);
}

/**
 * The host's open of its bot's session, under the bot's `host.lock`: the pointer is settled (recorded before anything
 * is built), the session's state is moved into the bot's home, and the session is opened; `continued` is whether the
 * home already had it. A move that must judge a holder by its machine (`placing`) waits for this process's machine id
 * and moves again.
 */
export async function openHostedBotSession(
	agentDir: string,
	home: BotHome,
	cwd: string,
	notices: BotSessionOpenNotices,
): Promise<{ sessionManager: SessionManager; continued: boolean }> {
	const pointer = settleBotSessionPointer(agentDir, home, (file, reason) => notices.pointerSetAside(file, reason));
	if (!pointer) {
		const sessionManager = createInHome(agentDir, home, cwd);
		const file = sessionManager.getSessionFile();
		if (file === undefined) throw new Error(`The new session of bot home ${home.dir} has no file.`);
		writeBotSessionPointer(home, { sessionId: sessionManager.getSessionId(), file: basename(file) });
		return { sessionManager, continued: false };
	}
	let move = moveBotSessionBundle(agentDir, home.orchestrationHome, pointer.sessionId);
	// Once the read finished no holder waits for it, so the second move decides.
	while (move.kind === "placing") {
		await warmHostIdentity();
		move = moveBotSessionBundle(agentDir, home.orchestrationHome, pointer.sessionId);
	}
	if (move.kind === "kept") notices.notMoved(move);
	const sessionManager = openRecorded(agentDir, home, pointer, join(home.sessionsDir, pointer.file), cwd);
	return { sessionManager, continued: true };
}

/**
 * Continues the bot's session from another process (a session opened on the bot's `sessions/` directory): the one its
 * pointer records, else the one the host's first load would choose, else a new one in the bot's roots. Reads only: the
 * pointer, the move and a pointer that does not count are its host's.
 */
export function continueBotSession(agentDir: string, home: BotHome, cwd: string): SessionManager {
	const choice = botSessionChoice(agentDir, home);
	if (choice.kind === "recorded") return openRecorded(agentDir, home, choice.pointer, choice.path, cwd);
	if (choice.newest === undefined) return createInHome(agentDir, home, cwd);
	const { path } = choice.newest;
	return SessionManager.open(path, sessionStorageRootsOfFile(agentDir, path), home.sessionsDir, cwd);
}
