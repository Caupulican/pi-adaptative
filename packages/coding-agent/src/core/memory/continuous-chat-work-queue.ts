/**
 * Durable work queue for the permanent chat tree: which nodes may be built next, which are running, and which wait
 * for another logged message. Pure and immutable: each transition returns a new state, and nothing here reads the
 * tree. Bootstrapping an existing node catalog when queue state is missing is a one-time replay owned by the
 * integration layer, not a work-discovery scan.
 */

import { hasOnlyKeys, isNonNegativeSafeInteger, isPlainRecord } from "../util/value-guards.ts";
import {
	type ContinuousChatNodeCoordinate,
	continuousChatNodeFirstMessage,
	continuousChatNodeKey,
	continuousChatNodeMessageCount,
	continuousChatParentCoordinate,
	parseContinuousChatNodeCoordinate,
} from "./continuous-chat-tree.ts";

export const CONTINUOUS_CHAT_WORK_QUEUE_SCHEMA_VERSION = 2;
export const CONTINUOUS_CHAT_MAX_CONCURRENT_COMPACTIONS = 8;
export const CONTINUOUS_CHAT_LEAF_WINDOW = 8;
/** Leaves claimed while a ready parent waits before that parent is claimed. Leaves still go first otherwise. */
export const CONTINUOUS_CHAT_MAX_LEAF_STREAK = 4;
/** Longest failure reason kept with blocked work. A longer reason is cut at a code point boundary. */
export const CONTINUOUS_CHAT_MAX_FAILURE_REASON_CHARACTERS = 512;

/** Highest level the tree represents. Its nodes have no parent, since a parent would be level 53. */
export const CONTINUOUS_CHAT_TOP_LEVEL = 52;

const WORK_QUEUE_KEYS = [
	"schemaVersion",
	"revision",
	"generation",
	"totalMessages",
	"nextLeaf",
	"halfBuilt",
	"readyLeaves",
	"readyParents",
	"leafStreak",
	"running",
	"blocked",
];

/** A node to build. Level 0 is a leaf whose ordinal is its message id. */
export type ContinuousChatWorkItem = ContinuousChatNodeCoordinate;

/**
 * A failed item. It is retried at the next arrival, which moves `generation` past `retryAfterGeneration`. `reason`
 * is the real failure, kept so a turn that waits on this item reports its cause even after a restart.
 */
export interface ContinuousChatBlockedWork {
	item: ContinuousChatWorkItem;
	retryAfterGeneration: number;
	reason: string;
}

/** Persisted queue. `readyLeaves` holds message ids, and the FIFO queues are ordered oldest first. */
export interface ContinuousChatWorkQueueState {
	schemaVersion: typeof CONTINUOUS_CHAT_WORK_QUEUE_SCHEMA_VERSION;
	revision: number;
	/** Advances on every arrival: a logged message or the start of a user turn. */
	generation: number;
	totalMessages: number;
	nextLeaf: number;
	halfBuilt: ContinuousChatNodeCoordinate[];
	readyLeaves: number[];
	readyParents: ContinuousChatNodeCoordinate[];
	/** Leaves claimed in a row while a parent was ready. Never above `CONTINUOUS_CHAT_MAX_LEAF_STREAK`. */
	leafStreak: number;
	running: ContinuousChatWorkItem[];
	blocked: ContinuousChatBlockedWork[];
}

/** Result of a claim. `item` is absent, and `state` unchanged, when nothing can run. */
export interface ContinuousChatWorkClaim {
	state: ContinuousChatWorkQueueState;
	item?: ContinuousChatWorkItem;
}

/** Persistence port. `load` returns the raw stored value or undefined; `save` must be atomic and durable. */
export interface ContinuousChatWorkQueueStorage {
	load(): Promise<unknown>;
	save(state: ContinuousChatWorkQueueState): Promise<void>;
}

function leafItem(id: number): ContinuousChatWorkItem {
	return { level: 0, ordinal: id };
}

/** Every queued item, leaves included. Keys are unique across this list. */
export function queuedItems(state: ContinuousChatWorkQueueState): ContinuousChatWorkItem[] {
	return [
		...state.readyLeaves.map(leafItem),
		...state.readyParents,
		...state.running,
		...state.blocked.map((entry) => entry.item),
	];
}

