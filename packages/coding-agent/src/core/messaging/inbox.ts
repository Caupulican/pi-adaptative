/**
 * Durable inbox for messages addressed to a recipient that may not be running. The file is the truth and a wake only
 * tells the recipient to look, so a lost wake never loses a message (the pattern of every mailbox in the harness).
 *
 * A pending entry carries its body. Settling an entry drops the body and keeps a small receipt: the receipt makes a
 * retried send idempotent and tells the sender what became of its message. Everything is bounded, and a message the
 * recipient never collects expires.
 */

import { createHash } from "node:crypto";
import { existsSync, type FSWatcher, mkdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { closeWatcher, watchWithErrorHandler } from "../../utils/fs-watch.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedDirectoryNamesSync, readOptionalBoundedTextFileSync } from "../util/bounded-file.ts";
import { KeyedSignal } from "../util/keyed-signal.ts";
import { isPlainRecord } from "../util/value-guards.ts";

export type InboxJson = null | boolean | number | string | InboxJson[] | { [key: string]: InboxJson };
export type InboxEnvelope = { readonly [key: string]: InboxJson };
export type InboxOutcome = "delivered" | "failed" | "expired";

export interface InboxEntry {
	readonly id: string;
	readonly sender: string;
	/** Routing and trust facts the sender sealed with the body; opaque to the inbox. */
	readonly envelope: InboxEnvelope;
	readonly body: string;
	readonly bodyDigest: string;
	readonly createdAt: string;
	/** Collections the recipient tried and could not complete. */
	readonly attempts: number;
}

export interface InboxReceipt {
	readonly id: string;
	readonly sender: string;
	readonly bodyDigest: string;
	readonly createdAt: string;
	readonly settledAt: string;
	readonly outcome: InboxOutcome;
	readonly reason?: string;
}

export type InboxFate =
	| { readonly state: "pending" }
	| { readonly state: InboxOutcome; readonly settledAt: string; readonly reason?: string };

export interface InboxLimits {
	/** A pending entry older than this expires. */
	readonly ttlMs: number;
	readonly maxPending: number;
	readonly maxPendingBodyBytes: number;
	readonly maxBodyBytes: number;
	readonly maxEnvelopeBytes: number;
	readonly maxReceipts: number;
	readonly receiptRetentionMs: number;
	/** Recipient files kept at once. */
	readonly maxFiles: number;
	/** Failed collections before an entry settles as failed. */
	readonly maxAttempts: number;
}

export const DEFAULT_INBOX_LIMITS: InboxLimits = Object.freeze({
	ttlMs: 24 * 60 * 60 * 1000,
	maxPending: 32,
	maxPendingBodyBytes: 256 * 1024,
	maxBodyBytes: 32 * 1024,
	maxEnvelopeBytes: 16 * 1024,
	maxReceipts: 128,
	receiptRetentionMs: 24 * 60 * 60 * 1000,
	maxFiles: 256,
	maxAttempts: 3,
});

export interface InboxEnqueueInput {
	readonly id: string;
	readonly sender: string;
	readonly recipient: string;
	readonly envelope: InboxEnvelope;
	readonly body: string;
}

export type InboxEnqueueResult =
	| { readonly status: "queued" }
	/** The same message was enqueued before; `fate` is what became of it. */
	| { readonly status: "duplicate"; readonly fate: InboxFate }
	/** The id was used before for a different body. */
	| { readonly status: "conflict" }
	| { readonly status: "full"; readonly reason: string };

export class InboxCorruptError extends Error {
	readonly path: string;
	constructor(path: string, reason: string) {
		super(`pi-chat inbox ${path} is unusable: ${reason}`);
		this.name = "InboxCorruptError";
		this.path = path;
	}
}

export interface MessageInboxOptions {
	readonly dir: string;
	readonly limits?: Partial<InboxLimits>;
	/** Epoch milliseconds; the system clock unless a host drives time itself. */
	readonly now?: () => number;
}

interface InboxState {
	readonly version: 1;
	readonly recipient: string;
	readonly entries: readonly InboxEntry[];
	readonly receipts: readonly InboxReceipt[];
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const IDENTITY_MAX_CHARS = 256;
const REASON_MAX_CHARS = 512;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 4096;
const FILE_SUFFIX = ".json";

/** Wakes, in this process, whoever waits on a recipient file; keyed by its path. */
const inboxChanges = new KeyedSignal();
/** One directory watcher per inbox directory in this process, shared by its subscribers. */
const directoryWatchers = new Map<string, { watcher: FSWatcher | null; references: number }>();

function digestOf(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function identityText(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > IDENTITY_MAX_CHARS ||
		/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
	) {
		throw new TypeError(`Inbox ${label} is invalid.`);
	}
	return value;
}

function messageId(value: unknown): string {
	if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new TypeError("Inbox message id is invalid.");
	return value;
}

function timestamp(value: unknown, label: string): string {
	if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
		throw new TypeError(`Inbox ${label} is invalid.`);
	}
	return value;
}

function sameMessage(item: { readonly id: string; readonly sender: string }, sender: string, id: string): boolean {
	return item.id === id && item.sender === sender;
}

function receiptFate(receipt: InboxReceipt): InboxFate {
	return {
		state: receipt.outcome,
		settledAt: receipt.settledAt,
		...(receipt.reason ? { reason: receipt.reason } : {}),
	};
}

function settledReceipt(entry: InboxEntry, outcome: InboxOutcome, settledAt: string, reason?: string): InboxReceipt {
	return {
		id: entry.id,
		sender: entry.sender,
		bodyDigest: entry.bodyDigest,
		createdAt: entry.createdAt,
		settledAt,
		outcome,
		...(reason ? { reason: reason.slice(0, REASON_MAX_CHARS) } : {}),
	};
}

function parseEntry(value: unknown, limits: InboxLimits): InboxEntry {
	if (!isPlainRecord(value)) throw new TypeError("Inbox entry is invalid.");
	const body = value.body;
	if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > limits.maxBodyBytes) {
		throw new TypeError("Inbox entry body is invalid.");
	}
	const bodyDigest = value.bodyDigest;
	if (typeof bodyDigest !== "string" || !DIGEST_PATTERN.test(bodyDigest) || bodyDigest !== digestOf(body)) {
		throw new TypeError("Inbox entry body does not match its digest.");
	}
	const envelope = value.envelope;
	if (!isPlainRecord(envelope) || JSON.stringify(envelope).length > limits.maxEnvelopeBytes) {
		throw new TypeError("Inbox entry envelope is invalid.");
	}
	const attempts = value.attempts;
	if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 0 || attempts > limits.maxAttempts) {
		throw new TypeError("Inbox entry attempts are invalid.");
	}
	return {
		id: messageId(value.id),
		sender: identityText(value.sender, "sender"),
		envelope: envelope as InboxEnvelope,
		body,
		bodyDigest,
		createdAt: timestamp(value.createdAt, "creation time"),
		attempts,
	};
}

