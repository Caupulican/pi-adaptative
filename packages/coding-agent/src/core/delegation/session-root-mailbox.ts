import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { sessionRootMailboxFile } from "../agent-paths.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedTextFileSync } from "../util/bounded-file.ts";
import { createReplaySafeMailboxBounder } from "./replay-safe-mailbox-bounds.ts";

const MAX_MANDATORY_REPLIES = 64;
const MAX_RETAINED_REPLIES = 128;
const MAX_REPLAY_RECEIPTS = MAX_RETAINED_REPLIES * 4;
const MAX_REPLY_CONTENT_CHARS = 4_096;
const MAX_REPLY_ENCODED_BYTES = 15 * 1024;
const MAX_IDENTITY_CHARS = 512;
const MAX_MESSAGE_ID_CHARS = 512;
const MAX_ACK_TOKEN_CHARS = 128;
const MAX_TIMESTAMP_CHARS = 128;
const MAX_DEFAULT_REPLAY_RECEIPTS = MAX_REPLAY_RECEIPTS - MAX_MANDATORY_REPLIES;
const MAX_DEFAULT_MAILBOX_BYTES = 128 * 1024;
const MAX_TRANSITION_TIMESTAMP = "9999-12-31T23:59:59.999Z";
const MAX_ENCODED_SOURCE_OWNED_RECEIPT_BYTES =
	Buffer.byteLength(
		JSON.stringify({
			messageId: `session-root-reply-${"f".repeat(64)}`,
			sourceAgentId: `s${"\0".repeat(MAX_IDENTITY_CHARS - 1)}`,
			requestMessageId: `r${"\0".repeat(MAX_MESSAGE_ID_CHARS - 1)}`,
			threadId: `t${"\0".repeat(MAX_IDENTITY_CHARS - 1)}`,
			contentDigest: "f".repeat(64),
			sourceOwned: true,
		}),
		"utf-8",
	) + 1;
const MAX_SOURCE_OWNED_RESERVE_BYTES =
	Math.ceil((MAX_REPLY_ENCODED_BYTES + MAX_ENCODED_SOURCE_OWNED_RECEIPT_BYTES + 1_024) / 1_024) * 1_024;
const MAX_MAILBOX_BYTES = MAX_DEFAULT_MAILBOX_BYTES + MAX_SOURCE_OWNED_RESERVE_BYTES;
const MAX_WAIT_TIMEOUT_MS = 300_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_SIZE = 16;
const RANDOM_UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const listenersByMailboxFile = new Map<string, Set<() => void>>();
const assertSessionRootMailboxBounds = createReplaySafeMailboxBounder(
	"Session root mailbox",
	MAX_RETAINED_REPLIES,
	MAX_REPLAY_RECEIPTS,
	MAX_MAILBOX_BYTES,
);

export interface SessionRootReply {
	messageId: string;
	sourceAgentId: string;
	requestMessageId: string;
	threadId?: string;
	content: string;
	createdAt: string;
	ackToken: string;
	sourceReconciledAt?: string;
	acknowledgedAt?: string;
}

interface SessionRootMailboxState {
	version: 1;
	parentSessionId: string;
	replies: SessionRootReply[];
	replayReceipts: SessionRootReplyReplayReceipt[];
}

interface SessionRootReplyReplayReceipt {
	messageId: string;
	sourceAgentId: string;
	requestMessageId: string;
	threadId?: string;
	contentDigest: string;
	sourceOwned?: true;
}

export type SessionRootReplyAcceptance =
	| { status: "retained"; messageId: string; reply: SessionRootReply; created: boolean }
	| { status: "completed_replay"; messageId: string; created: false };

export interface SessionRootMailboxOptions {
	agentDir: string;
	parentSessionId: string;
}

export interface SessionRootReplyInput {
	sourceAgentId: string;
	requestMessageId: string;
	threadId?: string;
	content: string;
}

export interface SessionRootReplyQuery {
	sourceAgentId?: string;
	requestMessageId?: string;
	maxMessages?: number;
}

