/**
 * Read side of the summary hierarchy for one project: the in-memory mirror of the accepted nodes and every
 * check a read of them rests on (handle resolution, retention age, approval, live dependencies, the delivery
 * fence). The running coordinator and a read-only view each hold one catalog; neither keeps a second copy of
 * these rules.
 *
 * The catalog owns no reader or settings. Whoever reads through it passes the lineage reader, the current
 * retention policy, the operation deadline and its delivery fence, so the same mirror answers under whichever
 * owner loaded it. The only clock it reads is the wall clock against that deadline. Mutations come only from
 * the owner, after the store accepted them.
 *
 * Validity of one read: a node's text depends on an exact range of its session's selected lineage, its covered
 * parts plus the context parts its leaves were built with ({@link TranscriptSummaryCatalog.dependency}). The
 * whole range is checked against the index in one bounded request (range digests over the parts' capture
 * identities; no span bodies), so a part whose capture identity changed (its text or the metadata that identity
 * binds), context included, refuses the text, while appending to the lineage never does. A node built under
 * another capture version is never served. Detection is as good as the identity: a 64-bit digest per part, not
 * collision resistant against crafted input, and only against what the index has been notified of and ingested.
 *
 * Linearization: after the delivery fence (the last await) and with no further wait before the answer, the
 * index observation the range check returned is judged current, and the node and every shown child are judged
 * again in the catalog current at delivery under the retention cutoff current at delivery. Text is delivered
 * only if all of these are current as known to this process at that one point.
 *
 * Cost per read: the descriptor is built once per immutable node (O(descendant parts), in memory); one verify
 * request (O(1) per range once the index's prefix sums reach it; the first reach hashes positions up to the
 * range end) or, for a leaf, one listing of at most its context plus covered parts; one delivery fence; all
 * within the operation deadline.
 */

import { MinHeap } from "../util/min-heap.ts";
import { FrontierNodeIndex, type TranscriptFrontierNodeIndex } from "./transcript-frontier.ts";
import {
	formatTranscriptNodeHandle,
	formatTranscriptSourceHandle,
	parseTranscriptNodeHandle,
	sameTranscriptSource,
	TRANSCRIPT_HANDLE_PREFIX,
	TRANSCRIPT_SUMMARY_CHANGED_IN_FLIGHT,
	type TranscriptIndexObservation,
	type TranscriptLineageRangeCheck,
	type TranscriptLineageReader,
	type TranscriptLineageSpansResult,
	type TranscriptReadUnavailable,
	type TranscriptSourceRef,
	type TranscriptSourceSpan,
	transcriptLineageRangeDigest,
} from "./transcript-memory-contracts.ts";
import type {
	TranscriptNodeExpansion,
	TranscriptNodeSummaryView,
	TranscriptSummaryLookupResult,
} from "./transcript-source-tools.ts";
import { needsReadmission, summaryApproval, type TranscriptSummaryApproval } from "./transcript-summary-admission.ts";
import { coveredSourceRefs, isCurrentCaptureNode, type TranscriptSummaryNode } from "./transcript-summary-node.ts";
import {
	sourceKeyOfHandle,
	type TranscriptAnchorRequest,
	type TranscriptRetentionAnchors,
} from "./transcript-summary-store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Dependency ranges longer than this are rebuilt per read, not cached on the node. */
const MAX_CACHED_DEPENDENCY_REFS = 4096;
/** Exact-source handles a refused node's reply names before it elides the rest. */
const REFUSAL_SOURCE_POINTERS = 8;

/** What one read through the catalog depends on besides the mirror. */
export interface TranscriptSummaryReadContext {
	reader: Pick<TranscriptLineageReader, "listLineageSpans" | "verifyLineageRanges" | "observationCurrent">;
	/** The retention cutoff (epoch ms) in force now, undefined when retention is off; asked at every judgment. */
	cutoff(): number | undefined;
	/** The read budget class of the lineage reads: `foreground` whenever a tool call waits on the answer. */
	priority: "foreground" | "background";
	/**
	 * Epoch ms the whole read must end by, set once where the tool call starts and passed unchanged to every
	 * reader call; past it the read answers `unavailable` (timed out), never a partial success.
	 */
	deadlineAt?: number;
	/**
	 * The delivery fence: the catalog current now (the owner's store revision checked), or why none can be
	 * vouched for. Awaited once, last; the node and every shown child are then re-resolved by id in it and
	 * judged again under a fresh {@link cutoff}, with no further wait before the answer is returned.
	 */
	confirm(): Promise<{ catalog: TranscriptSummaryCatalog } | TranscriptReadUnavailable>;
}

export interface TranscriptSummaryExpansionContext extends TranscriptSummaryReadContext {
	/** Set while the owner cannot serve node reads: answered once the handle is well-formed, before any lookup. */
	unavailable?: TranscriptReadUnavailable;
	/** Why an accepted node is not approved, in words, for the reply that points at its exact sources. */
	unapprovedReason(node: TranscriptSummaryNode): string;
}

/** The retention cutoff for `retentionDays` at `now`; undefined when retention is off. */
export function transcriptRetentionCutoff(days: number | undefined, now: number): number | undefined {
	return days === undefined ? undefined : now - days * DAY_MS;
}

/** The listed spans are exactly these covered source parts, in order. */
export function coversLiveSpans(
	live: TranscriptLineageSpansResult,
	sourceRefs: readonly TranscriptSourceRef[],
): boolean {
	return (
		live.status === "ok" &&
		live.spans.length === sourceRefs.length &&
		live.spans.every((span, position) => sameTranscriptSource(span.ref, sourceRefs[position] as TranscriptSourceRef))
	);
}

function leafKey(sessionId: string, fromIndex: number): string {
	return `${sessionId}\u0000${fromIndex}`;
}

/** The fields the permanent-forget rule reads from a node. */
export type ForgetDeniableNode = Pick<TranscriptSummaryNode, "id" | "sessionId" | "contextRefs" | "children">;

/** Whether a node itself names a forgotten session: it belongs to one, or consulted one as context. */
export function namesForgottenSession(node: ForgetDeniableNode, forgotten: ReadonlySet<string>): boolean {
	return forgotten.has(node.sessionId) || node.contextRefs.some((ref) => forgotten.has(ref.sessionId));
}