function parseReceipt(value: unknown): InboxReceipt {
	if (!isPlainRecord(value)) throw new TypeError("Inbox receipt is invalid.");
	const bodyDigest = value.bodyDigest;
	if (typeof bodyDigest !== "string" || !DIGEST_PATTERN.test(bodyDigest)) {
		throw new TypeError("Inbox receipt digest is invalid.");
	}
	const outcome = value.outcome;
	if (outcome !== "delivered" && outcome !== "failed" && outcome !== "expired") {
		throw new TypeError("Inbox receipt outcome is invalid.");
	}
	const reason = value.reason;
	if (reason !== undefined && (typeof reason !== "string" || reason.length > REASON_MAX_CHARS)) {
		throw new TypeError("Inbox receipt reason is invalid.");
	}
	return {
		id: messageId(value.id),
		sender: identityText(value.sender, "sender"),
		bodyDigest,
		createdAt: timestamp(value.createdAt, "creation time"),
		settledAt: timestamp(value.settledAt, "settlement time"),
		outcome,
		...(reason ? { reason } : {}),
	};
}

function parseState(raw: string, recipient: string, limits: InboxLimits): InboxState {
	const value: unknown = JSON.parse(raw);
	if (
		!isPlainRecord(value) ||
		value.version !== 1 ||
		value.recipient !== recipient ||
		!Array.isArray(value.entries) ||
		!Array.isArray(value.receipts)
	) {
		throw new TypeError("Inbox state does not match its recipient.");
	}
	if (value.entries.length > limits.maxPending || value.receipts.length > limits.maxReceipts) {
		throw new TypeError("Inbox state exceeds its bounds.");
	}
	const entries = value.entries.map((entry) => parseEntry(entry, limits));
	const receipts = value.receipts.map(parseReceipt);
	const seen = new Set<string>();
	for (const item of [...entries, ...receipts]) {
		const key = `${item.sender}\0${item.id}`;
		if (seen.has(key)) throw new TypeError("Inbox state repeats a message.");
		seen.add(key);
	}
	if (
		entries.reduce((total, entry) => total + Buffer.byteLength(entry.body, "utf8"), 0) > limits.maxPendingBodyBytes
	) {
		throw new TypeError("Inbox state exceeds its body bound.");
	}
	return { version: 1, recipient, entries, receipts };
}