export interface SessionRootReplyWaitOptions extends SessionRootReplyQuery {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface SessionRootReplyWaitResult {
	replies: SessionRootReply[];
	timedOut: boolean;
}

function requiredIdentity(value: unknown, label: string): string {
	if (typeof value !== "string") throw new TypeError(`Session root reply ${label} is invalid.`);
	const normalized = value.trim();
	if (!normalized || normalized.length > MAX_IDENTITY_CHARS) {
		throw new TypeError(`Session root reply ${label} is invalid.`);
	}
	return normalized;
}

function optionalIdentity(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	return requiredIdentity(value, label);
}

function requiredContent(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("Session root reply content is invalid.");
	const normalized = value.trim();
	if (!normalized || normalized.length > MAX_REPLY_CONTENT_CHARS) {
		throw new TypeError(
			`Session root reply content must contain from 1 through ${MAX_REPLY_CONTENT_CHARS.toLocaleString("en-US")} characters.`,
		);
	}
	return normalized;
}

function requiredBoundedString(value: unknown, maxChars: number, label: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxChars) {
		throw new Error(`Session root mailbox contains an invalid reply ${label}.`);
	}
	return value;
}

function requiredTimestamp(value: unknown, label: string): string {
	const timestamp = requiredBoundedString(value, MAX_TIMESTAMP_CHARS, label);
	const parsed = new Date(timestamp);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
		throw new Error(`Session root mailbox contains an invalid reply ${label}.`);
	}
	return timestamp;
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
	return value === undefined ? undefined : requiredTimestamp(value, label);
}

function requiredAckToken(value: unknown): string {
	const token = requiredBoundedString(value, MAX_ACK_TOKEN_CHARS, "acknowledgement token");
	if (!RANDOM_UUID_V4_PATTERN.test(token)) {
		throw new Error("Session root mailbox contains an invalid reply acknowledgement token.");
	}
	return token;
}

function inputAckToken(value: unknown): string {
	if (typeof value !== "string" || value.length > MAX_ACK_TOKEN_CHARS || !RANDOM_UUID_V4_PATTERN.test(value)) {
		throw new TypeError("Session root reply acknowledgement token is invalid.");
	}
	return value;
}

function transitionTimestamp(createdAt: string): string {
	const current = new Date().toISOString();
	return current < createdAt ? createdAt : current;
}

function identityDigest(domain: string, identities: readonly string[]): string {
	const hash = createHash("sha256").update(domain);
	for (const identity of identities) hash.update("\0").update(identity);
	return hash.digest("hex");
}

/** Opaque host-owned sender address for root-originated reply-expected worker messages. */
export function sessionRootAddress(parentSessionId: string): string {
	const normalized = requiredIdentity(parentSessionId, "parent session id");
	return `session-root-${identityDigest("pi-session-root-address-v1", [normalized])}`;
}

export function sessionRootReplyMessageId(
	parentSessionId: string,
	sourceAgentId: string,
	requestMessageId: string,
): string {
	return `session-root-reply-${identityDigest("pi-session-root-reply-v1", [
		requiredIdentity(parentSessionId, "parent session id"),
		requiredIdentity(sourceAgentId, "source agent id"),
		requiredIdentity(requestMessageId, "request message id"),
	])}`;
}

function replyContentDigest(content: string): string {
	return identityDigest("pi-session-root-reply-content-v1", [content]);
}

function replayReceipt(reply: SessionRootReply, sourceOwned = false): SessionRootReplyReplayReceipt {
	return {
		messageId: reply.messageId,
		sourceAgentId: reply.sourceAgentId,
		requestMessageId: reply.requestMessageId,
		...(reply.threadId ? { threadId: reply.threadId } : {}),
		contentDigest: replyContentDigest(reply.content),
		...(sourceOwned ? { sourceOwned: true } : {}),
	};
}

function sameReplayIntent(receipt: SessionRootReplyReplayReceipt, reply: SessionRootReply): boolean {
	return (
		receipt.messageId === reply.messageId &&
		receipt.sourceAgentId === reply.sourceAgentId &&
		receipt.requestMessageId === reply.requestMessageId &&
		receipt.threadId === reply.threadId &&
		receipt.contentDigest === replyContentDigest(reply.content)
	);
}

function isMandatory(reply: SessionRootReply): boolean {
	return reply.sourceReconciledAt === undefined || reply.acknowledgedAt === undefined;
}

