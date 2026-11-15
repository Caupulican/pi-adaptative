/**
 * `bots/<id>/session.json`, `{ version: 1, sessionId, file }`: which of its session files a bot keeps its conversation
 * in, by the session's id and the file's name in the home's `sessions/`. Its host writes it, write-then-rename, the
 * first time it loads the bot (from the newest session file the home has, before the session is built, or from the
 * session it creates when the home has none); after that the choice is the pointer's, never a file's modification time.
 * {@link botSessionChoice} is the one reader, for the host's load and for every view of the bot's conversation alike.
 */
import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { sessionBundleDeletionPolicy } from "../../kernel/session/session-bundle-lifecycle.ts";
import { readSessionHeaderResult } from "../../kernel/session/session-header.ts";
import { isValidSessionId } from "../../kernel/session/session-identity.ts";
import { newestSessionFileIn } from "../../kernel/session/session-listing.ts";
import { resolveSessionHome } from "../orchestration-homes.ts";
import { isMissingFileError, writeFileAtomicSync } from "../util/atomic-file.ts";
import type { BotHome } from "./bot-home.ts";

/** The bot's session: its id and the name of its file in the home's `sessions/`. */
export interface BotSessionPointer {
	readonly sessionId: string;
	readonly file: string;
}

/**
 * Why a pointer that reads does not count: it is not a session pointer (`not-a-pointer`: not JSON, or not its shape),
 * its file holds something that is not a session (`not-a-session`), or another session (`other-session`), or the
 * session it names was deleted (`deleted`: a permanent tombstone stands for it, so it is never started again).
 */
export type BotPointerSetAsideReason =
	| { readonly kind: "not-a-pointer" }
	| { readonly kind: "not-a-session"; readonly file: string }
	| { readonly kind: "other-session"; readonly file: string; readonly holds: string; readonly sessionId: string }
	| { readonly kind: "deleted"; readonly sessionId: string };

/**
 * Which session the bot keeps its conversation in. `recorded`: the pointer's (its file may not exist yet, or be empty:
 * a session that wrote nothing yet, or whose file was lost, is started under the recorded id). `chosen`: the home has
 * no pointer that counts, so the first-load rule picks its newest session file, if it has any (`setAside` says why a
 * pointer that is there does not count).
 */
export type BotSessionChoice =
	| { readonly kind: "recorded"; readonly pointer: BotSessionPointer; readonly path: string }
	| {
			readonly kind: "chosen";
			readonly newest: { readonly path: string; readonly sessionId: string } | undefined;
			readonly setAside?: BotPointerSetAsideReason;
	  };

function parsePointer(text: string): BotSessionPointer | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const { version, sessionId, file } = value as Record<string, unknown>;
	if (version !== 1 || typeof sessionId !== "string" || !isValidSessionId(sessionId)) return undefined;
	if (typeof file !== "string" || basename(file) !== file || !file.endsWith(".jsonl")) return undefined;
	return { sessionId, file };
}

/** Whether session `sessionId` of the bot was deleted: the home that holds it keeps a permanent tombstone for it. */
function deleted(agentDir: string, home: BotHome, sessionId: string): boolean {
	const holder = resolveSessionHome(agentDir, sessionId, home.orchestrationHome);
	return sessionBundleDeletionPolicy(holder, sessionId) === "permanent";
}

/**
 * Why the file a pointer names does not hold its session, or undefined when it does, is missing or is empty (the
 * session is started there). Only its content decides; a failure to read it is thrown, so the load is asked again.
 */
function pointedFileFault(path: string, pointer: BotSessionPointer): BotPointerSetAsideReason | undefined {
	const header = readSessionHeaderResult(path);
	if (header.ok)
		return header.header.id === pointer.sessionId
			? undefined
			: { kind: "other-session", file: pointer.file, holds: header.header.id, sessionId: pointer.sessionId };
	if (header.reason === "unreadable") {
		if (isMissingFileError(header.cause)) return undefined;
		throw header.cause;
	}
	return header.reason === "not_a_header" && statSync(path).size === 0
		? undefined
		: { kind: "not-a-session", file: pointer.file };
}

/**
 * The bot's session as its home records it. A pointer counts when it parses, its file holds its session (or is missing
 * or empty) and that session was not deleted; only those contents set it aside. Any other failure to read the pointer,
 * its file, a tombstone or the home's session files is thrown to the reader: the home is not judged on what it could
 * not read.
 */
export function botSessionChoice(agentDir: string, home: BotHome): BotSessionChoice {
	const chosen = (setAside?: BotPointerSetAsideReason): BotSessionChoice => {
		const newest = newestSessionFileIn(home.sessionsDir, (id) => deleted(agentDir, home, id));
		return {
			kind: "chosen",
			newest: newest && { path: newest.path, sessionId: newest.header.id },
			...(setAside === undefined ? {} : { setAside }),
		};
	};
	let text: string;
	try {
		text = readFileSync(home.pointerFile, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) return chosen();
		throw error;
	}
	const pointer = parsePointer(text);
	if (!pointer) return chosen({ kind: "not-a-pointer" });
	const path = join(home.sessionsDir, pointer.file);
	const fault = pointedFileFault(path, pointer);
	if (fault) return chosen(fault);
	if (deleted(agentDir, home, pointer.sessionId)) return chosen({ kind: "deleted", sessionId: pointer.sessionId });
	return { kind: "recorded", pointer, path };
}

/** Records `pointer` as the bot's session, replacing the file whole. */
export function writeBotSessionPointer(home: BotHome, pointer: BotSessionPointer): void {
	const text = `${JSON.stringify({ version: 1, sessionId: pointer.sessionId, file: pointer.file })}\n`;
	writeFileAtomicSync(home.pointerFile, text, { mode: 0o600 });
}

/** A name next to the pointer that no earlier set-aside took: `session.json.set-aside-<n>`. */
function setAsideName(home: BotHome): string {
	for (let n = 1; ; n++) {
		const name = `${home.pointerFile}.set-aside-${n}`;
		if (!existsSync(name)) return name;
	}
}

/**
 * The host's reading, under the bot's `host.lock` (the one writer of the pointer and its set-asides): the recorded
 * session, or the one the first-load rule chooses, recorded now, before anything is built from it; undefined when the
 * home has no session file, so the host creates one and records it ({@link writeBotSessionPointer}). A pointer that does
 * not count is set aside under a name no earlier one took and told through `setAside`, once: the next load finds the
 * pointer this one writes. A failure to read is thrown before anything is renamed or written.
 */
export function settleBotSessionPointer(
	agentDir: string,
	home: BotHome,
	setAside: (file: string, reason: BotPointerSetAsideReason) => void,
): BotSessionPointer | undefined {
	const choice = botSessionChoice(agentDir, home);
	if (choice.kind === "recorded") return choice.pointer;
	if (choice.setAside !== undefined) {
		const file = setAsideName(home);
		renameSync(home.pointerFile, file);
		setAside(file, choice.setAside);
	}
	if (choice.newest === undefined) return undefined;
	const pointer = { sessionId: choice.newest.sessionId, file: basename(choice.newest.path) };
	writeBotSessionPointer(home, pointer);
	return pointer;
}
