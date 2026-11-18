/**
 * Version evidence for owned transcript arrays and immutable request rows.
 */
import { countHistoryWork, historyWorkFallback, inheritHistoryWork } from "@caupulican/pi-ai/history-work";
import type { AgentMessage } from "./types.ts";

const revisions = new WeakMap<readonly object[], { revision: number; appendLineage: object }>();
const contentRevisions = new WeakMap<object, number>();
let contentEpoch = 0;

/** Only arrays owned by Agent have a revision; arbitrary caller arrays must not be memoized. */
export function messageRevision(messages: readonly AgentMessage[]): number | undefined {
	return histories.get(messages)?.ordinaryArray === false ? undefined : revisions.get(messages)?.revision;
}

/** A shared token certifies that the owner only appended since the previous observation. */
export function messageAppendLineage(items: readonly object[]): object | undefined {
	return histories.get(items)?.ordinaryArray === false ? undefined : revisions.get(items)?.appendLineage;
}

/** Publish an Agent-owned change. All mutations except a declared append end the prior lineage. */
function advanceMessageRevision(messages: readonly AgentMessage[], change?: "append"): void {
	const previous = revisions.get(messages);
	if (previous && change === "append") previous.revision++;
	else revisions.set(messages, { revision: (previous?.revision ?? 0) + 1, appendLineage: {} });
}

/**
 * The process-wide epoch of the last published edit to one message, or zero. It moves only when that object is edited in place (a replacement or tool argument normalization),
 * never on append or removal, so a cache keyed by message identity compares it to know whether its reading is still the
 * object's content.
 */
export function messageContentRevision(message: object): number {
	return contentRevisions.get(message) ?? 0;
}

/**
 * The number of in-place content edits of live messages so far, process-wide. A fold that reads message content checks it
 * once per call and starts over when it has moved: any edit may have changed an element the fold already read, and the
 * identity of the element does not show that.
 */
export function messageContentEpoch(): number {
	return contentEpoch;
}

/** Publish an in-place content edit of one live message before any reader can observe the edited content. */
export function advanceMessageContentRevision(message: object): void {
	contentRevisions.set(message, ++contentEpoch);
}

const messageSources = new WeakMap<AgentMessage, AgentMessage>();

/** Preserve provenance when a projection rewrites a message without modifying the original. */
export function withMessageSource<T extends AgentMessage>(source: AgentMessage, projection: T): T {
	messageSources.set(projection, messageSourceOf(source));
	return projection;
}

export function messageSourceOf(message: AgentMessage): AgentMessage {
	return messageSources.get(message) ?? message;
}

const immutableHistoryMessages = new WeakMap<object, { source: AgentMessage; revision: number }>();
const historyVersions = new WeakMap<
	MessageHistoryVersion,
	{ history: HistoryRevision; revision: number; length: number }
>();
const projectedHistoryVersions = new WeakMap<readonly object[], MessageHistoryVersion>();
const projectedHistoryPrefixes = new WeakMap<
	MessageHistoryVersion,
	{ readonly length: number; readonly previous?: WeakRef<MessageHistoryVersion>; readonly prefix: number }
>();
const histories = new WeakMap<readonly object[], HistoryRevision>();
const RETAINED_HISTORY_EDITS = 256;

declare const historyVersionBrand: unique symbol;

/** Opaque evidence that an owner observed a history with immutable rows at one revision. */
export interface MessageHistoryVersion {
	readonly [historyVersionBrand]: true;
}

interface HistoryRevision {
	revision: number;
	lastRewrite: number;
	discardedThrough: number;
	edits: Map<number, number>;
	firstUnownedRow: number;
	ordinaryArray: boolean;
	positions: WeakMap<AgentMessage, Set<number>>;
	version?: MessageHistoryVersion;
}

export function isImmutableHistoryMessage(message: object): boolean {
	return immutableHistoryMessages.has(message);
}

/** Isolate a data-only message before any content-based cache can reuse it. */
export function immutableHistoryMessage(message: AgentMessage): AgentMessage | undefined {
	if (isImmutableHistoryMessage(message)) return message;
	const copies = new WeakMap<object, object>();
	const copy = (value: unknown): unknown => {
		if (typeof value === "function") throw new TypeError("Function in history message");
		if (value === null || typeof value !== "object") return value;
		const existing = copies.get(value);
		if (existing) return existing;
		const prototype = Object.getPrototypeOf(value);
		const isArray = Array.isArray(value);
		if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("Non-data history message");
		}
		const result: object = isArray ? [] : Object.create(prototype);
		copies.set(value, result);
		if (isArray) (result as unknown[]).length = (value as unknown[]).length;
		for (const key of Reflect.ownKeys(value)) {
			if (isArray && key === "length") continue;
			const property = Object.getOwnPropertyDescriptor(value, key);
			if (!property || !("value" in property)) throw new TypeError("Accessor in history message");
			Object.defineProperty(result, key, {
				value: copy(property.value),
				enumerable: property.enumerable,
			});
		}
		return Object.freeze(result);
	};
	try {
		const snapshot = copy(message) as AgentMessage;
		immutableHistoryMessages.set(snapshot, { source: message, revision: messageContentRevision(message) });
		return withMessageSource(message, snapshot);
	} catch {
		return undefined;
	}
}