/** Admitted leaves that are not built yet. */
function unbuiltLeaves(state: ContinuousChatWorkQueueState): ContinuousChatWorkItem[] {
	return queuedItems(state).filter((item) => item.level === 0);
}

/** The other child of the same parent. XOR would truncate ordinals above 2^31. */
function siblingOf(item: ContinuousChatWorkItem): ContinuousChatWorkItem {
	return { level: item.level, ordinal: item.ordinal % 2 === 0 ? item.ordinal + 1 : item.ordinal - 1 };
}

/** The parent of two aligned siblings, in either order. */
function parentOfPair(
	node: ContinuousChatWorkItem,
	sibling: ContinuousChatWorkItem,
): ContinuousChatNodeCoordinate | undefined {
	return node.ordinal % 2 === 0
		? continuousChatParentCoordinate(node, sibling)
		: continuousChatParentCoordinate(sibling, node);
}

/** Every message the item covers has been admitted, so no coordinate here reaches an unlogged message. */
function isAdmitted(item: ContinuousChatWorkItem, nextLeaf: number): boolean {
	return continuousChatNodeFirstMessage(item) + continuousChatNodeMessageCount(item.level) <= nextLeaf;
}

/** Admit leaves in order until the window is full or the log is exhausted. Every transition ends here. */
function admit(state: ContinuousChatWorkQueueState): ContinuousChatWorkQueueState {
	const count = Math.min(
		state.totalMessages - state.nextLeaf,
		CONTINUOUS_CHAT_LEAF_WINDOW - unbuiltLeaves(state).length,
	);
	if (count <= 0) return state;
	const admitted = Array.from({ length: count }, (_, offset) => state.nextLeaf + offset);
	return { ...state, nextLeaf: state.nextLeaf + count, readyLeaves: [...state.readyLeaves, ...admitted] };
}

/** The running list without `item`. Only claimed work can fail or be released. */
function withoutRunning(state: ContinuousChatWorkQueueState, item: ContinuousChatWorkItem): ContinuousChatWorkItem[] {
	const key = continuousChatNodeKey(item);
	if (!state.running.some((entry) => continuousChatNodeKey(entry) === key)) {
		throw new RangeError("Continuous-chat work item is not running.");
	}
	return state.running.filter((entry) => continuousChatNodeKey(entry) !== key);
}

function parseParentCoordinate(value: unknown): ContinuousChatNodeCoordinate | undefined {
	const coordinate = parseContinuousChatNodeCoordinate(value);
	return coordinate !== undefined && coordinate.level >= 1 ? coordinate : undefined;
}

function parseLeafId(value: unknown): number | undefined {
	return isNonNegativeSafeInteger(value) ? value : undefined;
}

/** A non-empty reason within the bound. A blocked entry without a reason is invalid. */
function isBoundedFailureReason(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		Array.from(value).length <= CONTINUOUS_CHAT_MAX_FAILURE_REASON_CHARACTERS
	);
}

/** The reason as stored: non-empty, and cut to the bound at a code point boundary. */
function storedFailureReason(reason: string): string {
	if (reason.length === 0) throw new RangeError("Continuous-chat work failure needs a reason.");
	return Array.from(reason).slice(0, CONTINUOUS_CHAT_MAX_FAILURE_REASON_CHARACTERS).join("");
}

function parseBlockedWork(value: unknown): ContinuousChatBlockedWork | undefined {
	if (!isPlainRecord(value) || !hasOnlyKeys(value, ["item", "retryAfterGeneration", "reason"])) return undefined;
	const item = parseContinuousChatNodeCoordinate(value.item);
	const { retryAfterGeneration, reason } = value;
	if (item === undefined || !isNonNegativeSafeInteger(retryAfterGeneration) || !isBoundedFailureReason(reason)) {
		return undefined;
	}
	return { item, retryAfterGeneration, reason };
}

