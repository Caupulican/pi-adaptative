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

import { isPlainRecord } from "../util/value-guards.ts";
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
	return state.entries.reduce((total, entry) => total + entry.size, 0);
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
	index: number;
	parent: ContinuousChatTreeNode;
	due: number;
}

function mostDuePair(
	state: ContinuousChatViewState,
	nodes: ReadonlyMap<string, ContinuousChatTreeNode>,
): DuePair | undefined {
	let selected: DuePair | undefined;
	for (let index = 0; index + 1 < state.entries.length; index++) {
		const left = state.entries[index];
		const right = state.entries[index + 1];
		if (left === undefined || right === undefined) continue;
		const parentCoordinate = continuousChatParentCoordinate(left, right);
		if (parentCoordinate === undefined) continue;
		const parent = nodes.get(continuousChatNodeKey(parentCoordinate));
		if (parent === undefined) continue;
		const lastMessage = continuousChatNodeFirstMessage(right) + continuousChatNodeMessageCount(right.level) - 1;
		const due = (state.totalMessages - lastMessage) / continuousChatNodeMessageCount(left.level);
		if (selected === undefined || due > selected.due) selected = { index, parent, due };
	}
	return selected;
}

/** A copy of the view with the most due available pairs merged until low water or until no built parent remains. */
function mergeDuePairs(
	state: ContinuousChatViewState,
	nodes: ReadonlyMap<string, ContinuousChatTreeNode>,
): ContinuousChatViewState {
	const merged: ContinuousChatViewState = { ...state, entries: [...state.entries] };
	while (continuousChatViewBytes(merged) > merged.lowBytes) {
		const selected = mostDuePair(merged, nodes);
		if (selected === undefined) break;
		merged.entries.splice(selected.index, 2, entryForNode(selected.parent));
	}
	return merged;
}

/**
 * Refreshes every line against the tree, then fits the view. Past high water (or with a batch pending, on an arrival)
 * the merge is proposed from a copy. An arrival commits whatever the proposal reached. A background fit commits only a
 * proposal that reaches low water or saves at least one high-water budget, so the lines are always current while the
 * partition changes in whole batches.
 */
export function refreshContinuousChatView(
	current: ContinuousChatViewState,
	nodes: ReadonlyMap<string, ContinuousChatTreeNode>,
	fit: ContinuousChatViewFit,
): ContinuousChatViewState {
	const state: ContinuousChatViewState = {
		...current,
		revision: current.revision + 1,
		entries: current.entries.map((entry) => entryForCoordinate(entry, nodes)),
	};
	const before = continuousChatViewBytes(state);
	if (before > state.highBytes || (fit === "arrival" && state.batchPending)) {
		const proposed = mergeDuePairs(state, nodes);
		if (
			fit === "arrival" ||
			continuousChatViewBytes(proposed) <= Math.max(state.lowBytes, before - state.highBytes)
		) {
			state.entries = proposed.entries;
		}
		state.batchPending = continuousChatViewBytes(state) > state.lowBytes;
	}
	validateCompletePartition(state);
	return state;
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
		entries: [
			...current.entries.map((entry) => entryForCoordinate(entry, nodes)),
			entryForCoordinate({ level: 0, ordinal: messageId }, nodes),
		],
	};
	return refreshContinuousChatView(state, nodes, "arrival");
}

export function renderContinuousChatView(
	state: ContinuousChatViewState,
	nodes: ReadonlyMap<string, ContinuousChatTreeNode>,
): string {
	validateCompletePartition(state);
	const lines = state.entries.map((entry) => {
		const node = nodes.get(continuousChatNodeKey(entry));
		return node === undefined
			? renderContinuousChatPendingLine(entry, CONTINUOUS_CHAT_NOT_SUMMARIZED)
			: renderContinuousChatViewLine(node);
	});
	return `<chat>\n${lines.join("\n")}\n</chat>`;
}

/** One rendered line, measured as the view's entries are: the line and its newline. */
interface RenderedLine extends ContinuousChatNodeCoordinate {
	text: string;
	bytes: number;
}

function renderedLine(coordinate: ContinuousChatNodeCoordinate, text: string): RenderedLine {
	return { level: coordinate.level, ordinal: coordinate.ordinal, text, bytes: Buffer.byteLength(`${text}\n`, "utf8") };
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
	);
}

/**
 * The turn view's lines as the model reads them. The stored entries stand as they are while the view is within its
 * high-water mark. Past it, the oldest adjacent sibling pairs collapse into their parent (its summary line when the node
 * exists, otherwise a not-merged line) until the view is within its low-water mark. Every collapse removes one line, so the
 * passes end, and a collapsed line opens back into its two lines through zoom. Nothing is stored: merges in the tree
 * and the causal view are unchanged, and a pinned view stays bounded while merges lag.
 */
function turnViewRows(
	state: ContinuousChatViewState,
	nodes: ReadonlyMap<string, ContinuousChatTreeNode>,
): RenderedLine[] {
	let rows = state.entries.map((entry) => renderedLineFor(entry, nodes, CONTINUOUS_CHAT_NOT_SUMMARIZED));
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

/** The turn view as the model reads it: the stored entries, collapsed when past high water (see `turnViewRows`). */
export function renderContinuousChatTurnView(
	state: ContinuousChatViewState,
	nodes: ReadonlyMap<string, ContinuousChatTreeNode>,
): string {
	validateCompletePartition(state);
	const lines = turnViewRows(state, nodes).map((row) => row.text);
	return `<chat>\n${lines.join("\n")}\n</chat>`;
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
