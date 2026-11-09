/**
 * Summary construction of the transcript memory coordinator: the reads of source text and of the context that feed
 * a summary request, the construction of leaf and parent nodes, and the request that re-judges an accepted node.
 */

import type { CoordinatorHost } from "./transcript-coordinator-host.ts";
import type { JobOutcome, SourceReadFailure } from "./transcript-job-outcome.ts";
import {
	formatTranscriptNodeHandle,
	isCurrentCaptureIdentity,
	sameTranscriptSource,
	TRANSCRIPT_CAPTURE_VERSION,
	TRANSCRIPT_SUMMARY_RECIPE_VERSION,
	TRANSCRIPT_SUMMARY_SCHEMA_VERSION,
	TRANSCRIPT_SUMMARY_TARGET_BYTES,
	type TranscriptReadUnavailable,
	type TranscriptSourceRef,
	type TranscriptSourceSpan,
	utf8ByteLength,
} from "./transcript-memory-contracts.ts";
import type { TranscriptSummarizerPort } from "./transcript-memory-ports.ts";
import type { TranscriptReadmissionWait } from "./transcript-memory-status.ts";
import { lineageStamp } from "./transcript-session-runtime.ts";
import {
	admissionBlockFromSummary,
	admissionBlocksFromCaptures,
	type TranscriptSummaryAdmissionRequest,
} from "./transcript-summary-admission.ts";
import { coversLiveSpans } from "./transcript-summary-catalog.ts";
import {
	coveredSourceRefs,
	exactCopyText,
	isCurrentCaptureNode,
	leafIdentity,
	legacyCaptureRef,
	parentIdentity,
	type TranscriptCaptureText,
	type TranscriptSummaryNode,
} from "./transcript-summary-node.ts";
import { summaryRequest, withHandle } from "./transcript-summary-prompt.ts";
import type { TranscriptSummaryClaimToken, TranscriptSummaryJob } from "./transcript-summary-scheduler.ts";

export const TRANSCRIPT_MEMORY_CONTEXT_BYTES = 2 * 1024;

export const TRANSCRIPT_MEMORY_CONTEXT_SPANS = 2;

function minTimestamp(values: readonly (string | undefined)[]): string | undefined {
	let best: string | undefined;
	let bestTime = Number.POSITIVE_INFINITY;
	for (const value of values) {
		if (value === undefined) continue;
		const time = Date.parse(value);
		if (!Number.isNaN(time) && time < bestTime) {
			bestTime = time;
			best = value;
		}
	}
	return best;
}

const SOURCE_READ_PAGES = 8;

const SOURCE_READ_BYTES = 8 * 1024;

export function failureFor(unavailable: TranscriptReadUnavailable): SourceReadFailure {
	if (unavailable.status === "pending" || unavailable.status === "unavailable") {
		return {
			kind: "fail",
			failure: { kind: "transient", message: `source ${unavailable.status}: ${unavailable.reason}` },
		};
	}
	return { kind: "stale", reason: `source ${unavailable.status}: ${unavailable.reason}` };
}

/**
 * Exact part text, verified through the one capture identity: the text with the span's own metadata (role, tool,
 * error status, timestamp, origin) must be exactly what the span's handle names.
 */
export async function readSourceText(
	host: Pick<CoordinatorHost, "ports" | "failureFor">,
	span: TranscriptSourceSpan,
): Promise<{ text: string } | { outcome: SourceReadFailure }> {
	const { ref } = span;
	let cursor = 0;
	let text = "";
	for (let page = 0; page < SOURCE_READ_PAGES; page++) {
		const result = await host.ports.reader.readSource({ ref, cursor, maxBytes: SOURCE_READ_BYTES });
		if (result.status !== "ok") return { outcome: host.failureFor(result) };
		text += result.text;
		if (result.nextCursor === undefined) {
			return isCurrentCaptureIdentity(ref, span, text)
				? { text }
				: {
						outcome: {
							kind: "stale",
							reason: "the source text or its recorded metadata no longer match its identity",
						},
					};
		}
		cursor = result.nextCursor;
	}
	return {
		outcome: { kind: "fail", failure: { kind: "malformed", message: "source part exceeds the read bound" } },
	};
}

