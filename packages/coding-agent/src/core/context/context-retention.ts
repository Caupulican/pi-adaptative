/**
 * Pure retention-eligibility helpers for ContextItem.
 *
 * These functions only classify what a runtime policy is *allowed* to do with an item;
 * they do not mutate, evict, or summarize anything themselves, and they never touch the
 * transcript or artifact stores. Per contracts-and-retention.md, dropping from model
 * context must never mean deleting from storage: these helpers only ever describe prompt
 * inclusion, not deletion.
 */

import { type ContextItem, HARD_RETAINED_CONTEXT_KINDS } from "./context-item.ts";

export type RetentionAction = "keep_raw" | "summarize" | "pack_to_artifact" | "drop_from_prompt";

export interface RetentionEligibility {
	/** Actions a runtime policy may choose between for this item, most-preserving first. */
	allowedActions: RetentionAction[];
	/** True if the item's semantics must stay present verbatim; only "keep_raw" is allowed. */
	hardRetained: boolean;
	reasonCodes: string[];
}

/**
 * True if the item carries a ref at all. This is item-level and store-free by design: it
 * does not check whether an artifact ref is still resolvable in a live artifact store
 * (that check belongs to a store-aware layer, e.g. `HardConstraintFlags` in
 * policy-types.ts). Do not treat this as "retrieval is available" when wiring a real store.
 */
function hasReferencedEvidence(item: ContextItem): boolean {
	return item.primaryRef !== undefined || (item.evidenceRefs?.length ?? 0) > 0;
}

/**
 * True if `kind`/`retentionClass` combination must never be dropped or summarized away,
 * regardless of budget pressure. Mirrors the "Hard retention rules" in
 * contracts-and-retention.md: pinned items and the explicitly hard-retained kinds
 * (user instructions, approvals, denials, safety constraints).
 */
export function isHardRetained(item: ContextItem): boolean {
	return item.retentionClass === "pinned" || HARD_RETAINED_CONTEXT_KINDS.has(item.kind);
}

/**
 * Determine which prompt-retention actions are permitted for an item. This is the pure
 * policy helper referenced by implementation-phases.md Phase 1: it must never allow
 * dropping pinned/open/latest-failure items, and it must never allow summarizing
 * decision-bearing content that has no evidence/retrieval path.
 */
export function evaluateRetentionEligibility(item: ContextItem): RetentionEligibility {
	if (isHardRetained(item)) {
		return {
			allowedActions: ["keep_raw"],
			hardRetained: true,
			reasonCodes: [item.retentionClass === "pinned" ? "pinned_hard_retained" : "hard_retained_kind"],
		};
	}

	const retrievable = hasReferencedEvidence(item);

	switch (item.retentionClass) {
		case "active":
			// Current working state (active goal, open requirement, plan, blocker):
			// must stay present while active. Summarizing requires evidence so the
			// summary does not silently lose decision-bearing facts.
			return {
				allowedActions: retrievable ? ["keep_raw", "summarize"] : ["keep_raw"],
				hardRetained: false,
				reasonCodes: retrievable ? ["active_summarizable"] : ["active_no_retrieval_path"],
			};
		case "decision_bearing":
			// Evidence for a current decision (latest failing check, current diff, etc.):
			// keep while the decision is pending. Only summarizable with an evidence ref
			// so exact identifiers remain recoverable.
			return {
				allowedActions: retrievable ? ["keep_raw", "summarize"] : ["keep_raw"],
				hardRetained: false,
				reasonCodes: retrievable ? ["decision_bearing_summarizable"] : ["decision_bearing_no_retrieval_path"],
			};
		case "useful":
			// Can be summarized or evicted if budget is tight AND retrieval is available.
			// With no retrieval/source ref, the conservative default is keep_raw only.
			return {
				allowedActions: retrievable
					? ["keep_raw", "summarize", "pack_to_artifact", "drop_from_prompt"]
					: ["keep_raw"],
				hardRetained: false,
				reasonCodes: retrievable ? ["useful_retrievable"] : ["useful_no_retrieval_path"],
			};
		case "ephemeral":
			// Should not be resent raw after immediate use (broad search output, command
			// logs, old file reads). Packing/dropping requires a retrieval path per the
			// "retrieval precedes aggressive eviction" ground rule.
			return {
				allowedActions: retrievable
					? ["keep_raw", "pack_to_artifact", "drop_from_prompt"]
					: ["keep_raw", "pack_to_artifact"],
				hardRetained: false,
				reasonCodes: retrievable ? ["ephemeral_retrievable"] : ["ephemeral_no_retrieval_path"],
			};
		case "expired":
			// Should not be included in prompt unless explicitly retrieved.
			return {
				allowedActions: ["drop_from_prompt"],
				hardRetained: false,
				reasonCodes: ["expired"],
			};
		default:
			return {
				allowedActions: ["keep_raw"],
				hardRetained: false,
				reasonCodes: ["unknown_retention_class"],
			};
	}
}

export function canDropFromPrompt(item: ContextItem): boolean {
	return evaluateRetentionEligibility(item).allowedActions.includes("drop_from_prompt");
}

export function canSummarize(item: ContextItem): boolean {
	return evaluateRetentionEligibility(item).allowedActions.includes("summarize");
}

export function canPackToArtifact(item: ContextItem): boolean {
	return evaluateRetentionEligibility(item).allowedActions.includes("pack_to_artifact");
}