/**
 * Whether the permanent forget state denies a node: it names a forgotten session, or a summary it is built on is denied
 * (a parent does not carry its children's context, so it is found through its children). The one rule: the
 * coordinator's catalog and the read-only view both apply it, one node at a time or as a batch.
 */
export function forgetDenies(
	node: ForgetDeniableNode,
	forgotten: ReadonlySet<string>,
	lookup: (id: string) => ForgetDeniableNode | undefined,
	memo: Map<string, boolean> = new Map(),
): boolean {
	if (forgotten.size === 0) return false;
	const known = memo.get(node.id);
	if (known !== undefined) return known;
	memo.set(node.id, false);
	const denied =
		namesForgottenSession(node, forgotten) ||
		(node.children ?? []).some((childId) => {
			const child = lookup(childId);
			return child !== undefined && forgetDenies(child, forgotten, lookup, memo);
		});
	memo.set(node.id, denied);
	return denied;
}

/** The ids {@link forgetDenies} denies among `nodes`. */
export function forgottenNodeIds(nodes: Iterable<ForgetDeniableNode>, forgotten: ReadonlySet<string>): Set<string> {
	const all = [...nodes];
	const byId = new Map(all.map((node) => [node.id, node]));
	const memo = new Map<string, boolean>();
	return new Set(
		all.filter((node) => forgetDenies(node, forgotten, (id) => byId.get(id), memo)).map((node) => node.id),
	);
}

/** Why a node's text cannot be read now; see {@link TranscriptSummaryCatalog.readRefusal}. */
export type ReadRefusal = "expired" | "age_unknown" | "unapproved" | "forgotten";

/**
 * Why a node's dependencies do not vouch for its text: `moved` (the live range holds other parts),
 * `session_gone` (its session is no longer indexed), `unverifiable` (it depends on parts outside its session's
 * positions, or a parent carries context of its own), `inconsistent` (its stored dependencies disagree),
 * `descendant_revoked` (a summary it is built on is no longer accepted), `changed_in_flight` (it was revoked or
 * changed while the read ran; retrying reads the current state).
 */
type ValidityRefusal =
	| "moved"
	| "session_gone"
	| "unverifiable"
	| "inconsistent"
	| "descendant_revoked"
	| "changed_in_flight";

/**
 * One node's dependency range on its session's selected lineage: the exact parts expected at
 * `[fromIndex, fromIndex + refs.length)`, of which the first `contextCount` are context before its coverage.
 */
export type TranscriptNodeDependency =
	| {
			kind: "range";
			fromIndex: number;
			refs: readonly TranscriptSourceRef[];
			contextCount: number;
			check: TranscriptLineageRangeCheck;
	  }
	| { kind: "unverifiable" | "inconsistent" };

/** The operation deadline passed; never a partial answer. */
const TIMED_OUT: TranscriptReadUnavailable = {
	status: "unavailable",
	reason: "the summary read operation timed out before its deadline; the hits and exact sources are unaffected",
};

/**
 * The dependency range of `node`, built from its descendant leaves: positions in its coverage take its covered
 * parts; each leaf's context takes the positions just before that leaf. A position assigned twice must agree,
 * a leaf's covered part must be the node's part there, and context may reach before the coverage but not past
 * it; anything else is `inconsistent`. A part from another session has no position here: `unverifiable`.
 */
function rangeDependency(
	node: TranscriptSummaryNode,
	leaves: readonly TranscriptSummaryNode[],
): TranscriptNodeDependency {
	const from = node.spanRange.fromIndex;
	const to = node.spanRange.toIndexExclusive;
	const expected = new Map<number, TranscriptSourceRef>();
	for (const leaf of leaves) {
		const refs = [...leaf.contextRefs, ...leaf.sourceRefs];
		if (leaf.sessionId !== node.sessionId || refs.some((ref) => ref.sessionId !== node.sessionId)) {
			return { kind: "unverifiable" };
		}
		if (leaf.sourceRefs.length !== leaf.spanRange.toIndexExclusive - leaf.spanRange.fromIndex) {
			return { kind: "inconsistent" };
		}
		for (const [offset, ref] of leaf.sourceRefs.entries()) {
			const position = leaf.spanRange.fromIndex + offset;
			if (position < from || position >= to || expected.has(position)) return { kind: "inconsistent" };
			expected.set(position, ref);
		}
	}
	let depFrom = from;
	for (const leaf of leaves) {
		const contextFrom = leaf.spanRange.fromIndex - leaf.contextRefs.length;
		for (const [offset, ref] of leaf.contextRefs.entries()) {
			const position = contextFrom + offset;
			if (position < 0 || position >= to) return { kind: "inconsistent" };
			const held = expected.get(position);
			if (held) {
				if (!sameTranscriptSource(held, ref)) return { kind: "inconsistent" };
				continue;
			}
			// Context reaches before the coverage; a position inside it that no leaf covers is a hole, not context.
			if (position >= from) return { kind: "inconsistent" };
			expected.set(position, ref);
			depFrom = Math.min(depFrom, position);
		}
	}
	const refs: TranscriptSourceRef[] = [];
	for (let position = depFrom; position < to; position++) {
		const ref = expected.get(position);
		if (!ref) return { kind: "inconsistent" };
		refs.push(ref);
	}
	return {
		kind: "range",
		fromIndex: depFrom,
		refs,
		contextCount: from - depFrom,
		check: {
			sessionId: node.sessionId,
			fromIndex: depFrom,
			count: refs.length,
			digest: transcriptLineageRangeDigest(depFrom, refs),
		},
	};
}

