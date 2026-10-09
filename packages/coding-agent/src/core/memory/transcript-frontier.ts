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

import type { ActiveBranchEntryStanding } from "./active-branch-probe.ts";
import {
	formatTranscriptNodeHandle,
	formatTranscriptSourceHandle,
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
		open: `<transcript_history session="${sessionId}" revision="${revision}" covered="[${omittedBeforeIndex},${coveredThroughIndex})">`,
		close: "</transcript_history>",
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

/** One line or node record of a rendering, with the span interval it speaks about. */
interface RenderableRecord {
	text: string;
	fromIndex: number;
	toIndexExclusive: number;
	/** Set when the record is an accepted node's own record. */
	nodeId?: string;
}

/**
 * Frame, pointer and records measured in UTF-8 bytes with every wrapper and status line charged. If the
 * records no longer fit the allowance, the oldest whole records are folded into the pointer; a record is never
 * cut, and when not even the frame fits the text is empty.
 */
function renderRecords(
	records: readonly RenderableRecord[],
	frame: { sessionId: string; revision: number; omittedBeforeIndex: number; coveredThroughIndex: number },
	options: { gap?: TranscriptFrontierGap; allowanceBytes: number; audience?: FrontierAudience },
): TranscriptFrontierRendering {
	let first = 0;
	for (;;) {
		const omitted =
			first < records.length ? (records[first] as RenderableRecord).fromIndex : frame.coveredThroughIndex;
		const effectiveOmitted = first === 0 ? frame.omittedBeforeIndex : omitted;
		const built = buildFrame(
			frame.sessionId,
			frame.revision,
			effectiveOmitted,
			frame.coveredThroughIndex,
			options.gap,
			options.audience,
		);
		const included = records.slice(first);
		const bytes = frameBytes(built) + included.reduce((sum, record) => sum + utf8ByteLength(record.text) + 1, 0);
		if (bytes <= options.allowanceBytes) {
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
		if (first >= records.length) {
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
		const compactedRefs: typeof node.sourceRefs = [];
		for (const ref of node.sourceRefs) {
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
 * record, the coarse pointer and the gap record, under the same byte accounting as {@link renderFrontier}.
 */
export function renderFrontierView(
	view: FrontierView,
	options: {
		sessionId: string;
		revision: number;
		omittedBeforeIndex: number;
		gap?: TranscriptFrontierGap;
		allowanceBytes: number;
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
		{ ...(options.gap ? { gap: options.gap } : {}), allowanceBytes: options.allowanceBytes, audience },
	);
}
