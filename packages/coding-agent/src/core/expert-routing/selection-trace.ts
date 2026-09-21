/**
 * Expert Selection Trace Builder.
 * Records candidates, hard rejections, feature vectors, and chosen bindings.
 * Conforms to schemas/expert-selection-trace.schema.json.
 */

import {
	EXPERT_ROUTING_SCHEMA_VERSION,
	type ExpertCandidate,
	type ExpertCandidateRejection,
	type ExpertSelectionPlan,
	type ExpertSelectionTrace,
	type ScoredExpertCandidate,
	type WorkerCapabilityRequest,
} from "./contracts.ts";

export function buildSelectionTrace(
	request: WorkerCapabilityRequest,
	_candidates: readonly ExpertCandidate[],
	rejected: readonly ExpertCandidateRejection[],
	scored: readonly ScoredExpertCandidate[],
	plan: ExpertSelectionPlan,
	policyVersion = "1.0",
): ExpertSelectionTrace {
	const candidatesAudit: Record<string, unknown>[] = [];

	for (const rej of rejected) {
		candidatesAudit.push({
			expert_id: rej.candidate.descriptor.expert_id,
			provider: rej.candidate.descriptor.provider,
			model_id: rej.candidate.descriptor.model_id,
			admitted: false,
			rejection_reasons: rej.reasonCodes,
		});
	}

	for (const sc of scored) {
		candidatesAudit.push({
			expert_id: sc.candidate.descriptor.expert_id,
			provider: sc.candidate.descriptor.provider,
			model_id: sc.candidate.descriptor.model_id,
			admitted: true,
			score: sc.features.totalScore,
			features: sc.features,
		});
	}

	return {
		schema_version: EXPERT_ROUTING_SCHEMA_VERSION,
		trace_id: plan.traceId,
		request_digest: request.request_id,
		policy_version: policyVersion,
		candidates: candidatesAudit,
		selected_expert_ids: plan.bindings.map((b) => b.expert_id),
		selection_mode: plan.mode,
		owner_pin_applied: plan.ownerPinApplied,
		exploration: plan.exploration,
		created_at: new Date().toISOString(),
		effective_policy: {
			preset: request.hmoe_preset ?? "balanced",
			team_strategy: request.team_strategy ?? plan.mode,
			independence: request.independence_level ?? "none",
			prefer_subscription: request.prefer_subscription ?? false,
			prefer_local: request.prefer_local ?? false,
			weights: request.hmoe_weights,
		},
	};
}
