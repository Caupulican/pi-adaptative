/**
 * What a refused completion asks of the model, as a structured list the harness and the model can act on.
 *
 * Each failed gate maps, by its id, to one remedy kind from a closed table; the remedy carries the gate's own
 * `required_next_proof` as its next step. The table is code: a gate id outside it is reported as `follow_next`
 * (do what its next step says) instead of being guessed into a kind.
 */

import type { CompletionRejectionDetail } from "./policy.ts";

export type CompletionRemedyKind =
	/** Repair the work a deterministic gate or the harness's own check found failing; the check is rerun on complete. */
	| "fix_work"
	/** Record verified evidence (or a passing check) that shows the outcome or claim. */
	| "attach_evidence"
	/** Correct or drop a claim the evidence contradicts or does not support. */
	| "revise_claim"
	/** Repair the completion account itself: an unaccounted, unknown or mis-served path, or a missing cause. */
	| "revise_account"
	/** Resolve an open verification obligation with receiving-lane evidence. */
	| "resolve_obligation"
	/** The evaluator or the host's evidence was unavailable: not a production finding; retry once it is back. */
	| "wait_evaluator"
	/** An external gate or hook refused, or the host cannot run the proof: only the owner can change it. */
	| "ask_owner"
	/** A gate id outside the table: do what its next step says. */
	| "follow_next";

export interface CompletionRemedy {
	readonly gate: string;
	readonly kind: CompletionRemedyKind;
	readonly requirementId?: string;
	/** The gate's required next proof, bounded by {@link MAX_REMEDY_NEXT_CHARS}. */
	readonly next: string;
}

export const MAX_COMPLETION_REMEDIES = 16;
export const MAX_REMEDY_NEXT_CHARS = 240;

const EXACT_KIND: Readonly<Record<string, CompletionRemedyKind>> = {
	"G-TEST": "fix_work",
	"G-BUILD": "fix_work",
	"G-RISK": "fix_work",
	"G-OBJ": "attach_evidence",
	"G-CONSTRAINTS": "attach_evidence",
	"G-EVIDENCE": "attach_evidence",
	"G-VERIFY": "resolve_obligation",
	"JEV-outcomes_achieved": "attach_evidence",
	"JEV-required_behavior_unverified": "attach_evidence",
	"JEV-CHALLENGE-missing_requirement": "attach_evidence",
	"JEV-material_claim_unsupported": "revise_claim",
	repository_outcome_evidence_unavailable: "wait_evaluator",
	external_completion_gate: "ask_owner",
	external_hook_gate: "ask_owner",
	account_missing: "revise_account",
	account_diff_incomplete: "revise_account",
	account_cause_missing: "revise_account",
	account_cause_unknown_paths: "revise_account",
	account_evidence_oversized: "attach_evidence",
};

/** Gate ids that carry a subject after a colon (`account_change_unexplained:<path>`), by the part before it. */
const PREFIX_KIND: Readonly<Record<string, CompletionRemedyKind>> = {
	account_contradicted: "revise_claim",
	account_unsettled: "attach_evidence",
	account_unknown_evidence: "attach_evidence",
	account_unverified_evidence: "attach_evidence",
	account_change_unknown: "revise_account",
	account_change_unexplained: "revise_account",
	account_serves_unknown: "revise_account",
	account_suppression_unaccounted: "revise_account",
};

const UNAVAILABLE_STAGE = /^JEV-[\w-]+-unavailable$/u;

export function completionRemedyKind(gateId: string): CompletionRemedyKind {
	const exact = EXACT_KIND[gateId];
	if (exact) return exact;
	if (UNAVAILABLE_STAGE.test(gateId)) return "wait_evaluator";
	const colon = gateId.indexOf(":");
	return (colon > 0 ? PREFIX_KIND[gateId.slice(0, colon)] : undefined) ?? "follow_next";
}

function boundedNext(text: string): string {
	const flat = text.replace(/\s+/gu, " ").trim();
	return flat.length > MAX_REMEDY_NEXT_CHARS ? `${flat.slice(0, MAX_REMEDY_NEXT_CHARS - 1)}…` : flat;
}

export function completionRemedy(
	gate: string,
	next: string,
	options: { kind?: CompletionRemedyKind; requirementId?: string } = {},
): CompletionRemedy {
	return {
		gate,
		kind: options.kind ?? completionRemedyKind(gate),
		...(options.requirementId ? { requirementId: options.requirementId } : {}),
		next: boundedNext(next),
	};
}

/** One remedy per failed gate, in the verdict's order, at most {@link MAX_COMPLETION_REMEDIES}. */
export function completionRemedies(failedGates: readonly CompletionRejectionDetail[]): CompletionRemedy[] {
	return failedGates
		.slice(0, MAX_COMPLETION_REMEDIES)
		.map((gate) => completionRemedy(gate.id, gate.required_next_proof));
}

/** The `r` line the refusal ends with: the remedies as one JSON array, or nothing when there are none. */
export function renderCompletionRemedies(remedies: readonly CompletionRemedy[]): string[] {
	return remedies.length > 0 ? [`r ${JSON.stringify(remedies.slice(0, MAX_COMPLETION_REMEDIES))}`] : [];
}
