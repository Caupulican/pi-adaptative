/**
 * The durable admission journal of one channel, shared by every session of the agent directory. The file is the truth:
 * an inbound event is acknowledged to its provider only after it is held here, a duplicate event id finds its earlier
 * outcome, and a delivered batch keeps the address its reply goes back to. Every list is bounded; a third party's text
 * is kept only while it waits to be delivered and in a reply draft.
 */

import { createHash } from "node:crypto";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readOptionalBoundedTextFileSync } from "../util/bounded-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";

const JOURNAL_VERSION = 1;
/** Above every bounded list at its largest (128 messages and 32 drafts at their character caps, 4 bytes a character). */
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
export const MAX_PENDING_MESSAGES = 128;
const MAX_SEEN = 1024;
const SEEN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_HELD = 64;
const MAX_BATCHES = 64;
const MAX_DRAFTS = 32;
const MAX_GAPS = 32;
const MAX_ONBOARDING = 16;
/** The owner's private chats a channel pushes to. */
export const MAX_OWNER_CONVERSATIONS = 8;
/**
 * Push records kept for dedupe and the hourly rate: the latest ones of the last week. A week at a high rate holds
 * more, and the oldest go first; the hourly rate reads only the last hour, which always fits, while a key whose record
 * went may be pushed again.
 */
const MAX_OWNER_PUSHES = 512;
export const DAY_MS = 24 * 60 * 60 * 1000;
/** A waiting message is delivered within a day or becomes a gap. */
export const PENDING_EXPIRY_MS = DAY_MS;

export type ChannelHeldReason = "unverified" | "not_allowed" | "burst";
export type ChannelSeenOutcome = "pending" | "delivered" | "held" | "ignored" | "expired";

export interface ChannelPendingMessage {
	readonly eventDigest: string;
	readonly conversationKey: string;
	readonly address: string;
	readonly senderId: string;
	readonly senderLabel: string;
	readonly verified: boolean;
	readonly kind: "message" | "reaction";
	readonly text: string;
	readonly receivedAt: number;
	readonly admittedAt: number;
	/** The session a turn holding this message is being offered to: no other session delivers it meanwhile. */
	offeredTo?: string;
	/** That session's process, when it was offered (absent in a journal written before it was recorded). */
	offeredPid?: number;
	offeredAt?: number;
	/** The batch the offer delivers: one offer of several messages is one batch. */
	offeredBatch?: string;
	/** Offered by the daemon while no session was open: the offer charges the away spend bound until accepted. */
	offeredAway?: true;
	/**
	 * Admitted as the owner's words (`ownerAdmission`): offered only as an owner turn, never in a third party's batch; one
	 * whose authority lapsed waits and expires. An earlier build ignores the field and delivers it as a third party's.
	 */
	readonly owner?: true;
}

export interface ChannelBatchRecord {
	readonly id: string;
	readonly sessionId: string;
	/** The accepting session's process (absent in a journal written before it was recorded). */
	readonly pid?: number;
	readonly conversationKey: string;
	readonly address: string;
	readonly eventDigests: readonly string[];
	/** Every sender of the batch was verified and allowlisted when it was admitted. */
	readonly allowlisted: boolean;
	readonly acceptedAt: number;
	state: "accepted" | "replied" | "drafted" | "unanswered";
	usd?: number;
	/** Delivered by the daemon while no session was open: it charges the away spend bound (`away-channels.ts`). */
	readonly away?: true;
	/** An owner turn: it charges the channel's owner pool, never the away bound or the channel's third-party bounds. */
	readonly owner?: true;
	/** Accepted while the subscription's usage had room (`ownerQuotaMaxUsedPercent`): it charges no dollars to the owner pool. */
	readonly quota?: true;
	/** The owner sender's digest (`ownerSenderDigest`): the answer goes back only while that sender is still listed. */
	readonly senderDigest?: string;
	/** The held draft this owner turn performs, approved from the owner's chat: at most one turn per draft. */
	readonly approval?: string;
}

/** A private chat an owner message was admitted from: where the owner's updates are pushed. */
export interface ChannelOwnerConversation {
	readonly conversationKey: string;
	readonly address: string;
	readonly senderDigest: string;
	readonly at: number;
}

/**
 * One push to the owner's chat, recorded before it is sent: `k` is `push:<key>`. A held action's presentation gets
 * `c`, the conversation it was shown to, and `at` again, once its send resolved.
 */
