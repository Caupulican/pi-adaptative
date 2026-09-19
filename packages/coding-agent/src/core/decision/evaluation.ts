import type { ConfidenceProvenance, DecisionConfidence } from "./confidence.ts";

export interface BooleanDecisionResult {
	readonly kind: "boolean";
	readonly value: boolean;
	readonly probabilityTrue: number;
	readonly confidence: DecisionConfidence;
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

export type DecisionResult =
	| BooleanDecisionResult
	| ChoiceDecisionResult
	| ScoreDecisionResult
	| SetDecisionResult
	| FunctionCallDecisionResult;

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
	};
}
