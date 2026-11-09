/**
 * Leaf enumeration of the transcript memory coordinator: walks a session's committed spans in bounded pages and
 * queues the leaf summaries that the session's cursor does not cover yet.
 */

import type { CoordinatorHost } from "./transcript-coordinator-host.ts";
import {
	formatTranscriptSourceHandle,
	sameTranscriptSource,
	type TranscriptSourceRef,
} from "./transcript-memory-contracts.ts";
import { lineageStamp, type SessionRuntime } from "./transcript-session-runtime.ts";
import { groupLeafSpans, leafJobKey, legacyCaptureRef } from "./transcript-summary-node.ts";

/** A cut near the end of a truncated page might split a protocol pair whose result lies past the page. */
const ENUMERATION_PAGE_MARGIN = 16;

export const ENUMERATION_PAGE_SPANS = 256;

/**
 * Enumerate sealed leaf groups from the enumeration cursor and enqueue the ones not yet built. Groups
 * are deterministic from the start of the lineage, so an ordinal is a pure function of position.
 */
/**
 * Returns the real cause when a read it needed was unavailable or the lineage moved under it (a page without
 * `stamp`, the probe's {@link lineageStamp}; see {@link reconcileSession}); else undefined.
 */
export async function enumerateSummaryLeaves(
	host: Pick<
		CoordinatorHost,
		| "run"
		| "retentionCutoff"
		| "proofLedger"
		| "sessionTimestamp"
		| "live"
		| "ports"
		| "causes"
		| "lineageMoved"
		| "spanTime"
		| "anchorRefs"
		| "deferStoreWork"
		| "holds"
		| "sessions"
		| "catalog"
		| "revokeDeadCoverage"
		| "isExpired"
		| "markJobsDirty"
		| "batch"
	>,
	sessionId: string,
	runtime: SessionRuntime,
	epoch: number,
	stamp: string | undefined,
): Promise<string | undefined> {
	const scheduler = host.run.scheduler;
	if (!scheduler) return;
	const cutoff = host.retentionCutoff();
	host.sessions.backpressure(runtime, false);
	// Under a possibly-lost-proof hold the scheduler admits only sessions known to have started after it: learn
	// this session's start first (an unavailable listing leaves it held until its next index event).
	if (host.proofLedger.hold?.cause === "possibly_lost_proof") await host.sessionTimestamp(sessionId);
	while (host.live(epoch)) {
		const page = await host.ports.reader.listLineageSpans({
			sessionId,
			fromIndex: runtime.next.fromIndex,
			maxSpans: ENUMERATION_PAGE_SPANS,
		});
		if (!host.live(epoch)) return;
		if (page.status !== "ok") {
			host.causes.noteInternal(`enumerating ${sessionId}: ${page.status}: ${page.reason}`);
			return `enumerating the lineage: ${page.status}: ${page.reason}`;
		}
		// Groups and positions from another lineage than the probe's are never enqueued.
		const pageStamp = lineageStamp(page);
		if (pageStamp === undefined || pageStamp !== stamp)
			return host.lineageMoved(sessionId, "enumerating the lineage");
		if (page.spans.length === 0) return;
		const pageEnd = page.fromIndex + page.spans.length;
		const truncated = pageEnd < page.total;
		const groups = groupLeafSpans(page.spans, page.fromIndex).filter(
			(group) => group.sealed && (!truncated || group.toIndexExclusive + ENUMERATION_PAGE_MARGIN <= pageEnd),
		);
		if (groups.length === 0) return;
		// A source without a usable event time is anchored before any decision depends on its age.
		const undated = groups.flatMap((group) => group.spans).filter((span) => host.spanTime(span) === undefined);
		if (undated.length > 0) {
			const anchored = await host.anchorRefs(
				undated.map((span) => ({
					ref: span.ref,
					legacyHandle: formatTranscriptSourceHandle(legacyCaptureRef(span)),
				})),
				epoch,
			);
			if (anchored === false) return;
			if (anchored !== true) {
				// The anchors could not be written: this session is enumerated again after the store backoff.
				host.deferStoreWork(anchored.reason, { sessions: [sessionId] }, epoch);
				return anchored.reason;
			}
		}
		if (!host.live(epoch)) return;
		for (const group of groups) {
			const refs = group.spans.map((span) => span.ref);
			const legacyKey = leafJobKey({ sessionId, sourceRefs: group.spans.map(legacyCaptureRef) });
			// A recovered leaf held for reconciliation: this read of its coverage gives its version 1 key, so its budget
			// is adopted now (whatever this group leads to below) and the hold released.
			const jobId = leafJobKey({ sessionId, sourceRefs: refs });
			if (host.holds.parked.get(jobId)?.scope === "reconciliation") {
				scheduler.reconcileLegacy(jobId, legacyKey);
				host.holds.unpark(jobId);
			}
			const existing = host.catalog.leafAt(sessionId, group.fromIndex);
			if (existing) {
				const same =
					existing.sourceRefs.length === refs.length &&
					existing.sourceRefs.every((ref, position) =>
						sameTranscriptSource(ref, refs[position] as TranscriptSourceRef),
					);
				if (!same) {
					// The lineage changed under this leaf: the dead coverage is revoked and the session rediscovered.
					const dead = await host.revokeDeadCoverage(sessionId, epoch, stamp);
					return dead.kind === "unreadable" ? dead.cause : undefined;
				}
			} else if (!host.isExpired(group.spans, cutoff)) {
				const result = scheduler.enqueueLeaf(
					{
						sessionId,
						ordinal: runtime.next.ordinal,
						spanRange: { fromIndex: group.fromIndex, toIndexExclusive: group.toIndexExclusive },
						sourceRefs: refs,
						legacyKey,
					},
					host.ports.now(),
					host.holds.parked,
				);
				if (result.status === "backpressure") {
					host.sessions.backpressure(runtime, true);
					return;
				}
				// Before this run's first acknowledged save: the cursor stays, discovery reconciles every session after it.
				if (result.status === "admission_closed") return;
				// A held identity was not created: the cursor stays on it. Capacity resumes when a slot frees (and the
				// save makes the pending reservations and the hold durable); a lost-proof scope looks again on the
				// session's next index event.
				if (result.status === "held") {
					if (result.cause === "capacity") {
						host.sessions.backpressure(runtime, true);
						host.markJobsDirty();
					}
					return;
				}
				if (result.status === "created") host.batch.noteEnqueued();
			}
			host.sessions.advance(runtime, { fromIndex: group.toIndexExclusive, ordinal: runtime.next.ordinal + 1 });
		}
		if (!truncated) return;
	}
}
