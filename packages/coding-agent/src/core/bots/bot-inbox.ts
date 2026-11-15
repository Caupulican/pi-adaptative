/**
 * The owner's messages to a bot whose session another process hosts: `bots/<id>/inbox/`, one file per message. The sending
 * process writes it; the process holding the bot's lock (`host.lock`) gives each to the bot's session as the owner's words,
 * oldest first, and deletes it once the session accepted it. A message the session refuses is kept beside the queue as a
 * refused record with its reason (the newest few), so every session's chat with the bot shows what happened to it.
 *
 * Files: `<at>-<id>.json` waiting, `<at>-<id>.refused.json` refused, `<at>-<id>.stop.json` the owner's stop of the bot's
 * work, `<at>-<id>.scoped.stop.json` a stop recorded after it was made (the process that made it could not record it then),
 * which ends only the work there was when it was made, `<name>.unreadable` a file that did not read as a record, set aside
 * so it neither blocks the queue nor is lost.
 *
 * Suffix rule: every kind has its own suffix after `<at>-<id>` and its own reader, and a reader lists only its suffix, so a
 * kind a build does not know is never read as another (a build that knows no stop record leaves it where it is). A stop
 * record is no message: the queue's caps do not count it, the bot's chat does not show it, and it never opens a bot. Only
 * the newest whole stop is kept, since one ends all the work there is: the process holding `host.lock` takes it and stops
 * the bot's foreground turn and its whole worker fleet. A scoped stop has a suffix of its own, so a build that knows only
 * the whole stop never lists, takes or counts it; every scoped stop is kept until a take, each naming the work it ends.
 * Every write is an atomic replace, so a reader never sees a partial message. Delivery is at least once: a host killed after its session accepted a message and before it deleted the
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
import { type FleetStopScope, WHOLE_FLEET_STOP_SCOPE } from "../delegation/worker-fleet-stop.ts";
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
const SCOPED_STOP = /^\d{15}-[0-9a-f-]{36}\.scoped\.stop\.json$/;
/** Either kind of stop. */
const ANY_STOP = /^\d{15}-[0-9a-f-]{36}\.(?:scoped\.)?stop\.json$/;

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
	/**
	 * What it ends: everything of the bot's when it is taken (`whole`, a `.stop.json`), or, recorded after it was made, only
	 * the work there was then (`scoped`, a `.scoped.stop.json`).
	 */
	readonly scope: FleetStopScope;
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

function parseStop(value: unknown, agentId: string, scoped: boolean): BotInboxStop | undefined {
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
	const scope = scoped ? parseScope(value.scope) : WHOLE_FLEET_STOP_SCOPE;
	if (!from || !scope) return undefined;
	return { version: 1, id: value.id, agentId, reasonCode: value.reasonCode, at: value.at, from, scope };
}

const isIdList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

/** A scoped stop's `scope`: the attempt and plan ids it ends. */
function parseScope(value: unknown): FleetStopScope | undefined {
	if (!isPlainRecord(value) || !isIdList(value.attempts) || !isIdList(value.plans)) return undefined;
	return { kind: "scoped", attempts: value.attempts, plans: value.plans };
}

/** The messages waiting for the bot's session, oldest first. */
export function readBotInbox(
	agentDir: string,
	agentId: string,
	unreadable: (file: string, reason: string, setAside: boolean) => void,
): BotInboxItem[] {
	return readHomeRecords(botInboxDir(agentDir, agentId), WAITING, (value) => parseMessage(value, agentId), unreadable);
}

/** The messages the bot's session refused, oldest first (the newest {@link MAX_REFUSED_KEPT}). */
export function readBotInboxRefusals(
	agentDir: string,
	agentId: string,
	unreadable: (file: string, reason: string, setAside: boolean) => void,
): BotInboxItem<BotInboxRefusal>[] {
	return readHomeRecords(botInboxDir(agentDir, agentId), REFUSED, (value) => parseRefusal(value, agentId), unreadable);
}

/** Whether a message waits for the bot's session; read from the names alone. */
export function botInboxWaiting(agentDir: string, agentId: string): boolean {
	return homeRecordNames(botInboxDir(agentDir, agentId), WAITING).length > 0;
}

/**
 * The stops waiting for the process that hosts the bot's session, oldest first: the newest whole stop (another, if two
 * writers raced) and every scoped stop.
 */
export function readBotInboxStops(
	agentDir: string,
	agentId: string,
	unreadable: (file: string, reason: string, setAside: boolean) => void,
): BotHomeRecord<BotInboxStop>[] {
	const dir = botInboxDir(agentDir, agentId);
	return [
		...readHomeRecords(dir, STOP, (value) => parseStop(value, agentId, false), unreadable),
		...readHomeRecords(dir, SCOPED_STOP, (value) => parseStop(value, agentId, true), unreadable),
	].sort((a, b) => a.message.at - b.message.at);
}

/** Whether a stop waits for the process that hosts the bot's session; read from the names alone. */
export function botInboxStopWaiting(agentDir: string, agentId: string): boolean {
	return botInboxStopNames(agentDir, agentId).length > 0;
}

/** The file names of the stops waiting (both kinds), oldest first: which stops wait, read from the names alone. */
export function botInboxStopNames(agentDir: string, agentId: string): readonly string[] {
	return homeRecordNames(botInboxDir(agentDir, agentId), ANY_STOP);
}

/**
 * Writes the owner's stop of the bot's work for the process that hosts its session (one that holds `host.lock` while the
 * sender does not). A whole stop drops the older whole stops: the newest says all of them. Once written the stop is
 * recorded, whatever becomes of the older ones: a drop that failed is handed back (`olderLeft`), the older stops then
 * taken with it. A scoped stop drops none: it names only the work there was when it was made, and a whole stop is never
 * replaced by it.
 */
export function requestBotStop(
	agentDir: string,
	input: { agentId: string; reasonCode: string; from: BotInboxSender; at: number; scope: FleetStopScope },
): { readonly record: BotHomeRecord<BotInboxStop>; readonly olderLeft?: unknown } {
	const dir = botInboxDir(agentDir, input.agentId);
	const id = randomUUID();
	const head = {
		version: 1,
		id,
		agentId: input.agentId,
		reasonCode: input.reasonCode,
		at: input.at,
		from: input.from,
	};
	const { scope } = input;
	const name = `${String(input.at).padStart(15, "0")}-${id}${scope.kind === "whole" ? "" : ".scoped"}.stop.json`;
	const file = join(dir, name);
	// A whole stop is written as every build reads it; a scoped one carries the ids of the work it ends.
	const body = scope.kind === "whole" ? head : { ...head, scope: { attempts: scope.attempts, plans: scope.plans } };
	writeFileAtomicSync(file, `${JSON.stringify(body)}\n`, { mode: 0o600 });
	const record = { file, message: { ...head, version: 1 as const, scope } };
	if (scope.kind !== "whole") return { record };
	try {
		keepNewestHomeRecords(dir, STOP, 1);
	} catch (error) {
		return { record, olderLeft: error };
	}
	return { record };
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
