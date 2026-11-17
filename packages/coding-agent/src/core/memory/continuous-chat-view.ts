/** Persistent complete-view state machine for ICM's sawtooth compaction policy. */

import {
	CONTINUOUS_CHAT_CAUSAL_VIEW_HIGH_BYTES,
	CONTINUOUS_CHAT_CAUSAL_VIEW_LOW_BYTES,
	CONTINUOUS_CHAT_TURN_VIEW_HIGH_BYTES,
	CONTINUOUS_CHAT_TURN_VIEW_LOW_BYTES,
} from "../../kernel/session/continuous-chat-view-limits.ts";

export {
	CONTINUOUS_CHAT_CAUSAL_VIEW_HIGH_BYTES,
	CONTINUOUS_CHAT_CAUSAL_VIEW_LOW_BYTES,
	CONTINUOUS_CHAT_TURN_VIEW_HIGH_BYTES,
	CONTINUOUS_CHAT_TURN_VIEW_LOW_BYTES,
} from "../../kernel/session/continuous-chat-view-limits.ts";

import { MinHeap } from "../util/min-heap.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import type { ContinuousChatViewProjection, RenderedContinuousChatView } from "./continuous-chat-cache.ts";
import type { ContinuousChatMessageKind } from "./continuous-chat-contracts.ts";
import {
	CONTINUOUS_CHAT_NOT_MERGED,
	CONTINUOUS_CHAT_NOT_SUMMARIZED,
	type ContinuousChatNodeCoordinate,
	type ContinuousChatTreeNode,
	continuousChatNodeFirstMessage,
	continuousChatNodeKey,
	continuousChatNodeMessageCount,
	continuousChatParentCoordinate,
	renderContinuousChatPendingLine,
	renderContinuousChatViewLine,
} from "./continuous-chat-tree.ts";

export const CONTINUOUS_CHAT_VIEW_SCHEMA_VERSION = 1;
export type ContinuousChatViewKind = "turn" | "causal";

export interface ContinuousChatViewEntry extends ContinuousChatNodeCoordinate {
	size: number;
}

export interface ContinuousChatViewState {
	schemaVersion: typeof CONTINUOUS_CHAT_VIEW_SCHEMA_VERSION;
	kind: ContinuousChatViewKind;
	revision: number;
	totalMessages: number;
	batchPending: boolean;
	lowBytes: number;
	highBytes: number;
	entries: ContinuousChatViewEntry[];
}

/**
 * What fits a view. A message `arrival` commits the pending batch as far as the tree allows. A `background` fit (a node
 * was published, a retry became eligible, a view was loaded) refreshes the lines but commits a batch only when it
 * reaches low water or removes at least one high-water budget, so partial progress never rewrites the view's prefix.
 */
export type ContinuousChatViewFit = "arrival" | "background";

export function createContinuousChatView(kind: ContinuousChatViewKind): ContinuousChatViewState {
	return {
		schemaVersion: CONTINUOUS_CHAT_VIEW_SCHEMA_VERSION,
		kind,
		revision: 0,
		totalMessages: 0,
		batchPending: false,
		lowBytes: kind === "turn" ? CONTINUOUS_CHAT_TURN_VIEW_LOW_BYTES : CONTINUOUS_CHAT_CAUSAL_VIEW_LOW_BYTES,
		highBytes: kind === "turn" ? CONTINUOUS_CHAT_TURN_VIEW_HIGH_BYTES : CONTINUOUS_CHAT_CAUSAL_VIEW_HIGH_BYTES,
		entries: [],
	};
}

export function continuousChatViewBytes(state: ContinuousChatViewState): number {
	let bytes = liveViewBytes.get(state);
	if (bytes === undefined) {
		bytes = state.entries.reduce((total, entry) => total + entry.size, 0);
		liveViewBytes.set(state, bytes);
	}
	return bytes;
}

function entryForNode(node: ContinuousChatTreeNode): ContinuousChatViewEntry {
	return {
		level: node.level,
		ordinal: node.ordinal,
		size: Buffer.byteLength(`${renderContinuousChatViewLine(node)}\n`, "utf8"),
	};
}

function entryForCoordinate(
	coordinate: ContinuousChatNodeCoordinate,
	nodes: ReadonlyMap<string, ContinuousChatTreeNode>,
): ContinuousChatViewEntry {
	const node = nodes.get(continuousChatNodeKey(coordinate));
	if (node !== undefined) return entryForNode(node);
	const pending = `${renderContinuousChatPendingLine(coordinate, CONTINUOUS_CHAT_NOT_SUMMARIZED)}\n`;
	return { ...coordinate, size: Buffer.byteLength(pending, "utf8") };
}

