/**
 * Frontier selection for one lineage: which accepted summary nodes stand for the history, in order, within
 * a byte allowance. Pure: no filesystem, timers or clocks.
 *
 * A frontier is an ordered, non-overlapping view of accepted nodes in the covered interval
 * `[omittedBeforeIndex, coveredThroughIndex)`. Missing internal ranges are rendered as explicit gaps, so one
 * failed summary cannot hide later accepted history. Spans before
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
 * re-ranks. A selection stored before it recorded its origin is checked against its omitted boundary instead, which
 * can rebuild it once.
 */

import { estimateLineCount } from "../context/context-item.ts";
import type { ActiveBranchEntryStanding } from "./active-branch-probe.ts";
import {
	formatTranscriptNodeHandle,
	formatTranscriptSourceHandle,
	TRANSCRIPT_SUMMARY_RECIPE_VERSION,
	utf8ByteLength,
} from "./transcript-memory-contracts.ts";
import { coveredSourceRefs, isNonNegativeInteger, type TranscriptSummaryNode } from "./transcript-summary-node.ts";

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
	/** Chronological, non-overlapping accepted nodes; absent intervals render as explicit gaps. */
	nodeIds: string[];
	/** Spans before this index are covered only by the coarse pointer. */
	omittedBeforeIndex: number;
	/**
	 * The lineage position the selection was first built from (the earliest approved leaf then). Reduction moves
	 * `omittedBeforeIndex` forward but never this, so an accepted leaf before it is history the build missed, not history
	 * a reduction dropped.
	 */
	originIndex: number;
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

interface TranscriptFrontierInputBase {
	sessionId: string;
	allowanceBytes: number;
	previous?: TranscriptFrontierSelection;
	/** The known end of the lineage, so an uncovered tail is reported as a gap. */
	tail?: TranscriptFrontierTail;
}

export interface TranscriptFrontierNodeIndex {
	get(id: string): TranscriptFrontierNode | undefined;
	startingAt(fromIndex: number): TranscriptFrontierNode | undefined;
	parentOf(leftId: string, rightId: string): TranscriptFrontierNode | undefined;
	nextStart(fromIndex: number): number | undefined;
	firstLeafStart(): number | undefined;
}

export type TranscriptFrontierInput = TranscriptFrontierInputBase &
	(
		| { /** Accepted nodes of this one lineage. */ nodes: readonly TranscriptFrontierNode[]; index?: never }
		| { /** Incrementally maintained accepted-node index. */ index: TranscriptFrontierNodeIndex; nodes?: never }
	);

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

/**
 * `keep` is set when the only fault is a gap that now has an accepted node: the first `keep` nodes are still a valid
 * prefix, so selection resumes from the end of that prefix instead of rebuilding the whole frontier.
 */
export type TranscriptFrontierValidation = { ok: true; bytes: number } | { ok: false; reason: string; keep?: number };

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
	status: string;
	pointer?: string;
	gap?: string;
}

/**
 * Who reads the rendering, and so which tools its pointers may name: the root session (the `memory` tool's
 * history actions) or a delegated lane (only `memory_read`). One renderer; the audience only picks tool names.
 */
export type FrontierAudience = "root" | "lane";

function searchOrOpenTools(audience: FrontierAudience): string {
	return audience === "lane"
		? "memory_read (a query searches; a tx: handle as ref opens a source)"
		: "the memory tool (history_search, history_source)";
}

function expandCall(audience: FrontierAudience, handle: string): string {
	return audience === "lane" ? `memory_read with ref ${handle}` : `history_expand ${handle}`;
}