/** Expires what outlived its time to live and forgets receipts past their retention. */
function sweep(state: InboxState, nowMs: number, limits: InboxLimits): InboxState {
	const entries: InboxEntry[] = [];
	const receipts = [...state.receipts];
	for (const entry of state.entries) {
		const deadline = Date.parse(entry.createdAt) + limits.ttlMs;
		if (nowMs > deadline) receipts.push(settledReceipt(entry, "expired", new Date(deadline).toISOString()));
		else entries.push(entry);
	}
	const retained = receipts
		.filter((receipt) => nowMs - Date.parse(receipt.settledAt) <= limits.receiptRetentionMs)
		.slice(-limits.maxReceipts);
	return { ...state, entries, receipts: retained };
}

export class MessageInbox {
	private readonly dir: string;
	private readonly limits: InboxLimits;
	private readonly now: () => number;

	constructor(options: MessageInboxOptions) {
		this.dir = options.dir;
		this.limits = { ...DEFAULT_INBOX_LIMITS, ...options.limits };
		this.now = options.now ?? Date.now;
	}

	/** Holds `input` for its recipient. Retrying the same sender and id is idempotent. */
	enqueue(input: InboxEnqueueInput): InboxEnqueueResult {
		const id = messageId(input.id);
		const sender = identityText(input.sender, "sender");
		const recipient = identityText(input.recipient, "recipient");
		const bodyBytes = Buffer.byteLength(input.body, "utf8");
		if (input.body.length === 0 || bodyBytes > this.limits.maxBodyBytes)
			throw new TypeError("Inbox body is invalid.");
		const envelope: unknown = JSON.parse(JSON.stringify(input.envelope));
		if (!isPlainRecord(envelope) || JSON.stringify(envelope).length > this.limits.maxEnvelopeBytes) {
			throw new TypeError("Inbox envelope is invalid.");
		}
		const bodyDigest = digestOf(input.body);
		const file = this.fileFor(recipient);
		if (!existsSync(file) && !this.hasRoomForAnotherFile()) {
			return { status: "full", reason: "too many recipients hold mail on this machine" };
		}
		let result: InboxEnqueueResult = { status: "queued" };
		this.update(recipient, (state, nowMs) => {
			const entry = state.entries.find((candidate) => sameMessage(candidate, sender, id));
			if (entry) {
				result =
					entry.bodyDigest === bodyDigest
						? { status: "duplicate", fate: { state: "pending" } }
						: { status: "conflict" };
				return state;
			}
			const receipt = state.receipts.find((candidate) => sameMessage(candidate, sender, id));
			if (receipt) {
				result =
					receipt.bodyDigest === bodyDigest
						? { status: "duplicate", fate: receiptFate(receipt) }
						: { status: "conflict" };
				return state;
			}
			const pendingBytes = state.entries.reduce((total, held) => total + Buffer.byteLength(held.body, "utf8"), 0);
			if (state.entries.length >= this.limits.maxPending) {
				result = {
					status: "full",
					reason: `${this.limits.maxPending} messages are already held for this recipient`,
				};
				return state;
			}
			if (pendingBytes + bodyBytes > this.limits.maxPendingBodyBytes) {
				result = { status: "full", reason: "this recipient's held messages reached their size bound" };
				return state;
			}
			const held: InboxEntry = {
				id,
				sender,
				envelope: envelope as InboxEnvelope,
				body: input.body,
				bodyDigest,
				createdAt: new Date(nowMs).toISOString(),
				attempts: 0,
			};
			return { ...state, entries: [...state.entries, held] };
		});
		return result;
	}

