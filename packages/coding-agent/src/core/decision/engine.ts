import type { DecisionEngineCapabilities } from "./capabilities.ts";
import type { DecisionEvaluation } from "./evaluation.ts";
import type { Consequence } from "./primitives.ts";
import type { DecisionProgram } from "./program.ts";

export interface DecisionOptions {
	readonly signal?: AbortSignal;
	readonly consequence?: Consequence;
	readonly timeoutMs?: number;
}

export interface SemanticDecisionEngine {
	readonly id: string;
	readonly model: string;
	capabilities(): DecisionEngineCapabilities;
	evaluate(program: DecisionProgram, state: unknown, options?: DecisionOptions): Promise<DecisionEvaluation>;
}
