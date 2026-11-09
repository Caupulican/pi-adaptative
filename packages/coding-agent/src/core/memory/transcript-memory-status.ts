/**
 * Status shapes of the transcript memory coordinator: the snapshot diagnostics read (phase, job counts, frontiers,
 * retention, admission and paid work, revocations, internal causes) and the records that snapshot carries. Types
 * only; the coordinator assembles the snapshot.
 */

import type { TranscriptFrontierGap } from "./transcript-frontier.ts";
import type { TranscriptSummaryJobState } from "./transcript-memory-contracts.ts";
import type { TranscriptMemoryTerminalEvent } from "./transcript-memory-ports.ts";
import type { TranscriptSummaryProofHold } from "./transcript-summary-scheduler.ts";
import type { TranscriptSummaryHeldByKind, TranscriptSummaryHoldKind } from "./transcript-summary-store.ts";

export interface TranscriptMemoryFailureRecord {
	jobId: string;
	sessionId: string;
	level: number;
	reason: string;
	message: string;
	at: number;
}

export interface TranscriptMemoryFrontierStatus {
	lineageKey: string;
	revision: number;
	bytes: number;
	nodeCount: number;
	omittedBeforeIndex: number;
	coveredThroughIndex: number;
	gap?: TranscriptFrontierGap;
}

/** How derived-summary retention is currently applied; see {@link TranscriptMemorySettings.retentionDays}. */
export interface TranscriptMemoryRetentionStatus {
	/** What the setting ages out. Canonical transcripts and exact reads are never affected by it. */
	scope: "derived_summaries_only";
	days?: number;
	/** The instant the next accepted summary node reaches its retention deadline, when retention is on. */
	nextDeadlineAt?: number;
	/** Source parts whose event time is unknown; they age from the moment they were first captured (`event_time_unknown`). */
	eventTimeUnknownSources: number;
	/** Source parts without an entry time that age from the canonical session timestamp. */
	sessionTimestampSources: number;
	/** Source parts the anchor ceiling refused: work depending on them is held, never treated as ageless. */
	heldForAnchor: number;
}

/** The latest published revocation of derived history and what the scheduler did about it. */
export interface TranscriptMemoryRevocationRecord {
	at: number;
	reason: "invalidated" | "retention" | "forgotten" | "admission_rejected" | "admission_uncertain";
	revokedNodes: number;
	/** Ready jobs removed because their accepted node was revoked. */
	droppedReadyJobs: number;
	/** Parents whose two children survived and were admitted for re-derivation. */
	readmittedParents: number;
}

/** Why model summary work cannot proceed right now. A fixed class for diagnostics, the real cause in words for the operator. */
export interface TranscriptMemoryModelWorkBlock {
	kind:
		| "no_summarizer"
		| "summary_egress_not_allowed"
		| "no_admission_evaluator"
		| "admission_egress_not_allowed"
		| "admission_not_bound"
		| "admission_not_calibrated";
	reason: string;
}

/** The evidence-quality admission of model summaries, as the operator sees it. Exact copies are never judged. */
/** Why an accepted model summary is not approved: one bounded code per node, for diagnostics. */
export type TranscriptReadmissionWait =
	| "not_yet_judged"
	| "judged_rejected"
	| "judged_uncertain"
	| "evaluator_unavailable"
	| "child_not_approved"
	| "source_coverage_changed"
	| "source_unreadable"
	| "source_read_refused"
	| "judgment_discarded"
	| "store_refused"
	| "store_unavailable"
	| "admission_mismatch"
	/** Its re-admission job ended failed (its budget is spent): it is not judged again for this text and contract. */
	| "readmission_failed";

