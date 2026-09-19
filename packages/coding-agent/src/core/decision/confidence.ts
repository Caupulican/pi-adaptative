export type ConfidenceProvenance =
	| "native_calibrated"
	| "native_uncalibrated"
	| "derived_logprobs"
	| "synthetic_self_report"
	| "none";

export interface DecisionConfidence {
	readonly value: number;
	readonly provenance: ConfidenceProvenance;
	readonly isCalibrated: boolean;
	readonly noulProbabilityTrue?: number;
}

/**
 * Calculates the weakest-link call confidence for a function invocation.
 * Rule: call confidence = minimum confidence among every semantic judgment required to form that invocation.
 * Never multiplies probabilities solely because a function has multiple arguments.
 */
export function weakestCallConfidence(
	confidences: readonly (DecisionConfidence | number | undefined)[],
	provenance: ConfidenceProvenance = "native_calibrated",
): DecisionConfidence {
	if (confidences.length === 0) {
		return {
			value: 1.0,
			provenance,
			isCalibrated: provenance === "native_calibrated",
		};
	}

	let minVal = 1.0;
	let hasUndefined = false;
	let derivedProvenance = provenance;

	for (const c of confidences) {
		if (c === undefined) {
			hasUndefined = true;
			continue;
		}
		const val = typeof c === "number" ? c : c.value;
		if (typeof c === "object" && c !== null) {
			if (c.provenance === "synthetic_self_report" || c.provenance === "none") {
				derivedProvenance = c.provenance;
			} else if (
				c.provenance === "native_uncalibrated" &&
				derivedProvenance !== "synthetic_self_report" &&
				derivedProvenance !== "none"
			) {
				derivedProvenance = c.provenance;
			}
		}
		if (val < minVal) {
			minVal = val;
		}
	}

	if (hasUndefined && minVal === 1.0) {
		minVal = 0.5;
	}

	return {
		value: Math.max(0, Math.min(1, minVal)),
		provenance: derivedProvenance,
		isCalibrated: derivedProvenance === "native_calibrated",
	};
}