/** The reply for a node whose dependencies do not vouch for its text; its exact sources stay readable. */
function validityReply(
	catalog: TranscriptSummaryCatalog,
	node: TranscriptSummaryNode,
	refusal: ValidityRefusal,
): TranscriptNodeExpansion {
	const pointers = catalog.sourcePointers(node);
	switch (refusal) {
		case "moved":
			return {
				status: "stale_snapshot",
				reason: `this summary's sources or context are no longer the live history; ${pointers}`,
			};
		case "session_gone":
			return {
				status: "stale_snapshot",
				reason: `this summary's session is no longer in the history index; ${pointers}`,
			};
		case "unverifiable":
			return {
				status: "unavailable",
				reason: `this summary depends on history that cannot be checked against the live index; ${pointers}`,
			};
		case "inconsistent":
			return {
				status: "stale_snapshot",
				reason: `this summary's stored dependencies disagree with each other; ${pointers}`,
			};
		case "descendant_revoked":
			return {
				status: "stale_snapshot",
				reason: `a summary this node is built on is no longer accepted; ${pointers}`,
			};
		case "changed_in_flight":
			return {
				status: "stale_snapshot",
				reason: `this summary ${TRANSCRIPT_SUMMARY_CHANGED_IN_FLIGHT}, or ${pointers}`,
			};
	}
}

/**
 * The reply for a node whose text cannot be read. Only expiry is final; otherwise its exact sources stay
 * readable and the reply names them, so recovery needs nothing from the summary.
 */
function refusalReply(
	catalog: TranscriptSummaryCatalog,
	node: TranscriptSummaryNode,
	refusal: ReadRefusal,
	context: TranscriptSummaryExpansionContext,
): TranscriptNodeExpansion {
	if (refusal === "forgotten") {
		return {
			status: "not_found",
			reason: "this summary belongs to a forgotten session and is not served; exact source recall is unaffected",
		};
	}
	if (refusal === "expired") {
		return {
			status: "expired",
			reason:
				"this derived summary is past the retention window (retentionDays) and is being revoked; exact source recall is unaffected",
		};
	}
	const pointers = catalog.sourcePointers(node);
	return {
		status: "unavailable",
		reason:
			refusal === "age_unknown"
				? `this summary's retention age cannot be established yet (no event time or anchor for its sources), so it is not shown while retention is on; ${pointers}`
				: `this summary has not passed the current admission contract (${context.unapprovedReason(node)}); ${pointers}`,
	};
}

function summaryView(entry: TranscriptSummaryNode): TranscriptNodeSummaryView {
	return {
		handle: formatTranscriptNodeHandle(entry.id),
		quality: entry.quality,
		level: entry.level,
		spanRange: { ...entry.spanRange },
		...(entry.coveredFrom !== undefined ? { coveredFrom: entry.coveredFrom } : {}),
		...(entry.coveredTo !== undefined ? { coveredTo: entry.coveredTo } : {}),
		text: entry.text,
	};
}

const NO_IDS: ReadonlySet<string> = new Set();

function addTo(map: Map<string, Set<string>>, key: string, id: string): void {
	const ids = map.get(key) ?? new Set<string>();
	ids.add(id);
	map.set(key, ids);
}

function removeFrom(map: Map<string, Set<string>>, key: string, id: string): void {
	const ids = map.get(key);
	ids?.delete(id);
	if (ids?.size === 0) map.delete(key);
}

export class TranscriptSummaryCatalog {
	private readonly nodes = new Map<string, TranscriptSummaryNode>();
	private readonly nodesBySession = new Map<string, Map<string, TranscriptSummaryNode>>();
	private readonly frontierBySession = new Map<string, FrontierNodeIndex>();
	private readonly approvedNodeIds = new Set<string>();
	private readonly approvalTracked = new Set<string>();
	private readonly unapprovedBySession = new Map<string, number>();
	private readonly approvalCache = new Map<string, TranscriptSummaryApproval>();
	private readonly parentsByChild = new Map<string, Set<string>>();
	/** Accepted model summaries without a current admission; kept with the nodes so no caller scans for them. */
	private readonly readmissionIds = new Set<string>();
	private readonly leafByStart = new Map<string, TranscriptSummaryNode>();
	/** Node ids by their 16-hex `txn:` handle prefix (more than one entry means an ambiguous handle). */
	private readonly nodeIdsByHandle = new Map<string, Set<string>>();
	/** Leaf ids by the `tx:` handle of each source part they cover (context parts are not coverage). */
	private readonly leafIdsBySource = new Map<string, Set<string>>();
	/** First-capture anchors by `tx:` source handle, mirrored from the store. Set once per source, never replaced. */
	private readonly sourceAnchors = new Map<string, string>();
	/** One session-timestamp anchor per session with the undated sources it covers (`<entryId>:<part>:<digest>`). */
	private readonly sessionAnchors = new Map<string, { at: string; sources: Set<string> }>();
	/** Nodes by the `tx:` handle of each context part they consulted (coverage parts are in `leafIdsBySource`). */
	private readonly nodesByContextHandle = new Map<string, Set<string>>();
	/**
	 * Retention instant per indexed node id (`null`: nothing to age it by), always current: a change to nodes or anchors
	 * recomputes exactly the nodes it reaches (see {@link refreshRetention}).
	 */
	private readonly retentionTimes = new Map<string, number | null>();
	/** The instants in `retentionTimes`, oldest first; an entry whose node moved on is dropped when it reaches the front. */
	private readonly retentionHeap = new MinHeap<{ at: number; id: string }>((left, right) => left.at - right.at);
	/**
	 * Whether the permanent forget state denies a node (set by the coordinator that owns that state). Denied nodes stay
	 * indexed, so the removal of their data still finds them, but no read of their text is ever served.
	 */
	private denial: ((node: TranscriptSummaryNode) => boolean) | undefined;
	/**
	 * Dependency ranges by node id; complete ones of indexed nodes only, so `unindex` and `replace` bound it. Ids are
	 * content addresses, so an entry never goes stale.
	 */
	private readonly dependencies = new Map<string, TranscriptNodeDependency>();

	/** Replace the whole mirror with a loaded store state. */
	replace(nodes: Iterable<TranscriptSummaryNode>, anchors: TranscriptRetentionAnchors): void {
		this.nodes.clear();
		this.nodesBySession.clear();
		this.frontierBySession.clear();
		this.approvedNodeIds.clear();
		this.approvalTracked.clear();
		this.unapprovedBySession.clear();
		this.approvalCache.clear();
		this.parentsByChild.clear();
		this.readmissionIds.clear();
		this.nodeIdsByHandle.clear();
		this.leafIdsBySource.clear();
		this.nodesByContextHandle.clear();
		this.leafByStart.clear();
		this.retentionTimes.clear();
		this.retentionHeap.retain(() => false);
		this.dependencies.clear();
		this.loadAnchorMaps(anchors);
		for (const node of nodes) this.index(node);
	}

