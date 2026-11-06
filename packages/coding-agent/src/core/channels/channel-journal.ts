/**
 * The durable admission journal of one channel, shared by every session of the agent directory. The file is the truth:
 * an inbound event is acknowledged to its provider only after it is held here, a duplicate event id finds its earlier
 * outcome, and a delivered batch keeps the address its reply goes back to. Every list is bounded; a third party's text
 * is kept only while it waits to be delivered and in a reply draft.
 */

import { createHash } from "node:crypto";
import { renameSync } from "node:fs";
import { join } from "node:path";
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
}

export interface ChannelBatchRecord {
	readonly id: string;
	readonly sessionId: string;
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
}

export interface ChannelDraftRecord {
	readonly id: string;
	readonly batchId: string;
	readonly conversationKey: string;
	readonly address: string;
	readonly text: string;
	readonly reason: string;
	readonly createdAt: number;
	state: "pending" | "sent" | "dismissed";
	settledAt?: number;
	/** Written by the daemon while no session was open; the next session that serves the channel is told. */
	readonly away?: true;
}

export interface ChannelGapRecord {
	readonly id: string;
	readonly reason: "expired" | "unanswered" | "reset";
	readonly count: number;
	readonly at: number;
}

export interface ChannelJournalState {
	version: number;
	/** The session serving the channel; `away` marks the daemon's host, which any open session takes over. */
	holder?: { sessionId: string; pid: number; away?: true };
	pending: ChannelPendingMessage[];
	seen: { d: string; at: number; outcome: ChannelSeenOutcome }[];
	held: { sender: string; kind: string; reason: ChannelHeldReason; at: number }[];
	heldTotal: number;
	ignoredTotal: number;
	batches: ChannelBatchRecord[];
	drafts: ChannelDraftRecord[];
	gaps: ChannelGapRecord[];
	/** Senders the owner was told how to allowlist (sender digest prefix), so each is told at most once a day. */
	onboarding: { sender: string; at: number }[];
}

export function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function emptyState(): ChannelJournalState {
	return {
		version: JOURNAL_VERSION,
		pending: [],
		seen: [],
		held: [],
		heldTotal: 0,
		ignoredTotal: 0,
		batches: [],
		drafts: [],
		gaps: [],
		onboarding: [],
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
		(value.offeredTo === undefined || isString(value.offeredTo))
	);
}

function isBatch(value: unknown): value is ChannelBatchRecord {
	return (
		isPlainRecord(value) &&
		isString(value.id) &&
		isString(value.sessionId) &&
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
		(value.away === undefined || value.away === true)
	);
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
		(value.state === "pending" || value.state === "sent" || value.state === "dismissed") &&
		(value.settledAt === undefined || isTime(value.settledAt)) &&
		(value.away === undefined || value.away === true)
	);
}

function isGap(value: unknown): value is ChannelGapRecord {
	return (
		isPlainRecord(value) &&
		isString(value.id) &&
		(value.reason === "expired" || value.reason === "unanswered" || value.reason === "reset") &&
		isCount(value.count) &&
		isTime(value.at)
	);
}

const SEEN_OUTCOMES = new Set<unknown>(["pending", "delivered", "held", "ignored", "expired"]);
const HELD_REASONS = new Set<unknown>(["unverified", "not_allowed", "burst"]);

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
	const list = <T>(field: unknown, check: (item: unknown) => item is T): T[] => {
		if (!Array.isArray(field) || !field.every(check)) throw new Error("malformed journal list");
		return field;
	};
	return {
		version: JOURNAL_VERSION,
		...(holder
			? {
					holder: {
						sessionId: holder.sessionId as string,
						pid: holder.pid as number,
						...(holder.away === true ? { away: true as const } : {}),
					},
				}
			: {}),
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
		heldTotal: isCount(value.heldTotal) ? value.heldTotal : 0,
		ignoredTotal: isCount(value.ignoredTotal) ? value.ignoredTotal : 0,
		batches: list(value.batches, isBatch),
		drafts: list(value.drafts, isDraft),
		gaps: list(value.gaps, isGap),
		// Absent in a journal written before onboarding notices existed.
		onboarding:
			value.onboarding === undefined
				? []
				: list(
						value.onboarding,
						(item): item is ChannelJournalState["onboarding"][number] =>
							isPlainRecord(item) && isString(item.sender) && isTime(item.at),
					),
	};
}

/** Drop what retention allows; a waiting message, an unanswered batch and a pending draft are kept. */
function prune(state: ChannelJournalState, now: number): void {
	state.seen = state.seen.filter((entry) => now - entry.at < SEEN_RETENTION_MS).slice(-MAX_SEEN);
	state.held = state.held.slice(-MAX_HELD);
	const settledBatches = state.batches.filter(
		(batch) => batch.state !== "accepted" && now - batch.acceptedAt >= DAY_MS,
	);
	const dropBatches = new Set(settledBatches.slice(0, Math.max(0, state.batches.length - MAX_BATCHES)));
	state.batches = state.batches.filter((batch) => !dropBatches.has(batch));
	const settledDrafts = state.drafts.filter((draft) => draft.state !== "pending");
	const dropDrafts = new Set(settledDrafts.slice(0, Math.max(0, state.drafts.length - MAX_DRAFTS)));
	state.drafts = state.drafts.filter((draft) => !dropDrafts.has(draft));
	state.gaps = state.gaps.slice(-MAX_GAPS);
	state.onboarding = state.onboarding.filter((entry) => now - entry.at < DAY_MS).slice(-MAX_ONBOARDING);
}

/** What a journal update observed besides its own result: the file was unreadable and was replaced. */
export interface ChannelJournalUpdate<T> {
	readonly result: T;
	readonly reset: boolean;
}

export class ChannelJournal {
	readonly path: string;

	constructor(agentDir: string, channel: string) {
		this.path = join(agentDir, "channels", `${channel}.json`);
	}

	/**
	 * Read, change and write the journal under its lock. An unreadable file is moved aside (kept for inspection), a
	 * fresh journal starts with one `reset` gap, and the update reports it. A throw in `change` writes nothing.
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
			writeFileAtomicSync(this.path, `${JSON.stringify(state)}\n`);
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

/** The turns delivered in the last 24 hours and what they cost: the figures a channel's daily bounds are read against. */
export function channelDayUsage(
	state: Pick<ChannelJournalState, "batches">,
	now: number,
): { readonly wakes: number; readonly usd: number } {
	const recent = state.batches.filter((batch) => now - batch.acceptedAt < DAY_MS);
	return { wakes: recent.length, usd: recent.reduce((sum, batch) => sum + (batch.usd ?? 0), 0) };
}
