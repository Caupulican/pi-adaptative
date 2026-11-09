import type { DecisionDefinition } from "./primitives.ts";

export interface DecisionProgram {
	readonly schema_version: "2.0";
	readonly id: string;
	readonly version: string;
	readonly decisions: readonly DecisionDefinition[];
	readonly applicabilityRules?: Record<string, string>;
	readonly stateSchemaVersion?: string;
}

export function createDecisionProgram(input: {
	readonly id: string;
	readonly version?: string;
	readonly decisions: readonly DecisionDefinition[];
	readonly applicabilityRules?: Record<string, string>;
	readonly stateSchemaVersion?: string;
}): DecisionProgram {
	return {
		schema_version: "2.0",
		id: input.id,
		version: input.version ?? "1.0.0",
		decisions: input.decisions,
		// An absent rule set is an absent key: a program is JSON data, so no undefined member reaches its digests.
		...(input.applicabilityRules !== undefined ? { applicabilityRules: input.applicabilityRules } : {}),
		stateSchemaVersion: input.stateSchemaVersion ?? "1.0",
	};
}
