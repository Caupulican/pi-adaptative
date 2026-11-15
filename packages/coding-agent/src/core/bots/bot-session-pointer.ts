/**
 * `bots/<id>/session.json`, `{ version: 1, sessionId, file }`: which of its session files a bot keeps its conversation
 * in, by the session's id and the file's name in the home's `sessions/`. Its host writes it, write-then-rename, the
 * first time it loads the bot (from the newest session file the home has, before the session is built, or from the
 * session it creates when the home has none); after that the choice is the pointer's, never a file's modification time.
 * {@link botSessionChoice} is the one reader, for the host's load and for every view of the bot's conversation alike.
 */
import { readFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { readSessionHeaderResult } from "../../kernel/session/session-header.ts";
import { isValidSessionId } from "../../kernel/session/session-identity.ts";
import { findMostRecentSessionInDirs } from "../../kernel/session/session-listing.ts";
import { isMissingFileError, writeFileAtomicSync } from "../util/atomic-file.ts";
import type { BotHome } from "./bot-home.ts";

/** The bot's session: its id and the name of its file in the home's `sessions/`. */
export interface BotSessionPointer {
	readonly sessionId: string;
	readonly file: string;
}

/**
 * Which session the bot keeps its conversation in. `recorded`: the pointer's (its file may not exist yet: a session
 * that wrote nothing yet, or whose file was lost, is started under the recorded id). `chosen`: the home has no pointer
 * that reads, so the first-load rule picks its newest session file, if it has any (`unreadable` says why a pointer that
 * is there does not count).
 */
export type BotSessionChoice =
	| { readonly kind: "recorded"; readonly pointer: BotSessionPointer; readonly path: string }
	| { readonly kind: "chosen"; readonly newest: string | undefined; readonly unreadable?: string };

function parsePointer(value: unknown): BotSessionPointer | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { version, sessionId, file } = value as Record<string, unknown>;
	if (version !== 1 || typeof sessionId !== "string" || !isValidSessionId(sessionId)) return undefined;
	if (typeof file !== "string" || basename(file) !== file || !file.endsWith(".jsonl")) return undefined;
	return { sessionId, file };
}

/**
 * The bot's session as its home records it. A pointer that does not parse, or whose file holds another session, does
 * not count; a pointer that cannot be read for any reason but its absence is thrown, since what it records is unknown.
 */
export function botSessionChoice(home: BotHome): BotSessionChoice {
	const chosen = (unreadable?: string): BotSessionChoice => ({
		kind: "chosen",
		newest: findMostRecentSessionInDirs([home.sessionsDir]) ?? undefined,
		...(unreadable === undefined ? {} : { unreadable }),
	});
	let text: string;
	try {
		text = readFileSync(home.pointerFile, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) return chosen();
		throw error;
	}
	let pointer: BotSessionPointer | undefined;
	try {
		pointer = parsePointer(JSON.parse(text));
	} catch (error) {
		return chosen(error instanceof Error ? error.message : String(error));
	}
	if (!pointer) return chosen("not a session pointer");
	const path = join(home.sessionsDir, pointer.file);
	const header = readSessionHeaderResult(path);
	if (header.ok && header.header.id !== pointer.sessionId)
		return chosen(`its file ${pointer.file} holds session ${header.header.id}, not ${pointer.sessionId}`);
	return { kind: "recorded", pointer, path };
}

/** Records `pointer` as the bot's session, replacing the file whole. */
export function writeBotSessionPointer(home: BotHome, pointer: BotSessionPointer): void {
	const text = `${JSON.stringify({ version: 1, sessionId: pointer.sessionId, file: pointer.file })}\n`;
	writeFileAtomicSync(home.pointerFile, text, { mode: 0o600 });
}

/**
 * The host's reading, under the bot's `host.lock`: the recorded session, or the one the first-load rule chooses,
 * recorded now, before anything is built from it; undefined when the home has no session file, so the host creates one
 * and records it ({@link writeBotSessionPointer}). A pointer that does not count is set aside (`session.json.unreadable`)
 * and told through `setAside`, once: the next load finds the pointer this one writes.
 */
export function settleBotSessionPointer(
	home: BotHome,
	setAside: (file: string, reason: string) => void,
): BotSessionPointer | undefined {
	const choice = botSessionChoice(home);
	if (choice.kind === "recorded") return choice.pointer;
	if (choice.unreadable !== undefined) {
		const file = `${home.pointerFile}.unreadable`;
		renameSync(home.pointerFile, file);
		setAside(file, choice.unreadable);
	}
	if (choice.newest === undefined) return undefined;
	const header = readSessionHeaderResult(choice.newest);
	if (!header.ok) throw new Error(`Session file ${choice.newest} no longer reads as a session (${header.reason}).`);
	const pointer = { sessionId: header.header.id, file: basename(choice.newest) };
	writeBotSessionPointer(home, pointer);
	return pointer;
}
