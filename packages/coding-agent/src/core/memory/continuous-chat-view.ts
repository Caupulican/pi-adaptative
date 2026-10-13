/** Persistent complete-view state machine for ICM's sawtooth compaction policy. */

import { isPlainRecord } from "../util/value-guards.ts";
import {
	type ContinuousChatNodeCoordinate,
	type ContinuousChatTreeNode,
	continuousChatNodeFirstMessage,
	continuousChatNodeKey,
	continuousChatNodeMessageCount,
	continuousChatParentCoordinate,
	renderContinuousChatViewLine,
} from "./continuous-chat-tree.ts";

export const CONTINUOUS_CHAT_VIEW_SCHEMA_VERSION = 1;
export const CONTINUOUS_CHAT_TURN_VIEW_LOW_BYTES = 64_000;
export const CONTINUOUS_CHAT_TURN_VIEW_HIGH_BYTES = 128_000;
export const CONTINUOUS_CHAT_CAUSAL_VIEW_LOW_BYTES = 16_000;
export const CONTINUOUS_CHAT_CAUSAL_VIEW_HIGH_BYTES = 32_000;

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

export interface ContinuousChatViewAdvance {
	state: ContinuousChatViewState;
	mergedParents: ContinuousChatNodeCoordinate[];
}

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
	const pending = `${continuousChatNodeFirstMessage(coordinate)}+${continuousChatNodeMessageCount(coordinate.level)}|(not summarized yet: zoom it)\n`;
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

export function refreshContinuousChatView(
	current: ContinuousChatViewState,
	nodes: ReadonlyMap<string, ContinuousChatTreeNode>,
): ContinuousChatViewAdvance {
	const state: ContinuousChatViewState = {
		...current,
		revision: current.revision + 1,
		entries: current.entries.map((entry) => entryForCoordinate(entry, nodes)),
	};
	const mergedParents: ContinuousChatNodeCoordinate[] = [];
	if (continuousChatViewBytes(state) > state.highBytes || state.batchPending) {
		while (continuousChatViewBytes(state) > state.lowBytes) {
			const selected = mostDuePair(state, nodes);
			if (selected === undefined) break;
			state.entries.splice(selected.index, 2, entryForNode(selected.parent));
			mergedParents.push({ level: selected.parent.level, ordinal: selected.parent.ordinal });
		}
		state.batchPending = continuousChatViewBytes(state) > state.lowBytes;
	}
	validateCompletePartition(state);
	return { state, mergedParents };
}

/**
 * Append exactly one leaf, then perform the current batch if the high-water mark was crossed or an
 * earlier batch is waiting for parents. Every returned state still covers all messages exactly once.
 */
export function advanceContinuousChatView(
	current: ContinuousChatViewState,
	messageId: number,
	nodes: ReadonlyMap<string, ContinuousChatTreeNode>,
): ContinuousChatViewAdvance {
	if (!Number.isSafeInteger(messageId) || messageId !== current.totalMessages) {
		throw new TypeError("Continuous-chat view can only append its exact next message leaf.");
	}
	const state: ContinuousChatViewState = {
		...current,
		revision: current.revision + 1,
		totalMessages: current.totalMessages + 1,
		entries: [
			...current.entries.map((entry) => entryForCoordinate(entry, nodes)),
			entryForCoordinate({ level: 0, ordinal: messageId }, nodes),
		],
	};
	const refreshed = refreshContinuousChatView({ ...state, revision: state.revision - 1 }, nodes);
	return { state: refreshed.state, mergedParents: refreshed.mergedParents };
}

/**
 * Applies merges already chosen by the main view to another complete view when it still contains both children. This
 * is the one coupling required by the reference: a main-view merge is never absent from the causal view merely because
 * the causal view has not crossed its own high-water mark yet.
 */
export function applyContinuousChatViewMerges(
	current: ContinuousChatViewState,
	parents: readonly ContinuousChatNodeCoordinate[],
	nodes: ReadonlyMap<string, ContinuousChatTreeNode>,
): ContinuousChatViewState {
	if (parents.length === 0) return current;
	const state: ContinuousChatViewState = { ...current, entries: [...current.entries] };
	let changed = false;
	for (const parentCoordinate of parents) {
		if (parentCoordinate.level === 0) continue;
		const left = { level: parentCoordinate.level - 1, ordinal: parentCoordinate.ordinal * 2 };
		const right = { level: parentCoordinate.level - 1, ordinal: parentCoordinate.ordinal * 2 + 1 };
		const index = state.entries.findIndex((entry) => entry.level === left.level && entry.ordinal === left.ordinal);
		const next = state.entries[index + 1];
		const parent = nodes.get(continuousChatNodeKey(parentCoordinate));
		if (index < 0 || next?.level !== right.level || next.ordinal !== right.ordinal || parent === undefined) continue;
		state.entries.splice(index, 2, entryForNode(parent));
		changed = true;
	}
	if (!changed) return current;
	state.revision = current.revision + 1;
	validateCompletePartition(state);
	return state;
}

export function renderContinuousChatView(
	state: ContinuousChatViewState,
	nodes: ReadonlyMap<string, ContinuousChatTreeNode>,
): string {
	validateCompletePartition(state);
	const lines = state.entries.map((entry) => {
		const node = nodes.get(continuousChatNodeKey(entry));
		return node === undefined
			? `${continuousChatNodeFirstMessage(entry)}+${continuousChatNodeMessageCount(entry.level)}|(not summarized yet: zoom it)`
			: renderContinuousChatViewLine(node);
	});
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