export interface ChannelOwnerPushRecord {
	readonly k: string;
	at: number;
	c?: string;
}

export interface ChannelDraftRecord {
	readonly id: string;
	readonly batchId: string;
	readonly conversationKey: string;
	readonly address: string;
	readonly text: string;
	readonly reason: string;
	readonly createdAt: number;
	/**
	 * `sending`: a settle claimed the draft and its send is in flight, or was cut short (`sendingBy` names the claimer);
	 * a draft whose claimer is gone has an unknown outcome and is surfaced to the owner as such, never sent again on its own.
	 */
	state: "pending" | "sending" | "sent" | "dismissed";
	settledAt?: number;
	/** The session and process that claimed the send; present only while `state` is `sending`. */
	sendingBy?: { sessionId: string; pid: number; at: number };
	/** Written by the daemon while no session was open; the next session that serves the channel is told. */
	readonly away?: true;
	/** An open session holding the channel told the owner of this away draft; no session tells it again. */
	told?: true;
	/**
	 * The digests, in order, of the leading parts of the reply the transport accepted (`sendReplyParts`). A send of the
	 * draft does not send those parts again, so a reply that failed part-way resumes where it stopped.
	 */
	deliveredParts?: string[];
}

export interface ChannelGapRecord {
	readonly id: string;
	readonly reason: "expired" | "unanswered" | "reset";
	readonly count: number;
	readonly at: number;
	/** The conversations were the daemon's: the owner is told of it in the summary of what the daemon left. */
	readonly away?: true;
	/** An open session holding the channel told the owner of this gap; no session tells it again. */
	told?: true;
}

/** Messages the daemon's host held, by reason, that no session told the owner of yet. */
export type ChannelHeldCounts = Partial<Record<ChannelHeldReason, number>>;

export interface ChannelJournalState {
	version: number;
	/** The session serving the channel; `away` marks the daemon's host, which any open session takes over. */
	holder?: { sessionId: string; pid: number; away?: true };
	pending: ChannelPendingMessage[];
	seen: { d: string; at: number; outcome: ChannelSeenOutcome }[];
	held: { sender: string; kind: string; reason: ChannelHeldReason; at: number }[];
	/**
	 * The journal records a told flag on each record, so a record without one is untold. Absent in a journal written
	 * before: its gaps and the daemon's drafts were told by that build's rule and are read as told.
	 */
	toldFlags?: true;
	heldTotal: number;
	/** Held while the daemon's host served the channel and not told yet; absent when there is none. */
	awayHeld?: ChannelHeldCounts;
	ignoredTotal: number;
	batches: ChannelBatchRecord[];
	drafts: ChannelDraftRecord[];
	gaps: ChannelGapRecord[];
	/**
	 * Senders the owner was told how to allowlist (sender digest prefix), so each is told at most once a day; `id` is the
	 * sender's own id when the sender chose it, kept for the owner's `channel_reply` `list` instead of the notice.
	 */
	onboarding: { sender: string; at: number; id?: string }[];
	/** The owner's private chats, newest last, at most `MAX_OWNER_CONVERSATIONS`; absent while there is none. */
	ownerConversations?: ChannelOwnerConversation[];
	/** Pushes to the owner's chats of the last week, oldest first; absent while there is none. */
	ownerPushes?: ChannelOwnerPushRecord[];
	/** Updates the push rate bound kept from the owner's chat since `status` last reported them; absent at zero. */
	ownerPushSuppressed?: number;
	/** The persistent session the daemon's host runs the owner's turns in (the phone session); absent until it wrote. */
	ownerSession?: { sessionId: string; file: string };
}

export function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * A fresh journal. `holder`, `awayHeld` and the owner fields keep their key positions while unset (`JSON.stringify` omits them), so a
 * first value is written where `parseState` puts it and the next update that changes nothing writes nothing.
 */
function emptyState(): ChannelJournalState {
	return {
		version: JOURNAL_VERSION,
		holder: undefined,
		pending: [],
		seen: [],
		held: [],
		toldFlags: true,
		heldTotal: 0,
		awayHeld: undefined,
		ignoredTotal: 0,
		batches: [],
		drafts: [],
		gaps: [],
		onboarding: [],
		ownerConversations: undefined,
		ownerPushes: undefined,
		ownerPushSuppressed: undefined,
		ownerSession: undefined,
	};
}

