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
