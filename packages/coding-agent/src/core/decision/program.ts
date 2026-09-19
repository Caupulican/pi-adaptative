import type { DecisionDefinition } from "./primitives.ts";

export interface SemanticFunctionDeclaration {
	readonly name: string;
	readonly description?: string;
	readonly parameters: Record<string, unknown>;
	readonly requiredParameters?: readonly string[];
}

export interface DecisionProgram {
	readonly schema_version: "2.0";
	readonly id: string;
	readonly version: string;
	readonly decisions: readonly DecisionDefinition[];
	readonly functions: readonly SemanticFunctionDeclaration[];
	readonly applicabilityRules?: Record<string, string>;
	readonly stateSchemaVersion?: string;
}

export function createDecisionProgram(input: {
	readonly id: string;
	readonly version?: string;
	readonly decisions: readonly DecisionDefinition[];
	readonly functions?: readonly SemanticFunctionDeclaration[];
	readonly applicabilityRules?: Record<string, string>;
	readonly stateSchemaVersion?: string;
}): DecisionProgram {
	return {
		schema_version: "2.0",
		id: input.id,
		version: input.version ?? "1.0.0",
		decisions: input.decisions,
		functions: input.functions ?? [],
		applicabilityRules: input.applicabilityRules,
		stateSchemaVersion: input.stateSchemaVersion ?? "1.0",
	};
}
