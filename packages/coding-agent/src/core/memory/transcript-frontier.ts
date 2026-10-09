/**
 * Frontier selection for one lineage: which accepted summary nodes stand for the history, in order, within
 * a byte allowance. Pure: no filesystem, timers or clocks.
 *
 * A frontier is an ordered, non-overlapping, gap-free partition of the covered interval
 * `[omittedBeforeIndex, coveredThroughIndex)` made only of accepted nodes. Spans before
 * `omittedBeforeIndex` are represented by one coarse pointer (an explicit statement that they are not
 * summarized here), and the uncovered tail (still pending or failed) is a separate gap record. Neither
 * ever counts as summarized coverage.
 *
 * Policy. The frontier grows by appending the next node at the covered-through cursor. When its rendered
 * size passes the allowance (the high-water mark) it reduces in one batch toward the low-water mark
 * (half of the allowance) by merging aligned sibling pairs whose parent node already exists, oldest
 * first (see {@link frontierMergeAge}); it never merges without a built parent and never merges when the
 * parent would be no smaller than its children. If merging cannot get under the allowance, the oldest
 * run is replaced by the coarse pointer until it reaches the low-water mark. A previous selection that
 * still validates is kept exactly as it is, extended only by newly available nodes: a restart never
 * re-ranks.
 */

import {
	formatTranscriptNodeHandle,
	TRANSCRIPT_SUMMARY_RECIPE_VERSION,
	utf8ByteLength,
} from "./transcript-memory-contracts.ts";
import { isNonNegativeInteger, type TranscriptSummaryNode } from "./transcript-summary-node.ts";

export const TRANSCRIPT_FRONTIER_RECIPE_VERSION = TRANSCRIPT_SUMMARY_RECIPE_VERSION;
/** Reduction target as a fraction of the allowance. */
export const TRANSCRIPT_FRONTIER_LOW_WATER_RATIO = 0.5;
const MAX_GAP_REASON_CHARS = 120;

export type TranscriptFrontierNode = Pick<
	TranscriptSummaryNode,
	| "id"
	| "level"
	| "ordinal"
	| "sessionId"
	| "spanRange"
	| "quality"
	| "text"
	| "children"
	| "coveredFrom"
	| "coveredTo"
	| "sourceRefs"
>;

/** The persisted selection. Everything else (bytes, rendering, gap) is derived from it and the nodes. */
export interface TranscriptFrontierSelection {
	/** Chronological, adjacent, non-overlapping accepted nodes. */
	nodeIds: string[];
	/** Spans before this index are covered only by the coarse pointer. */
	omittedBeforeIndex: number;
	/** One past the last covered span; the next node to append starts here. */
	coveredThroughIndex: number;
	/** Bumped on every change of the selection; never on a no-op. */
	revision: number;
	/** The allowance this selection was last fitted to. */
	allowanceBytes: number;
	recipeVersion: number;
}

/** An interval of the lineage with no accepted summary: pending, failed or not yet captured. */
export interface TranscriptFrontierGap {
	fromIndex: number;
	toIndexExclusive: number;
	reason: string;
}

export interface TranscriptFrontierTail {
	/** One past the last known span of the lineage. */
	toIndexExclusive: number;
	reason: string;
}

export interface TranscriptFrontierInput {
	sessionId: string;
	/** Accepted nodes of this one lineage. */
	nodes: readonly TranscriptFrontierNode[];
	allowanceBytes: number;
	previous?: TranscriptFrontierSelection;
	/** The known end of the lineage, so an uncovered tail is reported as a gap. */
	tail?: TranscriptFrontierTail;
}

export interface TranscriptFrontierResult {
	selection: TranscriptFrontierSelection;
	/** False when the previous selection was restored untouched. */
	changed: boolean;
	/** Exact UTF-8 size of the rendering, gap record included. */
	bytes: number;
	gap?: TranscriptFrontierGap;
	/** Why the previous selection was discarded and rebuilt, when it was. */
	recovery?: string;
}

