import type { ConfidenceProvenance, DecisionConfidence } from "./confidence.ts";
import { type NoulBand, type NoulDirection, noulBand, settledFromBand } from "./noul.ts";

/**
 * A noul answer, carrying what it actually decided.
 *
 * There is deliberately no `value: boolean` field. One existed, derived as `probabilityTrue >= 0.5`,
 * and every caller that read it silently turned an undecided answer into a yes. The band and the
 * direction are the decision; `settledBoolean` is the one way to collapse them, and it refuses to
 * answer when the claim is ambiguous.
 */
export interface BooleanDecisionResult {
	readonly kind: "boolean";
	readonly probabilityTrue: number;
	/** Which end this question needed. */
	readonly direction: NoulDirection;
	/** Where `probabilityTrue` fell relative to that end. */
	readonly band: NoulBand;
	readonly confidence: DecisionConfidence;
}

/** The answer this result settles on, or undefined when the band is ambiguous. */
export function settledBoolean(result: BooleanDecisionResult): boolean | undefined {
	return settledFromBand(result.band, result.direction);
}

/**
 * A boolean an engine computed rather than estimated: a mechanical read of state, or a model that
 * returned a literal true/false. It lands at P=1 or P=0, so its band is decisive either way, and
 * the direction still decides which of those is a pass.
 */
export function certainBooleanResult(
	value: boolean,
	direction: NoulDirection,
	confidence: DecisionConfidence,
): BooleanDecisionResult {
	const probabilityTrue = value ? 1 : 0;
	return { kind: "boolean", probabilityTrue, direction, band: noulBand(probabilityTrue, direction), confidence };
}

/**
 * The settled answer for a result that may be absent or of another kind. Undefined means the same
 * thing in every case: nothing was decided here, which callers already handle.
 */
export function booleanAnswer(result: DecisionResult | undefined): boolean | undefined {
	return result?.kind === "boolean" ? settledBoolean(result) : undefined;
}

/** True only for a decisive answer in the required direction. A soft pass is not decisive. */
export function decisivelyHolds(result: BooleanDecisionResult): boolean {
	return result.band === "hard_pass";
}

export interface ChoiceDecisionResult {
	readonly kind: "choice";
	readonly selected: string;
	readonly distribution: Record<string, number>;
	readonly margin: number;
	readonly confidence: DecisionConfidence;
}

export interface ScoreDecisionResult {
	readonly kind: "score";
	readonly value: number;
	readonly distribution: Record<number, number>;
	readonly confidence: DecisionConfidence;
}

export interface SetDecisionResult {
	readonly kind: "set";
	readonly selected: readonly string[];
	readonly memberships: Record<string, number>;
	readonly confidence: DecisionConfidence;
}

export interface FunctionCallDecisionResult {
	readonly kind: "function_call";
	readonly name: string;
	readonly arguments: Record<string, unknown>;
	readonly confidence: DecisionConfidence;
	readonly argumentConfidences: Record<string, DecisionConfidence>;
}

export interface UnsupportedDecisionResult {
	readonly kind: "unsupported";
	readonly reason: string;
}

export type DecisionResult =
	| BooleanDecisionResult
	| ChoiceDecisionResult
	| ScoreDecisionResult
	| SetDecisionResult
	| FunctionCallDecisionResult
	| UnsupportedDecisionResult;

export interface DecisionEvaluationAudit {
	readonly engineId: string;
	readonly provider?: string;
	readonly model: string;
	readonly programId: string;
	readonly programVersion: string;
	readonly programDigest?: string;
	readonly stateDigest?: string;
	readonly rawAnswerDigest?: string;
	readonly confidenceProvenance: ConfidenceProvenance;
	readonly latencyMs?: number;
	readonly consequence?: string;
	readonly fallbackChain?: readonly string[];
	readonly policyDisposition?: string;
}

export interface DecisionEvaluation {
	readonly schema_version: "2.0";
	readonly program: {
		readonly id: string;
		readonly version: string;
	};
	readonly engine: {
		readonly id: string;
		readonly model: string;
		readonly confidence_provenance: ConfidenceProvenance;
	};
	readonly results: Record<string, DecisionResult>;
	readonly timestamp: string;
	readonly proposedFunctionCall?: FunctionCallDecisionResult;
	readonly audit?: DecisionEvaluationAudit;
}

export function createDecisionEvaluation(input: {
	readonly programId: string;
	readonly programVersion: string;
	readonly engineId: string;
	readonly model: string;
	readonly confidenceProvenance: ConfidenceProvenance;
	readonly results: Record<string, DecisionResult>;
	readonly proposedFunctionCall?: FunctionCallDecisionResult;
	readonly timestamp?: string;
	readonly audit?: DecisionEvaluationAudit;
}): DecisionEvaluation {
	return {
		schema_version: "2.0",
		program: {
			id: input.programId,
			version: input.programVersion,
		},
		engine: {
			id: input.engineId,
			model: input.model,
			confidence_provenance: input.confidenceProvenance,
		},
		results: input.results,
		timestamp: input.timestamp ?? new Date().toISOString(),
		proposedFunctionCall: input.proposedFunctionCall,
		audit: input.audit,
	};
}
