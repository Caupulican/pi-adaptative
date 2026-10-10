/**
 * Summary hierarchy nodes: the immutable record, its identity, and the deterministic checks that gate
 * acceptance. Pure: no filesystem, timers, workers or provider clients.
 *
 * A node covers an exact interval of one session's selected lineage. A leaf (level 0) covers a bounded
 * run of captured spans; a parent covers exactly two adjacent, aligned sibling nodes one level below.
 * Coverage (what the text summarizes) is kept apart from context (sources that only helped resolve
 * references), because a context source can change a summary without being summarized by it.
 *
 * Identity is derived from inputs, never from the produced text or the creation time, so a retry of the
 * same work addresses the same node and a re-derivation after a recipe change addresses a different one.
 */

import { createHash } from "node:crypto";
import { isPlainRecord } from "../util/value-guards.ts";
import {
	formatTranscriptSourceHandle,
	TRANSCRIPT_CAPTURE_VERSION,
	TRANSCRIPT_SUMMARY_MAX_BYTES,
	TRANSCRIPT_SUMMARY_RECIPE_VERSION,
	TRANSCRIPT_SUMMARY_SCHEMA_VERSION,
	TRANSCRIPT_SUMMARY_TARGET_BYTES,
	type TranscriptCaptureRole,
	type TranscriptSourceRef,
	type TranscriptSourceSpan,
	utf8ByteLength,
} from "./transcript-memory-contracts.ts";
import { extractTranscriptSourceHandles } from "./transcript-source-tools.ts";
import { parseSummaryAdmission, type TranscriptSummaryAdmissionRecord } from "./transcript-summary-admission.ts";

// ---------------------------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------------------------

/** `exact_copy`: the covered capture text itself, no model call. `model_summary`: a model reply that passed admission. */
export type TranscriptSummaryQuality = "exact_copy" | "model_summary";

export interface TranscriptSummarySpanRange {
	/** Zero-based position on the session's selected lineage. */
	fromIndex: number;
	toIndexExclusive: number;
}

export interface TranscriptSummaryNode {
	/** Content-independent identity: see {@link leafIdentity} and {@link parentIdentity}. */
	id: string;
	schemaVersion: number;
	recipeVersion: number;
	/** 0 for a leaf; a parent is one level above its children. */
	level: number;
	/**
	 * Position among the session's nodes of this level, zero-based. Siblings are the aligned pair
	 * (2k, 2k+1); their parent is ordinal k one level up. Alignment makes the tree shape a function of
	 * the lineage alone, independent of the order summaries happen to finish in.
	 */
	ordinal: number;
	sessionId: string;
	/**
	 * Digest of the session's selected lineage when the node was built. Informational for staleness
	 * checks: appending to a lineage changes it without invalidating earlier coverage, so it is not part
	 * of identity and is not required to match between siblings.
	 */
	lineageDigest: string;
	spanRange: TranscriptSummarySpanRange;
	/** Leaf: the exact covered parts. Parent: the children's coverage, in order. */
	sourceRefs: TranscriptSourceRef[];
	/** Parent only: exactly two adjacent siblings, left then right. */
	children?: [string, string];
	/** Sources consulted only as context; never part of coverage. */
	contextRefs: TranscriptSourceRef[];
	text: string;
	/** `Buffer.byteLength(text)`, never `text.length`. */
	bytes: number;
	quality: TranscriptSummaryQuality;
	model?: string;
	/**
	 * Model summaries only: the evidence-quality admission that makes the text semantically approved
	 * (see `transcript-summary-admission.ts`). A model summary without a record under the current admission
	 * contract is accepted-but-unapproved: it is never shown or expanded as approved text until re-admitted.
	 */
	admission?: TranscriptSummaryAdmissionRecord;
	/** Timestamp of the first covered span, when the source recorded one. */
	coveredFrom?: string;
	/** Timestamp of the last covered span, when the source recorded one. */
	coveredTo?: string;
	/**
	 * Oldest EVENT time among everything this node depends on, coverage AND context (a parent: its
	 * children's as well). Absent when no dependency carried a timestamp. That never means ageless:
	 * sources without an event time age from a persisted retention anchor kept in the store beside the
	 * nodes (see `TranscriptRetentionAnchor`), and retention takes the oldest of both.
	 */
	oldestDependencyAt?: string;
	/**
	 * The capture identity version its source handles were taken under ({@link TRANSCRIPT_CAPTURE_VERSION}); absent
	 * means 1, text-only digests that did not bind role, tool, error status, timestamp or origin. Only a node of the
	 * current version may be served or reused: {@link isCurrentCaptureNode}.
	 */
	captureVersion?: number;
	/**
	 * Migration only: the identity this node would have had under capture version 1 (a leaf over its refs with
	 * text-only digests, {@link legacyCaptureRef}; a parent over its children's legacy identities). Spent and carried
	 * attempt budgets recorded under version 1 job keys are found again through it, so an upgrade never grants a fresh
	 * budget for the same work. Absent when it could not be computed.
	 */
	legacyIdentity?: string;
	createdAt: string;
}