/** Derived byte totals belong to live projections; persisted checkpoints are validated and counted on load. */
const liveViewBytes = new WeakMap<ContinuousChatViewState, number>();

function viewEntryIndex(state: ContinuousChatViewState, start: number): number {
	let low = 0;
	let high = state.entries.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		const entry = state.entries[middle]!;
		if (continuousChatNodeFirstMessage(entry) < start) low = middle + 1;
		else high = middle;
	}
	return low;
}

/** Refresh the exact slot and report whether the new size or a newly mergeable pair could justify a fit. */
export function refreshContinuousChatViewEntry(state: ContinuousChatViewState, node: ContinuousChatTreeNode): boolean {
	const start = continuousChatNodeFirstMessage(node);
	const index = viewEntryIndex(state, start);
	const current = state.entries[index];
	const previousBytes = continuousChatViewBytes(state);
	let bytes = previousBytes;
	if (current?.level === node.level && current.ordinal === node.ordinal) {
		const updated = entryForNode(node);
		bytes += updated.size - current.size;
		state.entries[index] = updated;
		state.revision++;
	}
	liveViewBytes.set(state, bytes);
	if (bytes <= state.highBytes) return false;
	state.batchPending = true;
	const spansEntries =
		current !== undefined && current.level < node.level && continuousChatNodeFirstMessage(current) === start;
	return bytes < previousBytes || previousBytes <= state.highBytes || spansEntries;
}

function validateCompletePartition(state: ContinuousChatViewState): void {
	let nextMessage = 0;
	for (const entry of state.entries) {
		if (continuousChatNodeFirstMessage(entry) !== nextMessage) {
			throw new TypeError("Continuous-chat view is not an ordered complete partition.");
		}
		nextMessage += continuousChatNodeMessageCount(entry.level);
	}
	if (nextMessage !== state.totalMessages) throw new TypeError("Continuous-chat view does not cover totalMessages.");
}

interface DuePair {
	first: number;
	count: number;
	parent: ContinuousChatTreeNode;
	due: number;
}

/** The shared fit steps also let background callers yield while working on a detached view snapshot. */
function* fitContinuousChatView(
	current: ContinuousChatViewState,
	nodes: ReadonlyMap<string, ContinuousChatTreeNode>,
	fit: ContinuousChatViewFit,
): Generator<void, ContinuousChatViewState> {
	const state: ContinuousChatViewState = { ...current, revision: current.revision + 1, entries: [] };
	let before = 0;
	for (const coordinate of current.entries) {
		const entry = entryForCoordinate(coordinate, nodes);
		state.entries.push(entry);
		before += entry.size;
		if (state.entries.length % 256 === 0) yield;
	}
	liveViewBytes.set(state, before);
	if (before <= state.highBytes && (fit !== "arrival" || !state.batchPending)) return state;

	const slots = new Map<number, ContinuousChatViewEntry>();
	const due = new MinHeap<DuePair>((left, right) => right.due - left.due || left.first - right.first);
	const enqueue = (first: number, count: number): void => {
		const left = slots.get(first);
		const right = slots.get(first + count);
		const coordinate = left && right && continuousChatParentCoordinate(left, right);
		if (!coordinate) return;
		const parent = nodes.get(continuousChatNodeKey(coordinate));
		if (parent) due.push({ first, count, parent, due: (state.totalMessages - first - count * 2 + 1) / count });
	};
	for (let index = 0; index < state.entries.length; index++) {
		const entry = state.entries[index]!;
		const first = continuousChatNodeFirstMessage(entry);
		const count = continuousChatNodeMessageCount(entry.level);
		slots.set(first, entry);
		if (entry.ordinal % 2 === 1) enqueue(first - count, count);
		if (index % 256 === 255) yield;
	}
	let mergedBytes = before;
	let merges = 0;
	while (mergedBytes > state.lowBytes) {
		const pair = due.pop();
		if (!pair) break;
		const right = pair.first + pair.count;
		const merged = entryForNode(pair.parent);
		mergedBytes += merged.size - slots.get(pair.first)!.size - slots.get(right)!.size;
		slots.set(pair.first, merged);
		slots.delete(right);
		const count = pair.count * 2;
		enqueue(pair.parent.ordinal % 2 === 0 ? pair.first : pair.first - count, count);
		if (++merges % 256 === 0) yield;
	}
	if (fit === "arrival" || mergedBytes <= Math.max(state.lowBytes, before - state.highBytes)) {
		const entries: ContinuousChatViewEntry[] = [];
		for (let first = 0; first < state.totalMessages; ) {
			const entry = slots.get(first);
			if (!entry) throw new TypeError("Continuous-chat fit lost a partition entry.");
			entries.push(entry);
			first += continuousChatNodeMessageCount(entry.level);
			if (entries.length % 256 === 0) yield;
		}
		state.entries = entries;
		liveViewBytes.set(state, mergedBytes);
	}
	state.batchPending = continuousChatViewBytes(state) > state.lowBytes;
	return state;
}