export async function buildLeafNode(
	host: Pick<
		CoordinatorHost,
		| "ports"
		| "failureFor"
		| "readText"
		| "makeNode"
		| "modelWorkBlock"
		| "readContext"
		| "reusableDormant"
		| "summarizeChecked"
	>,
	job: TranscriptSummaryJob,
	token: TranscriptSummaryClaimToken,
	summarizer: TranscriptSummarizerPort,
	signal: AbortSignal,
): Promise<JobOutcome> {
	const refs = job.sourceRefs ?? [];
	const live = await host.ports.reader.listLineageSpans({
		sessionId: job.sessionId,
		fromIndex: job.spanRange.fromIndex,
		maxSpans: refs.length,
	});
	if (live.status !== "ok") return host.failureFor(live);
	if (!coversLiveSpans(live, refs)) return { kind: "stale", reason: "the covered spans changed" };
	const covered: TranscriptCaptureText[] = [];
	for (const span of live.spans) {
		const read = await host.readText(span);
		if ("outcome" in read) return read.outcome;
		covered.push({ span, text: read.text });
	}
	const base = {
		sessionId: job.sessionId,
		lineageDigest: live.lineageDigest,
		spanRange: job.spanRange,
		ordinal: job.ordinal,
		coveredFrom: live.spans[0]?.timestamp,
		coveredTo: live.spans[live.spans.length - 1]?.timestamp,
	};
	const exact = exactCopyText(covered);
	if (exact !== undefined) {
		return {
			kind: "node",
			node: host.makeNode({
				...base,
				level: 0,
				id: leafIdentity({ sessionId: job.sessionId, sourceRefs: refs, contextRefs: [] }),
				legacyIdentity: leafIdentity({
					sessionId: job.sessionId,
					sourceRefs: live.spans.map(legacyCaptureRef),
					contextRefs: [],
				}),
				sourceRefs: refs,
				contextRefs: [],
				text: exact,
				quality: "exact_copy",
				oldestDependencyAt: minTimestamp(live.spans.map((span) => span.timestamp)),
			}),
		};
	}
	// Model work needs the summarizer and the admission judge both: held before any call if either cannot run.
	const blocked = host.modelWorkBlock();
	if (blocked) return { kind: "held", scope: "model_work", reason: blocked.reason };

	const context = await host.readContext(job, signal, lineageStamp(live));
	if ("outcome" in context) return context.outcome;
	const contextRefs = context.items.map((item) => item.span.ref);
	// Covered spans were verified live above and the context was read from the same lineage.
	const reusable = host.reusableDormant(
		leafIdentity({ sessionId: job.sessionId, sourceRefs: refs, contextRefs }),
		job,
	);
	if (reusable) return { kind: "node", node: reusable };
	const request = summaryRequest(summarizer.model, [
		"Summarize the SOURCE.\n\n",
		...(context.items.length > 0
			? [
					"CONTEXT (earlier turns, for resolving references only):\n",
					{ untrusted: context.items.map(withHandle).join("\n"), source: "memory:summary-context" },
				]
			: ["CONTEXT: none available."]),
		"\n\nSOURCE:\n",
		{ untrusted: covered.map(withHandle).join("\n"), source: "memory:summary-source" },
	]);
	const reply = await host.summarizeChecked(job, token, summarizer, request, signal, refs, contextRefs, {
		level: 0,
		target: admissionBlocksFromCaptures(covered),
		context: admissionBlocksFromCaptures(context.items),
	});
	if ("outcome" in reply) return reply.outcome;
	return {
		kind: "node",
		node: host.makeNode({
			...base,
			level: 0,
			id: leafIdentity({ sessionId: job.sessionId, sourceRefs: refs, contextRefs }),
			legacyIdentity: leafIdentity({
				sessionId: job.sessionId,
				sourceRefs: live.spans.map(legacyCaptureRef),
				contextRefs: context.items.map((item) => legacyCaptureRef(item.span)),
			}),
			sourceRefs: refs,
			contextRefs,
			text: reply.text,
			quality: "model_summary",
			model: reply.model,
			admission: reply.admission,
			oldestDependencyAt: minTimestamp([
				...live.spans.map((span) => span.timestamp),
				...context.items.map((item) => item.span.timestamp),
			]),
		}),
	};
}