/** Whether a node's source handles were taken under the current capture identity: the one version predicate. */
export function isCurrentCaptureNode(node: Pick<TranscriptSummaryNode, "captureVersion">): boolean {
	return (node.captureVersion ?? 1) === TRANSCRIPT_CAPTURE_VERSION;
}

/**
 * A span's ref as capture version 1 named it: the same session, entry and part with the text-only digest. The one
 * rule for reaching version 1 evidence (job keys, node identities, anchor handles) from a current span.
 */
export function legacyCaptureRef(span: Pick<TranscriptSourceSpan, "ref" | "textDigest">): TranscriptSourceRef {
	return { ...span.ref, digest: span.textDigest };
}

function sha256(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/** Project-free stable key for one source part; the store is already project-scoped. */
function sourceKey(ref: TranscriptSourceRef): string {
	return formatTranscriptSourceHandle(ref);
}

export interface LeafIdentityInput {
	sessionId: string;
	sourceRefs: readonly TranscriptSourceRef[];
	contextRefs: readonly TranscriptSourceRef[];
}

/** Leaf identity: schema/recipe versions, level 0, session, the covered parts, the context parts. */
export function leafIdentity(input: LeafIdentityInput): string {
	return sha256([
		"leaf",
		TRANSCRIPT_SUMMARY_SCHEMA_VERSION,
		TRANSCRIPT_SUMMARY_RECIPE_VERSION,
		0,
		input.sessionId,
		input.sourceRefs.map(sourceKey),
		[],
		input.contextRefs.map(sourceKey),
	]);
}

export interface ParentIdentityInput {
	sessionId: string;
	/** The parent's level (children are one below). */
	level: number;
	children: readonly [string, string];
	contextRefs: readonly TranscriptSourceRef[];
}

/** Parent identity: versions, level, session, the two child ids (which already commit to coverage), the context parts. */
export function parentIdentity(input: ParentIdentityInput): string {
	return sha256([
		"parent",
		TRANSCRIPT_SUMMARY_SCHEMA_VERSION,
		TRANSCRIPT_SUMMARY_RECIPE_VERSION,
		input.level,
		input.sessionId,
		[],
		[...input.children],
		input.contextRefs.map(sourceKey),
	]);
}

/**
 * Scheduling key of a leaf, identical for every attempt at the same coverage. It excludes context,
 * which is chosen when the job runs, so a node id is only known once its input has been built.
 */
export function leafJobKey(input: { sessionId: string; sourceRefs: readonly TranscriptSourceRef[] }): string {
	return sha256(["leaf-job", TRANSCRIPT_SUMMARY_RECIPE_VERSION, input.sessionId, input.sourceRefs.map(sourceKey)]);
}

export function parentJobKey(input: { sessionId: string; level: number; children: readonly [string, string] }): string {
	return sha256(["parent-job", TRANSCRIPT_SUMMARY_RECIPE_VERSION, input.sessionId, input.level, [...input.children]]);
}

// ---------------------------------------------------------------------------------------------
// Text admission (deterministic checks only)
// ---------------------------------------------------------------------------------------------

export type TranscriptSummaryRejectionReason = "empty" | "overlong" | "unknown_handle" | "refusal";

export type TranscriptSummaryTextCheck =
	| { ok: true; bytes: number }
	| { ok: false; reason: TranscriptSummaryRejectionReason; detail: string };

export interface TranscriptSummaryTextInputs {
	projectId: string;
	sourceRefs: readonly TranscriptSourceRef[];
	contextRefs: readonly TranscriptSourceRef[];
}

/**
 * Refusal-shaped openings. A bounded heuristic over the first {@link REFUSAL_WINDOW_CHARS} characters:
 * it catches the stock "I'm sorry / I cannot / as an AI" replies a model returns instead of a summary.
 * It can both miss a novel refusal and, rarely, reject a faithful summary that opens with first-person
 * refusal wording; a rejected summary is an explicit failed job, never a silently altered one, and the
 * semantic question stays with the evidence-quality admission, not with this filter.
 */
const REFUSAL_WINDOW_CHARS = 160;
const REFUSAL_OPENING =
	/^\W*(?:i(?:'m| am)?\s+(?:sorry|unable|not able|afraid)|i\s+(?:cannot|can't|can not|won't|will not)|sorry\b|as an ai\b|unfortunately,?\s+i\b|i(?:'m| am) not (?:going|comfortable)|(?:i\s+)?(?:do not|don't) have (?:access|enough|the ability))/i;

/**
 * Accept or reject one candidate summary body. Never clips: an overlong reply is rejected as it is, because
 * a clipped summary would claim coverage its text no longer carries.
 */
export function validateSummaryText(text: string, inputs: TranscriptSummaryTextInputs): TranscriptSummaryTextCheck {
	if (text.trim().length === 0) return { ok: false, reason: "empty", detail: "Summary text is empty." };
	const bytes = utf8ByteLength(text);
	if (bytes > TRANSCRIPT_SUMMARY_MAX_BYTES) {
		return {
			ok: false,
			reason: "overlong",
			detail: `Summary is ${bytes} UTF-8 bytes; the ceiling is ${TRANSCRIPT_SUMMARY_MAX_BYTES}.`,
		};
	}
	if (REFUSAL_OPENING.test(text.trimStart().slice(0, REFUSAL_WINDOW_CHARS))) {
		return { ok: false, reason: "refusal", detail: "Summary opens like a refusal rather than a summary." };
	}
	const allowed = new Set([...inputs.sourceRefs, ...inputs.contextRefs].map(sourceKey));
	for (const handle of extractTranscriptSourceHandles(text, inputs.projectId)) {
		if (!allowed.has(handle)) {
			return {
				ok: false,
				reason: "unknown_handle",
				detail: `Summary cites a source handle that is not among its inputs: ${handle}`,
			};
		}
	}
	return { ok: true, bytes };
}

// ---------------------------------------------------------------------------------------------
// Capture text rendering and the exact-copy rule
// ---------------------------------------------------------------------------------------------

export interface TranscriptCaptureText {
	span: TranscriptSourceSpan;
	/** The exact captured part text, as read from canonical storage. */
	text: string;
}

function roleLabel(role: TranscriptCaptureRole): string {
	return role === "tool_call" ? "tool call" : role === "tool_result" ? "tool result" : role;
}

/**
 * One captured part as a labelled line block. The label is deterministic metadata (role, tool, error
 * status), so the rendering is stable and a result is never presented without its status.
 */
export function renderCaptureText(item: TranscriptCaptureText): string {
	const { span } = item;
	const label = `${roleLabel(span.role)}${span.toolName ? ` ${span.toolName}` : ""}${span.isError ? " (error)" : ""}`;
	return `${label}: ${item.text}`;
}

/** The covered captures rendered in lineage order; the same text is the model input when no exact copy applies. */
export function renderSummaryInput(items: readonly TranscriptCaptureText[]): string {
	return items.map(renderCaptureText).join("\n");
}

/**
 * Exact-copy rule: when the covered capture text fits the summary target, the node text IS that text and
 * no model is called. Returns undefined when it does not fit (a model summary is then required).
 */
export function exactCopyText(items: readonly TranscriptCaptureText[]): string | undefined {
	const rendered = renderSummaryInput(items);
	return utf8ByteLength(rendered) <= TRANSCRIPT_SUMMARY_TARGET_BYTES ? rendered : undefined;
}

// ---------------------------------------------------------------------------------------------
// Leaf grouping
// ---------------------------------------------------------------------------------------------

export const TRANSCRIPT_LEAF_MAX_SPANS = 8;
export const TRANSCRIPT_LEAF_MAX_SOURCE_BYTES = 8 * 1024;

export interface TranscriptLeafGroup {
	/** Position of the first span on the session's selected lineage. */
	fromIndex: number;
	toIndexExclusive: number;
	spans: TranscriptSourceSpan[];
	/** Sum of the spans' UTF-8 bytes. */
	bytes: number;
	/**
	 * True when a limit (span count, source bytes, protocol pairing) closed the group, so its coverage
	 * can never grow. False for the trailing group, which new spans may still extend.
	 */
	sealed: boolean;
}

interface ProtocolUnit {
	start: number;
	end: number;
}

/**
 * Split consecutive selected-lineage spans of one session into leaf groups of at most
 * {@link TRANSCRIPT_LEAF_MAX_SPANS} spans and {@link TRANSCRIPT_LEAF_MAX_SOURCE_BYTES} bytes. A tool call
 * and its result (same `toolCallId`) stay in one group whenever together they fit one; otherwise the
 * group is cut where the limit forces it. A single oversized span still forms a group of its own.
 */
export function groupLeafSpans(spans: readonly TranscriptSourceSpan[], fromIndex = 0): TranscriptLeafGroup[] {
	const sessionId = spans[0]?.ref.sessionId;
	for (const span of spans) {
		if (span.lineage !== "selected") {
			throw new RangeError("Leaf grouping accepts selected-lineage spans only.");
		}
		if (span.ref.sessionId !== sessionId) {
			throw new RangeError("Leaf grouping accepts the spans of one session only.");
		}
	}
	const unitFits = (unit: ProtocolUnit): boolean => {
		let bytes = 0;
		for (let index = unit.start; index <= unit.end; index++) bytes += spans[index]?.bytes ?? 0;
		return unit.end - unit.start + 1 <= TRANSCRIPT_LEAF_MAX_SPANS && bytes <= TRANSCRIPT_LEAF_MAX_SOURCE_BYTES;
	};
	// A protocol unit runs from a call's first part to the matching result's last part.
	const callStart = new Map<string, number>();
	const resultEnd = new Map<string, number>();
	spans.forEach((span, index) => {
		if (span.toolCallId === undefined) return;
		if (span.role === "tool_call" && !callStart.has(span.toolCallId)) callStart.set(span.toolCallId, index);
		if (span.role === "tool_result") resultEnd.set(span.toolCallId, index);
	});
	const units: ProtocolUnit[] = [];
	for (const [toolCallId, start] of callStart) {
		const end = resultEnd.get(toolCallId);
		if (end !== undefined && end > start) {
			const unit = { start, end };
			if (unitFits(unit)) units.push(unit);
		}
	}

	const groups: TranscriptLeafGroup[] = [];
	let start = 0;
	while (start < spans.length) {
		let end = start;
		let bytes = 0;
		while (end < spans.length) {
			const span = spans[end] as TranscriptSourceSpan;
			if (
				end > start &&
				(end - start >= TRANSCRIPT_LEAF_MAX_SPANS || bytes + span.bytes > TRANSCRIPT_LEAF_MAX_SOURCE_BYTES)
			) {
				break;
			}
			bytes += span.bytes;
			end++;
		}
		const closedByLimit = end < spans.length;
		if (closedByLimit) {
			// The cut lies between end-1 and end. Pull it back before any protocol unit it would split.
			let cut = end;
			let moved = true;
			while (moved) {
				moved = false;
				for (const unit of units) {
					if (unit.start < cut && cut <= unit.end && unit.start > start) {
						cut = unit.start;
						moved = true;
					}
				}
			}
			end = cut;
			bytes = 0;
			for (let index = start; index < end; index++) bytes += spans[index]?.bytes ?? 0;
		}
		groups.push({
			fromIndex: fromIndex + start,
			toIndexExclusive: fromIndex + end,
			spans: spans.slice(start, end),
			bytes,
			sealed: closedByLimit,
		});
		start = end;
	}
	return groups;
}

// ---------------------------------------------------------------------------------------------
// Record validation (load and publish)
// ---------------------------------------------------------------------------------------------

export type TranscriptSummaryNodeParse = { ok: true; node: TranscriptSummaryNode } | { ok: false; reason: string };

export function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseRef(value: unknown): TranscriptSourceRef | undefined {
	if (!isPlainRecord(value)) return undefined;
	const { projectId, sessionId, entryId, part, digest } = value;
	if (typeof projectId !== "string" || typeof sessionId !== "string" || typeof entryId !== "string") return undefined;
	if (!isNonNegativeInteger(part) || typeof digest !== "string") return undefined;
	if (projectId.length === 0 || sessionId.length === 0 || entryId.length === 0 || digest.length === 0)
		return undefined;
	return { projectId, sessionId, entryId, part, digest };
}

/** Source parts from an untrusted array; undefined when any entry is malformed. */
export function parseSourceRefs(value: unknown): TranscriptSourceRef[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const refs: TranscriptSourceRef[] = [];
	for (const entry of value) {
		const ref = parseRef(entry);
		if (ref === undefined) return undefined;
		refs.push(ref);
	}
	return refs;
}

export interface TranscriptSummaryHeader {
	id: string;
	sessionId: string;
	level: number;
	ordinal: number;
	spanRange: TranscriptSummarySpanRange;
}

export type TranscriptSummaryHeaderParse =
	| { ok: true; header: TranscriptSummaryHeader }
	| { ok: false; reason: string };

/**
 * The fields a persisted node and a persisted job share: id, session, level, ordinal and a non-empty span
 * range. The one owner of their validation, so a node file and a job record cannot disagree on it.
 */
export function parseSummaryHeader(value: Record<string, unknown>): TranscriptSummaryHeaderParse {
	const fail = (reason: string): TranscriptSummaryHeaderParse => ({ ok: false, reason });
	if (typeof value.id !== "string" || value.id.length === 0) return fail("id is missing");
	if (typeof value.sessionId !== "string" || value.sessionId.length === 0) return fail("sessionId is missing");
	if (!isNonNegativeInteger(value.level)) return fail("level is invalid");
	if (!isNonNegativeInteger(value.ordinal)) return fail("ordinal is invalid");
	const range = value.spanRange;
	if (
		!isPlainRecord(range) ||
		!isNonNegativeInteger(range.fromIndex) ||
		!isNonNegativeInteger(range.toIndexExclusive)
	) {
		return fail("spanRange is invalid");
	}
	if (range.toIndexExclusive <= range.fromIndex) return fail("spanRange is empty");
	return {
		ok: true,
		header: {
			id: value.id,
			sessionId: value.sessionId,
			level: value.level,
			ordinal: value.ordinal,
			spanRange: { fromIndex: range.fromIndex, toIndexExclusive: range.toIndexExclusive },
		},
	};
}

/** Two child ids from an untrusted value; undefined unless it is exactly two strings. */
export function parseChildPair(value: unknown): [string, string] | undefined {
	return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string"
		? [value[0], value[1]]
		: undefined;
}

/** Validate an untrusted node record (a file read back from disk) and recompute its identity. */
export function parseSummaryNode(value: unknown): TranscriptSummaryNodeParse {
	if (!isPlainRecord(value)) return { ok: false, reason: "node is not an object" };
	const fail = (reason: string): TranscriptSummaryNodeParse => ({ ok: false, reason });
	if (value.schemaVersion !== TRANSCRIPT_SUMMARY_SCHEMA_VERSION) return fail("unsupported schema version");
	if (value.recipeVersion !== TRANSCRIPT_SUMMARY_RECIPE_VERSION) return fail("unsupported recipe version");
	const parsedHeader = parseSummaryHeader(value);
	if (!parsedHeader.ok) return fail(parsedHeader.reason);
	const { header } = parsedHeader;
	if (typeof value.lineageDigest !== "string" || value.lineageDigest.length === 0)
		return fail("lineageDigest is missing");
	const sourceRefs = parseSourceRefs(value.sourceRefs);
	if (sourceRefs === undefined || sourceRefs.length === 0) return fail("sourceRefs is invalid");
	const contextRefs = parseSourceRefs(value.contextRefs);
	if (contextRefs === undefined) return fail("contextRefs is invalid");
	if (typeof value.text !== "string" || value.text.length === 0) return fail("text is empty");
	const bytes = utf8ByteLength(value.text);
	if (value.bytes !== bytes) return fail("bytes does not match the text");
	if (bytes > TRANSCRIPT_SUMMARY_MAX_BYTES) return fail("text exceeds the summary ceiling");
	if (value.quality !== "exact_copy" && value.quality !== "model_summary") return fail("quality is invalid");
	if (value.model !== undefined && typeof value.model !== "string") return fail("model is invalid");
	for (const field of ["coveredFrom", "coveredTo", "oldestDependencyAt"] as const) {
		const stamp = value[field];
		if (stamp !== undefined && (typeof stamp !== "string" || Number.isNaN(Date.parse(stamp)))) {
			return fail(`${field} is invalid`);
		}
	}
	if (value.quality === "exact_copy" && value.model !== undefined) return fail("an exact copy cannot name a model");
	let admission: TranscriptSummaryAdmissionRecord | undefined;
	if (value.admission !== undefined) {
		if (value.quality !== "model_summary") return fail("only a model summary carries an admission");
		const parsedAdmission = parseSummaryAdmission(value.admission);
		if (!parsedAdmission.ok) return fail(parsedAdmission.reason);
		admission = parsedAdmission.admission;
	}
	if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt)))
		return fail("createdAt is invalid");
	if (value.captureVersion !== undefined && (!isNonNegativeInteger(value.captureVersion) || value.captureVersion < 1))
		return fail("captureVersion is invalid");
	if (
		value.legacyIdentity !== undefined &&
		(typeof value.legacyIdentity !== "string" || !/^[a-f0-9]{64}$/.test(value.legacyIdentity))
	)
		return fail("legacyIdentity is invalid");

	const children = value.children === undefined ? undefined : parseChildPair(value.children);
	if (value.children !== undefined && children === undefined) return fail("children is invalid");
	const node: TranscriptSummaryNode = {
		id: header.id,
		schemaVersion: value.schemaVersion,
		recipeVersion: value.recipeVersion,
		level: header.level,
		ordinal: header.ordinal,
		sessionId: header.sessionId,
		lineageDigest: value.lineageDigest,
		spanRange: header.spanRange,
		sourceRefs,
		...(children ? { children } : {}),
		contextRefs,
		text: value.text,
		bytes,
		quality: value.quality,
		...(typeof value.model === "string" ? { model: value.model } : {}),
		...(admission ? { admission } : {}),
		...(typeof value.coveredFrom === "string" ? { coveredFrom: value.coveredFrom } : {}),
		...(typeof value.coveredTo === "string" ? { coveredTo: value.coveredTo } : {}),
		...(typeof value.oldestDependencyAt === "string" ? { oldestDependencyAt: value.oldestDependencyAt } : {}),
		...(typeof value.captureVersion === "number" ? { captureVersion: value.captureVersion } : {}),
		...(typeof value.legacyIdentity === "string" ? { legacyIdentity: value.legacyIdentity } : {}),
		createdAt: value.createdAt,
	};
	if (node.level === 0) {
		if (children !== undefined) return fail("a leaf cannot have children");
		if (node.spanRange.toIndexExclusive - node.spanRange.fromIndex !== sourceRefs.length) {
			return fail("leaf span range does not match its source parts");
		}
		if (sourceRefs.some((ref) => ref.sessionId !== node.sessionId)) return fail("leaf coverage leaves its session");
		if (leafIdentity({ sessionId: node.sessionId, sourceRefs, contextRefs }) !== node.id) {
			return fail("id does not match the leaf identity");
		}
	} else {
		if (children === undefined) return fail("a parent needs two children");
		if (parentIdentity({ sessionId: node.sessionId, level: node.level, children, contextRefs }) !== node.id) {
			return fail("id does not match the parent identity");
		}
	}
	return { ok: true, node };
}

