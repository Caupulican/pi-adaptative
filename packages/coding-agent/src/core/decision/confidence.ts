export type ConfidenceProvenance =
	| "native_calibrated"
	| "native_uncalibrated"
	| "derived_calibrated_probability"
	| "derived_logprobs"
	| "synthetic_self_report"
	| "heuristic"
	| "none";

export interface DecisionConfidence {
	readonly value: number;
	readonly provenance: ConfidenceProvenance;
	readonly isCalibrated: boolean;
	readonly noulProbabilityTrue?: number;
}