/** Arrivals commit available progress. Background fits commit a whole batch that achieves the existing savings rule. */
export function refreshContinuousChatView(
	current: ContinuousChatViewState,
	nodes: ReadonlyMap<string, ContinuousChatTreeNode>,
	fit: ContinuousChatViewFit,
): ContinuousChatViewState {
	validateCompletePartition(current);
	const steps = fitContinuousChatView(current, nodes, fit);
	for (;;) {
		const step = steps.next();
		if (step.done) return step.value;
	}
}

export async function fitContinuousChatViewInBackground(
	current: ContinuousChatViewState,
	nodes: ReadonlyMap<string, ContinuousChatTreeNode>,
	yieldChunk: () => Promise<void>,
): Promise<ContinuousChatViewState> {
	const steps = fitContinuousChatView(current, nodes, "background");
	for (;;) {
		const step = steps.next();
		if (step.done) return step.value;
		await yieldChunk();
	}
}

/**
 * Append exactly one leaf, then perform the current batch if the high-water mark was crossed or an earlier batch is
 * waiting for parents. Every returned state still covers all messages exactly once.
 */
export function advanceContinuousChatView(
	current: ContinuousChatViewState,
	messageId: number,
	nodes: ReadonlyMap<string, ContinuousChatTreeNode>,
): ContinuousChatViewState {
	if (!Number.isSafeInteger(messageId) || messageId !== current.totalMessages) {
		throw new TypeError("Continuous-chat view can only append its exact next message leaf.");
	}
	const state: ContinuousChatViewState = {
		...current,
		totalMessages: current.totalMessages + 1,
		entries: [...current.entries, entryForCoordinate({ level: 0, ordinal: messageId }, nodes)],
	};
	return refreshContinuousChatView(state, nodes, "arrival");
}

/** One rendered line, measured as the view's entries are: the line and its newline. */
interface RenderedLine extends ContinuousChatNodeCoordinate {
	text: string;
	bytes: number;
	built: boolean;
}

function renderedLine(coordinate: ContinuousChatNodeCoordinate, text: string, built: boolean): RenderedLine {
	return {
		level: coordinate.level,
		ordinal: coordinate.ordinal,
		text,
		bytes: Buffer.byteLength(`${text}\n`, "utf8"),
		built,
	};
}

/** A coordinate's line: its node's summary, or the pending line for the reason it has none. */
function renderedLineFor(
	coordinate: ContinuousChatNodeCoordinate,
	nodes: ReadonlyMap<string, ContinuousChatTreeNode>,
	reason: string,
): RenderedLine {
	const node = nodes.get(continuousChatNodeKey(coordinate));
	return renderedLine(
		coordinate,
		node === undefined ? renderContinuousChatPendingLine(coordinate, reason) : renderContinuousChatViewLine(node),
		node !== undefined,
	);
}

/**
 * A view's lines as the model reads them. The stored entries stand as they are while the view is within its
 * high-water mark. Past it, the oldest adjacent sibling pairs collapse into their parent (its summary line when the node
 * exists, otherwise a not-merged line) until the view is within its low-water mark. Every collapse removes one line, so the
 * passes end, and a collapsed line opens back into its two lines through zoom. Nothing is stored: merges in the tree
 * and in both stored views are unchanged, and what a model reads stays bounded while merges lag or fail.
 */
function viewRows(state: ContinuousChatViewState, nodes: ReadonlyMap<string, ContinuousChatTreeNode>): RenderedLine[] {
	let rows: RenderedLine[] = [];
	for (const entry of state.entries) {
		let row = renderedLineFor(entry, nodes, CONTINUOUS_CHAT_NOT_SUMMARIZED);
		while (!row.built) {
			const left = rows.at(-1);
			if (!left || left.built) break;
			const parent = continuousChatParentCoordinate(left, row);
			if (!parent) break;
			rows.pop();
			row = renderedLineFor(parent, nodes, CONTINUOUS_CHAT_NOT_MERGED);
		}
		rows.push(row);
	}
	let total = rows.reduce((sum, row) => sum + row.bytes, 0);
	if (total <= state.highBytes) return rows;
	let collapsed = true;
	while (total > state.lowBytes && collapsed) {
		collapsed = false;
		const next: RenderedLine[] = [];
		for (const row of rows) {
			next.push(row);
			while (total > state.lowBytes && next.length >= 2) {
				const left = next[next.length - 2];
				const right = next[next.length - 1];
				if (left === undefined || right === undefined) break;
				const parent = continuousChatParentCoordinate(left, right);
				if (parent === undefined) break;
				const merged = renderedLineFor(parent, nodes, CONTINUOUS_CHAT_NOT_MERGED);
				next.splice(next.length - 2, 2, merged);
				total += merged.bytes - left.bytes - right.bytes;
				collapsed = true;
			}
		}
		rows = next;
	}
	return rows;
}