export type TranscriptFrontierValidation = { ok: true; bytes: number } | { ok: false; reason: string };

export interface TranscriptFrontierRendering {
	/** Empty when not even the frame fits the allowance. */
	text: string;
	bytes: number;
	/** Nodes whose records are in `text`, oldest first. */
	includedNodeIds: string[];
	/** Spans before this index are covered by the coarse pointer in `text`. */
	omittedBeforeIndex: number;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/** Keep a node's text from forging the frame or another record. */
function escapeFrame(text: string): string {
	return text.replace(/<(\s*\/?\s*transcript_history)/gi, "&lt;$1");
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, MAX_GAP_REASON_CHARS);
}

function renderRecord(node: TranscriptFrontierNode): string {
	const stamps =
		node.coveredFrom !== undefined || node.coveredTo !== undefined
			? `${node.coveredFrom ?? "?"}..${node.coveredTo ?? "?"}`
			: "undated";
	const head = `${formatTranscriptNodeHandle(node.id)} [${node.spanRange.fromIndex},${node.spanRange.toIndexExclusive}) ${stamps} ${node.quality}`;
	const body = escapeFrame(node.text)
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
	return `${head}\n${body}`;
}

interface Frame {
	open: string;
	close: string;
	pointer?: string;
	gap?: string;
}

function buildFrame(
	sessionId: string,
	revision: number,
	omittedBeforeIndex: number,
	coveredThroughIndex: number,
	gap: TranscriptFrontierGap | undefined,
): Frame {
	const frame: Frame = {
		open: `<transcript_history session="${sessionId}" revision="${revision}" covered="[${omittedBeforeIndex},${coveredThroughIndex})">`,
		close: "</transcript_history>",
	};
	if (omittedBeforeIndex > 0) {
		frame.pointer = `[omitted spans 0..${omittedBeforeIndex}) are not summarized here; search or open their sources with the memory tool (history_search, history_source)]`;
	}
	if (gap) {
		frame.gap = `[no summary yet for spans [${gap.fromIndex},${gap.toIndexExclusive}): ${singleLine(gap.reason)}; their exact sources stay readable]`;
	}
	return frame;
}

function frameBytes(frame: Frame): number {
	return (
		utf8ByteLength(frame.open) +
		1 +
		(frame.pointer ? utf8ByteLength(frame.pointer) + 1 : 0) +
		(frame.gap ? utf8ByteLength(frame.gap) + 1 : 0) +
		utf8ByteLength(frame.close)
	);
}

function assemble(frame: Frame, records: readonly string[]): string {
	return `${frame.open}\n${frame.pointer ? `${frame.pointer}\n` : ""}${records.map((record) => `${record}\n`).join("")}${frame.gap ? `${frame.gap}\n` : ""}${frame.close}`;
}

function gapFor(
	coveredThroughIndex: number,
	tail: TranscriptFrontierTail | undefined,
): TranscriptFrontierGap | undefined {
	if (!tail || tail.toIndexExclusive <= coveredThroughIndex) return undefined;
	return { fromIndex: coveredThroughIndex, toIndexExclusive: tail.toIndexExclusive, reason: tail.reason };
}

/**
 * Deterministic rendering of a selection: one record per node (`txn:` handle, half-open span range,
 * source timestamps, quality, text), the coarse pointer and the gap record. Measured in UTF-8 bytes with
 * every wrapper and status line charged. If the selection no longer fits the allowance, the oldest whole
 * records are folded into the pointer; a record is never cut, and when not even the frame fits the text
 * is empty.
 */