	private loadAnchorMaps(anchors: TranscriptRetentionAnchors): void {
		this.sourceAnchors.clear();
		this.sessionAnchors.clear();
		for (const [handle, anchor] of Object.entries(anchors.sources)) this.sourceAnchors.set(handle, anchor.at);
		for (const [sessionId, anchor] of Object.entries(anchors.sessions)) {
			this.sessionAnchors.set(sessionId, { at: anchor.at, sources: new Set(anchor.sources) });
		}
	}

	// ---- nodes ----------------------------------------------------------------------------------

	get size(): number {
		return this.nodes.size;
	}

	get(id: string): TranscriptSummaryNode | undefined {
		return this.nodes.get(id);
	}

	has(id: string): boolean {
		return this.nodes.has(id);
	}

	values(): IterableIterator<TranscriptSummaryNode> {
		return this.nodes.values();
	}

	ids(): IterableIterator<string> {
		return this.nodes.keys();
	}

	/** The summaries built directly on this one. */
	parentsOf(id: string): ReadonlySet<string> {
		return this.parentsByChild.get(id) ?? NO_IDS;
	}

	/** Accepted model summaries that need a current admission (children and parents alike, in no order). */
	needingReadmission(): TranscriptSummaryNode[] {
		const nodes: TranscriptSummaryNode[] = [];
		for (const id of this.readmissionIds) {
			const node = this.nodes.get(id);
			if (node) nodes.push(node);
		}
		return nodes;
	}

	/** Whether the forget state denies this node ({@link forgetDenies} over the indexed nodes). */
	deniedByForget(node: TranscriptSummaryNode, forgotten: ReadonlySet<string>): boolean {
		return forgetDenies(node, forgotten, (id) => this.nodes.get(id));
	}

	/** `open its exact sources instead: ...`, the pointer every refusal of a node's text carries. */
	sourcePointers(node: TranscriptSummaryNode): string {
		const refs = coveredSourceRefs(node, (id) => this.nodes.get(id), REFUSAL_SOURCE_POINTERS + 1) ?? [];
		const shown = refs.slice(0, REFUSAL_SOURCE_POINTERS).map(formatTranscriptSourceHandle);
		if (shown.length === 0) return "open its exact sources through history search instead";
		return `open its exact sources instead: ${shown.join(", ")}${refs.length > shown.length ? ", ..." : ""}`;
	}

	/** The accepted nodes of one session; a session that ever held one keeps its (possibly empty) map. */
	sessionNodes(sessionId: string): ReadonlyMap<string, TranscriptSummaryNode> | undefined {
		return this.nodesBySession.get(sessionId);
	}

	/** Incremental approved-node index, optionally overlaid by one not-yet-published candidate. */
	frontierIndex(sessionId: string, extra?: TranscriptSummaryNode): TranscriptFrontierNodeIndex {
		return (this.frontierBySession.get(sessionId) ?? new FrontierNodeIndex()).view(extra);
	}

	hasUnapproved(sessionId: string): boolean {
		return (this.unapprovedBySession.get(sessionId) ?? 0) > 0;
	}

	hasApproved(sessionId: string): boolean {
		return this.frontierBySession.get(sessionId)?.nextStart(0) !== undefined;
	}

	/** The accepted leaf that starts at this lineage position. */
	leafAt(sessionId: string, fromIndex: number): TranscriptSummaryNode | undefined {
		return this.leafByStart.get(leafKey(sessionId, fromIndex));
	}

	index(node: TranscriptSummaryNode): void {
		if (this.nodes.has(node.id)) this.unindex(node.id);
		this.nodes.set(node.id, node);
		if (needsReadmission(node)) this.readmissionIds.add(node.id);
		let bySession = this.nodesBySession.get(node.sessionId);
		if (!bySession) {
			bySession = new Map();
			this.nodesBySession.set(node.sessionId, bySession);
		}
		bySession.set(node.id, node);
		for (const child of node.children ?? []) {
			const parents = this.parentsByChild.get(child) ?? new Set<string>();
			parents.add(node.id);
			this.parentsByChild.set(child, parents);
		}
		const prefix = parseTranscriptNodeHandle(formatTranscriptNodeHandle(node.id));
		if (prefix !== undefined) {
			const ids = this.nodeIdsByHandle.get(prefix) ?? new Set<string>();
			ids.add(node.id);
			this.nodeIdsByHandle.set(prefix, ids);
		}
		if (node.level === 0) {
			this.leafByStart.set(leafKey(node.sessionId, node.spanRange.fromIndex), node);
			for (const ref of node.sourceRefs) addTo(this.leafIdsBySource, formatTranscriptSourceHandle(ref), node.id);
		}
		for (const ref of node.contextRefs) addTo(this.nodesByContextHandle, formatTranscriptSourceHandle(ref), node.id);
		this.refreshApprovalCascade(node.id);
		this.refreshRetention([node.id]);
	}

	unindex(id: string): void {
		const node = this.nodes.get(id);
		if (!node) return;
		const ancestors = this.ancestorIds(id);
		if (this.approvalTracked.delete(id)) {
			if (this.approvedNodeIds.delete(id)) this.frontierBySession.get(node.sessionId)?.unindex(node);
			else this.adjustUnapproved(node.sessionId, -1);
		}
		for (const child of node.children ?? []) {
			const parents = this.parentsByChild.get(child);
			parents?.delete(id);
			if (parents?.size === 0) this.parentsByChild.delete(child);
		}
		this.nodes.delete(id);
		this.readmissionIds.delete(id);
		this.nodesBySession.get(node.sessionId)?.delete(id);
		const prefix = parseTranscriptNodeHandle(formatTranscriptNodeHandle(id));
		if (prefix !== undefined) removeFrom(this.nodeIdsByHandle, prefix, id);
		if (node.level === 0) {
			// A leaf indexed at the same start since then owns the entry; only this node's own entry goes.
			const key = leafKey(node.sessionId, node.spanRange.fromIndex);
			if (this.leafByStart.get(key)?.id === id) this.leafByStart.delete(key);
			for (const ref of node.sourceRefs) removeFrom(this.leafIdsBySource, formatTranscriptSourceHandle(ref), id);
		}
		for (const ref of node.contextRefs) removeFrom(this.nodesByContextHandle, formatTranscriptSourceHandle(ref), id);
		this.retentionTimes.delete(id);
		this.dependencies.delete(id);
		this.approvalCache.delete(id);
		for (const ancestor of ancestors) this.approvalCache.delete(ancestor);
		for (const ancestor of this.byLevel(ancestors)) this.refreshApproval(ancestor);
		this.refreshRetention(ancestors);
	}