function recordHistoryChange(history: HistoryRevision, index: number, append: boolean): void {
	history.revision++;
	history.version = undefined;
	if (append) return;
	history.lastRewrite = history.revision;
	history.edits.set(history.revision, index);
	if (history.edits.size > RETAINED_HISTORY_EDITS) {
		const oldest = history.edits.keys().next();
		if (!oldest.done) {
			history.discardedThrough = oldest.value;
			history.edits.delete(oldest.value);
		}
	}
}

function arrayIndex(key: PropertyKey): number | undefined {
	if (typeof key !== "string" || key === "") return undefined;
	const index = Number(key);
	return Number.isInteger(index) && index >= 0 && index < 0xffffffff && String(index) === key ? index : undefined;
}

function countUnownedRow(value: unknown): number {
	return value !== null && typeof value === "object" && isImmutableHistoryMessage(value) ? 0 : 1;
}

/** Track structural edits at the array boundary, including writes made through ordinary Array APIs. */
export function createVersionedMessageHistory(items: readonly AgentMessage[] = []): AgentMessage[] {
	const rows = Array.from(items);
	const history: HistoryRevision = {
		revision: 0,
		lastRewrite: 0,
		discardedThrough: 0,
		edits: new Map(),
		firstUnownedRow: rows.findIndex((row) => countUnownedRow(row) !== 0),
		ordinaryArray: true,
		positions: new WeakMap(),
	};
	const dropPosition = (message: AgentMessage | undefined, index: number): void => {
		if (message !== null && typeof message === "object") history.positions.get(message)?.delete(index);
	};
	const addPosition = (message: AgentMessage | undefined, index: number): void => {
		if (message === null || typeof message !== "object") return;
		const positions = history.positions.get(message);
		if (positions) positions.add(index);
		else history.positions.set(message, new Set([index]));
	};
	rows.forEach(addPosition);
	const tracked = new Proxy(rows, {
		set(target, key, value) {
			if (key === "length") {
				const before = target.length;
				const nextLength = Number(value);
				const removed =
					Number.isInteger(nextLength) && nextLength >= 0 && nextLength < before
						? target.slice(nextLength)
						: undefined;
				if (!Reflect.set(target, key, value)) return false;
				removed?.forEach((row, index) => {
					dropPosition(row, nextLength + index);
				});
				if (target.length !== before) {
					if (target.length > before) {
						if (history.firstUnownedRow === -1) history.firstUnownedRow = before;
					} else if (history.firstUnownedRow >= target.length) {
						history.firstUnownedRow = -1;
					}
					recordHistoryChange(history, Math.min(target.length, before), target.length > before);
					advanceMessageRevision(tracked, target.length > before ? "append" : undefined);
				}
				return true;
			}
			const index = arrayIndex(key);
			if (index === undefined) {
				history.ordinaryArray = false;
				revisions.delete(tracked);
				return Reflect.set(target, key, value);
			}
			const length = target.length;
			const old = target[index];
			if (!Reflect.set(target, key, value)) return false;
			if (index >= length) {
				addPosition(value, index);
				if (history.firstUnownedRow === -1) {
					if (index > length) history.firstUnownedRow = length;
					else if (countUnownedRow(value)) history.firstUnownedRow = index;
				}
				recordHistoryChange(history, length, true);
				advanceMessageRevision(tracked, "append");
			} else if (old !== value) {
				dropPosition(old, index);
				addPosition(value, index);
				if (countUnownedRow(value)) {
					if (history.firstUnownedRow === -1 || index < history.firstUnownedRow) history.firstUnownedRow = index;
				} else if (history.firstUnownedRow === index) {
					history.firstUnownedRow = -1;
					for (let next = index + 1; next < target.length; next++) {
						if (countUnownedRow(target[next])) {
							history.firstUnownedRow = next;
							break;
						}
					}
				}
				recordHistoryChange(history, index, false);
				advanceMessageRevision(tracked);
			}
			return true;
		},
		deleteProperty(target, key) {
			const index = arrayIndex(key);
			const old = index === undefined ? undefined : target[index];
			const deleted = Reflect.deleteProperty(target, key);
			if (deleted && index !== undefined && old !== undefined) {
				dropPosition(old, index);
				if (history.firstUnownedRow === -1 || index < history.firstUnownedRow) history.firstUnownedRow = index;
				recordHistoryChange(history, index, false);
				advanceMessageRevision(tracked);
			}
			return deleted;
		},
		defineProperty(target, key, descriptor) {
			history.ordinaryArray = false;
			revisions.delete(tracked);
			return Reflect.defineProperty(target, key, descriptor);
		},
		setPrototypeOf(target, prototype) {
			history.ordinaryArray = false;
			revisions.delete(tracked);
			return Reflect.setPrototypeOf(target, prototype);
		},
	});
	histories.set(tracked, history);
	advanceMessageRevision(tracked);
	return tracked;
}