function pruneRetainedReplies(replies: readonly SessionRootReply[]): SessionRootReply[] {
	const mandatory = replies.filter(isMandatory);
	if (mandatory.length > MAX_MANDATORY_REPLIES) {
		throw new Error(`Session root mailbox reached its ${MAX_MANDATORY_REPLIES} mandatory reply limit.`);
	}
	const remainingSlots = MAX_RETAINED_REPLIES - mandatory.length;
	const completed = replies.filter((reply) => !isMandatory(reply));
	const retainedCompletedIds = new Set(completed.slice(-remainingSlots).map((reply) => reply.messageId));
	return replies.filter((reply) => isMandatory(reply) || retainedCompletedIds.has(reply.messageId));
}

function encodedStateBytes(state: SessionRootMailboxState): number {
	return Buffer.byteLength(`${JSON.stringify(state)}\n`, "utf-8");
}

function lifecycleProjectedEncodedBytes(state: SessionRootMailboxState): number {
	return encodedStateBytes({
		...state,
		replies: state.replies.map((reply) => ({
			...reply,
			sourceReconciledAt: reply.sourceReconciledAt ?? MAX_TRANSITION_TIMESTAMP,
			acknowledgedAt: reply.acknowledgedAt ?? MAX_TRANSITION_TIMESTAMP,
		})),
	});
}

function assertReplyEncodedByteBound(reply: SessionRootReply): void {
	// Reserve both lifecycle fields before accepting content so every durable reply can still fit as
	// one whole entry in the delegate inbox's 16 KiB result envelope after later transitions.
	const transitioned = {
		...reply,
		sourceReconciledAt: reply.sourceReconciledAt ?? reply.createdAt,
		acknowledgedAt: reply.acknowledgedAt ?? reply.createdAt,
	};
	if (Buffer.byteLength(JSON.stringify(transitioned), "utf-8") > MAX_REPLY_ENCODED_BYTES) {
		throw new Error(`Session root reply exceeds its ${MAX_REPLY_ENCODED_BYTES}-byte encoded byte bound.`);
	}
}

function createSessionRootReply(parentSessionId: string, input: SessionRootReplyInput): SessionRootReply {
	const sourceAgentId = requiredIdentity(input.sourceAgentId, "source agent id");
	const requestMessageId = requiredIdentity(input.requestMessageId, "request message id");
	const threadId = optionalIdentity(input.threadId, "thread id");
	const content = requiredContent(input.content);
	const reply: SessionRootReply = {
		messageId: sessionRootReplyMessageId(parentSessionId, sourceAgentId, requestMessageId),
		sourceAgentId,
		requestMessageId,
		...(threadId ? { threadId } : {}),
		content,
		createdAt: new Date().toISOString(),
		ackToken: randomUUID(),
	};
	assertReplyEncodedByteBound(reply);
	return reply;
}

function parseReply(value: unknown, parentSessionId: string): SessionRootReply {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Session root mailbox contains an invalid reply.");
	}
	const candidate = value as Partial<SessionRootReply>;
	const sourceAgentId = requiredBoundedString(candidate.sourceAgentId, MAX_IDENTITY_CHARS, "source agent id");
	const requestMessageId = requiredBoundedString(
		candidate.requestMessageId,
		MAX_MESSAGE_ID_CHARS,
		"request message id",
	);
	const messageId = requiredBoundedString(candidate.messageId, MAX_MESSAGE_ID_CHARS, "message id");
	const threadId =
		candidate.threadId === undefined
			? undefined
			: requiredBoundedString(candidate.threadId, MAX_IDENTITY_CHARS, "thread id");
	const content = requiredBoundedString(candidate.content, MAX_REPLY_CONTENT_CHARS, "content");
	const createdAt = requiredTimestamp(candidate.createdAt, "creation timestamp");
	const ackToken = requiredAckToken(candidate.ackToken);
	const sourceReconciledAt = optionalTimestamp(candidate.sourceReconciledAt, "source reconciliation timestamp");
	const acknowledgedAt = optionalTimestamp(candidate.acknowledgedAt, "acknowledgement timestamp");
	if (sourceReconciledAt !== undefined && sourceReconciledAt < createdAt) {
		throw new Error("Session root mailbox reply source reconciliation timestamp predates creation.");
	}
	if (acknowledgedAt !== undefined && acknowledgedAt < createdAt) {
		throw new Error("Session root mailbox reply acknowledgement timestamp predates creation.");
	}
	if (
		sourceAgentId.trim() !== sourceAgentId ||
		requestMessageId.trim() !== requestMessageId ||
		messageId !== sessionRootReplyMessageId(parentSessionId, sourceAgentId, requestMessageId) ||
		(threadId !== undefined && threadId.trim() !== threadId) ||
		content.trim() !== content
	) {
		throw new Error("Session root mailbox contains an invalid reply.");
	}
	const reply: SessionRootReply = {
		messageId,
		sourceAgentId,
		requestMessageId,
		...(threadId ? { threadId } : {}),
		content,
		createdAt,
		ackToken,
		...(sourceReconciledAt ? { sourceReconciledAt } : {}),
		...(acknowledgedAt ? { acknowledgedAt } : {}),
	};
	assertReplyEncodedByteBound(reply);
	return reply;
}