	// ---- retention anchors --------------------------------------------------------------------

	/** The persisted anchor a source ages from, when it has one: its own first capture, else its session's timestamp. */
	anchorAt(ref: TranscriptSourceRef): string | undefined {
		const handle = formatTranscriptSourceHandle(ref);
		const first = this.sourceAnchors.get(handle);
		if (first !== undefined) return first;
		const session = this.sessionAnchors.get(ref.sessionId);
		return session?.sources.has(sourceKeyOfHandle(handle)) ? session.at : undefined;
	}

	/** Mirror anchors the store recorded; only the nodes that depend on those sources age differently. */
	recordAnchors(recorded: readonly TranscriptAnchorRequest[]): void {
		for (const { handle, at, basis } of recorded) {
			if (basis === "first_capture") this.sourceAnchors.set(handle, at);
			else {
				const sessionId = handle.split(":")[1] ?? "";
				const session = this.sessionAnchors.get(sessionId) ?? { at, sources: new Set<string>() };
				session.sources.add(sourceKeyOfHandle(handle));
				this.sessionAnchors.set(sessionId, session);
			}
		}
		this.refreshRetentionForHandles(recorded.map((request) => request.handle));
	}

	/**
	 * Forget these sources' anchors (first-capture entries by handle, session-anchor memberships by source key)
	 * after the store moved or dropped them; the nodes that depend on those sources age again.
	 */
	forgetAnchors(handles: readonly string[]): void {
		for (const handle of handles) {
			this.sourceAnchors.delete(handle);
			this.sessionAnchors.get(handle.split(":")[1] ?? "")?.sources.delete(sourceKeyOfHandle(handle));
		}
		this.refreshRetentionForHandles(handles);
	}

	/** Forget the anchors of these sessions after the store dropped them. */
	dropSessionAnchors(sessionIds: ReadonlySet<string>): void {
		const handles = this.anchoredHandles().filter(([handle]) => sessionIds.has(handle.split(":")[1] ?? ""));
		for (const sessionId of sessionIds) this.sessionAnchors.delete(sessionId);
		for (const [handle] of handles) this.sourceAnchors.delete(handle);
		this.refreshRetentionForHandles(handles.map(([handle]) => handle));
	}

	/**
	 * Take another owner's anchors as they are now (a read-only view following the store). Only the nodes that depend on a
	 * source whose age changed are recomputed.
	 */
	replaceAnchors(anchors: TranscriptRetentionAnchors): void {
		const before = new Map(this.anchoredHandles());
		this.loadAnchorMaps(anchors);
		const after = new Map(this.anchoredHandles());
		const changed: string[] = [];
		for (const [handle, at] of before) if (after.get(handle) !== at) changed.push(handle);
		for (const handle of after.keys()) if (!before.has(handle)) changed.push(handle);
		this.refreshRetentionForHandles(changed);
	}

	/** Every anchored source handle with the instant it ages from (its own first capture before its session's). */
	private anchoredHandles(): [string, string][] {
		const handles = new Map<string, string>();
		for (const [sessionId, anchor] of this.sessionAnchors) {
			for (const key of anchor.sources) handles.set([TRANSCRIPT_HANDLE_PREFIX, sessionId, key].join(":"), anchor.at);
		}
		for (const [handle, at] of this.sourceAnchors) handles.set(handle, at);
		return [...handles];
	}

	/** Sources aging from their first capture, and sources aging from their session's timestamp. */
	anchorCounts(): { firstCapture: number; sessionTimestamp: number } {
		let sessionTimestamp = 0;
		for (const anchor of this.sessionAnchors.values()) sessionTimestamp += anchor.sources.size;
		return { firstCapture: this.sourceAnchors.size, sessionTimestamp };
	}

	/** Every session that holds an anchor, once per anchor. */
	anchoredSessionIds(): string[] {
		return [
			...this.sessionAnchors.keys(),
			...[...this.sourceAnchors.keys()].map((handle) => handle.split(":")[1] ?? ""),
		];
	}

	// ---- retention age ------------------------------------------------------------------------

	/**
	 * The oldest instant a node depends on: its recorded dependency time (coverage and context event times),
	 * the anchors of its coverage and context sources, and everything its children depend on.
	 */
	nodeRetentionTime(node: TranscriptSummaryNode): number | undefined {
		// The memo describes the indexed node under this id; a same-id object that is not the indexed one is judged alone.
		const known = this.nodes.get(node.id) === node ? this.retentionTimes.get(node.id) : undefined;
		return known === undefined ? this.computeRetentionTime(node) : (known ?? undefined);
	}

	private computeRetentionTime(node: TranscriptSummaryNode): number | undefined {
		let oldest = Number.POSITIVE_INFINITY;
		const consider = (at: number | undefined) => {
			if (at !== undefined && !Number.isNaN(at) && at < oldest) oldest = at;
		};
		if (node.oldestDependencyAt !== undefined) consider(Date.parse(node.oldestDependencyAt));
		for (const ref of [...node.sourceRefs, ...node.contextRefs]) {
			const anchor = this.anchorAt(ref);
			if (anchor !== undefined) consider(Date.parse(anchor));
		}
		for (const childId of node.children ?? []) {
			const childTime = this.retentionTimes.get(childId);
			if (typeof childTime === "number") consider(childTime);
		}
		return oldest === Number.POSITIVE_INFINITY ? undefined : oldest;
	}