function structuralHistoryVersion(items: readonly object[]): MessageHistoryVersion | undefined {
	const history = histories.get(items);
	if (!history?.ordinaryArray) return undefined;
	if (!history.version) {
		history.version = Object.freeze({}) as MessageHistoryVersion;
		historyVersions.set(history.version, { history, revision: history.revision, length: items.length });
	}
	return history.version;
}

/** Capture the prefix of an owned transcript, including mutations published after acceptance. */
export function capturePublishedMessagePrefix(
	getMessages: () => readonly AgentMessage[],
	count: number,
): () => boolean {
	const messages = getMessages();
	const accepted = structuralHistoryVersion(messages);
	if (!accepted || !Number.isSafeInteger(count) || count < 0 || count > messages.length) return () => false;
	return () => {
		const live = structuralHistoryVersion(getMessages());
		return live !== undefined && unchangedMessagePrefix(accepted, live) >= count;
	};
}

/**
 * Register a frozen projection whose owner derived a prefix from a previous snapshot.
 * The owner must certify the rows are immutable and the prefix retained its exact rows.
 */
export function registerProjectedMessageHistory(
	items: AgentMessage[],
	previous: MessageHistoryVersion | undefined,
	prefix: number,
): MessageHistoryVersion {
	const previousLength = previous
		? (historyVersions.get(previous)?.length ?? projectedHistoryPrefixes.get(previous)?.length ?? 0)
		: 0;
	if (!Number.isSafeInteger(prefix) || prefix < 0 || prefix > Math.min(items.length, previousLength)) {
		throw new RangeError("Invalid projected message history prefix");
	}
	Object.freeze(items);
	const version = Object.freeze({}) as MessageHistoryVersion;
	projectedHistoryVersions.set(items, version);
	projectedHistoryPrefixes.set(version, {
		length: items.length,
		previous: previous && new WeakRef(previous),
		prefix,
	});
	return version;
}

export function messageHistoryVersion(
	items: readonly object[],
	prefixLength = items.length,
): MessageHistoryVersion | undefined {
	const projected = projectedHistoryVersions.get(items);
	if (projected && prefixLength === items.length) return projected;
	const history = histories.get(items);
	if (
		!history?.ordinaryArray ||
		!Number.isSafeInteger(prefixLength) ||
		prefixLength < 0 ||
		prefixLength > items.length ||
		(history.firstUnownedRow !== -1 && prefixLength > history.firstUnownedRow)
	)
		return undefined;
	if (prefixLength === items.length) return structuralHistoryVersion(items);
	const version = Object.freeze({}) as MessageHistoryVersion;
	historyVersions.set(version, { history, revision: history.revision, length: prefixLength });
	return version;
}

function sharesHistoryLineage(before: MessageHistoryVersion, after: MessageHistoryVersion): boolean {
	const history = historyVersions.get(before)?.history;
	return history !== undefined && history === historyVersions.get(after)?.history;
}

function invalidateTrackedPrefix(items: AgentMessage[]): void {
	const history = histories.get(items);
	if (history) recordHistoryChange(history, 0, false);
	advanceMessageRevision(items);
}

/** Publish a sanctioned in-place edit on the live transcript so its immutable projection can replace the row. */
export function markMessageHistoryEdit(items: readonly AgentMessage[], message: AgentMessage): void {
	const history = histories.get(items);
	if (!history?.ordinaryArray) return;
	const positions = history.positions.get(message);
	if (positions) {
		let first = items.length;
		for (const index of positions) first = Math.min(first, index);
		if (first < items.length) recordHistoryChange(history, first, false);
	}
	advanceMessageRevision(items);
}

/** Copy-on-write request rows owned independently of public state and event messages. */
export class ImmutableMessageHistory {
	private readonly rows = createVersionedMessageHistory();
	private sourceVersion: MessageHistoryVersion | undefined;

	reset(): void {
		this.sourceVersion = undefined;
		this.rows.length = 0;
	}

