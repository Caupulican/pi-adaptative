import type { DecisionEngineCapabilities } from "./capabilities.ts";
import type { DecisionEvaluation } from "./evaluation.ts";
import type { Consequence } from "./primitives.ts";
import type { DecisionProgram } from "./program.ts";

/** Identity boundary carried with a semantic decision into the session's evaluation ledger. */
export type SemanticEvaluationScope =
	| { readonly kind: "session"; readonly id: string }
	| { readonly kind: "worker-task"; readonly id: string };

export interface DecisionOptions {
	readonly signal?: AbortSignal;
	readonly consequence?: Consequence;
	readonly timeoutMs?: number;
	readonly evaluationScope?: SemanticEvaluationScope;
}

export interface SemanticDecisionEngine {
	readonly id: string;
	readonly model: string;
	capabilities(): DecisionEngineCapabilities;
	evaluate(program: DecisionProgram, state: unknown, options?: DecisionOptions): Promise<DecisionEvaluation>;
}
