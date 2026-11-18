/**
 * The owner's messages to a bot whose session another process hosts: `bots/<id>/inbox/`, one file per message. The sending
 * process writes it; the process holding the bot's lock (`host.lock`) gives each to the bot's session as the owner's words,
 * oldest first, and deletes it once the session accepted it. A message the session refuses is kept beside the queue as a
 * refused record with its reason (the newest few), so every session's chat with the bot shows what happened to it.
 *
 * Files: `<at>-<id>.json` waiting, `<at>-<id>.refused.json` refused, `<at>-<id>.mail.json` and `<at>-<id>.mail.refused.json`
 * the same for words whose origin the sending host recorded (an agent's mail, a routine's prompt: `origin`), which the
 * bot's session takes under that origin and never as the owner's words, only while it is idle (a mail waits here while a
 * turn runs, never in the session's own queue, whose record keeps no origin), `<at>-<id>.mail.given.json` a mail record
 * the session took, kept until the turn that took it ends (a host killed before then leaves it to the next host, which
 * gives it again unless the transcript holds it; the session whose goal sent a mail reads whether either still holds it,
 * `botInboxHoldsMail`), `<at>-<id>.stop.json` the owner's stop of the bot's
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
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	isRecordedDeliveryOrigin,
	parseTurnOriginRecord,
	type TurnOriginRecord,
} from "../../kernel/turn-origin-stamp.ts";
import { isPlainRecord } from "../../kernel/utils/value-guards.ts";
import { botInboxDir } from "../agent-paths.ts";
import { isOwnerChannelName } from "../channels/channel-policy.ts";
import { type FleetStopScope, WHOLE_FLEET_STOP_SCOPE } from "../delegation/worker-fleet-stop.ts";
import { routineBotOccurrenceRef } from "../routines/routine-bot-reference.ts";
import { writeFileAtomicSync } from "../util/atomic-file.ts";
import {
	type BotHomeRecord,
	homeRecordNames,
	keepNewestHomeRecords,
	parseHomeRecordHead,
	readHomeRecords,
	tellUnreadableHomeRecord,
} from "./bot-home-records.ts";
import { BotOwnerError } from "./bot-owner-error.ts";

/** Most messages waiting at once: a host that does not take them is not given an unbounded queue. */
export const MAX_BOT_INBOX_MESSAGES = 32;
/** Most bytes of the waiting messages together. */
export const MAX_BOT_INBOX_BYTES = 1024 * 1024;
/** Refused records kept, the newest: what the chat shows of messages that did not reach the bot. */
const MAX_REFUSED_KEPT = 8;
const PROJECT_TAKEN = /^\d{15}-[0-9a-f-]{36}\.project\.mail\.taken\.json$/;

const WAITING = /^\d{15}-[0-9a-f-]{36}\.json$/;
const REFUSED = /^\d{15}-[0-9a-f-]{36}\.refused\.json$/;
const STOP = /^\d{15}-[0-9a-f-]{36}\.stop\.json$/;
const SCOPED_STOP = /^\d{15}-[0-9a-f-]{36}\.scoped\.stop\.json$/;
/** Words under a recorded origin: a suffix of their own, so a build that knows no such origin never gives them as the owner's. */
const MAIL_WAITING = /^\d{15}-[0-9a-f-]{36}(?:\.project)?\.mail\.json$/;
const MAIL_REFUSED = /^\d{15}-[0-9a-f-]{36}(?:\.project)?\.mail\.refused\.json$/;
/** A mail record the bot's session took, kept until the turn that took it ends (`markBotInboxMailGiven`). */
const PHONE_WAITING = /^\d{15}-[0-9a-f-]{36}(?:\.project)?\.phone\.json$/;
const PHONE_REFUSED = /^\d{15}-[0-9a-f-]{36}(?:\.project)?\.phone\.refused\.json$/;
const MAIL_GIVEN = /^\d{15}-[0-9a-f-]{36}(?:\.project)?\.mail\.given\.json$/;
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