/** Parses every entry or none: one malformed entry rejects the whole list. */
function parseList<T>(value: unknown, parseEntry: (entry: unknown) => T | undefined): T[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const entries: T[] = [];
	for (const entry of value) {
		const parsed = parseEntry(entry);
		if (parsed === undefined) return undefined;
		entries.push(parsed);
	}
	return entries;
}

function isConsistentHalfBuilt(
	state: ContinuousChatWorkQueueState,
	queued: readonly ContinuousChatWorkItem[],
	queuedKeys: ReadonlySet<string>,
): boolean {
	const halfKeys = new Set(state.halfBuilt.map(continuousChatNodeKey));
	if (halfKeys.size !== state.halfBuilt.length) return false;
	for (const node of state.halfBuilt) {
		if (!isAdmitted(node, state.nextLeaf) || queuedKeys.has(continuousChatNodeKey(node))) return false;
		const sibling = siblingOf(node);
		if (halfKeys.has(continuousChatNodeKey(sibling))) return false;
		if (node.level < CONTINUOUS_CHAT_TOP_LEVEL) {
			const parent = parentOfPair(node, sibling);
			if (parent === undefined) return false;
			const parentKey = continuousChatNodeKey(parent);
			if (queuedKeys.has(parentKey) || halfKeys.has(parentKey)) return false;
		}
	}
	// A queued parent exists only after both children have left the queues and halfBuilt.
	for (const item of queued) {
		if (item.level === 0) continue;
		for (const ordinal of [item.ordinal * 2, item.ordinal * 2 + 1]) {
			const childKey = continuousChatNodeKey({ level: item.level - 1, ordinal });
			if (queuedKeys.has(childKey) || halfKeys.has(childKey)) return false;
		}
	}
	return true;
}

/** Invariants that every transition preserves. A stored state that breaks one is contradictory. */
function isConsistentQueue(state: ContinuousChatWorkQueueState): boolean {
	const queued = queuedItems(state);
	const queuedKeys = new Set(queued.map(continuousChatNodeKey));
	if (queuedKeys.size !== queued.length) return false;
	if (!queued.every((item) => isAdmitted(item, state.nextLeaf))) return false;
	if (state.running.length > CONTINUOUS_CHAT_MAX_CONCURRENT_COMPACTIONS) return false;
	const pending = unbuiltLeaves(state).length;
	if (pending > CONTINUOUS_CHAT_LEAF_WINDOW) return false;
	if (state.nextLeaf !== state.totalMessages && pending !== CONTINUOUS_CHAT_LEAF_WINDOW) return false;
	// A failure is retry-eligible at the next arrival, which moves it out of blocked.
	if (state.blocked.some((entry) => entry.retryAfterGeneration !== state.generation)) return false;
	return isConsistentHalfBuilt(state, queued, queuedKeys);
}

/** An empty queue: nothing logged, nothing admitted. */
export function createContinuousChatWorkQueue(): ContinuousChatWorkQueueState {
	return {
		schemaVersion: CONTINUOUS_CHAT_WORK_QUEUE_SCHEMA_VERSION,
		revision: 0,
		generation: 0,
		totalMessages: 0,
		nextLeaf: 0,
		halfBuilt: [],
		readyLeaves: [],
		readyParents: [],
		leafStreak: 0,
		running: [],
		blocked: [],
	};
}

