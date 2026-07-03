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
	/** default: false — a memory_replace/memory_remove (supersedes/deletes an existing fact) stays an
	 * approval-gated proposal even when otherwise eligible, unless explicitly opted in. */
	autoApplySupersessions?: boolean;
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

	// A replace/remove supersedes or deletes an existing fact — the reflection engine's
	// confront-before-write conflict signal — so by default it routes through approval rather than
	// silently overwriting prior memory. With `autoApplySupersessions` opted in, that signal no longer
	// short-circuits the decision outright: it FALLS THROUGH to the standard eligibility chain below,
	// so a supersession auto-applies only when everything else (threshold/observations/evidence/
	// rollback/autoApplyEnabled/layer) also passes.
	if (contradictions > 0 && !settings.autoApplySupersessions) {
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
		// Below-threshold confidence degrades to an approval-gated proposal, never a silent no-op:
		// learning stays fail-closed (it can only auto-apply above the threshold) while remaining
		// VISIBLE and audited. A silent no-op here disabled learning entirely under stock settings
		// (reflectionSourceConfidence < confidenceThreshold, reflection writes carrying no evidenceIds).
		return learningDecision({
			kind: "proposal",
			reasonCode: "below_confidence_threshold",
			confidence,
			summary: proposal.summary,
			requiresApproval: true,
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function isLearningDecision(value: unknown): value is LearningDecision {
	if (!isPlainRecord(value)) return false;

	if (typeof value.kind !== "string" || !["no-op", "proposal", "apply"].includes(value.kind)) {
		return false;
	}

	if (typeof value.reasonCode !== "string") return false;
	if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence)) return false;
	if (typeof value.summary !== "string") return false;
	if (typeof value.requiresApproval !== "boolean") return false;
	if (value.createdAt !== undefined && typeof value.createdAt !== "string") return false;

	return true;
}

export function cloneLearningDecisionForStorage(decision: LearningDecision): LearningDecision {
	return {
		kind: decision.kind,
		reasonCode: decision.reasonCode,
		confidence: decision.confidence,
		summary: decision.summary,
		requiresApproval: decision.requiresApproval,
		createdAt: decision.createdAt,
	};
}