/**
 * The dormant node of exactly this identity, when it may be published again with no summarizer or evaluator
 * call: the same position as the job, and the catalog's read rule finds it neither expired, of unknown age nor
 * unapproved under the CURRENT admission contract (a parent judged with its accepted children). The caller has
 * verified its covered and context spans live. Otherwise undefined, and the job builds normally: never a
 * partial reuse. Publication then takes the normal fenced path with every publication fence.
 *
 * The node is returned exactly as parked: node content is immutable, so a publication that fails after writing
 * the node file leaves the dormant entry's content as it was. The lineage the coverage was verified against at
 * publication is recorded on the session cursor when the rest of the session was verified on it too
 * ({@link advanceCursor}).
 */
export function reusableDormantNode(
	host: Pick<CoordinatorHost, "dormant" | "catalog" | "retentionCutoff">,
	id: string,
	job: TranscriptSummaryJob,
): TranscriptSummaryNode | undefined {
	const node = host.dormant.get(id);
	if (
		!node ||
		!isCurrentCaptureNode(node) ||
		node.level !== job.level ||
		node.ordinal !== job.ordinal ||
		node.spanRange.fromIndex !== job.spanRange.fromIndex ||
		node.spanRange.toIndexExclusive !== job.spanRange.toIndexExclusive
	) {
		return undefined;
	}
	return host.catalog.readRefusal(node, host.retentionCutoff()) === undefined ? node : undefined;
}

/**
 * Up to two preceding spans of the same selected lineage within 2 KiB: nearest first, then chronological. The
 * listing must carry `stamp`, the {@link lineageStamp} of the covered spans' read; otherwise context and covered
 * spans would come from two lineages, and the job ends stale to be enumerated again.
 */
export async function readSummaryContext(
	host: Pick<CoordinatorHost, "ports" | "isOutsideRetention" | "readText">,
	job: TranscriptSummaryJob,
	signal: AbortSignal,
	stamp: string | undefined,
): Promise<{ items: TranscriptCaptureText[] } | { outcome: JobOutcome }> {
	const from = job.spanRange.fromIndex;
	const count = Math.min(TRANSCRIPT_MEMORY_CONTEXT_SPANS, from);
	if (count === 0) return { items: [] };
	const preceding = await host.ports.reader.listLineageSpans({
		sessionId: job.sessionId,
		fromIndex: from - count,
		maxSpans: count,
	});
	if (preceding.status !== "ok") return { items: [] };
	const precedingStamp = lineageStamp(preceding);
	if (precedingStamp === undefined || precedingStamp !== stamp) {
		return { outcome: { kind: "stale", reason: "the lineage moved during verification" } };
	}
	const chosen: TranscriptSourceSpan[] = [];
	let bytes = 0;
	for (const span of [...preceding.spans].reverse()) {
		// Context past the retention window is not consulted: a summary revoked with it is derived again from what is still permitted.
		if (
			span.lineage !== "selected" ||
			host.isOutsideRetention(span) ||
			bytes + span.bytes > TRANSCRIPT_MEMORY_CONTEXT_BYTES
		) {
			break;
		}
		chosen.unshift(span);
		bytes += span.bytes;
	}
	const items: TranscriptCaptureText[] = [];
	for (const span of chosen) {
		if (signal.aborted) return { outcome: { kind: "aborted" } };
		const read = await host.readText(span);
		// Context is optional: a part that cannot be read exactly is left out, never guessed at.
		if ("outcome" in read) return { items: [] };
		items.push({ span, text: read.text });
	}
	return { items };
}