/** Strict parse of stored state. Returns a normalized copy, or undefined for anything malformed or contradictory. */
export function parseContinuousChatWorkQueue(value: unknown): ContinuousChatWorkQueueState | undefined {
	if (!isPlainRecord(value) || !hasOnlyKeys(value, WORK_QUEUE_KEYS)) return undefined;
	const { schemaVersion, revision, generation, totalMessages, nextLeaf, leafStreak } = value;
	if (schemaVersion !== CONTINUOUS_CHAT_WORK_QUEUE_SCHEMA_VERSION) return undefined;
	if (!isNonNegativeSafeInteger(revision) || !isNonNegativeSafeInteger(generation)) return undefined;
	if (!isNonNegativeSafeInteger(totalMessages)) return undefined;
	if (!isNonNegativeSafeInteger(nextLeaf) || nextLeaf > totalMessages) return undefined;
	if (!isNonNegativeSafeInteger(leafStreak) || leafStreak > CONTINUOUS_CHAT_MAX_LEAF_STREAK) return undefined;
	const halfBuilt = parseList(value.halfBuilt, parseContinuousChatNodeCoordinate);
	const readyLeaves = parseList(value.readyLeaves, parseLeafId);
	const readyParents = parseList(value.readyParents, parseParentCoordinate);
	const running = parseList(value.running, parseContinuousChatNodeCoordinate);
	const blocked = parseList(value.blocked, parseBlockedWork);
	if (!halfBuilt || !readyLeaves || !readyParents || !running || !blocked) return undefined;
	const state: ContinuousChatWorkQueueState = {
		schemaVersion: CONTINUOUS_CHAT_WORK_QUEUE_SCHEMA_VERSION,
		revision,
		generation,
		totalMessages,
		nextLeaf,
		halfBuilt,
		readyLeaves,
		readyParents,
		leafStreak,
		running,
		blocked,
	};
	return isConsistentQueue(state) ? state : undefined;
}

/**
 * Blocked work recorded before the current generation is retry-eligible. Blocked entries are oldest first, so the
 * eligible ones are a prefix.
 */
function releaseEligible(state: ContinuousChatWorkQueueState): ContinuousChatWorkQueueState {
	const retry: ContinuousChatBlockedWork[] = [];
	for (const entry of state.blocked) {
		if (entry.retryAfterGeneration >= state.generation) break;
		retry.push(entry);
	}
	if (retry.length === 0) return state;
	const readyLeaves = [...state.readyLeaves];
	const readyParents = [...state.readyParents];
	for (const { item } of retry) {
		if (item.level === 0) readyLeaves.push(item.ordinal);
		else readyParents.push(item);
	}
	return { ...state, readyLeaves, readyParents, blocked: state.blocked.slice(retry.length) };
}

/**
 * An arrival: a user turn began. It advances the generation, releases failed work for another attempt, and refills
 * the leaf window. A failure waits for an arrival, never for a timer.
 */
export function noteContinuousChatArrival(state: ContinuousChatWorkQueueState): ContinuousChatWorkQueueState {
	return admit(releaseEligible({ ...state, revision: state.revision + 1, generation: state.generation + 1 }));
}

/**
 * The log reached `totalMessages`. Every new permanent message is an arrival, so the generation advances by the
 * number of messages, blocked work is released, and the leaf window refills. An equal count returns the same state.
 */
export function recordContinuousChatMessages(
	state: ContinuousChatWorkQueueState,
	totalMessages: number,
): ContinuousChatWorkQueueState {
	if (!Number.isSafeInteger(totalMessages) || totalMessages < state.totalMessages) {
		throw new RangeError("Continuous-chat message count must not decrease.");
	}
	if (totalMessages === state.totalMessages) return state;
	const arrivals = totalMessages - state.totalMessages;
	return admit(
		releaseEligible({
			...state,
			revision: state.revision + 1,
			generation: state.generation + arrivals,
			totalMessages,
		}),
	);
}

/**
 * Claims one ready item. Leaves go first so the turn barrier opens, but a ready parent is claimed once
 * `CONTINUOUS_CHAT_MAX_LEAF_STREAK` leaves were claimed while it waited, so parents cannot starve. Nothing runnable
 * returns the same state.
 */
export function claimContinuousChatWork(state: ContinuousChatWorkQueueState): ContinuousChatWorkClaim {
	if (state.running.length >= CONTINUOUS_CHAT_MAX_CONCURRENT_COMPACTIONS) return { state };
	const leafId = state.readyLeaves[0];
	const parent = state.readyParents[0];
	if (parent !== undefined && (leafId === undefined || state.leafStreak >= CONTINUOUS_CHAT_MAX_LEAF_STREAK)) {
		return {
			item: parent,
			state: {
				...state,
				revision: state.revision + 1,
				readyParents: state.readyParents.slice(1),
				running: [...state.running, parent],
				leafStreak: 0,
			},
		};
	}
	if (leafId === undefined) return { state };
	const item = leafItem(leafId);
	return {
		item,
		state: {
			...state,
			revision: state.revision + 1,
			readyLeaves: state.readyLeaves.slice(1),
			running: [...state.running, item],
			leafStreak: parent === undefined ? 0 : state.leafStreak + 1,
		},
	};
}

