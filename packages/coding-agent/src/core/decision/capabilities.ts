import type { ConfidenceProvenance } from "./confidence.ts";
import type { DecisionProgram } from "./program.ts";

export interface DecisionEngineCapabilities {
	readonly boolean: boolean;
	readonly choice: boolean;
	readonly score: boolean;
	readonly set: boolean;
	readonly fullDistributions: boolean;
	readonly parallelIndependentDecisions: boolean;
	readonly confidenceProvenance: ConfidenceProvenance;
	readonly maxStateTokens?: number;
}

export function supportsProgram(caps: DecisionEngineCapabilities, program: DecisionProgram): boolean {
	for (const d of program.decisions) {
		if (d.kind === "boolean" && !caps.boolean) return false;
		if (d.kind === "choice" && !caps.choice) return false;
		if (d.kind === "score" && !caps.score) return false;
		if (d.kind === "set" && !caps.set) return false;
	}
	return true;
}