function parseState(raw: string, parentSessionId: string): SessionRootMailboxState {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("Session root mailbox is invalid JSON.");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Session root mailbox is invalid.");
	}
	const candidate = value as Partial<SessionRootMailboxState>;
	if (candidate.version !== 1 || candidate.parentSessionId !== parentSessionId || !Array.isArray(candidate.replies)) {
		throw new Error("Session root mailbox identity conflicts with the requested foreground session.");
	}
	const replies = candidate.replies.map((reply) => parseReply(reply, parentSessionId));
	const ids = new Set(replies.map((reply) => reply.messageId));
	if (ids.size !== replies.length) throw new Error("Session root mailbox contains duplicate reply identities.");
	const acknowledgementTokens = new Set(replies.map((reply) => reply.ackToken));
	if (acknowledgementTokens.size !== replies.length) {
		throw new Error("Session root mailbox contains duplicate acknowledgement tokens.");
	}
	if (replies.length > MAX_RETAINED_REPLIES) {
		throw new Error(`Session root mailbox exceeds its ${MAX_RETAINED_REPLIES} retained reply limit.`);
	}
	if (replies.filter(isMandatory).length > MAX_MANDATORY_REPLIES) {
		throw new Error(`Session root mailbox exceeds its ${MAX_MANDATORY_REPLIES} mandatory reply limit.`);
	}
	if (candidate.replayReceipts !== undefined && !Array.isArray(candidate.replayReceipts)) {
		throw new Error("Session root mailbox contains invalid replay receipt state.");
	}
	const receiptIds = new Set<string>();
	const replayReceipts = (candidate.replayReceipts ?? []).map((value): SessionRootReplyReplayReceipt => {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("Session root mailbox contains invalid replay receipt state.");
		}
		const receipt = value as Partial<SessionRootReplyReplayReceipt>;
		const messageId = requiredBoundedString(receipt.messageId, MAX_MESSAGE_ID_CHARS, "replay message id");
		const sourceAgentId = requiredBoundedString(receipt.sourceAgentId, MAX_IDENTITY_CHARS, "replay source agent id");
		const requestMessageId = requiredBoundedString(
			receipt.requestMessageId,
			MAX_MESSAGE_ID_CHARS,
			"replay request message id",
		);
		const threadId =
			receipt.threadId === undefined
				? undefined
				: requiredBoundedString(receipt.threadId, MAX_IDENTITY_CHARS, "replay thread id");
		if (
			messageId !== sessionRootReplyMessageId(parentSessionId, sourceAgentId, requestMessageId) ||
			typeof receipt.contentDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(receipt.contentDigest) ||
			(receipt.sourceOwned !== undefined && receipt.sourceOwned !== true) ||
			receiptIds.has(messageId)
		) {
			throw new Error("Session root mailbox contains invalid replay receipt state.");
		}
		receiptIds.add(messageId);
		return {
			messageId,
			sourceAgentId,
			requestMessageId,
			...(threadId ? { threadId } : {}),
			contentDigest: receipt.contentDigest,
			...(receipt.sourceOwned ? { sourceOwned: true } : {}),
		};
	});
	if (replayReceipts.length > MAX_REPLAY_RECEIPTS) {
		throw new Error("Session root mailbox exceeds its replay receipt bound.");
	}
	if (replayReceipts.filter((receipt) => !receipt.sourceOwned).length > MAX_DEFAULT_REPLAY_RECEIPTS) {
		throw new Error("Session root mailbox exceeds its default replay receipt reserve.");
	}
	for (const reply of replies) {
		const receipt = replayReceipts.find((candidate) => candidate.messageId === reply.messageId);
		if (receipt && !sameReplayIntent(receipt, reply)) {
			throw new Error("Session root mailbox reply conflicts with its durable replay receipt.");
		}
	}
	return { version: 1, parentSessionId, replies, replayReceipts };
}