function buildFrame(
	sessionId: string,
	revision: number,
	omittedBeforeIndex: number,
	coveredThroughIndex: number,
	gap: TranscriptFrontierGap | undefined,
	audience: FrontierAudience = "root",
): Frame {
	const frame: Frame = {
		// Mutable coverage belongs after the records. Keeping the opening bytes stable lets an append preserve the
		// provider-visible prefix through every retained record until a reduction actually replaces one.
		open: `<transcript_history session="${sessionId}">`,
		close: "</transcript_history>",
		status: `[frontier revision ${revision}; covered spans [${omittedBeforeIndex},${coveredThroughIndex})]`,
	};
	if (omittedBeforeIndex > 0) {
		frame.pointer = `[omitted spans 0..${omittedBeforeIndex}) are not summarized here; search or open their sources with ${searchOrOpenTools(audience)}]`;
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
		utf8ByteLength(frame.status) +
		1 +
		(frame.gap ? utf8ByteLength(frame.gap) + 1 : 0) +
		utf8ByteLength(frame.close)
	);
}

/** Lines of the assembled frame alone: open, pointer, status and gap (each one line), close. */
function frameLines(frame: Frame): number {
	return 3 + (frame.pointer ? 1 : 0) + (frame.gap ? 1 : 0);
}

function assemble(frame: Frame, records: readonly string[]): string {
	return `${frame.open}\n${frame.pointer ? `${frame.pointer}\n` : ""}${records.map((record) => `${record}\n`).join("")}${frame.status}\n${frame.gap ? `${frame.gap}\n` : ""}${frame.close}`;
}

function gapFor(
	coveredThroughIndex: number,
	tail: TranscriptFrontierTail | undefined,
): TranscriptFrontierGap | undefined {
	if (!tail || tail.toIndexExclusive <= coveredThroughIndex) return undefined;
	return { fromIndex: coveredThroughIndex, toIndexExclusive: tail.toIndexExclusive, reason: tail.reason };
}

/** One line or node record of a rendering, with the span interval it speaks about. */
interface RenderableRecord {
	text: string;
	fromIndex: number;
	toIndexExclusive: number;
	/** Set when the record is an accepted node's own record. */
	nodeId?: string;
}

function internalGapRecord(fromIndex: number, toIndexExclusive: number): RenderableRecord {
	return {
		text: `[no summary for spans [${fromIndex},${toIndexExclusive}); a summary failed or is not yet available, and the exact sources stay readable]`,
		fromIndex,
		toIndexExclusive,
	};
}

/** Insert an explicit record for every uncovered range, preserving chronology without claiming summary coverage. */
function withInternalGaps(records: readonly RenderableRecord[], omittedBeforeIndex: number): RenderableRecord[] {
	const rendered: RenderableRecord[] = [];
	let cursor = omittedBeforeIndex;
	for (const record of records) {
		if (record.fromIndex > cursor) rendered.push(internalGapRecord(cursor, record.fromIndex));
		rendered.push(record);
		cursor = Math.max(cursor, record.toIndexExclusive);
	}
	return rendered;
}

/**
 * Frame, pointer and records measured in UTF-8 bytes, and in lines when a line allowance is given, with every
 * wrapper and status line charged. If the records no longer fit either allowance, the oldest whole records are
 * folded into the pointer; a record is never cut, and when not even the frame fits the text is empty.
 */
function renderRecords(
	records: readonly RenderableRecord[],
	frame: { sessionId: string; revision: number; omittedBeforeIndex: number; coveredThroughIndex: number },
	options: {
		gap?: TranscriptFrontierGap;
		allowanceBytes: number;
		allowanceLines?: number;
		audience?: FrontierAudience;
	},
): TranscriptFrontierRendering {
	const complete = withInternalGaps(records, frame.omittedBeforeIndex);
	let first = 0;
	for (;;) {
		const omitted =
			first < complete.length ? (complete[first] as RenderableRecord).fromIndex : frame.coveredThroughIndex;
		const effectiveOmitted = first === 0 ? frame.omittedBeforeIndex : omitted;
		const built = buildFrame(
			frame.sessionId,
			frame.revision,
			effectiveOmitted,
			frame.coveredThroughIndex,
			options.gap,
			options.audience,
		);
		const included = complete.slice(first);
		const bytes = frameBytes(built) + included.reduce((sum, record) => sum + utf8ByteLength(record.text) + 1, 0);
		const lines = frameLines(built) + included.reduce((sum, record) => sum + estimateLineCount(record.text), 0);
		if (
			bytes <= options.allowanceBytes &&
			(options.allowanceLines === undefined || lines <= options.allowanceLines)
		) {
			return {
				text: assemble(
					built,
					included.map((record) => record.text),
				),
				bytes,
				includedNodeIds: included.flatMap((record) => (record.nodeId === undefined ? [] : [record.nodeId])),
				omittedBeforeIndex: effectiveOmitted,
			};
		}
		if (first >= complete.length) {
			return { text: "", bytes: 0, includedNodeIds: [], omittedBeforeIndex: frame.coveredThroughIndex };
		}
		first += 1;
	}
}

