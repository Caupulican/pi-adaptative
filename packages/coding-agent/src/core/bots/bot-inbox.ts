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
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { isPlainRecord } from "../../kernel/utils/value-guards.ts";
import { botInboxDir } from "../agent-paths.ts";
import { interfaceText } from "../language/interface-text.ts";
import { writeFileAtomicSync } from "../util/atomic-file.ts";
import {
	type BotHomeRecord,
	homeRecordNames,
	keepNewestHomeRecords,
	parseHomeRecordHead,
	readHomeRecords,
} from "./bot-home-records.ts";

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
export type BotInboxItem<T extends BotInboxMessage = BotInboxMessage> = BotHomeRecord<T>;

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
	const parsed = parseHomeRecordHead(value, agentId);
	if (!parsed) return undefined;
	const { mode } = parsed.record;
	if (mode !== undefined && mode !== "follow_up" && mode !== "queue" && mode !== "start") return undefined;
	const from = parseSender(parsed.record.from);
	if (!from) return undefined;
	return { ...parsed.head, from, ...(mode !== undefined ? { mode: mode as BotInboxMode } : {}) };
}

function parseRefusal(value: unknown, agentId: string): BotInboxRefusal | undefined {
	const message = parseMessage(value, agentId);
	if (!message || !isPlainRecord(value) || typeof value.refusedAt !== "number" || typeof value.reason !== "string")
		return undefined;
	return { ...message, refusedAt: value.refusedAt, reason: value.reason };
}

/** The messages waiting for the bot's session, oldest first. */
export function readBotInbox(
	agentDir: string,
	agentId: string,
	unreadable: (file: string, reason: string) => void,
): BotInboxItem[] {
	return readHomeRecords(botInboxDir(agentDir, agentId), WAITING, (value) => parseMessage(value, agentId), unreadable);
}

/** The messages the bot's session refused, oldest first (the newest {@link MAX_REFUSED_KEPT}). */
export function readBotInboxRefusals(
	agentDir: string,
	agentId: string,
	unreadable: (file: string, reason: string) => void,
): BotInboxItem<BotInboxRefusal>[] {
	return readHomeRecords(botInboxDir(agentDir, agentId), REFUSED, (value) => parseRefusal(value, agentId), unreadable);
}

/** Whether a message waits for the bot's session; read from the names alone. */
export function botInboxWaiting(agentDir: string, agentId: string): boolean {
	return homeRecordNames(botInboxDir(agentDir, agentId), WAITING).length > 0;
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
	const waiting = homeRecordNames(dir, WAITING).map((name) => join(dir, name));
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
	keepNewestHomeRecords(botInboxDir(agentDir, item.message.agentId), REFUSED, MAX_REFUSED_KEPT);
}
