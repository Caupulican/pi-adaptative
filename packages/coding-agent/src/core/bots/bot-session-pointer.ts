/**
 * `bots/<id>/session.json`, `{ version: 1, sessionId, file }`: which of its session files a bot keeps its conversation
 * in, by the session's id and the file's name in the home's `sessions/`. Its host writes it, write-then-rename, the
 * first time it loads the bot (from the newest session file the home has, before the session is built, or from the
 * session it creates when the home has none); after that the choice is the pointer's, never a file's modification time.
 * {@link botSessionChoice} is the one reader, for the host's load and for every view of the bot's conversation alike.
 */
import { existsSync, lstatSync, readlinkSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { sessionBundleDeletionPolicy } from "../../kernel/session/session-bundle-lifecycle.ts";
import { readSessionHeaderResult } from "../../kernel/session/session-header.ts";
import { isValidSessionId } from "../../kernel/session/session-identity.ts";
import { newestSessionFileIn, SessionFileLinkError } from "../../kernel/session/session-listing.ts";
import { BoundedReadError, readOptionalBoundedTextFileSync } from "../../kernel/storage/bounded-file.ts";
import { resolveSessionHome } from "../orchestration-homes.ts";
import { isMissingFileError, writeFileAtomicSync } from "../util/atomic-file.ts";
import type { BotHome } from "./bot-home.ts";
import { BotOwnerError } from "./bot-owner-error.ts";

/** The most a pointer file holds: a version, a session id and a file name, with room to spare. */
const MAX_POINTER_BYTES = 4096;

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
 * The bot's session pointer, or a session file its load reads, is a symbolic link (`path`). A session's write and the
 * pointer's replace their file whole, which would replace the link with a regular file, so neither is followed through a
 * link: the load stops with this, in the owner's words, until the link is replaced by the file. Nothing is set aside
 * and no session is started for it.
 */
export class BotSessionLinkError extends BotOwnerError {
	readonly path: string;
	constructor(path: string, options?: ErrorOptions) {
		super((text) => text.botTeam.botSessionFileLinked(path), options);
		this.name = "BotSessionLinkError";
		this.path = path;
	}
}

/**
 * How a read of the bot's home meets a pointer or session file that is a symbolic link: a read for a session's writer
 * refuses it ({@link BotSessionLinkError}); a read that only reads (a release) reads the file the link names.
 */
export type BotSessionLinks = "refuse" | "follow";

/** The path a read of `path` reads: `path` itself, or for a symbolic link the path it names (see {@link BotSessionLinks}). */
export function botFileReadPath(path: string, links: BotSessionLinks): string {
	if (!lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return path;
	if (links === "refuse") throw new BotSessionLinkError(path);
	return resolve(dirname(path), readlinkSync(path));
}

/** Throws {@link BotSessionLinkError} when `path` is a symbolic link. */
export function refuseLink(path: string): void {
	botFileReadPath(path, "refuse");
}

/**
 * Why the file a pointer names does not hold its session, or undefined when it does, is missing or is empty (the
 * session is started there). Only its content decides (a directory, a FIFO or a device holds no session); a symbolic
 * link is thrown ({@link BotSessionLinkError}), as is a failure to read it, so the load is asked again (after a backoff
 * when it passes on its own: `storeFailure`).
 */
function pointedFileFault(
	path: string,
	pointer: BotSessionPointer,
	links: BotSessionLinks,
	readHeader: typeof readSessionHeaderResult,
): BotPointerSetAsideReason | undefined {
	const header = readHeader(botFileReadPath(path, links));
	if (header.ok)
		return header.header.id === pointer.sessionId
			? undefined
			: { kind: "other-session", file: pointer.file, holds: header.header.id, sessionId: pointer.sessionId };
	if (header.reason === "unreadable") {
		if (isMissingFileError(header.cause)) return undefined;
		// A directory, a FIFO or a device where the session's file belongs holds no session: content, set aside.
		if (header.cause instanceof BoundedReadError && header.cause.reason === "not_regular")
			return { kind: "not-a-session", file: pointer.file };
		throw header.cause;
	}
	return header.reason === "not_a_header" && statSync(path).size === 0
		? undefined
		: { kind: "not-a-session", file: pointer.file };
}

/**
 * The bot's session as its home records it. A pointer counts when it parses, its file holds its session (or is missing
 * or empty) and that session was not deleted; only those contents set it aside. A pointer or session file that is a
 * symbolic link is refused or read through, as `links` says ({@link BotSessionLinks}); any other failure to read the
 * pointer, its file, a tombstone or the home's session files is thrown to the reader: the home is not judged on what it
 * could not read.
 */
export function botSessionChoice(
	agentDir: string,
	home: BotHome,
	links: BotSessionLinks,
	readHeader = readSessionHeaderResult,
): BotSessionChoice {
	const chosen = (setAside?: BotPointerSetAsideReason): BotSessionChoice => {
		let newest: ReturnType<typeof newestSessionFileIn>;
		try {
			newest = newestSessionFileIn(home.sessionsDir, (id) => deleted(agentDir, home, id), links);
		} catch (error) {
			if (error instanceof SessionFileLinkError) throw new BotSessionLinkError(error.path, { cause: error });
			throw error;
		}
		return {
			kind: "chosen",
			newest: newest && { path: newest.path, sessionId: newest.header.id },
			...(setAside === undefined ? {} : { setAside }),
		};
	};
	let text: string | undefined;
	try {
		text = readOptionalBoundedTextFileSync(
			botFileReadPath(home.pointerFile, links),
			MAX_POINTER_BYTES,
			"Bot session pointer",
		);
	} catch (error) {
		// A pointer that is not a regular file (a directory, a FIFO), or larger than any pointer, is content that does not count.
		if (!(error instanceof BoundedReadError) || error.reason === "deadline") throw error;
		return chosen({ kind: "not-a-pointer" });
	}
	if (text === undefined) return chosen();
	const pointer = parsePointer(text);
	if (!pointer) return chosen({ kind: "not-a-pointer" });
	const path = join(home.sessionsDir, pointer.file);
	const fault = pointedFileFault(path, pointer, links, readHeader);
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
	const choice = botSessionChoice(agentDir, home, "refuse");
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