	/** Recompute these nodes and every node built on them, children first. */
	private refreshRetention(ids: Iterable<string>): void {
		const affected = new Set<string>();
		for (const id of ids) {
			if (!this.nodes.has(id)) continue;
			affected.add(id);
			for (const ancestor of this.ancestorIds(id)) affected.add(ancestor);
		}
		for (const id of this.byLevel(affected)) {
			const node = this.nodes.get(id);
			if (!node) continue;
			const time = this.computeRetentionTime(node);
			if (this.retentionTimes.get(id) === (time ?? null)) continue;
			this.retentionTimes.set(id, time ?? null);
			if (time !== undefined) this.retentionHeap.push({ at: time, id });
		}
		// Superseded instants wait in the heap until they reach the front. A same-id remove/reinsert can also push the
		// same live instant again, so compaction keeps at most one current entry per node.
		if (this.retentionHeap.size > 2 * this.nodes.size + 64) {
			const retained = new Set<string>();
			this.retentionHeap.retain((entry) => {
				if (this.retentionTimes.get(entry.id) !== entry.at || retained.has(entry.id)) return false;
				retained.add(entry.id);
				return true;
			});
		}
	}

	/** The nodes that depend on any of these sources (coverage or context), recomputed with their ancestors. */
	private refreshRetentionForHandles(handles: Iterable<string>): void {
		const ids = new Set<string>();
		for (const handle of handles) {
			for (const id of this.leafIdsBySource.get(handle) ?? []) ids.add(id);
			for (const id of this.nodesByContextHandle.get(handle) ?? []) ids.add(id);
		}
		this.refreshRetention(ids);
	}

	/** The ids ordered children before parents (a parent is always one level above its children). */
	private byLevel(ids: Iterable<string>): string[] {
		return [...ids].sort((left, right) => (this.nodes.get(left)?.level ?? 0) - (this.nodes.get(right)?.level ?? 0));
	}

	isNodeExpired(node: TranscriptSummaryNode | undefined, cutoff: number | undefined): boolean {
		if (cutoff === undefined || !node) return false;
		const at = this.nodeRetentionTime(node);
		return at !== undefined && at < cutoff;
	}

	/** The instant the next accepted node expires; undefined when retention is off or nothing can expire. */
	nextRetentionAt(days: number | undefined): number | undefined {
		if (days === undefined) return undefined;
		for (let front = this.retentionHeap.peek(); front !== undefined; front = this.retentionHeap.peek()) {
			// One millisecond past the instant a node's age reaches the window, so a wake never fires before it is due.
			if (this.retentionTimes.get(front.id) === front.at) return front.at + days * DAY_MS + 1;
			this.retentionHeap.pop();
		}
		return undefined;
	}

	/** How many nodes have at least one aged source (its own or, for a parent, one a summary it is built on has). */
	agedNodeCount(): number {
		const aged = new Map<string, boolean>();
		const visit = (node: TranscriptSummaryNode): boolean => {
			const known = aged.get(node.id);
			if (known !== undefined) return known;
			let result = [...node.sourceRefs, ...node.contextRefs].some((ref) => this.anchorAt(ref) !== undefined);
			for (const childId of node.children ?? []) {
				const child = this.nodes.get(childId);
				if (child && visit(child)) result = true;
			}
			aged.set(node.id, result);
			return result;
		};
		let count = 0;
		for (const node of this.nodes.values()) if (visit(node)) count += 1;
		return count;
	}

	// ---- approval -----------------------------------------------------------------------------

	private adjustUnapproved(sessionId: string, delta: number): void {
		const count = (this.unapprovedBySession.get(sessionId) ?? 0) + delta;
		if (count > 0) this.unapprovedBySession.set(sessionId, count);
		else this.unapprovedBySession.delete(sessionId);
	}