export async function buildParentNode(
	host: Pick<
		CoordinatorHost,
		"catalog" | "nodeDenied" | "makeNode" | "modelWorkBlock" | "reusableDormant" | "summarizeChecked"
	>,
	job: TranscriptSummaryJob,
	token: TranscriptSummaryClaimToken,
	summarizer: TranscriptSummarizerPort,
	signal: AbortSignal,
): Promise<JobOutcome> {
	const children = job.children;
	const left = children ? host.catalog.get(children[0]) : undefined;
	const right = children ? host.catalog.get(children[1]) : undefined;
	if (!children || !left || !right) return { kind: "stale", reason: "a child node is no longer accepted" };
	// No model is sent text derived from a forgotten session, whether or not its removal has landed yet.
	if (host.nodeDenied(left) || host.nodeDenied(right)) {
		return { kind: "stale", reason: "a child summary belongs to a forgotten session" };
	}
	const base = {
		sessionId: job.sessionId,
		lineageDigest: right.lineageDigest,
		spanRange: job.spanRange,
		ordinal: job.ordinal,
		level: job.level,
		id: parentIdentity({ sessionId: job.sessionId, level: job.level, children, contextRefs: [] }),
		legacyIdentity:
			left.legacyIdentity !== undefined && right.legacyIdentity !== undefined
				? parentIdentity({
						sessionId: job.sessionId,
						level: job.level,
						children: [left.legacyIdentity, right.legacyIdentity],
						contextRefs: [],
					})
				: undefined,
		children,
		// A parent's coverage is its children's, never copied into it (see TranscriptSummaryNode.sourceRefs).
		sourceRefs: [] as TranscriptSourceRef[],
		contextRefs: [] as TranscriptSourceRef[],
		coveredFrom: left.coveredFrom,
		coveredTo: right.coveredTo,
		oldestDependencyAt: minTimestamp([left.oldestDependencyAt, right.oldestDependencyAt]),
	};
	// Two exact copies that still fit the target are one exact copy of the union: no model call.
	if (left.quality === "exact_copy" && right.quality === "exact_copy") {
		const joined = `${left.text}\n${right.text}`;
		if (utf8ByteLength(joined) <= TRANSCRIPT_SUMMARY_TARGET_BYTES) {
			return { kind: "node", node: host.makeNode({ ...base, text: joined, quality: "exact_copy" }) };
		}
	}
	const blocked = host.modelWorkBlock();
	if (blocked) return { kind: "held", scope: "model_work", reason: blocked.reason };
	// A parent is judged only against children that are themselves approved: merging an unadmitted summary would
	// make the parent "supported" by text nothing has checked against its sources.
	const unapproved = [left, right].find((child) => !host.catalog.isApproved(child));
	if (unapproved) {
		return {
			kind: "held",
			scope: "children",
			reason: `child summary ${formatTranscriptNodeHandle(unapproved.id)} is not admitted under the current contract; a parent is judged only after both children are approved`,
		};
	}
	// Both children are accepted and approved here (anything else was held above).
	const reusable = host.reusableDormant(base.id, job);
	if (reusable) return { kind: "node", node: reusable };
	const describe = (node: TranscriptSummaryNode): string =>
		`[${formatTranscriptNodeHandle(node.id)}] spans [${node.spanRange.fromIndex},${node.spanRange.toIndexExclusive}) ${node.quality}: ${node.text}`;
	const request = summaryRequest(summarizer.model, [
		"Merge the two adjacent SUMMARIES below, oldest first, into one summary of both. Keep every cited handle that still matters.\n\nSUMMARIES:\n",
		{ untrusted: [left, right].map(describe).join("\n"), source: "memory:summary-source" },
	]);
	// The handles the merged text may cite: everything the two children cover, derived for this one check.
	const lookup = (id: string) => host.catalog.get(id);
	const leftCoverage = coveredSourceRefs(left, lookup);
	const rightCoverage = coveredSourceRefs(right, lookup);
	if (!leftCoverage || !rightCoverage) return { kind: "stale", reason: "a summary a child is built on is gone" };
	const reply = await host.summarizeChecked(
		job,
		token,
		summarizer,
		request,
		signal,
		[...leftCoverage, ...rightCoverage],
		[],
		{
			level: job.level,
			target: [left, right].map(admissionBlockFromSummary),
			context: [],
		},
	);
	if ("outcome" in reply) return reply.outcome;
	return {
		kind: "node",
		node: host.makeNode({
			...base,
			text: reply.text,
			quality: "model_summary",
			model: reply.model,
			admission: reply.admission,
		}),
	};
}

