/**
 * The owner's messages to a bot whose session another process hosts: `bots/<id>/inbox/`, one file per message. The sending
 * process writes it; the process holding the bot's lock (`host.lock`) gives each to the bot's session as the owner's words,
 * oldest first, and deletes it once the session accepted it. A message the session refuses is kept beside the queue as a
 * refused record with its reason (the newest few), so every session's chat with the bot shows what happened to it.
 *
 * Files: `<at>-<id>.json` waiting, `<at>-<id>.refused.json` refused, `<name>.unreadable` a file that did not read as a
 * message, set aside so it neither blocks the queue nor is lost. Every write is an atomic replace, so a reader never sees a
 * partial message. Delivery is at least once: a host killed after its session accepted a message and before it deleted the
 * file gives it again at the next open.
 *
 * The directory is private harness storage like the session files beside it: a worker's and a bot session's file and
 * process tools are refused the bot homes.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { isPlainRecord } from "../../kernel/utils/value-guards.ts";
import { botInboxDir } from "../agent-paths.ts";
import { interfaceText } from "../language/interface-text.ts";
import { writeFileAtomicSync } from "../util/atomic-file.ts";

/** Most messages waiting at once: a host that does not take them is not given an unbounded queue. */
export const MAX_BOT_INBOX_MESSAGES = 32;
/** Most bytes of the waiting messages together. */
export const MAX_BOT_INBOX_BYTES = 1024 * 1024;
/** Refused records kept, the newest: what the chat shows of messages that did not reach the bot. */
const MAX_REFUSED_KEPT = 8;

const WAITING = /^\d{15}-[0-9a-f-]{36}\.json$/;
const REFUSED = /^\d{15}-[0-9a-f-]{36}\.refused\.json$/;

/** How the owner asked the words to reach a running turn (`BotOperatorMessageOptions.mode`). */
export type BotInboxMode = "follow_up" | "queue" | "start";

/** The process and session that sent a message, and the directory it works in. */
export interface BotInboxSender {
	readonly pid: number;
	readonly sessionId?: string;
	readonly cwd: string;
}

export interface BotInboxMessage {
	readonly version: 1;
	readonly id: string;
	readonly agentId: string;
	readonly text: string;
	readonly mode?: BotInboxMode;
	readonly at: number;
	readonly from: BotInboxSender;
}

export interface BotInboxRefusal extends BotInboxMessage {
	readonly refusedAt: number;
	readonly reason: string;
}

/** A message as the inbox holds it: the file it is in and what it says. */
export interface BotInboxItem<T extends BotInboxMessage = BotInboxMessage> {
	readonly file: string;
	readonly message: T;
}

function parseSender(value: unknown): BotInboxSender | undefined {
	if (!isPlainRecord(value) || !Number.isInteger(value.pid) || typeof value.cwd !== "string") return undefined;
	if (value.sessionId !== undefined && typeof value.sessionId !== "string") return undefined;
	return {
		pid: value.pid as number,
		cwd: value.cwd,
		...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
	};
}

function parseMessage(value: unknown, agentId: string): BotInboxMessage | undefined {
	if (
		!isPlainRecord(value) ||
		value.version !== 1 ||
		typeof value.id !== "string" ||
		value.agentId !== agentId ||
		typeof value.text !== "string" ||
		typeof value.at !== "number" ||
		(value.mode !== undefined && value.mode !== "follow_up" && value.mode !== "queue" && value.mode !== "start")
	)
		return undefined;
	const from = parseSender(value.from);
	if (!from) return undefined;
	return {
		version: 1,
		id: value.id,
		agentId,
		text: value.text,
		at: value.at,
		from,
		...(value.mode !== undefined ? { mode: value.mode as BotInboxMode } : {}),
	};
}

function parseRefusal(value: unknown, agentId: string): BotInboxRefusal | undefined {
	const message = parseMessage(value, agentId);
	if (!message || !isPlainRecord(value) || typeof value.refusedAt !== "number" || typeof value.reason !== "string")
		return undefined;
	return { ...message, refusedAt: value.refusedAt, reason: value.reason };
}

function names(dir: string, pattern: RegExp): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => pattern.test(name))
		.sort();
}

/**
 * Reads the files `pattern` names, oldest first. A file that does not read as a message is set aside (renamed
 * `.unreadable`) and reported through `unreadable`: it would otherwise hold the queue, or be counted, forever.
 */