export interface TranscriptMemoryAdmissionStatus {
	contractVersion: number;
	/** Set while model summaries cannot be built or judged; exact copies still flow. */
	blocked?: TranscriptMemoryModelWorkBlock;
	/** Summary jobs held before any provider call; they resume when the condition clears. */
	heldJobs: number;
	/** The kind of the first held job's hold, when any is held. */
	heldKind?: TranscriptSummaryHoldKind;
	/** The real cause recorded with that hold when it was set. */
	heldReason?: string;
	/** Held jobs per hold kind (the kinds with none are absent); their sum is `heldJobs`. */
	heldByKind?: TranscriptSummaryHeldByKind;
	/** Job-level judgments since this coordinator started. */
	judgments: { accepted: number; rejected: number; uncertain: number; unavailable: number };
	/**
	 * Acceptances kept with a reply and published again without asking the evaluator, since this coordinator started.
	 * Not a judgment and in none of `judgments`; a kept reply that is judged again is counted there, not here.
	 */
	reused: number;
	/** Accepted model summaries without an admission under the current contract: never shown or expanded as approved. */
	unapprovedNodes: number;
	/**
	 * Paid work in distinct units, never merged: logical job attempts (claims), semantic requests (evaluator calls),
	 * transport attempts (paid provider responses behind them, retries included), usage receipts recorded and still owed,
	 * and verdicts reused without a new request. Persisted per job; summed over the jobs the scheduler holds.
	 */
	work: {
		logicalAttempts: number;
		semanticRequests: number;
		transportAttempts: number;
		receiptsRecorded: number;
		receiptsPending: number;
		receiptsLost: number;
		reused: number;
	};
	/** What re-admission of those nodes found since this coordinator started. */
	readmission: {
		admitted: number;
		rejected: number;
		uncertain: number;
		unavailable: number;
		/** The unapproved nodes counted by what each one waits for now. */
		waitingFor: Partial<Record<TranscriptReadmissionWait, number>>;
	};
}

export interface TranscriptMemoryStatus {
	enabled: boolean;
	/** `starting` while the store loads and recovers; `stopped` after a stop or fatal condition. */
	phase: "off" | "starting" | "running" | "stopped";
	disabledReason?: string;
	counts: Record<TranscriptSummaryJobState, number>;
	/** Age of the oldest job that is not terminal; undefined when there is no backlog. */
	oldestBacklogAgeMs?: number;
	recentFailures: TranscriptMemoryFailureRecord[];
	recoveryIssues: string[];
	acceptedNodes: number;
	/** UTF-8 bytes of the accepted nodes' text resident in the mirror (each node holds at most TRANSCRIPT_SUMMARY_MAX_BYTES). */
	catalogBytes: number;
	/** Accepted nodes whose retention age rests on an anchor rather than an event time. */
	nodesAgedByAnchor: number;
	admission: TranscriptMemoryAdmissionStatus;
	retention: TranscriptMemoryRetentionStatus;
	/**
	 * Parent summaries being derived again after a revocation left only their children: until they finish,
	 * those ranges are covered at child level.
	 */
	pendingParentRederivations: number;
	/**
	 * Durable terminal-proof capacity (contract C10): every admitted job identity holds a record, a reservation
	 * while its job lives, its spent budget once it failed, its carried attempts once it went stale or was cancelled
	 * after starting one, so identical work found again never gets a fresh budget. `hold`: new identities are held, for lack of a slot (`capacity`) or because proof may have been lost
	 * before `since` (`possibly_lost_proof`, sessions started by then only).
	 */
	spentAttempts: { recorded: number; reserved: number; bound: number; hold?: TranscriptSummaryProofHold };
	lastRevocation?: TranscriptMemoryRevocationRecord;
	frontierCount: number;
	/** The most recently changed frontiers, bounded. */
	frontiers: TranscriptMemoryFrontierStatus[];
	/** The latest terminal handoff records (persisted ones included), newest last. */
	recentBatches: TranscriptMemoryTerminalEvent[];
	/** The latest internal cause and when it was recorded: one slot the next cause overwrites, never cleared. */
	lastInternalError?: TranscriptMemoryInternalCause;
	/**
	 * The latest FAULT cause (a failed write or read, a refused store, a held receipt): only a fault overwrites it, so a
	 * benign event recorded later in `lastInternalError` (a lineage that moved during verification) never hides it.
	 */
	activeCause?: TranscriptMemoryInternalCause;
}

/** An internal cause the coordinator recorded, with the ISO time it was recorded at. */
export interface TranscriptMemoryInternalCause {
	cause: string;
	at: string;
}
