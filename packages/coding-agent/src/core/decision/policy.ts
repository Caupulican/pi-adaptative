import type { SemanticDecisionEngine } from "./engine.ts";
import type { Consequence } from "./primitives.ts";

export type CompletionAssuranceProfile =
	| "mechanical"
	| "mechanical_plus_reviewer"
	| "semantic_enhanced"
	| "system_one_required";

export interface DecisionEnginePolicy {
	allowed(engine: SemanticDecisionEngine, consequence?: Consequence): boolean;
	score(engine: SemanticDecisionEngine, consequence?: Consequence): number;
}

export class DefaultDecisionEnginePolicy implements DecisionEnginePolicy {
	private readonly allowedProvenances: readonly string[];
	private readonly requireCalibratedForHighConsequence: boolean;

	constructor(
		allowedProvenances: readonly string[] = [
			"native_calibrated",
			"native_uncalibrated",
			"derived_logprobs",
			"synthetic_self_report",
			"none",
		],
		requireCalibratedForHighConsequence: boolean = false,
	) {
		this.allowedProvenances = allowedProvenances;
		this.requireCalibratedForHighConsequence = requireCalibratedForHighConsequence;
	}

	allowed(engine: SemanticDecisionEngine, consequence: Consequence = "medium"): boolean {
		const caps = engine.capabilities();
		if (!this.allowedProvenances.includes(caps.confidenceProvenance)) {
			return false;
		}

		if (this.requireCalibratedForHighConsequence && (consequence === "high" || consequence === "critical")) {
			return caps.confidenceProvenance === "native_calibrated";
		}

		return true;
	}

	score(engine: SemanticDecisionEngine, consequence: Consequence = "medium"): number {
		const caps = engine.capabilities();
		let score = 0;

		// Prioritize native calibrated engines (TypeSafe Jev)
		if (caps.confidenceProvenance === "native_calibrated") {
			score += 100;
		} else if (caps.confidenceProvenance === "derived_logprobs") {
			score += 70;
		} else if (caps.confidenceProvenance === "native_uncalibrated") {
			score += 50;
		} else if (caps.confidenceProvenance === "synthetic_self_report") {
			score += 30;
		} else {
			score += 10;
		}

		if (caps.fullDistributions) score += 10;
		if (caps.parallelIndependentDecisions) score += 10;

		// High consequence rewards calibrated confidence heavily
		if ((consequence === "high" || consequence === "critical") && caps.confidenceProvenance === "native_calibrated") {
			score += 50;
		}

		return score;
	}
}

/**
 * Policy for `system_one_required`: calibrated Jev or mechanical `none`.
 * Generic LLM `synthetic_self_report` cannot satisfy a required checkpoint.
 */
export class RequiredSystemOneDecisionPolicy extends DefaultDecisionEnginePolicy {
	constructor() {
		super(["native_calibrated", "none", "derived_calibrated_probability"], true);
	}
}

export function isForbiddenRequiredProvenance(provenance: string): boolean {
	return provenance === "synthetic_self_report" || provenance === "heuristic";
}