export function makeSummaryNode(
	host: Pick<CoordinatorHost, "ports">,
	fields: Omit<
		TranscriptSummaryNode,
		| "schemaVersion"
		| "recipeVersion"
		| "bytes"
		| "createdAt"
		| "coveredFrom"
		| "coveredTo"
		| "oldestDependencyAt"
		| "captureVersion"
		| "legacyIdentity"
	> & {
		coveredFrom: string | undefined;
		coveredTo: string | undefined;
		oldestDependencyAt:
			| string
			| undefined /** Every construction site states it; see {@link TranscriptSummaryNode.legacyIdentity}. */;
		legacyIdentity: string | undefined;
	},
): TranscriptSummaryNode {
	const { coveredFrom, coveredTo, oldestDependencyAt, legacyIdentity, ...rest } = fields;
	return {
		...rest,
		schemaVersion: TRANSCRIPT_SUMMARY_SCHEMA_VERSION,
		recipeVersion: TRANSCRIPT_SUMMARY_RECIPE_VERSION,
		captureVersion: TRANSCRIPT_CAPTURE_VERSION,
		...(legacyIdentity !== undefined ? { legacyIdentity } : {}),
		bytes: utf8ByteLength(fields.text),
		...(coveredFrom !== undefined ? { coveredFrom } : {}),
		...(coveredTo !== undefined ? { coveredTo } : {}),
		...(oldestDependencyAt !== undefined ? { oldestDependencyAt } : {}),
		createdAt: new Date(host.ports.now()).toISOString(),
	};
}

/**
 * The admission input of an existing node, from its re-read sources or its approved children. `wait` names why
 * the judgment cannot be prepared now; undefined means the attempt was aborted.
 */
export async function readmissionRequestFor(
	host: Pick<CoordinatorHost, "catalog" | "ports" | "readmissionSourceWait" | "failureFor" | "readText">,
	node: TranscriptSummaryNode,
	signal: AbortSignal,
): Promise<{ request: TranscriptSummaryAdmissionRequest } | { wait: TranscriptReadmissionWait } | undefined> {
	const base = { recipeVersion: node.recipeVersion, level: node.level, candidate: node.text };
	if (node.children) {
		const children = node.children.map((id) => host.catalog.get(id));
		if (children.some((child) => !host.catalog.isApproved(child))) return { wait: "child_not_approved" };
		return {
			request: {
				...base,
				target: (children as TranscriptSummaryNode[]).map(admissionBlockFromSummary),
				context: [],
			},
		};
	}
	const live = await host.ports.reader.listLineageSpans({
		sessionId: node.sessionId,
		fromIndex: node.spanRange.fromIndex,
		maxSpans: node.sourceRefs.length,
	});
	if (live.status !== "ok") return { wait: host.readmissionSourceWait(node, host.failureFor(live)) };
	if (!coversLiveSpans(live, node.sourceRefs)) {
		return {
			wait: host.readmissionSourceWait(node, {
				kind: "stale",
				reason: "the live lineage no longer covers its sources",
			}),
		};
	}
	const covered: TranscriptCaptureText[] = [];
	for (const span of live.spans) {
		if (signal.aborted) return undefined;
		const read = await host.readText(span);
		if ("outcome" in read) return { wait: host.readmissionSourceWait(node, read.outcome) };
		covered.push({ span, text: read.text });
	}
	// Context the summary consulted, when it can still be read exactly. Without it the judge sees less, so a
	// claim that only the context supported is judged unsupported: the stricter side.
	const context: TranscriptCaptureText[] = [];
	const from = node.spanRange.fromIndex;
	const count = Math.min(TRANSCRIPT_MEMORY_CONTEXT_SPANS, from);
	if (node.contextRefs.length > 0 && count > 0) {
		const preceding = await host.ports.reader.listLineageSpans({
			sessionId: node.sessionId,
			fromIndex: from - count,
			maxSpans: count,
		});
		if (preceding.status === "ok") {
			for (const ref of node.contextRefs) {
				const span = preceding.spans.find((candidate) => sameTranscriptSource(candidate.ref, ref));
				const read = span ? await host.readText(span) : undefined;
				if (span && read && !("outcome" in read)) context.push({ span, text: read.text });
			}
		}
	}
	return {
		request: {
			...base,
			target: admissionBlocksFromCaptures(covered),
			context: admissionBlocksFromCaptures(context),
		},
	};
}