const isString = (value: unknown): value is string => typeof value === "string";
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function isPending(value: unknown): value is ChannelPendingMessage {
	return (
		isPlainRecord(value) &&
		isString(value.eventDigest) &&
		isString(value.conversationKey) &&
		isString(value.address) &&
		isString(value.senderId) &&
		isString(value.senderLabel) &&
		typeof value.verified === "boolean" &&
		(value.kind === "message" || value.kind === "reaction") &&
		isString(value.text) &&
		isTime(value.receivedAt) &&
		isTime(value.admittedAt) &&
		(value.offeredTo === undefined || isString(value.offeredTo)) &&
		(value.offeredPid === undefined || isCount(value.offeredPid)) &&
		(value.offeredAt === undefined || isTime(value.offeredAt)) &&
		(value.offeredBatch === undefined || isString(value.offeredBatch)) &&
		(value.offeredAway === undefined || value.offeredAway === true) &&
		(value.owner === undefined || value.owner === true)
	);
}

function isBatch(value: unknown): value is ChannelBatchRecord {
	return (
		isPlainRecord(value) &&
		isString(value.id) &&
		isString(value.sessionId) &&
		(value.pid === undefined || isCount(value.pid)) &&
		isString(value.conversationKey) &&
		isString(value.address) &&
		Array.isArray(value.eventDigests) &&
		value.eventDigests.every(isString) &&
		typeof value.allowlisted === "boolean" &&
		isTime(value.acceptedAt) &&
		(value.state === "accepted" ||
			value.state === "replied" ||
			value.state === "drafted" ||
			value.state === "unanswered") &&
		(value.usd === undefined || isTime(value.usd)) &&
		(value.away === undefined || value.away === true) &&
		(value.owner === undefined || value.owner === true) &&
		(value.quota === undefined || value.quota === true) &&
		(value.senderDigest === undefined || isString(value.senderDigest)) &&
		(value.approval === undefined || isString(value.approval))
	);
}

function isOwnerConversation(value: unknown): value is ChannelOwnerConversation {
	return (
		isPlainRecord(value) &&
		isString(value.conversationKey) &&
		isString(value.address) &&
		isString(value.senderDigest) &&
		isTime(value.at)
	);
}

function isOwnerPush(value: unknown): value is ChannelOwnerPushRecord {
	return isPlainRecord(value) && isString(value.k) && isTime(value.at) && (value.c === undefined || isString(value.c));
}

function isDraft(value: unknown): value is ChannelDraftRecord {
	return (
		isPlainRecord(value) &&
		isString(value.id) &&
		isString(value.batchId) &&
		isString(value.conversationKey) &&
		isString(value.address) &&
		isString(value.text) &&
		isString(value.reason) &&
		isTime(value.createdAt) &&
		(value.state === "pending" ||
			value.state === "sending" ||
			value.state === "sent" ||
			value.state === "dismissed") &&
		(value.settledAt === undefined || isTime(value.settledAt)) &&
		(value.sendingBy === undefined ||
			(isPlainRecord(value.sendingBy) &&
				isString(value.sendingBy.sessionId) &&
				isCount(value.sendingBy.pid) &&
				isTime(value.sendingBy.at))) &&
		(value.deliveredParts === undefined ||
			(Array.isArray(value.deliveredParts) && value.deliveredParts.every(isString))) &&
		(value.away === undefined || value.away === true) &&
		(value.told === undefined || value.told === true)
	);
}

function isGap(value: unknown): value is ChannelGapRecord {
	return (
		isPlainRecord(value) &&
		isString(value.id) &&
		(value.reason === "expired" || value.reason === "unanswered" || value.reason === "reset") &&
		isCount(value.count) &&
		isTime(value.at) &&
		(value.away === undefined || value.away === true) &&
		(value.told === undefined || value.told === true)
	);
}

const SEEN_OUTCOMES = new Set<unknown>(["pending", "delivered", "held", "ignored", "expired"]);
const HELD_REASONS = new Set<unknown>(["unverified", "not_allowed", "burst"]);

function isHeldCounts(value: unknown): value is ChannelHeldCounts {
	return (
		isPlainRecord(value) && Object.entries(value).every(([key, count]) => HELD_REASONS.has(key) && isCount(count))
	);
}