/**
 * A node is published. If its sibling already waits in halfBuilt, their parent becomes ready; otherwise the node
 * waits there. A node this queue does not hold (duplicate, stale, or published elsewhere) returns the same state.
 */
export function completeContinuousChatWork(
	state: ContinuousChatWorkQueueState,
	node: ContinuousChatNodeCoordinate,
): ContinuousChatWorkQueueState {
	const key = continuousChatNodeKey(node);
	if (!queuedItems(state).some((item) => continuousChatNodeKey(item) === key)) return state;
	const sibling = siblingOf(node);
	const siblingKey = continuousChatNodeKey(sibling);
	const siblingBuilt = state.halfBuilt.some((entry) => continuousChatNodeKey(entry) === siblingKey);
	const parent = siblingBuilt && node.level < CONTINUOUS_CHAT_TOP_LEVEL ? parentOfPair(node, sibling) : undefined;
	const readyParents = state.readyParents.filter((item) => continuousChatNodeKey(item) !== key);
	const halfBuilt = state.halfBuilt.filter((entry) => continuousChatNodeKey(entry) !== siblingKey);
	return admit({
		...state,
		revision: state.revision + 1,
		readyLeaves: node.level === 0 ? state.readyLeaves.filter((id) => id !== node.ordinal) : state.readyLeaves,
		readyParents: parent === undefined ? readyParents : [...readyParents, parent],
		running: state.running.filter((item) => continuousChatNodeKey(item) !== key),
		blocked: state.blocked.filter((entry) => continuousChatNodeKey(entry.item) !== key),
		halfBuilt: parent === undefined ? [...halfBuilt, node] : halfBuilt,
	});
}

/** A claimed item failed. It keeps its leaf-window slot until a later arrival makes it retry-eligible. */
export function failContinuousChatWork(
	state: ContinuousChatWorkQueueState,
	item: ContinuousChatWorkItem,
	reason: string,
): ContinuousChatWorkQueueState {
	const running = withoutRunning(state, item);
	return {
		...state,
		revision: state.revision + 1,
		running,
		blocked: [
			...state.blocked,
			{ item, retryAfterGeneration: state.generation, reason: storedFailureReason(reason) },
		],
	};
}

/** A claimed item is handed back without failing (cancelled or superseded). It goes to the front of its queue. */
export function releaseContinuousChatWork(
	state: ContinuousChatWorkQueueState,
	item: ContinuousChatWorkItem,
): ContinuousChatWorkQueueState {
	const running = withoutRunning(state, item);
	const next = { ...state, revision: state.revision + 1, running };
	return item.level === 0
		? { ...next, readyLeaves: [item.ordinal, ...state.readyLeaves] }
		: { ...next, readyParents: [item, ...state.readyParents] };
}

/** Restart recovery: claimed items return to the front of their queues in claim order. */
export function recoverContinuousChatWorkQueue(state: ContinuousChatWorkQueueState): ContinuousChatWorkQueueState {
	if (state.running.length === 0) return state;
	const leafIds = state.running.filter((item) => item.level === 0).map((item) => item.ordinal);
	const parents = state.running.filter((item) => item.level > 0);
	return {
		...state,
		revision: state.revision + 1,
		running: [],
		readyLeaves: [...leafIds, ...state.readyLeaves],
		readyParents: [...parents, ...state.readyParents],
	};
}

/** Message ids below the returned id are all built. The causal view stops here, so no call sees an unbuilt line. */
export function continuousChatBuiltLeafPrefix(state: ContinuousChatWorkQueueState): number {
	return unbuiltLeaves(state).reduce((prefix, item) => Math.min(prefix, item.ordinal), state.nextLeaf);
}

/** Key of a work item. It is the same key the tree uses for its nodes. */
export function continuousChatWorkItemKey(item: ContinuousChatWorkItem): string {
	return continuousChatNodeKey(item);
}
