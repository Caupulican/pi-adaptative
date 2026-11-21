/** Bounded ordinary-work visibility: lifecycle state and host cause codes, without owner text or execution evidence. */
import type { InterfaceText } from "../language/interface-text.ts";
import { ORDINARY_WORK_MAX_CONTINUATIONS } from "../ordinary-work-policy.ts";
import type { OrdinaryWorkRecord, OrdinaryWorkStatus } from "../ordinary-work-store.ts";

const REASONS = [
	"fulfilled",
	"waiting",
	"owner_needed",
	"unverified",
	"answer_recorded_unverified",
	"reporting_unverified",
	"reporting_changed",
	"reporting_override_unverified",
	"reporting_review_invalid",
	"held",
	"limited",
	"judge_unavailable",
	"evidence_exceeds_review_limit",
	"reviewer_no_eligible_model",
	"reviewer_unavailable",
	"reviewer_invalid_response",
	"review_timed_out",
	"owner_evidence_unavailable",
	"kernel_runaway_stop",
	"ambiguous_execution_receipt",
	"review_superseded",
	"stop_review_in_progress",
	"process_interrupted",
	"explicit_goal_owns_request",
	"goal_completed",
	"goal_cancelled",
	"worker_wait_exhausted",
	"system_bound",
] as const;
export type OrdinaryWorkStatusReason = (typeof REASONS)[number];
export type OrdinaryWorkStatusSnapshot =
	| { readonly state: "disabled" | "ephemeral" | "none" }
	| { readonly state: "unavailable"; readonly reason: "storage_not_loaded" | "storage_unavailable" }
	| {
			readonly state: OrdinaryWorkStatus;
			readonly reason?: OrdinaryWorkStatusReason;
			readonly continuationsUsed: number;
			readonly continuationLimit: number;
	  };

export function ordinaryWorkStatusSnapshot(record: OrdinaryWorkRecord | undefined): OrdinaryWorkStatusSnapshot {
	if (!record) return { state: "none" };
	const reason = record.reason?.startsWith("system_bound:")
		? "system_bound"
		: record.reason?.startsWith("explicit_goal_owns_request:")
			? "explicit_goal_owns_request"
			: record.reason;
	const safeReason =
		REASONS.find((known) => known === reason) ?? (record.status === "unverified" ? "unverified" : undefined);
	return {
		state: record.status,
		...(safeReason ? { reason: safeReason } : {}),
		continuationsUsed: record.continuationCount,
		continuationLimit: ORDINARY_WORK_MAX_CONTINUATIONS,
	};
}

export function ordinaryWorkStatusLines(
	value: OrdinaryWorkStatusSnapshot,
	words: InterfaceText["autonomyStatus"]["ordinaryWork"],
): string[] {
	return [
		words.states[value.state],
		...("reason" in value && value.reason ? [words.reasons[value.reason]] : []),
		...("continuationsUsed" in value ? [words.budget(value.continuationsUsed, value.continuationLimit)] : []),
	];
}
