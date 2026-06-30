import type { LearningDecision } from "../autonomy/contracts.ts";

export type DurableChangeLayer =
	| "memory"
	| "skill"
	| "prompt"
	| "extension"
	| "tool"
	| "script"
	| "settings"
	| "source";

export interface DurableChangeProposal {
	id: string;
	layer: DurableChangeLayer;
	summary: string;
	evidenceIds?: readonly string[];
	rollbackPlan?: string;
}

export interface LearningGateSettings {
	enabled: boolean;
	autoApplyEnabled: boolean;
	confidenceThreshold: number;
	minObservations: number;
	allowedAutoApplyLayers: readonly DurableChangeLayer[];
	requireRollbackPlan?: boolean;
	requireEvidence?: boolean;
}

const MAX_DECISION_SUMMARY_LENGTH = 240;

function boundedDecisionSummary(summary: string): string {
	if (summary.length <= MAX_DECISION_SUMMARY_LENGTH) return summary;
	return `${summary.slice(0, MAX_DECISION_SUMMARY_LENGTH - 1)}…`;
}

function learningDecision(args: {
	kind: LearningDecision["kind"];
	reasonCode: string;
	confidence: number;
	summary: string;
	requiresApproval: boolean;
	createdAt?: string;
}): LearningDecision {
	return {
		kind: args.kind,
		reasonCode: args.reasonCode,
		confidence: args.confidence,
		summary: boundedDecisionSummary(args.summary),
		requiresApproval: args.requiresApproval,
		createdAt: args.createdAt,
	};
}

export function evaluateLearningDecision(args: {
	proposal: DurableChangeProposal;
	confidence: number;
	observations: number;
	contradictions: number;
	settings: LearningGateSettings;
	now?: string;
}): LearningDecision {
	const { proposal, confidence, observations, contradictions, settings, now } = args;

	if (!settings.enabled) {
		return learningDecision({
			kind: "no-op",
			reasonCode: "learning_disabled",
			confidence,
			summary: proposal.summary,
			requiresApproval: false,
			createdAt: now,
		});
	}

	if (contradictions > 0) {
		return learningDecision({
			kind: "proposal",
			reasonCode: "contradictions_present",
			confidence,
			summary: proposal.summary,
			requiresApproval: true,
			createdAt: now,
		});
	}

	if (confidence < settings.confidenceThreshold) {
		const hasEvidence = !!(proposal.evidenceIds && proposal.evidenceIds.length > 0);
		return learningDecision({
			kind: hasEvidence ? "proposal" : "no-op",
			reasonCode: "below_confidence_threshold",
			confidence,
			summary: proposal.summary,
			requiresApproval: hasEvidence,
			createdAt: now,
		});
	}

	if (observations < settings.minObservations) {
		return learningDecision({
			kind: "proposal",
			reasonCode: "insufficient_observations",
			confidence,
			summary: proposal.summary,
			requiresApproval: true,
			createdAt: now,
		});
	}

	if (settings.requireEvidence) {
		const hasEvidence = !!(proposal.evidenceIds && proposal.evidenceIds.length > 0);
		if (!hasEvidence) {
			return learningDecision({
				kind: "proposal",
				reasonCode: "missing_evidence",
				confidence,
				summary: proposal.summary,
				requiresApproval: true,
				createdAt: now,
			});
		}
	}

	if (settings.requireRollbackPlan) {
		const hasRollback = proposal.rollbackPlan !== undefined && proposal.rollbackPlan.trim().length > 0;
		if (!hasRollback) {
			return learningDecision({
				kind: "proposal",
				reasonCode: "missing_rollback_plan",
				confidence,
				summary: proposal.summary,
				requiresApproval: true,
				createdAt: now,
			});
		}
	}

	if (!settings.autoApplyEnabled) {
		return learningDecision({
			kind: "proposal",
			reasonCode: "auto_apply_disabled",
			confidence,
			summary: proposal.summary,
			requiresApproval: true,
			createdAt: now,
		});
	}

	const isAllowed = settings.allowedAutoApplyLayers.includes(proposal.layer);
	if (!isAllowed) {
		return learningDecision({
			kind: "proposal",
			reasonCode: "layer_not_allowed_for_auto_apply",
			confidence,
			summary: proposal.summary,
			requiresApproval: true,
			createdAt: now,
		});
	}

	return learningDecision({
		kind: "apply",
		reasonCode: "eligible_auto_apply",
		confidence,
		summary: proposal.summary,
		requiresApproval: false,
		createdAt: now,
	});
}