/** Strict: any field out of shape makes the whole file unreadable, never a partly trusted journal. */
function parseState(text: string): ChannelJournalState {
	const value: unknown = JSON.parse(text);
	if (!isPlainRecord(value) || value.version !== JOURNAL_VERSION) throw new Error("unknown journal version");
	const holder = value.holder;
	if (
		holder !== undefined &&
		!(
			isPlainRecord(holder) &&
			isString(holder.sessionId) &&
			isCount(holder.pid) &&
			(holder.away === undefined || holder.away === true)
		)
	)
		throw new Error("malformed holder");
	if (value.awayHeld !== undefined && !isHeldCounts(value.awayHeld)) throw new Error("malformed held counts");
	if (value.toldFlags !== undefined && value.toldFlags !== true) throw new Error("malformed told marker");
	if (value.ownerPushSuppressed !== undefined && !isCount(value.ownerPushSuppressed))
		throw new Error("malformed push count");
	const ownerSession = value.ownerSession;
	if (
		ownerSession !== undefined &&
		!(isPlainRecord(ownerSession) && isString(ownerSession.sessionId) && isString(ownerSession.file))
	)
		throw new Error("malformed owner session");
	const list = <T>(field: unknown, check: (item: unknown) => item is T): T[] => {
		if (!Array.isArray(field) || !field.every(check)) throw new Error("malformed journal list");
		return field;
	};
	// Written before told flags: that build told its gaps and the daemon's drafts by its own rule, so none is told again
	// (a draft's reason from then may also hold a wrapper's raw error text).
	const legacy = value.toldFlags === undefined;
	const told = <T extends { told?: true }>(record: T, untold: boolean): T =>
		legacy && untold && record.told !== true ? { ...record, told: true } : record;
	return {
		version: JOURNAL_VERSION,
		holder: holder
			? {
					sessionId: holder.sessionId as string,
					pid: holder.pid as number,
					...(holder.away === true ? { away: true as const } : {}),
				}
			: undefined,
		pending: list(value.pending, isPending),
		seen: list(
			value.seen,
			(item): item is ChannelJournalState["seen"][number] =>
				isPlainRecord(item) && isString(item.d) && isTime(item.at) && SEEN_OUTCOMES.has(item.outcome),
		),
		held: list(
			value.held,
			(item): item is ChannelJournalState["held"][number] =>
				isPlainRecord(item) &&
				isString(item.sender) &&
				isString(item.kind) &&
				HELD_REASONS.has(item.reason) &&
				isTime(item.at),
		),
		toldFlags: true,
		heldTotal: isCount(value.heldTotal) ? value.heldTotal : 0,
		// Absent in a journal written before the daemon's held messages were told; the key keeps its place (`emptyState`).
		awayHeld: value.awayHeld === undefined ? undefined : { ...(value.awayHeld as ChannelHeldCounts) },
		ignoredTotal: isCount(value.ignoredTotal) ? value.ignoredTotal : 0,
		batches: list(value.batches, isBatch),
		drafts: list(value.drafts, isDraft).map((draft) => told(draft, draft.away === true && draft.state === "pending")),
		gaps: list(value.gaps, isGap).map((gap) => told(gap, true)),
		// Absent in a journal written before onboarding notices existed.
		onboarding:
			value.onboarding === undefined
				? []
				: list(
						value.onboarding,
						(item): item is ChannelJournalState["onboarding"][number] =>
							isPlainRecord(item) &&
							isString(item.sender) &&
							isTime(item.at) &&
							(item.id === undefined || isString(item.id)),
					),
		// Absent in a journal written before owner channels, and while each is empty.
		ownerConversations:
			value.ownerConversations === undefined ? undefined : list(value.ownerConversations, isOwnerConversation),
		ownerPushes: value.ownerPushes === undefined ? undefined : list(value.ownerPushes, isOwnerPush),
		ownerPushSuppressed: value.ownerPushSuppressed as number | undefined,
		// Absent in a journal written before the daemon hosted the owner's session, and until that session wrote.
		ownerSession: ownerSession
			? { sessionId: ownerSession.sessionId as string, file: ownerSession.file as string }
			: undefined,
	};
}

/** A draft the owner still has to settle: waiting, or claimed by a send whose outcome is not recorded. */
export function isDraftOpen(draft: Pick<ChannelDraftRecord, "state">): boolean {
	return draft.state === "pending" || draft.state === "sending";
}