	/** What became of one message, or undefined when this inbox never held it (or no longer remembers it). */
	fate(recipient: string, sender: string, id: string): InboxFate | undefined {
		const state = this.readIfPresent(identityText(recipient, "recipient"));
		if (!state) return undefined;
		const entry = state.entries.find((candidate) => sameMessage(candidate, sender, id));
		if (entry) {
			const deadline = Date.parse(entry.createdAt) + this.limits.ttlMs;
			return this.now() > deadline
				? { state: "expired", settledAt: new Date(deadline).toISOString() }
				: { state: "pending" };
		}
		const receipt = state.receipts.find((candidate) => sameMessage(candidate, sender, id));
		return receipt ? receiptFate(receipt) : undefined;
	}

	/** Messages still waiting for the recipient, oldest first. Read-only: expiry is applied to the result, not written. */
	pending(recipient: string): InboxEntry[] {
		const state = this.readIfPresent(identityText(recipient, "recipient"));
		if (!state) return [];
		const nowMs = this.now();
		return state.entries.filter((entry) => nowMs <= Date.parse(entry.createdAt) + this.limits.ttlMs);
	}

	/** Settles a waiting message as delivered and drops its body. False when nothing was waiting under that sender and id. */
	settle(recipient: string, sender: string, id: string): boolean {
		return this.close(recipient, sender, id);
	}

	/**
	 * Records that the recipient could not complete a collection. The message waits for the next one until it has failed
	 * `maxAttempts` times, then it settles as failed and drops its body.
	 */
	recordFailure(recipient: string, sender: string, id: string, reason: string): "retry" | "failed" | "missing" {
		let outcome: "retry" | "failed" | "missing" = "missing";
		this.update(identityText(recipient, "recipient"), (state, nowMs) => {
			const entry = state.entries.find((candidate) => sameMessage(candidate, sender, id));
			if (!entry) return state;
			if (entry.attempts + 1 < this.limits.maxAttempts) {
				outcome = "retry";
				return {
					...state,
					entries: state.entries.map((candidate) =>
						candidate === entry ? { ...candidate, attempts: candidate.attempts + 1 } : candidate,
					),
				};
			}
			outcome = "failed";
			return {
				...state,
				entries: state.entries.filter((candidate) => candidate !== entry),
				receipts: [...state.receipts, settledReceipt(entry, "failed", new Date(nowMs).toISOString(), reason)],
			};
		});
		return outcome;
	}