	project(source: AgentMessage[], workOwner: object = source): AgentMessage[] {
		inheritHistoryWork(source, workOwner);
		inheritHistoryWork(workOwner, this.rows);
		const nextVersion = structuralHistoryVersion(source);
		if (this.sourceVersion && (!nextVersion || !sharesHistoryLineage(this.sourceVersion, nextVersion))) {
			invalidateTrackedPrefix(this.rows);
		}
		const from = this.sourceVersion && nextVersion ? unchangedMessagePrefix(this.sourceVersion, nextVersion) : 0;
		for (let index = from; index < source.length; index++) {
			if (index < this.rows.length) countHistoryWork(workOwner, "oldRowsRead");
			const current = source[index]!;
			const snapshot = immutableHistoryMessage(current);
			if (!snapshot) {
				historyWorkFallback(workOwner, "non-data-message");
				this.reset();
				return source;
			}
			this.rows[index] = snapshot;
			countHistoryWork(workOwner, "projectedRows");
		}
		this.rows.length = source.length;
		this.sourceVersion = nextVersion;
		return this.rows;
	}
}

/** Compare the wire bytes of reconstructed message records when their references differ. */
export function serializedMessagesEqual(left: AgentMessage, right: AgentMessage): boolean {
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return false;
	}
}

/** Match an immediate immutable snapshot to its source at the revision it captured. */
export function sameMessageContents(left: AgentMessage | undefined, right: AgentMessage): boolean {
	if (!left) return false;
	if (left === right) return true;
	const before = immutableHistoryMessages.get(left);
	const after = immutableHistoryMessages.get(right);
	if (before && after) return before.source === after.source && before.revision === after.revision;
	if (before) return before.source === right && before.revision === messageContentRevision(right);
	return after?.source === left && after.revision === messageContentRevision(left);
}

/** A loop's mutable working copy can reconcile against the canonical list without comparing its old prefix. */
export class MessageHistoryMirror {
	readonly messages = createVersionedMessageHistory();
	private canonicalVersion: MessageHistoryVersion | undefined;
	private mirrorVersion: MessageHistoryVersion | undefined;
	changedFrom: number | undefined;

	refresh(canonical: readonly AgentMessage[]): AgentMessage[] {
		inheritHistoryWork(canonical, this.messages);
		const canonicalVersion = structuralHistoryVersion(canonical);
		const replaced =
			this.canonicalVersion && (!canonicalVersion || !sharesHistoryLineage(this.canonicalVersion, canonicalVersion));
		this.changedFrom = replaced ? 0 : this.messages.length > canonical.length ? canonical.length : undefined;
		if (replaced) invalidateTrackedPrefix(this.messages);
		const mirrorVersion = structuralHistoryVersion(this.messages);
		const from =
			this.canonicalVersion && this.mirrorVersion && canonicalVersion && mirrorVersion
				? Math.min(
						unchangedMessagePrefix(this.canonicalVersion, canonicalVersion),
						unchangedMessagePrefix(this.mirrorVersion, mirrorVersion),
					)
				: 0;
		for (let index = from; index < canonical.length; index++) {
			if (index < this.messages.length) countHistoryWork(this.messages, "oldRowsRead");
			const previous = this.messages[index];
			const current = canonical[index]!;
			if (previous !== current) {
				if (
					(this.changedFrom === undefined || index < this.changedFrom) &&
					!sameMessageContents(previous, current)
				) {
					this.changedFrom = index;
				}
				this.messages[index] = current;
				countHistoryWork(this.messages, "copiedRows");
			}
		}
		if (this.messages.length !== canonical.length) this.messages.length = canonical.length;
		this.canonicalVersion = canonicalVersion;
		this.mirrorVersion = structuralHistoryVersion(this.messages);
		return this.messages;
	}
}

/** Count of leading rows proven unchanged since the earlier observation. */
export function unchangedMessagePrefix(previous: MessageHistoryVersion, current: MessageHistoryVersion): number {
	const projection = projectedHistoryPrefixes.get(current);
	if (projection) {
		if (previous === current) return projection.length;
		return projection.previous?.deref() === previous ? projection.prefix : 0;
	}
	const before = historyVersions.get(previous);
	const after = historyVersions.get(current);
	if (!before || !after || before.history !== after.history || before.revision > after.revision) return 0;
	let prefix = Math.min(before.length, after.length);
	const { history } = after;
	if (before.revision >= history.lastRewrite) return prefix;
	if (before.revision < history.discardedThrough) return 0;
	for (const [revision, index] of history.edits) {
		if (revision > after.revision) break;
		if (revision > before.revision) prefix = Math.min(prefix, index);
	}
	return prefix;
}