export interface BotPhoneCommand {
	readonly channel: string;
	readonly command: string;
	readonly action: "stop" | "steer";
}

function validPhoneCommand(value: unknown): value is BotPhoneCommand {
	return (
		isPlainRecord(value) &&
		typeof value.channel === "string" &&
		isOwnerChannelName(value.channel) &&
		(value.action === "stop" || value.action === "steer") &&
		typeof value.command === "string" &&
		/^[a-f0-9]{64}$/.test(value.command)
	);
}

export interface BotInboxMessage {
	readonly version: 1;
	readonly id: string;
	readonly agentId: string;
	readonly text: string;
	readonly mode?: BotInboxMode;
	/** A scheduled delivery that can run only in the sending project. */
	readonly projectBound?: true;
	readonly phone?: BotPhoneCommand;
	readonly at: number;
	readonly from: BotInboxSender;
	/** The origin the sending host recorded for the words (a `.mail.json` record); absent for the owner's words. */
	readonly origin?: TurnOriginRecord;
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

/**
 * A record's words: the owner's in a plain record, under a recorded origin in a mail record. A mail record's origin must
 * be one the host records (`isRecordedDeliveryOrigin`): no file in the inbox names the owner's words as its origin.
 */
function parseMessage(
	value: unknown,
	agentId: string,
	mail: boolean,
	phone = false,
	boundFile = false,
): BotInboxMessage | undefined {
	const parsed = parseHomeRecordHead(value, agentId);
	if (!parsed) return undefined;
	const { mode } = parsed.record;
	if (mode !== undefined && mode !== "follow_up" && mode !== "queue" && mode !== "start") return undefined;
	const from = parseSender(parsed.record.from);
	if (!from) return undefined;
	const command = parsed.record.phone;
	if (phone ? !validPhoneCommand(command) : command !== undefined) return undefined;
	const origin = mail ? parseTurnOriginRecord(parsed.record.origin) : undefined;
	if (mail && (!origin || !isRecordedDeliveryOrigin(origin))) return undefined;
	const bound = parsed.record.projectBound;
	if (bound !== (boundFile ? true : undefined)) return undefined;
	if (boundFile && !origin && !(phone && validPhoneCommand(command) && command.action === "steer")) return undefined;
	return {
		...parsed.head,
		...(phone ? { phone: command as BotPhoneCommand } : {}),
		...(bound ? { projectBound: true as const } : {}),
		from,
		...(mode !== undefined ? { mode: mode as BotInboxMode } : {}),
		...(origin ? { origin } : {}),
	};
}

function parseRefusal(
	value: unknown,
	agentId: string,
	mail: boolean,
	phone = false,
	boundFile = false,
): BotInboxRefusal | undefined {
	const message = parseMessage(value, agentId, mail, phone, boundFile);
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

/** The messages waiting for the bot's session, the owner's words and mail together, oldest first. */
/**
 * The owner told of an inbox record that did not read (`tellUnreadableHomeRecord`), and, for a record set aside that
 * still names a mail's origin, `setAsideMail` given that origin and the reason in English: the mail's sender is
 * answered that no answer comes (`refuseUntakenMail`).
 */
export function tellUnreadableInboxRecord(
	agentId: string,
	warn: (message: string) => void,
	setAsideMail: (origin: TurnOriginRecord, reason: string) => void,
): (file: string, reason: string, setAside: boolean) => void {
	const tell = tellUnreadableHomeRecord(agentId, "inboxMessage", warn);
	return (file, reason, setAside) => {
		tell(file, reason, setAside);
		if (!setAside) return;
		let origin: TurnOriginRecord | undefined;
		try {
			const value: unknown = JSON.parse(readFileSync(`${file}.unreadable`, "utf8"));
			origin = isPlainRecord(value) ? parseTurnOriginRecord(value.origin) : undefined;
		} catch {
			// Not JSON, or gone: it names no origin and gets no reply; a goal that waits for it reads that the inbox no longer
			// holds it (`botInboxHoldsMail`) and stops waiting.
		}
		if (origin) setAsideMail(origin, `its record in the bot's inbox did not read (${reason}) and was set aside`);
	};
}

export function readBotInbox(
	agentDir: string,
	agentId: string,
	unreadable: (file: string, reason: string, setAside: boolean) => void,
): BotInboxItem[] {
	const dir = botInboxDir(agentDir, agentId);
	return [
		...readHomeRecords(dir, WAITING, (value) => parseMessage(value, agentId, false), unreadable),
		...readHomeRecords(
			dir,
			PHONE_WAITING,
			(value, name) => parseMessage(value, agentId, false, true, name.includes(".project.phone.")),
			unreadable,
		),
		...readHomeRecords(
			dir,
			MAIL_WAITING,
			(value, name) => parseMessage(value, agentId, true, false, name.includes(".project.mail.")),
			unreadable,
		),
	].sort(
		(a, b) =>
			Number(b.message.phone?.action === "stop") - Number(a.message.phone?.action === "stop") ||
			a.message.at - b.message.at,
	);
}

/** The messages the bot's session refused, oldest first (the newest {@link MAX_REFUSED_KEPT} of each kind). */
export function readBotInboxRefusals(
	agentDir: string,
	agentId: string,
	unreadable: (file: string, reason: string, setAside: boolean) => void,
): BotInboxItem<BotInboxRefusal>[] {
	const dir = botInboxDir(agentDir, agentId);
	return [
		...readHomeRecords(dir, REFUSED, (value) => parseRefusal(value, agentId, false), unreadable),
		...readHomeRecords(
			dir,
			PHONE_REFUSED,
			(value, name) => parseRefusal(value, agentId, false, true, name.includes(".project.phone.")),
			unreadable,
		),
		...readHomeRecords(
			dir,
			MAIL_REFUSED,
			(value, name) => parseRefusal(value, agentId, true, false, name.includes(".project.mail.")),
			unreadable,
		),
	].sort((a, b) => a.message.at - b.message.at);
}

/** The file names of the messages waiting (both kinds) and of the mail given whose turn has not ended; from the names alone. */
function waitingNames(dir: string): string[] {
	return [
		...homeRecordNames(dir, WAITING),
		...homeRecordNames(dir, MAIL_WAITING),
		...homeRecordNames(dir, PHONE_WAITING),
		...homeRecordNames(dir, MAIL_GIVEN),
	];
}

/** Whether a message waits for the bot's session, or a mail it took whose turn has not ended; from the names alone. */
export function botInboxWaiting(agentDir: string, agentId: string): boolean {
	return waitingNames(botInboxDir(agentDir, agentId)).length > 0;
}

/**
 * Whether the owner's words wait for the bot's session (a plain record, not a mail record): the owner's next words go
 * behind them. A mail record waits for the session's turn to end, which the owner's words do not.
 */
export function botInboxOwnerWordsWaiting(agentDir: string, agentId: string): boolean {
	return homeRecordNames(botInboxDir(agentDir, agentId), WAITING).length > 0;
}

/** The reference a mail record's origin names; undefined for a record that does not read, which is never given. */
function mailRecordRef(text: string): string | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return isPlainRecord(value) ? parseTurnOriginRecord(value.origin)?.ref : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether the bot's inbox holds the mail whose origin names `ref`: waiting, or given to a turn that has not ended. Read
 * without setting anything aside, as the process that sent it reads it while another hosts the bot. A record renamed
 * while it is read (given, or put back) is read again under its new name; a file that cannot be read throws. A record
 * that does not read as one names no mail: it is never given, and its host sets it aside.
 */
export function botInboxHoldsMail(agentDir: string, agentId: string, ref: string): boolean {
	const dir = botInboxDir(agentDir, agentId);
	for (let pass = 0; pass < 3; pass++) {
		let moved = false;
		let names: string[];
		try {
			names = readdirSync(dir).filter((name) => MAIL_WAITING.test(name) || MAIL_GIVEN.test(name));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
		for (const name of names) {
			let text: string;
			try {
				text = readFileSync(join(dir, name), "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				moved = true;
				continue;
			}
			if (mailRecordRef(text) === ref) return true;
		}
		if (!moved) return false;
	}
	// Still moving after three reads: it is in hand, and a later pass reads it again.
	return true;
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

/** The bot's inbox holds as many messages as it takes: the words were not written. */
export class BotInboxFullError extends BotOwnerError {
	override readonly name = "BotInboxFullError";
}

function messageIdFromKey(key: string): string {
	return [key.slice(0, 8), key.slice(8, 12), key.slice(12, 16), key.slice(16, 20), key.slice(20)].join("-");
}

function messageStem(at: number, id: string): string {
	return `${String(at).padStart(15, "0")}-${id}`;
}

/**
 * Writes the owner's message, or words under a recorded `origin` (a mail record), for the process hosting the bot's
 * session. Refused in the owner's words (`BotInboxFullError`) when the queue is full (by count or by bytes, both kinds
 * counted).
 */
export function enqueueBotInbox(
	agentDir: string,
	input: {
		agentId: string;
		text: string;
		mode?: BotInboxMode;
		projectBound?: true;
		/** Occurrence creation time identifies its mailbox file; at remains the owner-stop clock. */
		occurrenceCreatedAt?: number;
		phone?: BotPhoneCommand;
		wakeExisting?: boolean;
		from: BotInboxSender;
		at: number;
		origin?: TurnOriginRecord;
	},
): BotInboxItem {
	const dir = botInboxDir(agentDir, input.agentId);
	if (input.phone && (!validPhoneCommand(input.phone) || input.origin !== undefined))
		throw new TypeError("An authenticated phone command has its own inbox record.");
	const key =
		input.phone?.command.slice(0, 32) ??
		(input.projectBound ? input.origin?.ref?.match(/^routine:([a-f0-9]{32})$/)?.[1] : undefined);
	if (input.projectBound && !key) throw new Error("A project-bound delivery requires a routine occurrence reference.");
	const id = key ? messageIdFromKey(key) : randomUUID();
	const message: BotInboxMessage = {
		version: 1,
		id,
		...(input.phone ? { phone: input.phone } : {}),
		...(input.projectBound ? { projectBound: true as const } : {}),
		agentId: input.agentId,
		text: input.text,
		at: input.at,
		from: input.from,
		...(input.mode !== undefined ? { mode: input.mode } : {}),
		...(input.origin !== undefined ? { origin: input.origin } : {}),
	};
	if (input.origin !== undefined && !isRecordedDeliveryOrigin(input.origin))
		throw new TypeError("An inbox record's origin must be one the host records.");
	const text = `${JSON.stringify(message)}\n`;
	if (input.projectBound && !input.origin && input.phone?.action !== "steer")
		throw new Error("A project-bound command must steer a task or deliver a scheduled prompt.");
	const suffix = `${input.projectBound ? ".project" : ""}${input.phone ? ".phone" : input.origin ? ".mail" : ""}.json`;
	const file = join(dir, `${messageStem(input.occurrenceCreatedAt ?? input.at, message.id)}${suffix}`);
	if (input.phone && existsSync(file)) {
		if (input.wakeExisting) writeFileAtomicSync(file, text, { mode: 0o600 });
		return { file, message };
	}
	const waiting = waitingNames(dir).map((name) => join(dir, name));
	const bytes = waiting.reduce((sum, file) => sum + (statSync(file, { throwIfNoEntry: false })?.size ?? 0), 0);
	if (
		input.phone?.action !== "stop" &&
		(waiting.length >= MAX_BOT_INBOX_MESSAGES || bytes + Buffer.byteLength(text) > MAX_BOT_INBOX_BYTES)
	)
		throw new BotInboxFullError((text) => text.botTeam.botInboxFull(input.agentId, MAX_BOT_INBOX_MESSAGES));
	writeFileAtomicSync(file, text, { mode: 0o600 });
	return { file, message };
}

/** Exact evidence that the inbox accepted one project-bound occurrence, including a turn refused or already taken. */
export function hasNamedBotReceipt(
	agentDir: string,
	agentId: string,
	occurrenceId: string,
	createdAt: number,
	cwd: string,
): boolean {
	const ref = routineBotOccurrenceRef(occurrenceId);
	const id = messageIdFromKey(ref.slice("routine:".length));
	const stem = join(botInboxDir(agentDir, agentId), `${messageStem(createdAt, id)}.project.mail`);
	for (const status of ["", ".given", ".refused", ".taken"]) {
		try {
			const item = parseMessage(
				JSON.parse(readFileSync(`${stem}${status}.json`, "utf8")),
				agentId,
				true,
				false,
				true,
			);
			if (item?.id === id && item.origin?.ref === ref && item.from.cwd === cwd) return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return false;
}

/** The bot's session accepted the message: it leaves the queue. */
export function takeBotInboxMessage(item: BotInboxItem): void {
	if (item.message.projectBound && !item.message.phone) {
		// Retain a bounded receipt so a scheduler killed after enqueue can prove acceptance without repeating the turn.
		const receipt = item.file.replace(/\.mail(?:\.given)?\.json$/, ".mail.taken.json");
		renameSync(item.file, receipt);
		keepNewestHomeRecords(dirname(item.file), PROJECT_TAKEN, MAX_BOT_INBOX_MESSAGES);
		return;
	}
	rmSync(item.file, { force: true });
}

/**
 * The bot's session took the mail record: it is kept as given (`.mail.given.json`), no longer waiting or shown, until the
 * turn that took it ends and the drain takes it. A host killed before then leaves it, and the next host gives it again
 * (`restoreGivenBotInboxMail`), once: a session whose transcript holds its reference does not take it twice.
 */
export function markBotInboxMailGiven(item: BotInboxItem): void {
	renameSync(item.file, item.file.replace(/\.mail\.json$/, ".mail.given.json"));
}

/** The mail records the bot's session took whose turns had not ended when they were last read, oldest first. */
export function readBotInboxGiven(
	agentDir: string,
	agentId: string,
	unreadable: (file: string, reason: string, setAside: boolean) => void,
): BotInboxItem[] {
	return readHomeRecords(
		botInboxDir(agentDir, agentId),
		MAIL_GIVEN,
		(value, name) => parseMessage(value, agentId, true, false, name.includes(".project.mail.")),
		unreadable,
	);
}

/**
 * Puts the given mail back in the queue, for the host that has just taken the bot's lock: the process that gave it is gone
 * (or closed the session before its turn ended), so whether its turn ran is read from the session's transcript when it
 * is given again.
 */
export function restoreGivenBotInboxMail(agentDir: string, agentId: string): void {
	const dir = botInboxDir(agentDir, agentId);
	for (const name of homeRecordNames(dir, MAIL_GIVEN))
		renameSync(join(dir, name), join(dir, name.replace(/\.mail\.given\.json$/, ".mail.json")));
}

/** The bot's session refused the message: it leaves the queue as a refused record with `reason`, and old records go. */
export function refuseBotInboxMessage(agentDir: string, item: BotInboxItem, reason: string, refusedAt: number): void {
	const refusal: BotInboxRefusal = { ...item.message, refusedAt, reason };
	writeFileAtomicSync(item.file.replace(/\.json$/, ".refused.json"), `${JSON.stringify(refusal)}\n`, { mode: 0o600 });
	rmSync(item.file, { force: true });
	const kind = item.message.phone ? PHONE_REFUSED : item.message.origin === undefined ? REFUSED : MAIL_REFUSED;
	keepNewestHomeRecords(botInboxDir(agentDir, item.message.agentId), kind, MAX_REFUSED_KEPT);
}