function normalizeQuery(
	query: SessionRootReplyQuery,
): Required<Pick<SessionRootReplyQuery, "maxMessages">> & Omit<SessionRootReplyQuery, "maxMessages"> {
	const maxMessages = query.maxMessages ?? DEFAULT_PAGE_SIZE;
	if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > MAX_MANDATORY_REPLIES) {
		throw new TypeError(`Session root reply page size must be from 1 through ${MAX_MANDATORY_REPLIES}.`);
	}
	const sourceAgentId = optionalIdentity(query.sourceAgentId, "source agent id");
	const requestMessageId = optionalIdentity(query.requestMessageId, "request message id");
	return {
		maxMessages,
		...(sourceAgentId ? { sourceAgentId } : {}),
		...(requestMessageId ? { requestMessageId } : {}),
	};
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new Error("Session root reply wait was aborted.");
}

/** Bounded durable inbox for accepted worker replies addressed to one foreground session root. */
export class SessionRootMailbox {
	private readonly parentSessionId: string;
	private readonly file: string;

	constructor(options: SessionRootMailboxOptions) {
		this.parentSessionId = requiredIdentity(options.parentSessionId, "parent session id");
		this.file = sessionRootMailboxFile(options.agentDir, this.parentSessionId);
	}

	/** Validate and size one canonical reply without mutating durable inbox state. */
	assertReplyInput(input: SessionRootReplyInput): void {
		createSessionRootReply(this.parentSessionId, input);
	}

	enqueueReply(input: SessionRootReplyInput): SessionRootReplyAcceptance {
		return this.enqueueReplyWithAuthority(input, false);
	}

	/** Enqueue a reply whose permanent replay authority is the source worker's durable receipt. */
	enqueueSourceOwnedReply(input: SessionRootReplyInput): SessionRootReplyAcceptance {
		return this.enqueueReplyWithAuthority(input, true);
	}

	private enqueueReplyWithAuthority(input: SessionRootReplyInput, sourceOwned: boolean): SessionRootReplyAcceptance {
		const reply = createSessionRootReply(this.parentSessionId, input);
		const { sourceAgentId, requestMessageId, threadId, content } = reply;
		let accepted = reply;
		let created = false;
		let completedReplay = false;
		this.update((state) => {
			const existing = state.replies.find((candidate) => candidate.messageId === reply.messageId);
			const receipt = state.replayReceipts.find((candidate) => candidate.messageId === reply.messageId);
			if (existing) {
				if (
					existing.sourceAgentId !== sourceAgentId ||
					existing.requestMessageId !== requestMessageId ||
					existing.threadId !== threadId ||
					existing.content !== content
				) {
					throw new Error("Session root reply identity conflicts with an existing reply.");
				}
				if (receipt && !sameReplayIntent(receipt, reply)) {
					throw new Error("Session root reply identity conflicts with its durable replay receipt.");
				}
				accepted = existing;
				return receipt
					? state
					: { ...state, replayReceipts: [...state.replayReceipts, replayReceipt(existing, sourceOwned)] };
			}
			if (receipt) {
				if (!sameReplayIntent(receipt, reply)) {
					throw new Error("Session root reply identity conflicts with its durable replay receipt.");
				}
				completedReplay = true;
				return state;
			}
			if (state.replies.filter(isMandatory).length >= MAX_MANDATORY_REPLIES) {
				throw new Error(`Session root mailbox reached its ${MAX_MANDATORY_REPLIES} mandatory reply limit.`);
			}
			if (
				!sourceOwned &&
				state.replayReceipts.filter((candidate) => !candidate.sourceOwned).length >= MAX_DEFAULT_REPLAY_RECEIPTS
			) {
				throw new Error(
					`Session root mailbox default replay receipt capacity reached its ${MAX_DEFAULT_REPLAY_RECEIPTS} entry limit.`,
				);
			}
			if (state.replies.some((candidate) => candidate.ackToken === reply.ackToken)) {
				throw new Error("Session root mailbox could not allocate a unique acknowledgement token.");
			}
			created = true;
			return {
				...state,
				replies: [...state.replies, reply],
				replayReceipts: [...state.replayReceipts, replayReceipt(reply, sourceOwned)],
			};
		}, !sourceOwned);
		if (created) this.notify();
		if (completedReplay) return { status: "completed_replay", messageId: reply.messageId, created: false };
		return {
			status: "retained",
			messageId: accepted.messageId,
			reply: structuredClone(accepted),
			created,
		};
	}