	private ancestorIds(id: string): Set<string> {
		const ancestors = new Set<string>();
		const pending = [...(this.parentsByChild.get(id) ?? [])];
		for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
			if (ancestors.has(parent)) continue;
			ancestors.add(parent);
			pending.push(...(this.parentsByChild.get(parent) ?? []));
		}
		return ancestors;
	}

	private refreshApprovalCascade(id: string): void {
		const affected = new Set([id, ...this.ancestorIds(id)]);
		for (const nodeId of affected) this.approvalCache.delete(nodeId);
		for (const nodeId of this.byLevel(affected)) this.refreshApproval(nodeId);
	}

	private refreshApproval(id: string): void {
		const node = this.nodes.get(id);
		if (!node) return;
		const approved = this.approval(node).approved;
		const tracked = this.approvalTracked.has(id);
		const wasApproved = this.approvedNodeIds.has(id);
		if (tracked && wasApproved === approved) return;
		if (tracked) {
			if (wasApproved) this.frontierBySession.get(node.sessionId)?.unindex(node);
			else this.adjustUnapproved(node.sessionId, -1);
		}
		this.approvalTracked.add(id);
		if (approved) {
			this.approvedNodeIds.add(id);
			const frontier = this.frontierBySession.get(node.sessionId) ?? new FrontierNodeIndex();
			frontier.index(node);
			this.frontierBySession.set(node.sessionId, frontier);
		} else {
			this.approvedNodeIds.delete(id);
			this.adjustUnapproved(node.sessionId, 1);
		}
	}

	/** The node's approval under the current admission contract, its children resolved through this mirror. */
	approval(node: TranscriptSummaryNode): TranscriptSummaryApproval {
		// The memo describes the indexed node under this id. A same-id object that is not the indexed one (a candidate, or a
		// stale copy) is judged on its own content and never reads or fills it.
		return summaryApproval(
			node,
			(id) => this.nodes.get(id),
			0,
			this.nodes.get(node.id) === node ? this.approvalCache : undefined,
		);
	}

	/**
	 * Whether a node is semantically approved under the current admission contract: an exact copy, or a model
	 * summary with a current admission whose model-summary children are approved too. Read-only for the catalog's
	 * contents; it only fills the memo of the indexed node.
	 */
	isApproved(node: TranscriptSummaryNode | undefined): boolean {
		return node !== undefined && this.approval(node).approved;
	}

	// ---- reads --------------------------------------------------------------------------------

	/**
	 * Why a node's text cannot be read under `cutoff`, or undefined when it can: past the retention window,
	 * no retention age to judge it by while retention is on (never treated as ageless), or not approved.
	 */
	readRefusal(node: TranscriptSummaryNode, cutoff: number | undefined): ReadRefusal | undefined {
		if (this.denial?.(node)) return "forgotten";
		if (this.isNodeExpired(node, cutoff)) return "expired";
		if (cutoff !== undefined && this.nodeRetentionTime(node) === undefined) return "age_unknown";
		if (!this.isApproved(node)) return "unapproved";
		return undefined;
	}

	/** Install the predicate that denies reading a node (the permanent forget state); undefined removes it. */
	setDenial(denial: ((node: TranscriptSummaryNode) => boolean) | undefined): void {
		this.denial = denial;
	}

	/** The reply for the first of these nodes whose text cannot be read under `cutoff`. */
	private refuseAny(
		nodes: readonly TranscriptSummaryNode[],
		cutoff: number | undefined,
		context: TranscriptSummaryExpansionContext,
	): TranscriptNodeExpansion | undefined {
		for (const node of nodes) {
			const refused = this.readRefusal(node, cutoff);
			if (refused) return refusalReply(this, node, refused, context);
		}
		return undefined;
	}

	/**
	 * The node's dependency range (see {@link rangeDependency}), cached by id once complete for the node this mirror
	 * indexes (a candidate not yet published is computed, never cached: nothing would evict it); undefined while a
	 * summary it is built on is not in this mirror. A parent carrying context of its own has no construction path
	 * and no checkable position, and a node captured under another identity version cannot be matched to the
	 * index, so either makes it `unverifiable`, as it does any node built on one. The one validity rule:
	 * writers use it for their own liveness checks too.
	 */
	dependency(node: TranscriptSummaryNode): TranscriptNodeDependency | undefined {
		const cached = this.dependencies.get(node.id);
		if (cached) return cached;
		const leaves: TranscriptSummaryNode[] = [];
		const pending: TranscriptSummaryNode[] = [node];
		let unverifiable = false;
		for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
			// Built from parts captured under another identity version: its inputs cannot be matched to the index.
			if (!isCurrentCaptureNode(current)) unverifiable = true;
			if (!current.children) {
				leaves.push(current);
				continue;
			}
			if (current.contextRefs.length > 0) unverifiable = true;
			for (const id of current.children) {
				const child = this.nodes.get(id);
				if (!child) return undefined;
				pending.push(child);
			}
		}
		const dependency: TranscriptNodeDependency = unverifiable
			? { kind: "unverifiable" }
			: rangeDependency(node, leaves);
		// A range this large costs as much to rebuild as the verification of it, so it is not kept resident.
		if (
			this.nodes.get(node.id) === node &&
			(dependency.kind !== "range" || dependency.refs.length <= MAX_CACHED_DEPENDENCY_REFS)
		) {
			this.dependencies.set(node.id, dependency);
		}
		return dependency;
	}

	/**
	 * One level of zoom: a parent expands into its two child summaries, a leaf into the exact source parts it
	 * covers. Typed statuses, never an empty success: `invalid_handle` for a string that is not a node handle
	 * or names more than one node, then the owner's own `unavailable` status, `not_found` for a handle no
	 * accepted node has; `expired`, or exact-source pointers for a node or child without a retention age or
	 * approval; `stale_snapshot` with pointers when its dependencies are not the live history; `unavailable`
	 * (timed out) past the operation deadline. A parent is checked with one range verification of its whole
	 * dependency range, a leaf with one listing of its context and covered parts; then the delivery fence.
	 */
	async expand(handle: string, context: TranscriptSummaryExpansionContext): Promise<TranscriptNodeExpansion> {
		const prefix = parseTranscriptNodeHandle(handle);
		if (prefix === undefined) {
			return { status: "invalid_handle", reason: "ref is not a summary node handle (expected txn:<16 hex>)." };
		}
		if (context.unavailable) return { status: context.unavailable.status, reason: context.unavailable.reason };
		const ids = this.nodeIdsByHandle.get(prefix);
		if (!ids || ids.size === 0) {
			return {
				status: "not_found",
				reason: "no accepted summary node has this handle; it may be pending, revoked or never built",
			};
		}
		if (ids.size > 1) return { status: "invalid_handle", reason: "this node handle is ambiguous" };
		const node = this.nodes.get([...ids][0] as string);
		if (!node) return { status: "not_found", reason: "the summary node was revoked" };
		const refused = this.refuseAny([node], context.cutoff(), context);
		if (refused) return refused;
		const children = node.children?.map((id) => this.nodes.get(id));
		if (children?.some((child) => child === undefined)) return validityReply(this, node, "descendant_revoked");
		const refusedChild = this.refuseAny((children ?? []) as TranscriptSummaryNode[], context.cutoff(), context);
		if (refusedChild) return refusedChild;
		const dependency = this.dependency(node);
		if (!dependency) return validityReply(this, node, "descendant_revoked");
		if (dependency.kind !== "range") return validityReply(this, node, dependency.kind);
		let sources: TranscriptSourceSpan[] | undefined;
		let observation: TranscriptIndexObservation;
		if (node.children) {
			const verified = await context.reader.verifyLineageRanges({
				checks: [dependency.check],
				priority: context.priority,
				...(context.deadlineAt !== undefined ? { deadlineAt: context.deadlineAt } : {}),
			});
			if (verified.status !== "ok") return verified;
			observation = verified.observation;
			const verdict = verified.verdicts[0];
			if (verdict !== "live")
				return validityReply(this, node, verdict === "session_gone" ? "session_gone" : "moved");
		} else {
			// One listing of the whole dependency range: the check and the listed metadata come from one answer.
			const live = await context.reader.listLineageSpans({
				sessionId: node.sessionId,
				fromIndex: dependency.fromIndex,
				maxSpans: dependency.refs.length,
				priority: context.priority,
				...(context.deadlineAt !== undefined ? { deadlineAt: context.deadlineAt } : {}),
			});
			if (live.status === "not_found") return validityReply(this, node, "session_gone");
			if (live.status !== "ok") return live;
			if (!coversLiveSpans(live, dependency.refs)) return validityReply(this, node, "moved");
			observation = live.observation;
			sources = live.spans.slice(dependency.contextCount);
		}
		const fence = await context.confirm();
		// Linearization point: from here to the return there is no further wait.
		if ("status" in fence) return fence;
		if (context.deadlineAt !== undefined && Date.now() > context.deadlineAt) return TIMED_OUT;
		// The index state the range check saw must still be current: a rewrite or branch change it has learnt of
		// since (applied or only notified) refuses, retryably.
		const observed = context.reader.observationCurrent(observation);
		if (observed.status === "changed") return validityReply(this, node, "changed_in_flight");
		if (observed.status !== "current") return observed;
		const current = fence.catalog;
		const nodeNow = current.nodes.get(node.id);
		const childrenNow = node.children?.map((id) => current.nodes.get(id));
		if (!nodeNow || childrenNow?.some((child) => child === undefined)) {
			return validityReply(this, node, "changed_in_flight");
		}
		const shown = (childrenNow ?? []) as TranscriptSummaryNode[];
		const refusedNow = current.refuseAny([nodeNow, ...shown], context.cutoff(), context);
		if (refusedNow) return refusedNow;
		if (!sources) return { status: "ok", node: summaryView(nodeNow), children: shown.map(summaryView) };
		return {
			status: "ok",
			node: summaryView(nodeNow),
			sources: sources.map((span) => ({
				handle: formatTranscriptSourceHandle(span.ref),
				role: span.role,
				...(span.toolName !== undefined ? { toolName: span.toolName } : {}),
				...(span.isError ? { isError: true } : {}),
				...(span.timestamp !== undefined ? { timestamp: span.timestamp } : {}),
				bytes: span.bytes,
			})),
		};
	}

	/**
	 * The approved summaries that cover these source hits: per hit the smallest covering node that is readable
	 * under the current cutoff (approved, unexpired, with a retention age) and whose whole dependency range is
	 * still the live history, at most `limits.maxNodes` distinct nodes in hit order, each a whole record. The
	 * smallest covering node is a leaf: every ancestor is approved only when its children are (exact-copy parents
	 * have only exact-copy children), ages no later than they do and depends on their ranges, so it cannot qualify
	 * where its leaf does not. Every candidate's range is checked in ONE verification request; a candidate that
	 * moved, lost its session or cannot be checked leaves its hit without a summary. After the delivery fence the
	 * verification's index observation must still be current (otherwise the whole lookup answers a retryable
	 * `stale_snapshot`), and each delivered leaf is re-resolved and judged again in the current catalog; one
	 * revoked meanwhile is dropped. A reader that cannot answer, or a passed deadline, is the lookup's typed
	 * status, never a partial success. Read-only: nothing here mutates the mirror or any persisted selection.
	 */
	async approvedSummariesCovering(
		refs: readonly TranscriptSourceRef[],
		limits: { maxNodes: number },
		context: TranscriptSummaryReadContext,
	): Promise<TranscriptSummaryLookupResult> {
		const cutoff = context.cutoff();
		const candidates: { leaf: TranscriptSummaryNode; check: TranscriptLineageRangeCheck }[] = [];
		const judged = new Set<string>();
		for (const ref of refs) {
			const leaf = this.coveringLeaf(ref, cutoff);
			if (!leaf || judged.has(leaf.id)) continue;
			judged.add(leaf.id);
			const dependency = this.dependency(leaf);
			if (dependency?.kind === "range") candidates.push({ leaf, check: dependency.check });
		}
		if (candidates.length === 0) return { status: "ok", summaries: [] };
		const verified = await context.reader.verifyLineageRanges({
			checks: candidates.map((candidate) => candidate.check),
			priority: context.priority,
			...(context.deadlineAt !== undefined ? { deadlineAt: context.deadlineAt } : {}),
		});
		if (verified.status !== "ok") return verified;
		const fence = await context.confirm();
		// Linearization point: from here to the return there is no further wait.
		if ("status" in fence) return fence;
		if (context.deadlineAt !== undefined && Date.now() > context.deadlineAt) return TIMED_OUT;
		const observed = context.reader.observationCurrent(verified.observation);
		if (observed.status === "changed") {
			return {
				status: "stale_snapshot",
				reason: `history this summary lookup depended on ${TRANSCRIPT_SUMMARY_CHANGED_IN_FLIGHT}`,
			};
		}
		if (observed.status !== "current") return observed;
		const current = fence.catalog;
		const cutoffNow = context.cutoff();
		const delivered: TranscriptSummaryNode[] = [];
		for (const [position, candidate] of candidates.entries()) {
			if (delivered.length >= limits.maxNodes) break;
			if (verified.verdicts[position] !== "live") continue;
			const leafNow = current.nodes.get(candidate.leaf.id);
			if (!leafNow || current.readRefusal(leafNow, cutoffNow) !== undefined) continue;
			delivered.push(leafNow);
		}
		return {
			status: "ok",
			summaries: delivered.map((node) => ({
				handle: formatTranscriptNodeHandle(node.id),
				level: node.level,
				quality: node.quality,
				...(node.coveredFrom !== undefined ? { coveredFrom: node.coveredFrom } : {}),
				...(node.coveredTo !== undefined ? { coveredTo: node.coveredTo } : {}),
				text: node.text,
				covers: [
					...new Set(
						refs
							.filter((ref) => node.sourceRefs.some((covered) => sameTranscriptSource(covered, ref)))
							.map(formatTranscriptSourceHandle),
					),
				],
			})),
		};
	}

	/** The smallest readable accepted leaf covering this exact source part. */
	private coveringLeaf(ref: TranscriptSourceRef, cutoff: number | undefined): TranscriptSummaryNode | undefined {
		let best: TranscriptSummaryNode | undefined;
		for (const id of this.leafIdsBySource.get(formatTranscriptSourceHandle(ref)) ?? []) {
			const leaf = this.nodes.get(id);
			if (
				!leaf?.sourceRefs.some((covered) => sameTranscriptSource(covered, ref)) ||
				this.readRefusal(leaf, cutoff) !== undefined
			) {
				continue;
			}
			if (
				!best ||
				leaf.sourceRefs.length < best.sourceRefs.length ||
				(leaf.sourceRefs.length === best.sourceRefs.length && leaf.id < best.id)
			) {
				best = leaf;
			}
		}
		return best;
	}
}