/** Drop what retention allows; a waiting message, an unanswered batch and an open draft are kept. */
function prune(state: ChannelJournalState, now: number): void {
	state.seen = state.seen.filter((entry) => now - entry.at < SEEN_RETENTION_MS).slice(-MAX_SEEN);
	state.held = state.held.slice(-MAX_HELD);
	const settledBatches = state.batches.filter(
		(batch) => batch.state !== "accepted" && now - batch.acceptedAt >= DAY_MS,
	);
	const dropBatches = new Set(settledBatches.slice(0, Math.max(0, state.batches.length - MAX_BATCHES)));
	state.batches = state.batches.filter((batch) => !dropBatches.has(batch));
	const settledDrafts = state.drafts.filter((draft) => !isDraftOpen(draft));
	const dropDrafts = new Set(settledDrafts.slice(0, Math.max(0, state.drafts.length - MAX_DRAFTS)));
	state.drafts = state.drafts.filter((draft) => !dropDrafts.has(draft));
	// Told gaps go first, so a long absence keeps what no session told yet.
	const toldGaps = state.gaps.filter((gap) => gap.told === true);
	const dropGaps = new Set(toldGaps.slice(0, Math.max(0, state.gaps.length - MAX_GAPS)));
	state.gaps = state.gaps.filter((gap) => !dropGaps.has(gap)).slice(-MAX_GAPS);
	state.onboarding = state.onboarding.filter((entry) => now - entry.at < DAY_MS).slice(-MAX_ONBOARDING);
	const pushes = state.ownerPushes?.filter((entry) => now - entry.at < SEEN_RETENTION_MS).slice(-MAX_OWNER_PUSHES);
	state.ownerPushes = pushes && pushes.length > 0 ? pushes : undefined;
	const conversations = state.ownerConversations?.slice(-MAX_OWNER_CONVERSATIONS);
	state.ownerConversations = conversations && conversations.length > 0 ? conversations : undefined;
	if (state.ownerPushSuppressed === 0) state.ownerPushSuppressed = undefined;
}

/** What a journal update observed besides its own result: the file was unreadable and was replaced. */
export interface ChannelJournalUpdate<T> {
	readonly result: T;
	readonly reset: boolean;
}

export class ChannelJournal {
	readonly path: string;
	private readonly channel: string;

	constructor(agentDir: string, channel: string) {
		this.path = join(agentDir, "channels", `${channel}.json`);
		this.channel = channel;
	}

	/**
	 * Read, change and write the journal under its lock. An unreadable file is moved aside (kept for inspection), a
	 * fresh journal starts with one `reset` gap, and the update reports it. A throw in `change` writes nothing, and so
	 * does an update that leaves the file's text as it was: every write wakes the watchers of the directory.
	 */
	update<T>(now: number, change: (state: ChannelJournalState) => T): ChannelJournalUpdate<T> {
		return withFileLockSync(this.path, () => {
			let state: ChannelJournalState;
			let reset = false;
			const text = readOptionalBoundedTextFileSync(this.path, MAX_JOURNAL_BYTES, "channel journal");
			if (text === undefined) state = emptyState();
			else {
				try {
					state = parseState(text);
				} catch {
					renameSync(this.path, `${this.path}.unreadable-${now}`);
					harnessLog.warn("channels", "a channel journal could not be read; it was moved aside", {
						channel: this.channel,
					});
					state = emptyState();
					state.gaps.push({
						id: digest(`${this.path}:reset:${now}`).slice(0, 16),
						reason: "reset",
						count: 0,
						at: now,
					});
					reset = true;
				}
			}
			const result = change(state);
			prune(state, now);
			const next = `${JSON.stringify(state)}\n`;
			if (next !== text) writeFileAtomicSync(this.path, next);
			if (text === undefined)
				harnessLog.info("channels", "a channel journal was created", { channel: this.channel });
			return { result, reset };
		});
	}

	/**
	 * A read that writes nothing and takes no lock: every write replaces the file atomically, so a reader sees one whole
	 * journal. An unreadable file reads as an empty journal with `reset` set; the next update moves it aside and
	 * records the gap.
	 */
	read(): ChannelJournalUpdate<ChannelJournalState> {
		const text = readOptionalBoundedTextFileSync(this.path, MAX_JOURNAL_BYTES, "channel journal");
		if (text === undefined) return { result: emptyState(), reset: false };
		try {
			return { result: parseState(text), reset: false };
		} catch {
			return { result: emptyState(), reset: true };
		}
	}
}

/** What the daemon's host left that no session told the owner of: its gaps, its pending drafts, its held messages. */
export interface ChannelAwayUntold {
	readonly gaps: readonly ChannelGapRecord[];
	readonly drafts: readonly ChannelDraftRecord[];
	readonly held: ChannelHeldCounts;
}