	pendingReplies(query: SessionRootReplyQuery = {}): SessionRootReply[] {
		const normalized = normalizeQuery(query);
		return this.read()
			.replies.filter(
				(reply) =>
					reply.acknowledgedAt === undefined &&
					(normalized.sourceAgentId === undefined || reply.sourceAgentId === normalized.sourceAgentId) &&
					(normalized.requestMessageId === undefined || reply.requestMessageId === normalized.requestMessageId),
			)
			.slice(0, normalized.maxMessages)
			.map((reply) => structuredClone(reply));
	}

	retainedReplies(): SessionRootReply[] {
		return this.read().replies.map((reply) => structuredClone(reply));
	}

	getReply(messageId: string): SessionRootReply | undefined {
		const normalized = requiredIdentity(messageId, "message id");
		const reply = this.read().replies.find((candidate) => candidate.messageId === normalized);
		return reply ? structuredClone(reply) : undefined;
	}

	markSourceReconciled(messageId: string): boolean {
		const normalized = requiredIdentity(messageId, "message id");
		let accepted = false;
		let changed = false;
		this.update((state) => {
			const existing = state.replies.find((reply) => reply.messageId === normalized);
			if (!existing) return state;
			accepted = true;
			if (existing.sourceReconciledAt !== undefined) return state;
			changed = true;
			return {
				...state,
				replies: state.replies.map((reply) =>
					reply.messageId === normalized
						? { ...reply, sourceReconciledAt: transitionTimestamp(reply.createdAt) }
						: reply,
				),
			};
		});
		if (changed) this.notify();
		return accepted;
	}

	releaseSourceReplayReceipt(messageId: string): boolean {
		const normalized = requiredIdentity(messageId, "message id");
		let released = false;
		this.update((state) => ({
			...state,
			replayReceipts: state.replayReceipts.filter((receipt) => {
				if (receipt.messageId !== normalized || !receipt.sourceOwned) return true;
				released = true;
				return false;
			}),
		}));
		if (released) this.notify();
		return released;
	}

	acknowledge(messageId: string, ackToken: string): boolean {
		const normalizedMessageId = requiredIdentity(messageId, "message id");
		const normalizedToken = inputAckToken(ackToken);
		let accepted = false;
		let changed = false;
		this.update((state) => {
			const existing = state.replies.find((reply) => reply.messageId === normalizedMessageId);
			if (!existing) return state;
			if (existing.ackToken !== normalizedToken) {
				throw new Error("Session root reply acknowledgement token does not match.");
			}
			accepted = true;
			if (existing.acknowledgedAt !== undefined) return state;
			changed = true;
			return {
				...state,
				replies: state.replies.map((reply) =>
					reply.messageId === normalizedMessageId
						? { ...reply, acknowledgedAt: transitionTimestamp(reply.createdAt) }
						: reply,
				),
			};
		});
		if (changed) this.notify();
		return accepted;
	}

