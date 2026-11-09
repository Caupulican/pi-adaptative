/**
 * Per-session verification state of the transcript memory coordinator: the runtime record each session keeps
 * (enumeration position, verified lineage, backpressure), the verdict of a dead-coverage check, and the lineage stamp
 * rule that decides whether a read still vouches for the verified lineage.
 */

import type { TranscriptLineageSpansResult } from "./transcript-memory-contracts.ts";

/**
 * The cursor digest of a session whose coverage no full verification vouches for. A lineage digest is never empty,
 * so a runtime built from such a cursor never matches the live lineage and its first read verifies everything.
 */
export const UNVERIFIED_LINEAGE_DIGEST = "";

/**
 * What {@link TranscriptMemory.revokeDeadCoverage} decided: nothing dead (with the digest of the newest lineage it
 * verified on, undefined when no page was read), dead coverage revoked and the session read again, or no judgment.
 */
export type CoverageVerdict =
	| { kind: "unchanged"; digest: string | undefined }
	| { kind: "changed" }
	| { kind: "unreadable"; cause: string };

/** A verification of a session's whole coverage that found nothing dead: the newest lineage it read, and its stamp. */
export interface VerifiedLineage {
	digest: string;
	stamp: string | undefined;
}

export interface SessionRuntime {
	/** Where leaf enumeration continues: the next group starts here with this ordinal. */
	next: { fromIndex: number; ordinal: number };
	total: number;
	/**
	 * Lineage digest every accepted node and live job of the session was last verified against; undefined when no
	 * verification vouches for the whole coverage (the next read verifies it). A fresh runtime takes the cursor's
	 * digest, which carries the same guarantee ({@link advanceCursor}). A publication certified on the session moves
	 * it to the publication's lineage; one verified on another lineage clears it.
	 */
	verifiedDigest: string | undefined;
	/**
	 * The {@link lineageStamp} of a read that saw `verifiedDigest` in this run (the verification itself, or a probe
	 * that answered exactly that digest); undefined when none did. A later read with the same stamp saw the same
	 * positions, at most appended to, so every node and job verified on `verifiedDigest` is live on its lineage too
	 * ({@link vouchesFor}). Set only with `verifiedDigest` and cleared with it. In-process only: the cursor digest is
	 * the certificate across restarts.
	 */
	verifiedStamp: string | undefined;
	/**
	 * Enumeration stopped at the active-job ceiling or at the terminal-proof bound and must resume when a job
	 * finishes or a proof slot frees.
	 */
	backpressured: boolean;
}

/**
 * What a lineage read observed of its session: the index generation and the session's lineage revision, which the
 * index bumps whenever positions of the selected lineage may have changed and never on a pure append. Reads with the
 * same stamp saw one lineage (a later one possibly longer); undefined when the read does not name the session.
 */
export function lineageStamp(read: Extract<TranscriptLineageSpansResult, { status: "ok" }>): string | undefined {
	const session = read.observation.sessions.find((entry) => entry.sessionId === read.sessionId);
	return session === undefined ? undefined : `${read.observation.generation}:${session.lineageRevision}`;
}

/**
 * Whether `runtime` vouches for the lineage `read` saw: it is the verified lineage, or a read with the same
 * {@link lineageStamp} saw the verified one (the same positions, only appended to since). Two unknown stamps never
 * match.
 */
export function vouchesFor(
	runtime: SessionRuntime,
	read: Extract<TranscriptLineageSpansResult, { status: "ok" }>,
): boolean {
	return (
		runtime.verifiedDigest === read.lineageDigest ||
		(runtime.verifiedStamp !== undefined && runtime.verifiedStamp === lineageStamp(read))
	);
}

/**
 * The session-keyed state of the transcript memory coordinator: the runtime of each session, the sessions whose
 * coverage is due a revocation check, the session timestamps, the sources held for an anchor ceiling, and whether
 * undated nodes await their anchors. Field writes of a runtime take the runtime object the flow holds: after an await a
 * flow may hold a runtime the map no longer names, and its writes must land on that object as they always did.
 */
export class SessionRuntimes {
	private readonly runtimes = new Map<string, SessionRuntime>();
	/**
	 * Sessions the index reported invalidated whose coverage has not been judged since. Their next answered read revokes
	 * dead coverage whatever the digests say: the event is the index's own evidence that earlier spans changed.
	 */
	private readonly due = new Set<string>();
	/** Canonical session timestamps; `null` records a session that has none. */
	private readonly stamps = new Map<string, string | null>();
	/** Sources the anchor ceiling refused, so work depending on them is held. */
	private readonly anchorHeld = new Set<string>();
	/** Accepted nodes that still need anchors for their undated sources (a session listing was unavailable). */
	private undated = false;

	get(sessionId: string): SessionRuntime | undefined {
		return this.runtimes.get(sessionId);
	}

	has(sessionId: string): boolean {
		return this.runtimes.has(sessionId);
	}

	entries(): IterableIterator<[string, SessionRuntime]> {
		return this.runtimes.entries();
	}

	put(sessionId: string, runtime: SessionRuntime): void {
		this.runtimes.set(sessionId, runtime);
	}

	drop(sessionId: string): void {
		this.runtimes.delete(sessionId);
	}

	clear(): void {
		this.runtimes.clear();
	}

	/** The enumeration position of a runtime: where the next group starts. */
	advance(runtime: SessionRuntime, next: SessionRuntime["next"]): void {
		runtime.next = next;
	}

	setTotal(runtime: SessionRuntime, total: number): void {
		runtime.total = total;
	}

	backpressure(runtime: SessionRuntime, on: boolean): void {
		runtime.backpressured = on;
	}

	setDigest(runtime: SessionRuntime, digest: string | undefined): void {
		runtime.verifiedDigest = digest;
	}

	setStamp(runtime: SessionRuntime, stamp: string | undefined): void {
		runtime.verifiedStamp = stamp;
	}

	markDue(sessionId: string): void {
		this.due.add(sessionId);
	}

	/** The due mark is taken by the check that answers it; true when the session was due. */
	unmarkDue(sessionId: string): boolean {
		return this.due.delete(sessionId);
	}

	isDue(sessionId: string): boolean {
		return this.due.has(sessionId);
	}

	clearDue(): void {
		this.due.clear();
	}

	stampOf(sessionId: string): string | null | undefined {
		return this.stamps.get(sessionId);
	}

	hasStamp(sessionId: string): boolean {
		return this.stamps.has(sessionId);
	}

	recordStamp(sessionId: string, stamp: string | null): void {
		this.stamps.set(sessionId, stamp);
	}

	clearStamps(): void {
		this.stamps.clear();
	}

	holdAnchor(handle: string): void {
		this.anchorHeld.add(handle);
	}

	releaseAnchor(handle: string): void {
		this.anchorHeld.delete(handle);
	}

	get anchorHeldCount(): number {
		return this.anchorHeld.size;
	}

	clearAnchors(): void {
		this.anchorHeld.clear();
	}

	get undatedPending(): boolean {
		return this.undated;
	}

	setUndatedPending(on: boolean): void {
		this.undated = on;
	}
}