export function renderFrontier(
	selection: TranscriptFrontierSelection,
	nodes: ReadonlyMap<string, TranscriptFrontierNode>,
	options: { sessionId: string; gap?: TranscriptFrontierGap; allowanceBytes?: number },
): TranscriptFrontierRendering {
	const allowance = options.allowanceBytes ?? selection.allowanceBytes;
	const members = selection.nodeIds.map((id) => {
		const node = nodes.get(id);
		if (!node) throw new Error(`Frontier node ${id} is not among the accepted nodes.`);
		return node;
	});
	const records = members.map(renderRecord);
	let first = 0;
	for (;;) {
		const omitted =
			first < members.length
				? (members[first] as TranscriptFrontierNode).spanRange.fromIndex
				: selection.coveredThroughIndex;
		const effectiveOmitted = first === 0 ? selection.omittedBeforeIndex : omitted;
		const frame = buildFrame(
			options.sessionId,
			selection.revision,
			effectiveOmitted,
			selection.coveredThroughIndex,
			options.gap,
		);
		const included = records.slice(first);
		const bytes = frameBytes(frame) + included.reduce((sum, record) => sum + utf8ByteLength(record) + 1, 0);
		if (bytes <= allowance) {
			return {
				text: assemble(frame, included),
				bytes,
				includedNodeIds: selection.nodeIds.slice(first),
				omittedBeforeIndex: effectiveOmitted,
			};
		}
		if (first >= members.length) {
			return { text: "", bytes: 0, includedNodeIds: [], omittedBeforeIndex: selection.coveredThroughIndex };
		}
		first += 1;
	}
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

/**
 * Validate a persisted selection against the accepted nodes: known recipe, accepted nodes of this session,
 * chronological and adjacent from the omitted boundary to the covered-through cursor, and within its own
 * allowance. A failing selection is rebuilt, never trusted.
 */
export function validateFrontierSelection(
	selection: TranscriptFrontierSelection,
	nodes: ReadonlyMap<string, TranscriptFrontierNode>,
	sessionId: string,
): TranscriptFrontierValidation {
	const fail = (reason: string): TranscriptFrontierValidation => ({ ok: false, reason });
	if (selection.recipeVersion !== TRANSCRIPT_FRONTIER_RECIPE_VERSION) return fail("recipe version changed");
	if (!isNonNegativeInteger(selection.revision) || selection.revision < 1) return fail("revision is invalid");
	if (!isNonNegativeInteger(selection.allowanceBytes) || selection.allowanceBytes < 1)
		return fail("allowance is invalid");
	if (!isNonNegativeInteger(selection.omittedBeforeIndex) || !isNonNegativeInteger(selection.coveredThroughIndex)) {
		return fail("boundaries are invalid");
	}
	let cursor = selection.omittedBeforeIndex;
	const records: string[] = [];
	const seen = new Set<string>();
	for (const id of selection.nodeIds) {
		if (seen.has(id)) return fail(`node ${id} is repeated`);
		seen.add(id);
		const node = nodes.get(id);
		if (!node) return fail(`node ${id} is not accepted`);
		if (node.sessionId !== sessionId) return fail(`node ${id} belongs to another session`);
		if (node.spanRange.fromIndex !== cursor) return fail(`node ${id} does not continue at span ${cursor}`);
		cursor = node.spanRange.toIndexExclusive;
		records.push(renderRecord(node));
	}
	if (cursor !== selection.coveredThroughIndex) return fail("covered-through cursor does not match the nodes");
	const frame = buildFrame(
		sessionId,
		selection.revision,
		selection.omittedBeforeIndex,
		selection.coveredThroughIndex,
		undefined,
	);
	const bytes = frameBytes(frame) + records.reduce((sum, record) => sum + utf8ByteLength(record) + 1, 0);
	if (bytes > selection.allowanceBytes) return fail(`selection is ${bytes} bytes, over its allowance`);
	return { ok: true, bytes };
}

// ---------------------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------------------

/**
 * Merge urgency of an aligned pair: the distance from the pair's final span to the newest covered span,
 * divided by the pair's span count. Sequence indices are zero-based; a node covers `[from, to)`; the
 * pair's final span is `to - 1` and the newest covered span is `coveredThroughIndex - 1`, so the distance
 * is `coveredThroughIndex - to`. Larger means older relative to its size and merges first; the caller
 * compares ages by cross-multiplication (exact integers) and breaks ties toward the oldest pair.
 */
export function frontierMergeAge(
	pair: { fromIndex: number; toIndexExclusive: number },
	coveredThroughIndex: number,
): { distance: number; spans: number } {
	return { distance: coveredThroughIndex - pair.toIndexExclusive, spans: pair.toIndexExclusive - pair.fromIndex };
}

interface NodeIndex {
	byId: Map<string, TranscriptFrontierNode>;
	/** Lowest-level node starting at each span index. */
	startingAt: Map<number, TranscriptFrontierNode>;
	parentOf: Map<string, TranscriptFrontierNode>;
	firstLeafStart: number | undefined;
}

function indexNodes(sessionId: string, nodes: readonly TranscriptFrontierNode[]): NodeIndex {
	const index: NodeIndex = { byId: new Map(), startingAt: new Map(), parentOf: new Map(), firstLeafStart: undefined };
	for (const node of nodes) {
		if (node.sessionId !== sessionId) throw new RangeError("A frontier is built from the nodes of one lineage.");
		index.byId.set(node.id, node);
		const existing = index.startingAt.get(node.spanRange.fromIndex);
		if (!existing || node.level < existing.level || (node.level === existing.level && node.id < existing.id)) {
			index.startingAt.set(node.spanRange.fromIndex, node);
		}
		if (node.children) index.parentOf.set(`${node.children[0]}|${node.children[1]}`, node);
		if (node.level === 0 && (index.firstLeafStart === undefined || node.spanRange.fromIndex < index.firstLeafStart)) {
			index.firstLeafStart = node.spanRange.fromIndex;
		}
	}
	return index;
}

class FrontierBuilder {
	nodes: TranscriptFrontierNode[] = [];
	omittedBeforeIndex: number;
	coveredThroughIndex: number;
	private readonly recordBytes = new Map<string, number>();
	private recordSum = 0;
	private readonly sessionId: string;
	private readonly revision: number;
	private readonly index: NodeIndex;
	private readonly allowanceBytes: number;
	private readonly lowWaterBytes: number;
	private readonly tail: TranscriptFrontierTail | undefined;

	constructor(
		sessionId: string,
		revision: number,
		index: NodeIndex,
		allowanceBytes: number,
		tail: TranscriptFrontierTail | undefined,
		start: { nodes: TranscriptFrontierNode[]; omittedBeforeIndex: number; coveredThroughIndex: number },
	) {
		this.sessionId = sessionId;
		this.revision = revision;
		this.index = index;
		this.allowanceBytes = allowanceBytes;
		this.lowWaterBytes = Math.floor(allowanceBytes * TRANSCRIPT_FRONTIER_LOW_WATER_RATIO);
		this.tail = tail;
		this.omittedBeforeIndex = start.omittedBeforeIndex;
		this.coveredThroughIndex = start.coveredThroughIndex;
		for (const node of start.nodes) this.push(node);
	}

	gap(): TranscriptFrontierGap | undefined {
		return gapFor(this.coveredThroughIndex, this.tail);
	}

	bytes(): number {
		return (
			frameBytes(
				buildFrame(this.sessionId, this.revision, this.omittedBeforeIndex, this.coveredThroughIndex, this.gap()),
			) + this.recordSum
		);
	}

	private sizeOf(node: TranscriptFrontierNode): number {
		let size = this.recordBytes.get(node.id);
		if (size === undefined) {
			size = utf8ByteLength(renderRecord(node)) + 1;
			this.recordBytes.set(node.id, size);
		}
		return size;
	}

	private push(node: TranscriptFrontierNode): void {
		this.nodes.push(node);
		this.recordSum += this.sizeOf(node);
		this.coveredThroughIndex = node.spanRange.toIndexExclusive;
	}

	/** Append nodes at the covered-through cursor, reducing whenever the allowance is passed. */
	extend(): void {
		this.reduceIfOver();
		for (;;) {
			const next = this.index.startingAt.get(this.coveredThroughIndex);
			if (!next || next.spanRange.toIndexExclusive <= this.coveredThroughIndex) break;
			this.push(next);
			this.reduceIfOver();
		}
	}

	reduceIfOver(): void {
		if (this.bytes() <= this.allowanceBytes) return;
		this.mergeUntil(this.lowWaterBytes);
		if (this.bytes() > this.allowanceBytes) this.dropOldestUntil(this.lowWaterBytes);
	}

	private mergeUntil(target: number): void {
		while (this.bytes() > target) {
			const candidate = this.bestMerge();
			if (!candidate) return;
			const [at, parent] = candidate;
			const [left, right] = [this.nodes[at] as TranscriptFrontierNode, this.nodes[at + 1] as TranscriptFrontierNode];
			this.recordSum += this.sizeOf(parent) - this.sizeOf(left) - this.sizeOf(right);
			this.nodes.splice(at, 2, parent);
		}
	}

	private bestMerge(): [number, TranscriptFrontierNode] | undefined {
		let best: { at: number; parent: TranscriptFrontierNode; distance: number; spans: number } | undefined;
		for (let at = 0; at + 1 < this.nodes.length; at++) {
			const left = this.nodes[at] as TranscriptFrontierNode;
			const right = this.nodes[at + 1] as TranscriptFrontierNode;
			if (left.level !== right.level || left.ordinal % 2 !== 0 || right.ordinal !== left.ordinal + 1) continue;
			const parent = this.index.parentOf.get(`${left.id}|${right.id}`);
			if (!parent) continue;
			if (
				parent.spanRange.fromIndex !== left.spanRange.fromIndex ||
				parent.spanRange.toIndexExclusive !== right.spanRange.toIndexExclusive
			) {
				continue;
			}
			// A merge that does not shrink the frontier is not a reduction.
			if (this.sizeOf(parent) >= this.sizeOf(left) + this.sizeOf(right)) continue;
			const age = frontierMergeAge(
				{ fromIndex: left.spanRange.fromIndex, toIndexExclusive: right.spanRange.toIndexExclusive },
				this.coveredThroughIndex,
			);
			// distance/spans compared by cross-multiplication; ties keep the earlier (older) pair.
			if (!best || age.distance * best.spans > best.distance * age.spans) {
				best = { at, parent, ...age };
			}
		}
		return best ? [best.at, best.parent] : undefined;
	}

	/** The coarse pointer: whole oldest records leave the frontier and the omitted boundary moves past them. */
	private dropOldestUntil(target: number): void {
		while (this.nodes.length > 0 && this.bytes() > target) {
			const dropped = this.nodes.shift() as TranscriptFrontierNode;
			this.recordSum -= this.sizeOf(dropped);
			this.omittedBeforeIndex = this.nodes[0]?.spanRange.fromIndex ?? this.coveredThroughIndex;
		}
	}
}

/**
 * Select the frontier for one lineage. Restores `previous` when it still validates (extending it by newly
 * available nodes and reducing only if it is over the allowance); otherwise rebuilds from the earliest
 * available leaf and reports why in `recovery`.
 */
export function selectFrontier(input: TranscriptFrontierInput): TranscriptFrontierResult {
	if (!Number.isSafeInteger(input.allowanceBytes) || input.allowanceBytes < 1) {
		throw new RangeError("Frontier allowance must be a positive safe integer.");
	}
	const index = indexNodes(input.sessionId, input.nodes);
	const baseRevision = input.previous?.revision ?? 0;
	let recovery: string | undefined;
	let start: { nodes: TranscriptFrontierNode[]; omittedBeforeIndex: number; coveredThroughIndex: number } | undefined;
	if (input.previous) {
		const check = validateFrontierSelection(input.previous, index.byId, input.sessionId);
		if (check.ok) {
			start = {
				nodes: input.previous.nodeIds.map((id) => index.byId.get(id) as TranscriptFrontierNode),
				omittedBeforeIndex: input.previous.omittedBeforeIndex,
				coveredThroughIndex: input.previous.coveredThroughIndex,
			};
		} else {
			recovery = check.reason;
		}
	}
	const restored = start !== undefined;
	if (!start) {
		const origin = index.firstLeafStart ?? 0;
		start = { nodes: [], omittedBeforeIndex: origin, coveredThroughIndex: origin };
	}
	const builder = new FrontierBuilder(
		input.sessionId,
		baseRevision + 1,
		index,
		input.allowanceBytes,
		input.tail,
		start,
	);
	builder.extend();

	const nodeIds = builder.nodes.map((node) => node.id);
	const unchanged =
		restored &&
		input.previous !== undefined &&
		input.previous.omittedBeforeIndex === builder.omittedBeforeIndex &&
		input.previous.coveredThroughIndex === builder.coveredThroughIndex &&
		input.previous.nodeIds.length === nodeIds.length &&
		input.previous.nodeIds.every((id, position) => id === nodeIds[position]);
	if (unchanged && input.previous) {
		const gap = gapFor(input.previous.coveredThroughIndex, input.tail);
		const frame = buildFrame(
			input.sessionId,
			input.previous.revision,
			input.previous.omittedBeforeIndex,
			input.previous.coveredThroughIndex,
			gap,
		);
		const members = input.previous.nodeIds.map((id) => index.byId.get(id) as TranscriptFrontierNode);
		const bytes = frameBytes(frame) + members.reduce((sum, node) => sum + utf8ByteLength(renderRecord(node)) + 1, 0);
		return { selection: input.previous, changed: false, bytes, ...(gap ? { gap } : {}) };
	}
	const selection: TranscriptFrontierSelection = {
		nodeIds,
		omittedBeforeIndex: builder.omittedBeforeIndex,
		coveredThroughIndex: builder.coveredThroughIndex,
		revision: baseRevision + 1,
		allowanceBytes: input.allowanceBytes,
		recipeVersion: TRANSCRIPT_FRONTIER_RECIPE_VERSION,
	};
	const gap = builder.gap();
	return {
		selection,
		changed: true,
		bytes: builder.bytes(),
		...(gap ? { gap } : {}),
		...(recovery ? { recovery } : {}),
	};
}

/**
 * The leading run of a selection whose nodes satisfy `precedes`, as a selection of its own. The nodes of a
 * selection are chronological and `precedes` must be monotone along them (true for a prefix, false after),
 * which holds for "entirely before a point of one ancestry"; the boundary is found by bisection. The view
 * keeps the persisted revision: it is the same frontier, cut at a boundary the caller owns.
 */
export function limitFrontierToPrefix(
	selection: TranscriptFrontierSelection,
	nodes: ReadonlyMap<string, TranscriptFrontierNode>,
	precedes: (node: TranscriptFrontierNode) => boolean,
): { selection: TranscriptFrontierSelection; keptCount: number } {
	const members = selection.nodeIds.map((id) => {
		const node = nodes.get(id);
		if (!node) throw new Error(`Frontier node ${id} is not among the accepted nodes.`);
		return node;
	});
	let low = 0;
	let high = members.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (precedes(members[middle] as TranscriptFrontierNode)) low = middle + 1;
		else high = middle;
	}
	if (low === members.length) return { selection, keptCount: low };
	const last = members[low - 1];
	return {
		selection: {
			...selection,
			nodeIds: selection.nodeIds.slice(0, low),
			coveredThroughIndex: last ? last.spanRange.toIndexExclusive : selection.omittedBeforeIndex,
		},
		keptCount: low,
	};
}