	async waitForReplies(options: SessionRootReplyWaitOptions = {}): Promise<SessionRootReplyWaitResult> {
		const query = normalizeQuery(options);
		const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
			throw new TypeError(`Session root reply wait timeout must be from 0 through ${MAX_WAIT_TIMEOUT_MS}.`);
		}
		if (options.signal?.aborted) throw abortReason(options.signal);
		const currentReplies = () => this.pendingReplies(query);
		const immediate = currentReplies();
		if (immediate.length > 0) return { replies: immediate, timedOut: false };
		return new Promise<SessionRootReplyWaitResult>((resolve, reject) => {
			let settled = false;
			let unsubscribe = (): void => undefined;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const signal = options.signal;
			const cleanup = () => {
				unsubscribe();
				if (timeout) clearTimeout(timeout);
				if (signal) signal.removeEventListener("abort", onAbort);
			};
			const settleFromPredicate = () => {
				if (settled) return;
				let replies: SessionRootReply[];
				try {
					replies = currentReplies();
				} catch (error) {
					settled = true;
					cleanup();
					reject(error);
					return;
				}
				if (replies.length === 0) return;
				settled = true;
				cleanup();
				resolve({ replies, timedOut: false });
			};
			const onAbort = () => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(abortReason(signal!));
			};
			unsubscribe = this.subscribe(settleFromPredicate);
			if (settled) {
				unsubscribe();
				return;
			}
			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) {
					onAbort();
					return;
				}
			}
			timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				cleanup();
				let finalReplies: SessionRootReply[];
				try {
					finalReplies = currentReplies();
				} catch (error) {
					reject(error);
					return;
				}
				if (finalReplies.length > 0) {
					resolve({ replies: finalReplies, timedOut: false });
				} else {
					resolve({ replies: finalReplies, timedOut: true });
				}
			}, timeoutMs);
			if (typeof timeout === "object" && timeout && "unref" in timeout) timeout.unref();
			settleFromPredicate();
		});
	}

	/**
	 * Subscribes to process-local mutations for every mailbox instance backed by this file.
	 * Callers must unsubscribe; durable cross-process delivery remains the control owner's responsibility.
	 */
	subscribe(listener: () => void): () => void {
		const listeners = listenersByMailboxFile.get(this.file) ?? new Set<() => void>();
		listenersByMailboxFile.set(this.file, listeners);
		listeners.add(listener);
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			listeners.delete(listener);
			if (listeners.size === 0 && listenersByMailboxFile.get(this.file) === listeners) {
				listenersByMailboxFile.delete(this.file);
			}
		};
	}

	private notify(): void {
		const listeners = listenersByMailboxFile.get(this.file);
		if (!listeners) return;
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch {
				// Subscribers are advisory; the durable reply mutation remains authoritative.
			}
		}
	}

	private read(): SessionRootMailboxState {
		if (!existsSync(this.file)) {
			return { version: 1, parentSessionId: this.parentSessionId, replies: [], replayReceipts: [] };
		}
		return parseState(
			readBoundedTextFileSync(this.file, MAX_MAILBOX_BYTES, "Session root mailbox durable size bound"),
			this.parentSessionId,
		);
	}

	private update(
		mutator: (state: SessionRootMailboxState) => SessionRootMailboxState,
		defaultAdmission = false,
	): void {
		withFileLockSync(this.file, () => {
			const state = this.read();
			const previousDefaultBytes = lifecycleProjectedEncodedBytes(state);
			const mutated = mutator(state);
			let next = {
				...mutated,
				replies: pruneRetainedReplies(mutated.replies),
				replayReceipts: [...mutated.replayReceipts],
			};
			while (
				lifecycleProjectedEncodedBytes(next) > (defaultAdmission ? MAX_DEFAULT_MAILBOX_BYTES : MAX_MAILBOX_BYTES)
			) {
				const oldestCompletedIndex = next.replies.findIndex((reply) => !isMandatory(reply));
				if (oldestCompletedIndex >= 0) {
					next = { ...next, replies: next.replies.filter((_, index) => index !== oldestCompletedIndex) };
					continue;
				}
				break;
			}
			for (const reply of next.replies) assertReplyEncodedByteBound(reply);
			const addedReplayReceipt = mutated.replayReceipts.length > state.replayReceipts.length;
			const bytesWithoutAddedReceipt = addedReplayReceipt
				? lifecycleProjectedEncodedBytes({ ...next, replayReceipts: next.replayReceipts.slice(0, -1) })
				: undefined;
			const nextDefaultBytes = lifecycleProjectedEncodedBytes(next);
			if (
				defaultAdmission &&
				nextDefaultBytes > MAX_DEFAULT_MAILBOX_BYTES &&
				nextDefaultBytes > previousDefaultBytes
			) {
				throw new Error("Session root mailbox default replay receipt storage reserve is exhausted.");
			}
			assertSessionRootMailboxBounds(
				next.replies.length,
				next.replayReceipts.length,
				state.replayReceipts.length,
				nextDefaultBytes,
				bytesWithoutAddedReceipt,
			);
			if (JSON.stringify(next) !== JSON.stringify(state)) {
				writeFileAtomicSync(this.file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
			}
		});
	}
}
