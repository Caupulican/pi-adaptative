/**
 * Bookkeeping records of the transcript memory coordinator: the terminal batch being counted, the store-retry work
 * owed after an unavailable write, and the re-admission hold state of a node.
 */

import type { TranscriptMemoryTerminalCause } from "./transcript-memory-ports.ts";

export type ReadmissionHoldState = "admitted" | "rejected" | "uncertain" | "unavailable" | "waiting";

export interface BatchState {
	id: number;
	startedAt: number;
	succeeded: number;
	failed: number;
	cancelled: number;
	stale: number;
	causes: TranscriptMemoryTerminalCause[];
}

/**
 * Work a store write the store could not serve (its typed `unavailable`) left undone, tried again after the store
 * backoff ({@link TranscriptMemory.deferStoreWork}): discovery as a whole, retention, anchoring of undated nodes, the
 * reconciliation of sessions and the republication of frontiers.
 */
interface StoreRetryWork {
	discover: boolean;
	retention: boolean;
	anchors: boolean;
	sessions: Set<string>;
	frontiers: Set<string>;
	/** Forgotten sessions whose derived data is still to be removed (their permanent marker is already durable). */
	forgets: Set<string>;
}

export function emptyStoreRetry(): StoreRetryWork {
	return {
		discover: false,
		retention: false,
		anchors: false,
		sessions: new Set(),
		frontiers: new Set(),
		forgets: new Set(),
	};
}