	/**
	 * Calls `listener` when this recipient's file changes, in this process at once and in another process through the
	 * directory watcher. A wake is advisory: the listener re-reads the inbox and must not throw.
	 */
	subscribe(recipient: string, listener: () => void): () => void {
		const file = this.fileFor(identityText(recipient, "recipient"));
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const unsubscribe = inboxChanges.subscribe(file, listener);
		const release = this.watchDirectory();
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			unsubscribe();
			release();
		};
	}

	private close(recipient: string, sender: string, id: string): boolean {
		let settled = false;
		this.update(identityText(recipient, "recipient"), (state, nowMs) => {
			const entry = state.entries.find((candidate) => sameMessage(candidate, sender, id));
			if (!entry) return state;
			settled = true;
			return {
				...state,
				entries: state.entries.filter((candidate) => candidate !== entry),
				receipts: [...state.receipts, settledReceipt(entry, "delivered", new Date(nowMs).toISOString())],
			};
		});
		return settled;
	}

	private fileFor(recipient: string): string {
		return join(this.dir, `${digestOf(`pi-inbox-v1\0${recipient}`).slice(0, 40)}${FILE_SUFFIX}`);
	}

	private readIfPresent(recipient: string): InboxState | undefined {
		const file = this.fileFor(recipient);
		const raw = readOptionalBoundedTextFileSync(file, MAX_FILE_BYTES, "pi-chat inbox");
		if (raw === undefined) return undefined;
		try {
			return parseState(raw, recipient, this.limits);
		} catch (error) {
			throw new InboxCorruptError(file, error instanceof Error ? error.message : String(error));
		}
	}

	/** Read-modify-write of one recipient file under its lock; an emptied file is removed. */
	private update(recipient: string, mutate: (state: InboxState, nowMs: number) => InboxState): void {
		const file = this.fileFor(recipient);
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		let changed = false;
		withFileLockSync(file, () => {
			const nowMs = this.now();
			const current = this.readIfPresent(recipient) ?? { version: 1 as const, recipient, entries: [], receipts: [] };
			const next = mutate(sweep(current, nowMs, this.limits), nowMs);
			if (next.entries.length === 0 && next.receipts.length === 0) {
				if (existsSync(file)) {
					unlinkSync(file);
					changed = true;
				}
				return;
			}
			const encoded = JSON.stringify(next);
			if (encoded === JSON.stringify(current)) return;
			writeFileAtomicSync(file, `${encoded}\n`, { mode: 0o600 });
			changed = true;
		});
		if (changed) this.notify(file);
	}

	private notify(file: string): void {
		try {
			inboxChanges.notify(file);
		} catch {
			// A wake is advisory; the durable change stands.
		}
	}

	private watchDirectory(): () => void {
		let held = directoryWatchers.get(this.dir);
		if (!held) {
			const created: { watcher: FSWatcher | null; references: number } = { watcher: null, references: 0 };
			created.watcher = watchWithErrorHandler(
				this.dir,
				(_event, filename) => {
					if (filename && String(filename).endsWith(FILE_SUFFIX)) {
						this.notify(join(this.dir, basename(String(filename))));
					}
				},
				() => {
					// Without the watcher a change in another process is seen at the recipient's next join.
					closeWatcher(created.watcher);
					created.watcher = null;
				},
			);
			directoryWatchers.set(this.dir, created);
			held = created;
		}
		held.references++;
		const watched = held;
		return () => {
			watched.references--;
			if (watched.references > 0) return;
			closeWatcher(watched.watcher);
			if (directoryWatchers.get(this.dir) === watched) directoryWatchers.delete(this.dir);
		};
	}

	private listFiles(): string[] {
		if (!existsSync(this.dir)) return [];
		return readBoundedDirectoryNamesSync(this.dir, MAX_DIRECTORY_ENTRIES, "pi-chat inbox directory").filter((name) =>
			name.endsWith(FILE_SUFFIX),
		);
	}

	/** Room for a new recipient file, after removing files whose every entry and receipt is past its time. */
	private hasRoomForAnotherFile(): boolean {
		let names = this.listFiles();
		if (names.length < this.limits.maxFiles) return true;
		const nowMs = this.now();
		for (const name of names) {
			const file = join(this.dir, name);
			try {
				if (nowMs - statSync(file).mtimeMs > this.limits.ttlMs + this.limits.receiptRetentionMs) unlinkSync(file);
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
		}
		names = this.listFiles();
		return names.length < this.limits.maxFiles;
	}
}