export type TranscriptSummaryChildrenCheck = { ok: true } | { ok: false; reason: string };

/**
 * A parent covers exactly its two children: adjacent aligned siblings of one session, one level below,
 * with coverage and range equal to the children's concatenation.
 */
export function validateParentChildren(
	parent: TranscriptSummaryNode,
	left: TranscriptSummaryNode,
	right: TranscriptSummaryNode,
): TranscriptSummaryChildrenCheck {
	const fail = (reason: string): TranscriptSummaryChildrenCheck => ({ ok: false, reason });
	if (parent.children === undefined || parent.children[0] !== left.id || parent.children[1] !== right.id) {
		return fail("children do not match the parent's child ids");
	}
	if (left.sessionId !== parent.sessionId || right.sessionId !== parent.sessionId) {
		return fail("children belong to another session");
	}
	if (left.level !== parent.level - 1 || right.level !== parent.level - 1)
		return fail("children are not one level below");
	if (left.ordinal % 2 !== 0 || right.ordinal !== left.ordinal + 1)
		return fail("children are not an aligned sibling pair");
	if (parent.ordinal !== left.ordinal / 2) return fail("parent ordinal does not follow its children");
	if (left.spanRange.toIndexExclusive !== right.spanRange.fromIndex) return fail("children are not adjacent");
	if (
		parent.spanRange.fromIndex !== left.spanRange.fromIndex ||
		parent.spanRange.toIndexExclusive !== right.spanRange.toIndexExclusive
	) {
		return fail("parent range is not the children's union");
	}
	const expected = [...left.sourceRefs, ...right.sourceRefs].map(sourceKey);
	if (
		expected.length !== parent.sourceRefs.length ||
		expected.some((key, index) => key !== sourceKey(parent.sourceRefs[index] as TranscriptSourceRef))
	) {
		return fail("parent coverage is not the children's coverage in order");
	}
	return { ok: true };
}