/** What one tell covers: gaps told one by one, and what the daemon's host left when the tell covers it. */
export interface ChannelUntold {
	readonly gaps: readonly ChannelGapRecord[];
	readonly away?: ChannelAwayUntold;
}

/** Copies of the records no session told the owner of yet; `away` only when `withAway`. Reads only. */
export function untoldRecords(state: ChannelJournalState, withAway: boolean): ChannelUntold {
	const gaps = state.gaps.filter((gap) => gap.told !== true && gap.away !== true).map((gap) => ({ ...gap }));
	if (!withAway) return { gaps };
	return {
		gaps,
		away: {
			gaps: state.gaps.filter((gap) => gap.told !== true && gap.away === true).map((gap) => ({ ...gap })),
			drafts: state.drafts
				.filter((draft) => draft.away === true && draft.state === "pending" && draft.told !== true)
				.map((draft) => ({ ...draft })),
			held: { ...state.awayHeld },
		},
	};
}

/**
 * Record a gap. A gap of the daemon's host joins its untold gap of the same reason, so the bounded list keeps the
 * count of a long absence; the open sessions' gaps are told one by one and are kept apart.
 */
export function recordGap(state: ChannelJournalState, gap: ChannelGapRecord): void {
	const index =
		gap.away === true
			? state.gaps.findIndex((entry) => entry.away === true && entry.told !== true && entry.reason === gap.reason)
			: -1;
	const untold = index >= 0 ? state.gaps[index] : undefined;
	if (untold) state.gaps[index] = { ...untold, count: untold.count + gap.count };
	else state.gaps.push(gap);
}

export function heldCount(held: ChannelHeldCounts): number {
	return (held.unverified ?? 0) + (held.not_allowed ?? 0) + (held.burst ?? 0);
}

export function isUntoldEmpty(untold: ChannelUntold): boolean {
	const away = untold.away;
	return (
		untold.gaps.length === 0 &&
		(away === undefined || (away.gaps.length === 0 && away.drafts.length === 0 && heldCount(away.held) === 0))
	);
}

/**
 * Mark `untold` told in `state` (`told: true`), or, with `told: false`, take the mark back from a tell whose notice
 * was not kept. The held counts are taken off the waiting counts, or given back.
 */
export function markTold(state: ChannelJournalState, untold: ChannelUntold, told: boolean): void {
	const gapIds = new Set([...untold.gaps, ...(untold.away?.gaps ?? [])].map((gap) => gap.id));
	for (const gap of state.gaps) if (gapIds.has(gap.id)) gap.told = told ? true : undefined;
	const draftIds = new Set((untold.away?.drafts ?? []).map((draft) => draft.id));
	for (const draft of state.drafts) if (draftIds.has(draft.id)) draft.told = told ? true : undefined;
	const held = untold.away?.held;
	if (!held) return;
	const next: ChannelHeldCounts = {};
	for (const reason of ["unverified", "not_allowed", "burst"] as const) {
		const count = (state.awayHeld?.[reason] ?? 0) + (told ? -1 : 1) * (held[reason] ?? 0);
		if (count > 0) next[reason] = count;
	}
	state.awayHeld = heldCount(next) > 0 ? next : undefined;
}

/**
 * The third parties' turns delivered in the last 24 hours and what they cost: the figures a channel's daily bounds are
 * read against. Owner turns charge the owner pool alone (`ownerChannelCharges`, `owner-channel.ts`).
 */
export function channelDayUsage(
	state: Pick<ChannelJournalState, "batches">,
	now: number,
): { readonly wakes: number; readonly usd: number } {
	const recent = state.batches.filter((batch) => batch.owner !== true && now - batch.acceptedAt < DAY_MS);
	return { wakes: recent.length, usd: recent.reduce((sum, batch) => sum + (batch.usd ?? 0), 0) };
}

/**
 * When each offer not yet accepted was made, once per offered batch, among the pending entries `counts` picks: the
 * reservations a spend pool charges from the offer on.
 */
export function pendingOfferTimes(
	pending: readonly ChannelPendingMessage[],
	counts: (entry: ChannelPendingMessage) => boolean,
): number[] {
	const offers = new Map<string, number>();
	for (const entry of pending) {
		if (!counts(entry) || entry.offeredTo === undefined || entry.offeredAt === undefined) continue;
		offers.set(entry.offeredBatch ?? entry.offeredTo, entry.offeredAt);
	}
	return [...offers.values()];
}
