import { harnessLog } from "./harness-log.ts";

/**
 * Whether one append-on-change transient record kind (see transient-records.ts) is sent this request, as ordered rules
 * over code facts: the model is told a fact once, and again only when it changed or when the request no longer shows
 * the record that told it. Each decision names the rule that fired and is logged on the accepted request.
 */

/** What a request appends for one record kind. `none` and `skip` append nothing. */
export type TransientRecordAction = "none" | "skip" | "full" | "cleared" | "pointer";

/** The rule that decided, in evaluation order. */
export type TransientRecordRule =
	/** Nothing active and nothing of the kind on record: there is nothing to say. */
	| "inactive_unrecorded"
	/** Nothing active and the record on view already says so (the cleared record, or a kind without one). */
	| "inactive_settled"
	/** Nothing active while the record on view still names active content: one cleared record. */
	| "inactive_transition"
	/** Active, and the request's history holds no record of the kind (a new kind, or a projection that dropped it). */
	| "not_on_record"
	/** Active, and the content digest differs from the last full record's. */
	| "digest_changed"
	/** Active and unchanged, but the request no longer shows the last full record in full (packed or projected away). */
	| "record_not_visible"
	/** Active, unchanged and visible, but a trailing kind lost the literal tail: a pointer reclaims it. */
	| "tail_displaced"
	/** Active, unchanged, visible, and nothing to reclaim. */
	| "unchanged_visible";

/** The facts one decision reads; every one is computed by code from the request's history and the slot. */
export interface TransientRecordFacts {
	/** The producer has content for the kind now. */
	readonly active: boolean;
	/** The kind defines a cleared record (its disappearance means something to the model). */
	readonly hasClearedText: boolean;
	/** Digest of the last full (non-pointer) record of the kind in the request's history; undefined when none. */
	readonly lastDigest: string | undefined;
	/** That last full record is the kind's cleared record. */
	readonly lastIsCleared: boolean;
	/** Digest of the content the producer offers now; undefined while inactive. */
	readonly nextDigest: string | undefined;
	/** The request's planned messages still carry that last full record unpacked, as the last record of its kind. */
	readonly lastVisible: boolean;
	/** A trailing (MUST-protocol) kind: it must occupy the literal end of the request while active. */
	readonly trailing: boolean;
	/** The trailing group is not the exact tail, or something is appended after it this request. */
	readonly tailNeedsReclaim: boolean;
}

export interface TransientRecordVerdict {
	readonly action: TransientRecordAction;
	readonly rule: TransientRecordRule;
}

/** The ordered exits. The first that matches decides; a new case adds a fact and an exit, never a special case. */
export function decideTransientRecord(facts: TransientRecordFacts): TransientRecordVerdict {
	if (!facts.active) {
		if (facts.lastDigest === undefined) return { action: "none", rule: "inactive_unrecorded" };
		if (!facts.hasClearedText || facts.lastIsCleared) return { action: "skip", rule: "inactive_settled" };
		return { action: "cleared", rule: "inactive_transition" };
	}
	if (facts.lastDigest === undefined) return { action: "full", rule: "not_on_record" };
	if (facts.lastIsCleared || facts.lastDigest !== facts.nextDigest) return { action: "full", rule: "digest_changed" };
	if (!facts.lastVisible) return { action: "full", rule: "record_not_visible" };
	if (facts.trailing && facts.tailNeedsReclaim) return { action: "pointer", rule: "tail_displaced" };
	return { action: "skip", rule: "unchanged_visible" };
}

/** One decision as the accepted request records it: ids and counts only. */
export interface TransientRecordDecision extends TransientRecordVerdict {
	readonly kind: string;
	/** Digest of the content the decision concerns (the offered content, or the cleared text); undefined for `none`. */
	readonly digest: string | undefined;
	/** Characters appended by this decision (0 for `none` and `skip`). */
	readonly chars: number;
	readonly trailing: boolean;
}

/**
 * Logs every decision of an accepted request under the `context` category: a send at `info`, a skip at `debug`.
 * Called once per accepted request, never for a measured, stale or replanned candidate.
 */
export function logTransientRecordDecisions(decisions: readonly TransientRecordDecision[]): void {
	for (const decision of decisions) {
		if (decision.action === "none") continue;
		const send = decision.action !== "skip";
		harnessLog.log(
			send ? "info" : "debug",
			"context",
			send ? "transient record sent" : "transient record skipped",
			() => ({
				kind: decision.kind,
				action: decision.action,
				rule: decision.rule,
				digest: decision.digest,
				chars: decision.chars,
				trailing: decision.trailing,
			}),
		);
	}
}

/**
 * Fast, non-cryptographic 32-bit FNV-1a string hash. Deliberately not `node:crypto`: this sits on the
 * provider-request path, which `check:browser-smoke` bundles for a browser target where `node:crypto` does not
 * resolve. The property needed is only "same content in, same value out".
 */
export function fnv1aHash32(text: string, offsetBasis = 0x811c9dc5): number {
	let hash = offsetBasis;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * A record's content digest: two FNV-1a passes with different offset bases, 64 bits as 16 hex characters, so two
 * different contents colliding (and a change going unsent) is out of practical reach for this purpose.
 */
export function transientRecordDigest(text: string): string {
	const high = fnv1aHash32(text).toString(16).padStart(8, "0");
	const low = fnv1aHash32(text, 0x9e3779b9).toString(16).padStart(8, "0");
	return `${high}${low}`;
}