/**
 * Deterministic rendering of a selection: one record per node (`txn:` handle, half-open span range,
 * source timestamps, quality, text), the coarse pointer and the gap record.
 */
export function renderFrontier(
	selection: TranscriptFrontierSelection,
	nodes: ReadonlyMap<string, TranscriptFrontierNode>,
	options: { sessionId: string; gap?: TranscriptFrontierGap; allowanceBytes?: number },
): TranscriptFrontierRendering {
	const records = selection.nodeIds.map((id): RenderableRecord => {
		const node = nodes.get(id);
		if (!node) throw new Error(`Frontier node ${id} is not among the accepted nodes.`);
		return {
			text: renderRecord(node),
			fromIndex: node.spanRange.fromIndex,
			toIndexExclusive: node.spanRange.toIndexExclusive,
			nodeId: id,
		};
	});
	return renderRecords(
		records,
		{
			sessionId: options.sessionId,
			revision: selection.revision,
			omittedBeforeIndex: selection.omittedBeforeIndex,
			coveredThroughIndex: selection.coveredThroughIndex,
		},
		{
			...(options.gap ? { gap: options.gap } : {}),
			allowanceBytes: options.allowanceBytes ?? selection.allowanceBytes,
		},
	);
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

/**
 * Validate a persisted selection against the accepted nodes: known recipe, accepted nodes of this session,
 * chronological and non-overlapping from the omitted boundary to the covered-through cursor, with every gap
 * explicit at rendering, and within its own allowance. A failing selection is rebuilt, never trusted.
 */
export function validateFrontierSelection(
	selection: TranscriptFrontierSelection,
	nodes: ReadonlyMap<string, TranscriptFrontierNode>,
	sessionId: string,
): TranscriptFrontierValidation {
	// Foreign-session nodes stay indexed: a selection that names one fails validation rather than throwing.
	return validateFrontierSelectionWithIndex(selection, indexOf([...nodes.values()]), sessionId);
}

function validateFrontierSelectionWithIndex(
	selection: TranscriptFrontierSelection,
	index: TranscriptFrontierNodeIndex,
	sessionId: string,
): TranscriptFrontierValidation {
	const fail = (reason: string): TranscriptFrontierValidation => ({ ok: false, reason });
	if (selection.recipeVersion !== TRANSCRIPT_FRONTIER_RECIPE_VERSION) return fail("recipe version changed");
	if (!isNonNegativeInteger(selection.revision) || selection.revision < 1) return fail("revision is invalid");
	if (!isNonNegativeInteger(selection.allowanceBytes) || selection.allowanceBytes < 1)
		return fail("allowance is invalid");
	if (
		!isNonNegativeInteger(selection.omittedBeforeIndex) ||
		!isNonNegativeInteger(selection.coveredThroughIndex) ||
		!isNonNegativeInteger(selection.originIndex) ||
		selection.originIndex > selection.omittedBeforeIndex
	) {
		return fail("boundaries are invalid");
	}
	const earliestLeaf = index.firstLeafStart();
	if (earliestLeaf !== undefined && earliestLeaf < selection.originIndex) {
		return fail(`an accepted leaf at span ${earliestLeaf} precedes the frontier origin ${selection.originIndex}`);
	}
	let cursor = selection.omittedBeforeIndex;
	const records: RenderableRecord[] = [];
	const seen = new Set<string>();
	for (const [position, id] of selection.nodeIds.entries()) {
		if (seen.has(id)) return fail(`node ${id} is repeated`);
		seen.add(id);
		const node = index.get(id);
		if (!node) return fail(`node ${id} is not accepted`);
		if (node.sessionId !== sessionId) return fail(`node ${id} belongs to another session`);
		if (node.spanRange.fromIndex < cursor) return fail(`node ${id} overlaps coverage ending at span ${cursor}`);
		if (node.spanRange.fromIndex > cursor) {
			const nextStart = index.nextStart(cursor);
			if (nextStart !== undefined && nextStart < node.spanRange.fromIndex) {
				return { ok: false, reason: `the gap at span ${cursor} now has an accepted node`, keep: position };
			}
		}
		cursor = node.spanRange.toIndexExclusive;
		records.push({
			text: renderRecord(node),
			fromIndex: node.spanRange.fromIndex,
			toIndexExclusive: node.spanRange.toIndexExclusive,
			nodeId: node.id,
		});
	}
	if (cursor !== selection.coveredThroughIndex) return fail("covered-through cursor does not match the nodes");
	const frame = buildFrame(
		sessionId,
		selection.revision,
		selection.omittedBeforeIndex,
		selection.coveredThroughIndex,
		undefined,
	);
	const bytes =
		frameBytes(frame) +
		withInternalGaps(records, selection.omittedBeforeIndex).reduce(
			(sum, record) => sum + utf8ByteLength(record.text) + 1,
			0,
		);
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

function indexOf(nodes: readonly TranscriptFrontierNode[]): FrontierNodeIndex {
	const index = new FrontierNodeIndex();
	// Ascending starts make every insertion an append.
	for (const node of [...nodes].sort((left, right) => left.spanRange.fromIndex - right.spanRange.fromIndex)) {
		index.index(node);
	}
	return index;
}

function indexNodes(sessionId: string, nodes: readonly TranscriptFrontierNode[]): FrontierNodeIndex {
	if (nodes.some((node) => node.sessionId !== sessionId)) {
		throw new RangeError("A frontier is built from the nodes of one lineage.");
	}
	return indexOf(nodes);
}

/** Index of the first start at or after `cursor` in an ascending list (its length when none is). */
export function lowerBoundStart(starts: readonly number[], cursor: number): number {
	let low = 0;
	let high = starts.length;
	while (low < high) {
		const middle = low + Math.floor((high - low) / 2);
		if ((starts[middle] as number) < cursor) low = middle + 1;
		else high = middle;
	}
	return low;
}

/** The node a start position shows: the lowest level, then the lowest id. */
export function preferredFrontierNode(
	left: TranscriptFrontierNode | undefined,
	right: TranscriptFrontierNode | undefined,
): TranscriptFrontierNode | undefined {
	if (!left) return right;
	if (!right) return left;
	return right.level < left.level || (right.level === left.level && right.id < left.id) ? right : left;
}

/** Incremental ordered read index of one lineage's approved nodes: insertion and removal keep every lookup current. */
export class FrontierNodeIndex implements TranscriptFrontierNodeIndex {
	private readonly byId = new Map<string, TranscriptFrontierNode>();
	private readonly byStart = new Map<number, Map<string, TranscriptFrontierNode>>();
	private readonly preferredByStart = new Map<number, TranscriptFrontierNode>();
	private readonly parentsByPair = new Map<string, Map<string, TranscriptFrontierNode>>();
	private readonly starts: number[] = [];
	private readonly leafCounts = new Map<number, number>();
	private firstLeaf: number | undefined;

	get(id: string): TranscriptFrontierNode | undefined {
		return this.byId.get(id);
	}

	startingAt(fromIndex: number): TranscriptFrontierNode | undefined {
		return this.preferredByStart.get(fromIndex);
	}

	parentOf(leftId: string, rightId: string): TranscriptFrontierNode | undefined {
		let preferred: TranscriptFrontierNode | undefined;
		for (const node of this.parentsByPair.get(`${leftId}|${rightId}`)?.values() ?? []) {
			preferred = preferredFrontierNode(preferred, node);
		}
		return preferred;
	}

	nextStart(fromIndex: number): number | undefined {
		return this.starts[lowerBoundStart(this.starts, fromIndex)];
	}

	firstLeafStart(): number | undefined {
		return this.firstLeaf;
	}

	index(node: TranscriptFrontierNode): void {
		this.byId.set(node.id, node);
		const start = node.spanRange.fromIndex;
		let candidates = this.byStart.get(start);
		if (!candidates) {
			candidates = new Map();
			this.byStart.set(start, candidates);
			const at = lowerBoundStart(this.starts, start);
			this.starts.splice(at, 0, start);
		}
		candidates.set(node.id, node);
		this.reselectStart(start, candidates);
		if (node.children) {
			const pair = `${node.children[0]}|${node.children[1]}`;
			const parents = this.parentsByPair.get(pair) ?? new Map<string, TranscriptFrontierNode>();
			parents.set(node.id, node);
			this.parentsByPair.set(pair, parents);
		}
		if (node.level === 0) {
			this.leafCounts.set(start, (this.leafCounts.get(start) ?? 0) + 1);
			if (this.firstLeaf === undefined || start < this.firstLeaf) this.firstLeaf = start;
		}
	}

	unindex(node: TranscriptFrontierNode): void {
		if (!this.byId.delete(node.id)) return;
		const start = node.spanRange.fromIndex;
		const candidates = this.byStart.get(start);
		candidates?.delete(node.id);
		if (candidates?.size) this.reselectStart(start, candidates);
		else {
			this.byStart.delete(start);
			this.preferredByStart.delete(start);
			const at = lowerBoundStart(this.starts, start);
			if (this.starts[at] === start) this.starts.splice(at, 1);
		}
		if (node.children) {
			const pair = `${node.children[0]}|${node.children[1]}`;
			const parents = this.parentsByPair.get(pair);
			parents?.delete(node.id);
			if (parents?.size === 0) this.parentsByPair.delete(pair);
		}
		if (node.level === 0) {
			const count = (this.leafCounts.get(start) ?? 1) - 1;
			if (count > 0) this.leafCounts.set(start, count);
			else {
				this.leafCounts.delete(start);
				if (this.firstLeaf === start) {
					this.firstLeaf = this.starts.find((candidate) => (this.leafCounts.get(candidate) ?? 0) > 0);
				}
			}
		}
	}

	view(extra?: TranscriptFrontierNode): TranscriptFrontierNodeIndex {
		if (!extra) return this;
		return {
			get: (id) => (id === extra.id ? extra : this.get(id)),
			startingAt: (fromIndex) =>
				preferredFrontierNode(
					this.startingAt(fromIndex),
					extra.spanRange.fromIndex === fromIndex ? extra : undefined,
				),
			parentOf: (leftId, rightId) =>
				preferredFrontierNode(
					this.parentOf(leftId, rightId),
					extra.children?.[0] === leftId && extra.children[1] === rightId ? extra : undefined,
				),
			nextStart: (fromIndex) => {
				const known = this.nextStart(fromIndex);
				const candidate = extra.spanRange.fromIndex >= fromIndex ? extra.spanRange.fromIndex : undefined;
				return known === undefined || (candidate !== undefined && candidate < known) ? candidate : known;
			},
			firstLeafStart: () => {
				const known = this.firstLeafStart();
				return extra.level === 0 && (known === undefined || extra.spanRange.fromIndex < known)
					? extra.spanRange.fromIndex
					: known;
			},
		};
	}

	private reselectStart(start: number, candidates: ReadonlyMap<string, TranscriptFrontierNode>): void {
		let preferred: TranscriptFrontierNode | undefined;
		for (const node of candidates.values()) preferred = preferredFrontierNode(preferred, node);
		if (preferred) this.preferredByStart.set(start, preferred);
	}
}

class FrontierBuilder {
	nodes: TranscriptFrontierNode[] = [];
	omittedBeforeIndex: number;
	coveredThroughIndex: number;
	private readonly recordBytes = new Map<string, number>();
	/** Node and internal-gap record bytes between `omittedBeforeIndex` and `coveredThroughIndex`. */
	private recordSum = 0;
	private readonly sessionId: string;
	private readonly revision: number;
	private readonly index: TranscriptFrontierNodeIndex;
	private readonly allowanceBytes: number;
	private readonly lowWaterBytes: number;
	private readonly tail: TranscriptFrontierTail | undefined;

	constructor(
		sessionId: string,
		revision: number,
		index: TranscriptFrontierNodeIndex,
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
		this.coveredThroughIndex = start.omittedBeforeIndex;
		for (const node of start.nodes) this.push(node);
		if (this.coveredThroughIndex !== start.coveredThroughIndex) {
			throw new Error("A restored frontier's node endpoint disagrees with its covered-through cursor.");
		}
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
		if (node.spanRange.fromIndex > this.coveredThroughIndex) {
			this.recordSum +=
				utf8ByteLength(internalGapRecord(this.coveredThroughIndex, node.spanRange.fromIndex).text) + 1;
		}
		this.nodes.push(node);
		this.recordSum += this.sizeOf(node);
		this.coveredThroughIndex = node.spanRange.toIndexExclusive;
	}

	/** Append nodes at the covered-through cursor, reducing whenever the allowance is passed. */
	extend(): void {
		this.reduceIfOver();
		for (;;) {
			const start = this.index.nextStart(this.coveredThroughIndex);
			const next = start === undefined ? undefined : this.index.startingAt(start);
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
			const parent = this.index.parentOf(left.id, right.id);
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
			if (dropped.spanRange.fromIndex > this.omittedBeforeIndex) {
				this.recordSum -=
					utf8ByteLength(internalGapRecord(this.omittedBeforeIndex, dropped.spanRange.fromIndex).text) + 1;
			}
			const next = this.nodes[0];
			if (next && next.spanRange.fromIndex > dropped.spanRange.toIndexExclusive) {
				this.recordSum -=
					utf8ByteLength(internalGapRecord(dropped.spanRange.toIndexExclusive, next.spanRange.fromIndex).text) + 1;
			}
			this.omittedBeforeIndex = this.nodes[0]?.spanRange.fromIndex ?? this.coveredThroughIndex;
		}
	}
}

/**
 * Select the frontier for one lineage. Restores `previous` when it still validates (extending it by newly
 * available nodes and reducing only if it is over the allowance). When a summary landed in a gap the previous
 * selection skipped, the nodes before that gap are kept as they were and the selection resumes from there;
 * any other fault rebuilds from the earliest available leaf. Either way the cause is reported in `recovery`.
 */
export function selectFrontier(input: TranscriptFrontierInput): TranscriptFrontierResult {
	if (!Number.isSafeInteger(input.allowanceBytes) || input.allowanceBytes < 1) {
		throw new RangeError("Frontier allowance must be a positive safe integer.");
	}
	const index = input.index ?? indexNodes(input.sessionId, input.nodes ?? []);
	const baseRevision = input.previous?.revision ?? 0;
	let recovery: string | undefined;
	let start: { nodes: TranscriptFrontierNode[]; omittedBeforeIndex: number; coveredThroughIndex: number } | undefined;
	if (input.previous) {
		const check = validateFrontierSelectionWithIndex(input.previous, index, input.sessionId);
		if (check.ok) {
			start = {
				nodes: input.previous.nodeIds.map((id) => index.get(id) as TranscriptFrontierNode),
				omittedBeforeIndex: input.previous.omittedBeforeIndex,
				coveredThroughIndex: input.previous.coveredThroughIndex,
			};
		} else {
			recovery = check.reason;
			if (check.keep !== undefined) {
				// A late summary filled a gap: the nodes before it stay byte-identical and the rest is extended from there.
				const kept = input.previous.nodeIds
					.slice(0, check.keep)
					.map((id) => index.get(id) as TranscriptFrontierNode);
				const last = kept[kept.length - 1];
				start = {
					nodes: kept,
					omittedBeforeIndex: input.previous.omittedBeforeIndex,
					coveredThroughIndex: last ? last.spanRange.toIndexExclusive : input.previous.omittedBeforeIndex,
				};
			}
		}
	}
	const restored = start !== undefined && recovery === undefined;
	let originIndex = start ? (input.previous?.originIndex ?? 0) : 0;
	if (!start) {
		originIndex = index.firstLeafStart() ?? 0;
		start = { nodes: [], omittedBeforeIndex: originIndex, coveredThroughIndex: originIndex };
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
		const records = input.previous.nodeIds.map((id): RenderableRecord => {
			const node = index.get(id) as TranscriptFrontierNode;
			return {
				text: renderRecord(node),
				fromIndex: node.spanRange.fromIndex,
				toIndexExclusive: node.spanRange.toIndexExclusive,
				nodeId: node.id,
			};
		});
		const bytes =
			frameBytes(frame) +
			withInternalGaps(records, input.previous.omittedBeforeIndex).reduce(
				(sum, record) => sum + utf8ByteLength(record.text) + 1,
				0,
			);
		return { selection: input.previous, changed: false, bytes, ...(gap ? { gap } : {}) };
	}
	const selection: TranscriptFrontierSelection = {
		nodeIds,
		omittedBeforeIndex: builder.omittedBeforeIndex,
		originIndex,
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

// ---------------------------------------------------------------------------------------------
// Live-branch view
// ---------------------------------------------------------------------------------------------

/** Compacted-away sources a mixed record points at by handle; the rest are reachable by expanding the node. */
const MAX_POINTER_SOURCE_HANDLES = 4;

/** One stretch of a persisted selection as the live branch sees it. */
export type FrontierViewItem =
	/** Accepted node whose every covered source was compacted away. */
	| { kind: "node"; node: TranscriptFrontierNode }
	/** A stretch the live context still shows verbatim: not repeated. */
	| { kind: "visible"; fromIndex: number; toIndexExclusive: number }
	/** A leaf covering both compacted-away and still-visible sources: withheld, pointed at. */
	| {
			kind: "mixed";
			node: TranscriptFrontierNode;
			visibleSpans: number;
			compactedHandles: string[];
			compactedSpans: number;
	  };

export interface FrontierView {
	/** Chronological stretches from the first one the view speaks about. */
	items: FrontierViewItem[];
	/** The selection reaches past the last item: the live tail was cut, or the view stopped off the branch. */
	truncated: boolean;
	/** The view stopped at a node covering a source that is not on the active branch. */
	offBranch: boolean;
}

function itemRange(item: FrontierViewItem): { fromIndex: number; toIndexExclusive: number } {
	return item.kind === "visible" ? item : item.node.spanRange;
}

/**
 * The frontier as the live branch sees it: the compacted-away coverage of the persisted selection, minus what
 * the live context still shows. A pure, view-only projection; the selection, its nodes and their ordinals are
 * never touched, and a recipe change alone may regroup coverage.
 *
 * Each selected node is classified by the standing of the sources it covers. All compacted away: kept. All
 * visible: a `visible` stretch, not repeated. A mixed parent is expanded to its two children (accepted nodes
 * of the same lineage) and each is classified in turn; a mixed leaf cannot be split without rewriting opaque
 * model text, so it becomes a pointer that keeps its compacted-away source handles discoverable. A node
 * covering a source off the active branch ends the view. The visible tail after the last compacted-away
 * stretch is dropped.
 */
export function projectFrontierView(
	selection: TranscriptFrontierSelection,
	nodes: ReadonlyMap<string, TranscriptFrontierNode>,
	standingOf: (entryId: string) => ActiveBranchEntryStanding,
): FrontierView {
	const items: FrontierViewItem[] = [];
	let offBranch = false;
	let truncated = false;
	const pushVisible = (fromIndex: number, toIndexExclusive: number): void => {
		const last = items[items.length - 1];
		if (last?.kind === "visible" && last.toIndexExclusive === fromIndex) last.toIndexExclusive = toIndexExclusive;
		else items.push({ kind: "visible", fromIndex, toIndexExclusive });
	};
	const visit = (node: TranscriptFrontierNode): void => {
		if (offBranch) return;
		let compacted = 0;
		let visible = 0;
		let off = 0;
		// A parent's coverage is its children's: a summary it is built on that is not among the nodes ends the view.
		const covered = coveredSourceRefs(node, (id) => nodes.get(id));
		if (!covered) {
			offBranch = true;
			return;
		}
		const compactedRefs: typeof covered = [];
		for (const ref of covered) {
			const standing = standingOf(ref.entryId);
			if (standing === "compacted") {
				compacted += 1;
				if (compactedRefs.length < MAX_POINTER_SOURCE_HANDLES) compactedRefs.push(ref);
			} else if (standing === "visible") visible += 1;
			else off += 1;
		}
		if (off === 0 && visible === 0) {
			items.push({ kind: "node", node });
			return;
		}
		if (off === 0 && compacted === 0) {
			pushVisible(node.spanRange.fromIndex, node.spanRange.toIndexExclusive);
			return;
		}
		const [leftId, rightId] = node.children ?? [];
		const left = leftId === undefined ? undefined : nodes.get(leftId);
		const right = rightId === undefined ? undefined : nodes.get(rightId);
		if (left && right) {
			visit(left);
			visit(right);
			return;
		}
		if (off > 0) {
			offBranch = true;
			return;
		}
		items.push({
			kind: "mixed",
			node,
			visibleSpans: visible,
			compactedSpans: compacted,
			compactedHandles: compactedRefs.map(formatTranscriptSourceHandle),
		});
	};
	for (const id of selection.nodeIds) {
		const node = nodes.get(id);
		if (!node) throw new Error(`Frontier node ${id} is not among the accepted nodes.`);
		visit(node);
		if (offBranch) break;
	}
	while (items[items.length - 1]?.kind === "visible") {
		items.pop();
		truncated = true;
	}
	return { items, truncated: truncated || offBranch, offBranch };
}

function renderMixedPointer(item: Extract<FrontierViewItem, { kind: "mixed" }>, audience: FrontierAudience): string {
	const handle = formatTranscriptNodeHandle(item.node.id);
	const { fromIndex, toIndexExclusive } = item.node.spanRange;
	const more = item.compactedSpans - item.compactedHandles.length;
	const sources = `${item.compactedHandles.join(" ")}${more > 0 ? ` and ${more} more` : ""}`;
	return `[spans [${fromIndex},${toIndexExclusive}) of ${handle} also cover ${item.visibleSpans} span(s) the live context still shows, so its summary is withheld; compacted-away sources: ${sources}; list them all with ${expandCall(audience, handle)}]`;
}

/**
 * Render a live-branch view: node records, one line per still-visible stretch and per withheld mixed
 * record, the coarse pointer and the gap record, under the same byte accounting as {@link renderFrontier}
 * and within `allowanceLines` lines of the whole rendering (frame, pointer and gap lines included).
 */
export function renderFrontierView(
	view: FrontierView,
	options: {
		sessionId: string;
		revision: number;
		omittedBeforeIndex: number;
		gap?: TranscriptFrontierGap;
		allowanceBytes: number;
		allowanceLines: number;
		audience?: FrontierAudience;
	},
): TranscriptFrontierRendering {
	const audience = options.audience ?? "root";
	const records = view.items.map((item): RenderableRecord => {
		const { fromIndex, toIndexExclusive } = itemRange(item);
		if (item.kind === "node") {
			return { text: renderRecord(item.node), fromIndex, toIndexExclusive, nodeId: item.node.id };
		}
		if (item.kind === "mixed") return { text: renderMixedPointer(item, audience), fromIndex, toIndexExclusive };
		return {
			text: `[spans [${fromIndex},${toIndexExclusive}) remain in the live context and are not repeated here]`,
			fromIndex,
			toIndexExclusive,
		};
	});
	const last = records[records.length - 1];
	return renderRecords(
		records,
		{
			sessionId: options.sessionId,
			revision: options.revision,
			omittedBeforeIndex: options.omittedBeforeIndex,
			coveredThroughIndex: last ? last.toIndexExclusive : options.omittedBeforeIndex,
		},
		{
			...(options.gap ? { gap: options.gap } : {}),
			allowanceBytes: options.allowanceBytes,
			allowanceLines: options.allowanceLines,
			audience,
		},
	);
}
