/**
 * The owner's messages to a bot whose session another process hosts: `bots/<id>/inbox/`, one file per message. The sending
 * process writes it; the process holding the bot's lock (`host.lock`) gives each to the bot's session as the owner's words,
 * oldest first, and deletes it once the session accepted it. A message the session refuses is kept beside the queue as a
 * refused record with its reason (the newest few), so every session's chat with the bot shows what happened to it.
 *
 * Files: `<at>-<id>.json` waiting, `<at>-<id>.refused.json` refused, `<at>-<id>.stop.json` the owner's stop of the bot's
 * work, `<name>.unreadable` a file that did not read as a record, set aside so it neither blocks the queue nor is lost.
 *
 * Suffix rule: every kind has its own suffix after `<at>-<id>` and its own reader, and a reader lists only its suffix, so a
 * kind a build does not know is never read as another (a build that knows no stop record leaves it where it is). A stop
 * record is no message: the queue's caps do not count it, the bot's chat does not show it, and it never opens a bot. Only
 * the newest is kept, since one stop ends all the work there is: the process holding `host.lock` takes it and stops the
 * bot's foreground turn and its whole worker fleet. Every write is an atomic replace, so a reader never sees a
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
import { BotOwnerError } from "./bot-owner-error.ts";

/** Most messages waiting at once: a host that does not take them is not given an unbounded queue. */
export const MAX_BOT_INBOX_MESSAGES = 32;
/** Most bytes of the waiting messages together. */
export const MAX_BOT_INBOX_BYTES = 1024 * 1024;
/** Refused records kept, the newest: what the chat shows of messages that did not reach the bot. */
const MAX_REFUSED_KEPT = 8;

const WAITING = /^\d{15}-[0-9a-f-]{36}\.json$/;
const REFUSED = /^\d{15}-[0-9a-f-]{36}\.refused\.json$/;
const STOP = /^\d{15}-[0-9a-f-]{36}\.stop\.json$/;

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

/** The owner's stop of a bot's work, written for the process that hosts the bot's session. */
export interface BotInboxStop {
	readonly version: 1;
	readonly id: string;
	readonly agentId: string;
	/** The reason the bot's cancelled work ends with (`OWNER_STOPPED_REASON`). */
	readonly reasonCode: string;
	readonly at: number;
	readonly from: BotInboxSender;
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

function parseStop(value: unknown, agentId: string): BotInboxStop | undefined {
	if (
		!isPlainRecord(value) ||
		value.version !== 1 ||
		typeof value.id !== "string" ||
		value.agentId !== agentId ||
		typeof value.reasonCode !== "string" ||
		typeof value.at !== "number"
	)
		return undefined;
	const from = parseSender(value.from);
	if (!from) return undefined;
	return { version: 1, id: value.id, agentId, reasonCode: value.reasonCode, at: value.at, from };
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

/** The stops waiting for the process that hosts the bot's session, oldest first (one, unless two writers raced). */
export function readBotInboxStops(
	agentDir: string,
	agentId: string,
	unreadable: (file: string, reason: string) => void,
): BotHomeRecord<BotInboxStop>[] {
	return readHomeRecords(botInboxDir(agentDir, agentId), STOP, (value) => parseStop(value, agentId), unreadable);
}

/** Whether a stop waits for the process that hosts the bot's session; read from the names alone. */
export function botInboxStopWaiting(agentDir: string, agentId: string): boolean {
	return botInboxStopNames(agentDir, agentId).length > 0;
}

/** The file names of the stops waiting, oldest first: which stops wait, read from the names alone. */
export function botInboxStopNames(agentDir: string, agentId: string): readonly string[] {
	return homeRecordNames(botInboxDir(agentDir, agentId), STOP);
}

/**
 * Writes the owner's stop of the bot's work for the process that hosts its session (one that holds `host.lock` while the
 * sender does not), and drops the older stops: the newest says all of them.
 */
export function requestBotStop(
	agentDir: string,
	input: { agentId: string; reasonCode: string; from: BotInboxSender; at: number },
): BotHomeRecord<BotInboxStop> {
	const dir = botInboxDir(agentDir, input.agentId);
	const stop: BotInboxStop = {
		version: 1,
		id: randomUUID(),
		agentId: input.agentId,
		reasonCode: input.reasonCode,
		at: input.at,
		from: input.from,
	};
	const file = join(dir, `${String(input.at).padStart(15, "0")}-${stop.id}.stop.json`);
	writeFileAtomicSync(file, `${JSON.stringify(stop)}\n`, { mode: 0o600 });
	keepNewestHomeRecords(dir, STOP, 1);
	return { file, message: stop };
}

/** The host stopped the bot's work for the stop: it leaves the inbox. */
export function takeBotInboxStop(item: BotHomeRecord<BotInboxStop>): void {
	rmSync(item.file, { force: true });
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
		throw new BotOwnerError(interfaceText().botTeam.botInboxFull(input.agentId, MAX_BOT_INBOX_MESSAGES));
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