/**
 * The only way a view reaches a model, the turn's, a worker's birth view and a compaction's causal view alike: the
 * stored entries, collapsed when past the state's own high water (see `viewRows`). A view is never rendered whole.
 */
export const CONTINUOUS_CHAT_RECENT_CUE_COUNT = 8;
const RECENT_CUE_LABELS: Record<ContinuousChatMessageKind, string> = {
	user: "user input",
	pi: "assistant",
	tool: "tool call",
	echo: "tool result",
	work: "background work",
	note: "note",
};

export function renderContinuousChatView(
	state: ContinuousChatViewState,
	nodes: ReadonlyMap<string, ContinuousChatTreeNode>,
	projection: ContinuousChatViewProjection,
	recentKinds: ReadonlyMap<number, ContinuousChatMessageKind> = new Map(),
): RenderedContinuousChatView {
	validateCompletePartition(state);
	const rows = viewRows(state, nodes);
	const firstPending = rows.findIndex((row) => !row.built);
	return Object.freeze({
		text: `<chat>\n${rows
			.map((row) => {
				if (row.built) return row.text;
				const first = continuousChatNodeFirstMessage(row);
				const end = first + continuousChatNodeMessageCount(row.level);
				const cues: string[] = [];
				for (const [id, kind] of recentKinds) {
					if (id >= first && id < end) cues.push(`${id}: ${RECENT_CUE_LABELS[kind]}`);
				}
				return cues.length ? `${row.text} [recent ${cues.join(", ")}]` : row.text;
			})
			.join("\n")}\n</chat>`,
		cache: Object.freeze({
			authority: projection.identity,
			stablePrefixLineCount: firstPending < 0 ? rows.length : firstPending,
			lines: Object.freeze(
				rows.map((row) =>
					Object.freeze({
						level: row.level,
						ordinal: row.ordinal,
						projectionRevision: projection.requiredRevision(
							continuousChatNodeFirstMessage(row) + continuousChatNodeMessageCount(row.level),
						),
					}),
				),
			),
		}),
	});
}

export function parseContinuousChatView(
	value: unknown,
	expectedKind: ContinuousChatViewKind,
): ContinuousChatViewState | undefined {
	if (
		!isPlainRecord(value) ||
		value.schemaVersion !== CONTINUOUS_CHAT_VIEW_SCHEMA_VERSION ||
		value.kind !== expectedKind
	) {
		return undefined;
	}
	if (
		typeof value.revision !== "number" ||
		!Number.isSafeInteger(value.revision) ||
		value.revision < 0 ||
		typeof value.totalMessages !== "number" ||
		!Number.isSafeInteger(value.totalMessages) ||
		value.totalMessages < 0 ||
		typeof value.batchPending !== "boolean" ||
		typeof value.lowBytes !== "number" ||
		!Number.isSafeInteger(value.lowBytes) ||
		value.lowBytes < 1 ||
		typeof value.highBytes !== "number" ||
		!Number.isSafeInteger(value.highBytes) ||
		value.highBytes <= value.lowBytes ||
		!Array.isArray(value.entries)
	) {
		return undefined;
	}
	const entries: ContinuousChatViewEntry[] = [];
	for (const entry of value.entries) {
		if (!isPlainRecord(entry)) return undefined;
		if (
			typeof entry.level !== "number" ||
			!Number.isSafeInteger(entry.level) ||
			entry.level < 0 ||
			typeof entry.ordinal !== "number" ||
			!Number.isSafeInteger(entry.ordinal) ||
			entry.ordinal < 0 ||
			typeof entry.size !== "number" ||
			!Number.isSafeInteger(entry.size) ||
			entry.size < 0
		) {
			return undefined;
		}
		entries.push({ level: entry.level, ordinal: entry.ordinal, size: entry.size });
	}
	const state: ContinuousChatViewState = {
		schemaVersion: CONTINUOUS_CHAT_VIEW_SCHEMA_VERSION,
		kind: expectedKind,
		revision: value.revision,
		totalMessages: value.totalMessages,
		batchPending: value.batchPending,
		lowBytes: value.lowBytes,
		highBytes: value.highBytes,
		entries,
	};
	const defaults = createContinuousChatView(expectedKind);
	if (state.lowBytes !== defaults.lowBytes || state.highBytes !== defaults.highBytes) return undefined;
	try {
		validateCompletePartition(state);
	} catch {
		return undefined;
	}
	return state;
}