function readItems<T extends BotInboxMessage>(
	agentDir: string,
	agentId: string,
	pattern: RegExp,
	parse: (value: unknown, agentId: string) => T | undefined,
	unreadable: (file: string, reason: string) => void,
): BotInboxItem<T>[] {
	const dir = botInboxDir(agentDir, agentId);
	const items: BotInboxItem<T>[] = [];
	for (const name of names(dir, pattern)) {
		const file = join(dir, name);
		let message: T | undefined;
		let reason = "not a message";
		try {
			message = parse(JSON.parse(readFileSync(file, "utf8")), agentId);
		} catch (error) {
			// Taken (deleted) by its host while it was listed: it is gone, not unreadable.
			if (!existsSync(file)) continue;
			reason = error instanceof Error ? error.message : String(error);
		}
		if (message) {
			items.push({ file, message });
			continue;
		}
		try {
			renameSync(file, `${file}.unreadable`);
		} catch {
			if (!existsSync(file)) continue;
		}
		unreadable(file, reason);
	}
	return items;
}

/** The messages waiting for the bot's session, oldest first. */
export function readBotInbox(
	agentDir: string,
	agentId: string,
	unreadable: (file: string, reason: string) => void,
): BotInboxItem[] {
	return readItems(agentDir, agentId, WAITING, parseMessage, unreadable);
}

/** The messages the bot's session refused, oldest first (the newest {@link MAX_REFUSED_KEPT}). */
export function readBotInboxRefusals(
	agentDir: string,
	agentId: string,
	unreadable: (file: string, reason: string) => void,
): BotInboxItem<BotInboxRefusal>[] {
	return readItems(agentDir, agentId, REFUSED, parseRefusal, unreadable);
}

/** Whether a message waits for the bot's session; read from the names alone. */
export function botInboxWaiting(agentDir: string, agentId: string): boolean {
	return names(botInboxDir(agentDir, agentId), WAITING).length > 0;
}

/**
 * Writes the owner's message for the process hosting the bot's session. Refused in the owner's words when the queue is
 * full (by count or by bytes).
 */
export function enqueueBotInbox(
	agentDir: string,
	input: { agentId: string; text: string; mode?: BotInboxMode; from: BotInboxSender; at: number },
): BotInboxItem {
	const dir = botInboxDir(agentDir, input.agentId);
	const waiting = names(dir, WAITING).map((name) => join(dir, name));
	const message: BotInboxMessage = {
		version: 1,
		id: randomUUID(),
		agentId: input.agentId,
		text: input.text,
		at: input.at,
		from: input.from,
		...(input.mode !== undefined ? { mode: input.mode } : {}),
	};
	const text = `${JSON.stringify(message)}\n`;
	const bytes = waiting.reduce((sum, file) => sum + (statSync(file, { throwIfNoEntry: false })?.size ?? 0), 0);
	if (waiting.length >= MAX_BOT_INBOX_MESSAGES || bytes + Buffer.byteLength(text) > MAX_BOT_INBOX_BYTES)
		throw new Error(interfaceText().botTeam.botInboxFull(input.agentId, MAX_BOT_INBOX_MESSAGES));
	const file = join(dir, `${String(input.at).padStart(15, "0")}-${message.id}.json`);
	writeFileAtomicSync(file, text, { mode: 0o600 });
	return { file, message };
}

/** The bot's session accepted the message: it leaves the queue. */
export function takeBotInboxMessage(item: BotInboxItem): void {
	rmSync(item.file, { force: true });
}

/** The bot's session refused the message: it leaves the queue as a refused record with `reason`, and old records go. */
export function refuseBotInboxMessage(agentDir: string, item: BotInboxItem, reason: string, refusedAt: number): void {
	const refusal: BotInboxRefusal = { ...item.message, refusedAt, reason };
	writeFileAtomicSync(item.file.replace(/\.json$/, ".refused.json"), `${JSON.stringify(refusal)}\n`, { mode: 0o600 });
	rmSync(item.file, { force: true });
	const dir = botInboxDir(agentDir, item.message.agentId);
	const refused = names(dir, REFUSED);
	for (const name of refused.slice(0, Math.max(0, refused.length - MAX_REFUSED_KEPT)))
		rmSync(join(dir, name), { force: true });
}
