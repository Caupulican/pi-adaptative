/**
 * Job-level outcomes of the transcript memory coordinator: how a summary job settles (node, hold, failure, abandon,
 * supersede, stale, approval, re-admission, abort), the scopes that park a job before any provider call, and the
 * dependency verdict a publication is checked against.
 */

import type { TranscriptLineageSpansResult } from "./transcript-memory-contracts.ts";
import type { TranscriptSummaryAdmissionResult } from "./transcript-summary-admission.ts";
import type { TranscriptSummaryNode } from "./transcript-summary-node.ts";
import type { TranscriptSummaryFailure } from "./transcript-summary-scheduler.ts";
import type { TranscriptSummaryHoldKind, TranscriptSummaryRevokeResult } from "./transcript-summary-store.ts";

/**
 * `held`: the job reached model work that cannot run yet for a reason outside the job, before any provider
 * call. It goes back to the queue with its attempt returned and is not claimed again until `scope` clears:
 * `model_work` (egress, no evaluator) clears when the coordinator can run model work again, `children` when a
 * child summary is admitted, `proof` when a terminal-proof slot frees.
 */
/**
 * `persistence`: the save that should have made the claimed attempt durable did not succeed; released by the next
 * acknowledged save.
 */
export type HoldScope = TranscriptSummaryHoldKind;

/**
 * A job held before any provider call: the kind of condition that releases it and the real cause, set with it. A
 * reason starts with its cause (a hold that carries one composes it with {@link holdReason}), so the bound the status
 * applies never cuts the cause.
 */
export interface ParkedHold {
	scope: HoldScope;
	reason: string;
}

export type JobOutcome =
	| { kind: "node"; node: TranscriptSummaryNode }
	| { kind: "held"; scope: HoldScope; reason: string; waitsForOwnerSession?: true }
	| { kind: "fail"; failure: TranscriptSummaryFailure }
	/** The claim lost its spending authority before any provider call: returned, never below the durable floor. */
	| { kind: "abandoned"; reason: string }
	/** The claim lost its authority after its summarizer call: that attempt is spent, the paid reply stays kept. */
	| { kind: "superseded"; reason: string }
	| { kind: "stale"; reason: string }
	/** A re-admission whose node is already approved under its identity (its admission was made durable before a stop). */
	| { kind: "approved" }
	/** A re-admission judgment (paid now, or reused from a kept verdict) to apply to its node. */
	| {
			kind: "readmitted";
			node: TranscriptSummaryNode;
			result: TranscriptSummaryAdmissionResult;
			reused: boolean;
			inputDigest: string;
	  }
	| { kind: "aborted" };

/** A source read that returned no text: a transient failure (the index did not answer), or an answer that it cannot. */
export type SourceReadFailure = Extract<JobOutcome, { kind: "fail" | "stale" }>;

export type PublishedRevocation = Extract<TranscriptSummaryRevokeResult, { status: "published" }>;

/**
 * What one read of a leaf's whole dependency answered ({@link TranscriptMemory.readLiveDependency}): its spans are
 * exactly live (`covered`), the index answered that they are not (`not_covered`, with why), or the index did not
 * answer (`unanswered`, the transient failure that read is): nothing is known about the spans then.
 */
export type DependencyVerdict =
	| { kind: "covered"; live: Extract<TranscriptLineageSpansResult, { status: "ok" }> }
	| { kind: "not_covered"; reason: string }
	| { kind: "unanswered"; outcome: Extract<JobOutcome, { kind: "fail" }> };
