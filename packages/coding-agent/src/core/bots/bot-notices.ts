/**
 * What a bot's own session told the owner (a warning its session raised, a turn that failed or was stopped at its bound):
 * `bots/<id>/notices/`, one file per notice, the newest few kept. The bot's chat in every session draws them, the watch
 * over the bot homes tells every session when one is written, and a notice that asks for the owner's attention marks the
 * bot unread in the store every session reads (`PersistentBotTeamStore.recordBotNotice`). Never sent to a model.
 *
 * The directory is private harness storage like the rest of the bot's home.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { botNoticesDir } from "../agent-paths.ts";
import type { PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import type { OwnerNoticeLine } from "../harness-notice.ts";
import { interfaceText } from "../language/interface-text.ts";
import { writeFileAtomicSync } from "../util/atomic-file.ts";
import { type BotHomeRecord, keepNewestHomeRecords, parseHomeRecordHead, readHomeRecords } from "./bot-home-records.ts";

/** Notices kept, the newest: what the chat shows of what the bot's session told the owner. */
const MAX_NOTICES_KEPT = 16;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const NOTICE = /^\d{15}-[0-9a-f-]{36}\.json$/;

/** Most characters of the words the store keeps to mark the bot unread and list in its inbox. */
const MAX_MARK_CHARS = 500;

export interface BotNotice {
	readonly version: 1;
	readonly id: string;
	readonly agentId: string;
	/** The owner-facing words, in the owner's language when it was written. */
	readonly text: string;
	readonly at: number;
	/** A harness notice's delivery id (`harness-notice.ts`), so the bot's reopened session finds an episode it told. */
	readonly deliveryId?: string;
}

function parseNotice(value: unknown, agentId: string): BotNotice | undefined {
	const parsed = parseHomeRecordHead(value, agentId);
	if (!parsed) return undefined;
	const { deliveryId } = parsed.record;
	if (deliveryId !== undefined && typeof deliveryId !== "string") return undefined;
	return { ...parsed.head, ...(deliveryId === undefined ? {} : { deliveryId }) };
}

/** The notices kept for the bot, oldest first. */
export function readBotNotices(
	agentDir: string,
	agentId: string,
	unreadable: (file: string, reason: string) => void,
): BotHomeRecord<BotNotice>[] {
	return readHomeRecords(botNoticesDir(agentDir, agentId), NOTICE, (value) => parseNotice(value, agentId), unreadable);
}

/** What the bot's session told the owner, and when. */
export interface BotNoticeInput {
	readonly agentId: string;
	readonly text: string;
	readonly at: number;
	readonly deliveryId?: string | undefined;
}

/**
 * The bot's chat as its own session's notice destination (`OwnerNoticeLine`): `read` the notices kept, `keep` one with
 * its delivery id (marked unread), true when it is kept.
 */
export function botNoticeLine(
	read: () => readonly BotNotice[],
	keep: (text: string, deliveryId: string) => boolean,
): OwnerNoticeLine {
	return {
		heldIds: () => new Set(read().flatMap(({ deliveryId }) => (deliveryId ? [deliveryId] : []))),
		keep: ({ deliveryId, text }) => keep(text, deliveryId),
	};
}

/**
 * Writes what the bot's session told the owner into its chat and drops the oldest beyond the kept few. Throws when the
 * notice could not be written.
 */
function writeBotNotice(agentDir: string, input: BotNoticeInput): void {
	const notice: BotNotice = {
		version: 1,
		id: randomUUID(),
		agentId: input.agentId,
		text: input.text,
		at: input.at,
		...(input.deliveryId === undefined ? {} : { deliveryId: input.deliveryId }),
	};
	const dir = botNoticesDir(agentDir, input.agentId);
	writeFileAtomicSync(
		join(dir, `${String(input.at).padStart(15, "0")}-${notice.id}.json`),
		`${JSON.stringify(notice)}\n`,
		{
			mode: 0o600,
		},
	);
	keepNewestHomeRecords(dir, NOTICE, MAX_NOTICES_KEPT);
}

/**
 * The store marks the bot unread with the notice's words, unless these same words already mark it unread: the store's
 * change wakes every session's passes, so a warning one of them raises again cannot feed itself through the store. Throws
 * when the store could not be written.
 */
function markBotNotice(store: Pick<PersistentBotTeamStore, "getBot" | "recordBotNotice">, input: BotNoticeInput): void {
	const words = input.text.trim().slice(0, MAX_MARK_CHARS);
	const bot = store.getBot(input.agentId);
	const marked = bot?.lastNotice?.text === words && bot.lastNotice.at > (bot.lastReadAt ?? 0);
	if (!marked) store.recordBotNotice(input.agentId, { at: input.at, text: words });
}

/**
 * Keeps what the bot's session told the owner in its chat, every session's to read, and marks the bot unread unless `mark`
 * is false (an informational notice); returns whether the notice is in the chat. A notice that could not be written
 * reaches the owner through `warn` with its words; one written whose unread mark failed is in the chat, and the warning
 * says only that.
 */
export function keepBotNotice(
	agentDir: string,
	store: Pick<PersistentBotTeamStore, "getBot" | "recordBotNotice">,
	notice: BotNoticeInput,
	mark: boolean,
	warn: (message: string) => void,
): boolean {
	const words = interfaceText().botTeam;
	try {
		writeBotNotice(agentDir, notice);
	} catch (error) {
		warn(words.botNoticeNotRecorded(notice.agentId, notice.text, errorText(error)));
		return false;
	}
	try {
		if (mark) markBotNotice(store, notice);
	} catch (error) {
		warn(words.botNoticeNotMarked(notice.agentId, errorText(error)));
	}
	return true;
}
