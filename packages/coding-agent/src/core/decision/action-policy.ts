/**
 * Decision Action Policy.
 * Governs confidence, provenance, and consequence validation before semantic actions execute.
 * Conforms to DECISION_ENGINE_RULES.md and ROUTING_PROGRAM.md.
 */

import type { ConfidenceProvenance } from "./confidence.ts";
import type { DecisionEvaluation } from "./evaluation.ts";
import type { Consequence } from "./primitives.ts";

export type DecisionPolicyDisposition =
	| "accept"
	| "try_next_engine"
	| "gather_more"
	| "independent_verify"
	| "human_edge"
	| "block";

export interface DecisionActionPolicyOptions {
	readonly consequence?: Consequence;
	readonly requiredDecisionIds?: readonly string[];
	readonly minimumConfidence?: number;
	readonly minimumMargin?: number;
	readonly allowedProvenances?: readonly ConfidenceProvenance[];
}

export interface PolicyEvaluationResult {
	readonly disposition: DecisionPolicyDisposition;
	readonly reason: string;
	readonly failedChecks: readonly string[];
}

export class DecisionActionPolicy {
	evaluate(evaluation: DecisionEvaluation, options?: DecisionActionPolicyOptions): PolicyEvaluationResult {
		const failedChecks: string[] = [];
		const consequence = options?.consequence ?? "medium";
		const provenance = evaluation.engine.confidence_provenance;

		// 1. Check required decisions are supported and not missing
		if (options?.requiredDecisionIds) {
			for (const id of options.requiredDecisionIds) {
				const res = evaluation.results[id];
				if (!res || res.kind === "unsupported") {
					failedChecks.push(`required_decision_${id}_unsupported`);
				}
			}
		}

		// 2. Consequence vs provenance constraints
		if (consequence === "critical") {
			if (
				provenance !== "native_calibrated" &&
				provenance !== "none" &&
				provenance !== "derived_calibrated_probability"
			) {
				failedChecks.push(`critical_consequence_disallows_${provenance}`);
			}
		}

		// 3. Allowed provenances filter
		if (options?.allowedProvenances && !options.allowedProvenances.includes(provenance)) {
			failedChecks.push(`provenance_${provenance}_not_in_allowed_list`);
		}

		// 4. Threshold checks
		const minConf =
			options?.minimumConfidence ?? (consequence === "critical" ? 0.9 : consequence === "high" ? 0.8 : 0.6);
		const minMargin =
			options?.minimumMargin ?? (consequence === "critical" ? 0.4 : consequence === "high" ? 0.2 : 0.05);

		for (const [id, res] of Object.entries(evaluation.results)) {
			if (options?.requiredDecisionIds && !options.requiredDecisionIds.includes(id)) continue;
			if (res.kind === "choice") {
				if (res.confidence.value < minConf) {
					failedChecks.push(`choice_${id}_confidence_${res.confidence.value}_below_${minConf}`);
				}
				if (res.margin < minMargin) {
					failedChecks.push(`choice_${id}_margin_${res.margin}_below_${minMargin}`);
				}
			} else if (res.kind === "boolean") {
				if (res.confidence.value < minConf) {
					failedChecks.push(`boolean_${id}_confidence_${res.confidence.value}_below_${minConf}`);
				}
			}
		}

		if (failedChecks.length === 0) {
			return {
				disposition: "accept",
				reason: "policy_satisfied",
				failedChecks: [],
			};
		}

		// If required decisions are unsupported or provenance is disallowed -> try next engine
		const hasUnsupported = failedChecks.some((c) => c.includes("unsupported") || c.includes("disallows"));
		if (hasUnsupported) {
			return {
				disposition: "try_next_engine",
				reason: failedChecks.join("; "),
				failedChecks,
			};
		}

		// Low confidence on high/critical consequence -> gather more evidence
		if (consequence === "high" || consequence === "critical") {
			return {
				disposition: "gather_more",
				reason: failedChecks.join("; "),
				failedChecks,
			};
		}

		return {
			disposition: "try_next_engine",
			reason: failedChecks.join("; "),
			failedChecks,
		};
	}

	evaluateChoice(
		choice: { margin: number; confidence: { value: number; provenance: string } },
		consequence: Consequence = "medium",
	): { action: DecisionPolicyDisposition; reason: string } {
		const minConf = consequence === "critical" ? 0.9 : consequence === "high" ? 0.8 : 0.6;
		const minMargin = consequence === "critical" ? 0.4 : consequence === "high" ? 0.2 : 0.05;

		if (choice.confidence.value < minConf) {
			return {
				action: "gather_more",
				reason: `confidence_${choice.confidence.value}_below_${minConf}`,
			};
		}
		if (choice.margin < minMargin) {
			return {
				action: "gather_more",
				reason: `margin_${choice.margin}_below_${minMargin}`,
			};
		}
		return { action: "accept", reason: "accepted" };
	}
}
