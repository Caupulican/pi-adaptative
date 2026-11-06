/**
 * Decision Action Policy.
 * Governs confidence, provenance, and consequence validation before semantic actions execute.
 * Conforms to DECISION_ENGINE_RULES.md and ROUTING_PROGRAM.md.
 *
 * Cuts come from `thresholds.ts`. A yes/no result is read by its band (which already carries the
 * direction), never by max(p, 1-p): an answer in the middle band is uncertain, and so is a soft pass
 * at critical consequence. A Choice is read on P(selected), never on `confidence`. Only a missing
 * result or a disallowed provenance is an engine miss; an answer below a cut is uncertainty and stays
 * uncertainty (`gather_more`), it is never handed to another engine as if the first had not answered.
 */

import type { ConfidenceProvenance } from "./confidence.ts";
import type { ChoiceDecisionResult, DecisionEvaluation } from "./evaluation.ts";
import type { Consequence } from "./primitives.ts";
import { CHOICE_RUNNER_UP_MARGIN, type ChoiceActReading, type ChoiceRisk, choiceAct } from "./thresholds.ts";

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
	/** Runner-up margin a Choice must clear; by default {@link CHOICE_RUNNER_UP_MARGIN} at high and critical, none below. */
	readonly minimumMargin?: number;
	readonly allowedProvenances?: readonly ConfidenceProvenance[];
}

export interface PolicyEvaluationResult {
	readonly disposition: DecisionPolicyDisposition;
	readonly reason: string;
	readonly failedChecks: readonly string[];
}

/** What acting on a Choice risks at each consequence: the act floor on P(selected) rises with it. */
const CHOICE_RISK_BY_CONSEQUENCE: Readonly<Record<Consequence, ChoiceRisk>> = Object.freeze({
	low: "reversible",
	medium: "reversible",
	high: "consequential",
	critical: "consequential",
});

function choiceMargin(consequence: Consequence, override?: number): number | undefined {
	return override ?? (consequence === "high" || consequence === "critical" ? CHOICE_RUNNER_UP_MARGIN : undefined);
}

function readChoice(
	choice: Pick<ChoiceDecisionResult, "selected" | "distribution">,
	consequence: Consequence,
	minimumMargin?: number,
): ChoiceActReading {
	const minMargin = choiceMargin(consequence, minimumMargin);
	return choiceAct(
		choice,
		undefined,
		CHOICE_RISK_BY_CONSEQUENCE[consequence],
		minMargin !== undefined ? { minMargin } : {},
	);
}

export class DecisionActionPolicy {
	evaluate(evaluation: DecisionEvaluation, options?: DecisionActionPolicyOptions): PolicyEvaluationResult {
		const failedChecks: string[] = [];
		const consequence = options?.consequence ?? "medium";
		const provenance = evaluation.engine.confidence_provenance;
		let engineMiss = false;

		// 1. Required decisions must be answered: a missing or unsupported one is an engine miss.
		if (options?.requiredDecisionIds) {
			for (const id of options.requiredDecisionIds) {
				const res = evaluation.results[id];
				if (!res || res.kind === "unsupported") {
					failedChecks.push(`required_decision_${id}_unsupported`);
					engineMiss = true;
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
				engineMiss = true;
			}
		}

		// 3. Allowed provenances filter
		if (options?.allowedProvenances && !options.allowedProvenances.includes(provenance)) {
			failedChecks.push(`provenance_${provenance}_not_in_allowed_list`);
			engineMiss = true;
		}

		// 4. Whether each answer settled anything.
		for (const [id, res] of Object.entries(evaluation.results)) {
			if (options?.requiredDecisionIds && !options.requiredDecisionIds.includes(id)) continue;
			if (res.kind === "choice") {
				const reading = readChoice(res, consequence, options?.minimumMargin);
				if (reading !== "act") {
					const p = res.distribution[res.selected];
					failedChecks.push(`choice_${id}_${reading}_p_${p ?? "none"}_${CHOICE_RISK_BY_CONSEQUENCE[consequence]}`);
				}
			} else if (res.kind === "boolean") {
				if (res.band === "ambiguous") {
					failedChecks.push(`boolean_${id}_ambiguous_p_${res.probabilityTrue}`);
				} else if (res.band === "soft_pass" && consequence === "critical") {
					failedChecks.push(`boolean_${id}_soft_pass_at_critical_p_${res.probabilityTrue}`);
				}
			} else if (res.kind === "set" && res.unsettled?.length) {
				failedChecks.push(`set_${id}_unsettled_${res.unsettled.join(",")}`);
			}
		}

		if (failedChecks.length === 0) {
			return { disposition: "accept", reason: "policy_satisfied", failedChecks: [] };
		}

		return {
			disposition: engineMiss ? "try_next_engine" : "gather_more",
			reason: failedChecks.join("; "),
			failedChecks,
		};
	}

	/** One Choice result read on P(selected) at `consequence`: accept when code may act on it, else gather more. */
	evaluateChoice(
		choice: Pick<ChoiceDecisionResult, "selected" | "distribution">,
		consequence: Consequence = "medium",
	): { action: DecisionPolicyDisposition; reason: string } {
		const reading = readChoice(choice, consequence);
		if (reading === "act") return { action: "accept", reason: "accepted" };
		const p = choice.distribution[choice.selected];
		return {
			action: "gather_more",
			reason: `${reading}_p_${p ?? "none"}_${CHOICE_RISK_BY_CONSEQUENCE[consequence]}`,
		};
	}
}
