import { type DecisionConfidence, weakestCallConfidence } from "./confidence.ts";
import type { DecisionEvaluation, FunctionCallDecisionResult } from "./evaluation.ts";
import type { SemanticFunctionRegistry } from "./functions.ts";
import type { ChoiceDecision, DecisionDefinition } from "./primitives.ts";
import { createDecisionProgram, type DecisionProgram, type SemanticFunctionDeclaration } from "./program.ts";

/**
 * Compiles a typed semantic function registry and extra standalone decisions into a single DecisionProgram.
 */
export function compileSemanticFunctionsToProgram(
	programId: string,
	registry: SemanticFunctionRegistry,
	extraDecisions: readonly DecisionDefinition[] = [],
	options: {
		version?: string;
		stateSchemaVersion?: string;
	} = {},
): DecisionProgram {
	const decisions: DecisionDefinition[] = [...extraDecisions];
	const functions: SemanticFunctionDeclaration[] = [];

	// 1. Create the root function selection Choice decision
	const functionOptions: Record<string, { description: string }> = {};
	for (const [funcName, def] of Object.entries(registry)) {
		functionOptions[funcName] = {
			description: def.description ?? `Invoke semantic function ${funcName}`,
		};

		const parameters: Record<string, unknown> = {};
		const requiredParams: string[] = [];

		for (const [paramName, paramDef] of Object.entries(def.parameters)) {
			parameters[paramName] = {
				kind: paramDef.kind,
				optional: paramDef.optional ?? false,
				defaultValue: paramDef.defaultValue,
			};
			if (!paramDef.optional) {
				requiredParams.push(paramName);
			}

			// Generate argument decision
			const decisionId = `${funcName}__${paramName}`;
			if (paramDef.kind === "choice") {
				const argOptions: Record<string, { description: string }> = {};
				for (const opt of paramDef.options) {
					argOptions[opt] = {
						description: paramDef.descriptions?.[opt] ?? `Option ${opt} for ${paramName}`,
					};
				}
				decisions.push({
					kind: "choice",
					id: decisionId,
					instruction: `Select argument ${paramName} for function ${funcName}`,
					options: argOptions,
				});
			} else if (paramDef.kind === "boolean") {
				decisions.push({
					kind: "boolean",
					id: decisionId,
					instruction: paramDef.description ?? `Determine boolean flag ${paramName} for function ${funcName}`,
				});
			}
		}

		functions.push({
			name: funcName,
			description: def.description,
			parameters,
			requiredParameters: requiredParams,
		});
	}

	const rootFunctionDecision: ChoiceDecision = {
		kind: "choice",
		id: "__function__",
		instruction: "Select the primary semantic function to execute for this controller step",
		options: functionOptions,
	};

	decisions.unshift(rootFunctionDecision);

	return createDecisionProgram({
		id: programId,
		version: options.version ?? "1.0.0",
		decisions,
		functions,
		stateSchemaVersion: options.stateSchemaVersion ?? "1.0",
	});
}

/**
 * Resolves the proposed function call from a DecisionEvaluation using the function registry.
 * Applies defaults for optional parameters and calculates weakest-link call confidence.
 */
export function resolveFunctionCall(
	evaluation: DecisionEvaluation,
	registry: SemanticFunctionRegistry,
): FunctionCallDecisionResult | undefined {
	const rootFuncResult = evaluation.results.__function__;
	if (rootFuncResult?.kind !== "choice") {
		return undefined;
	}

	const selectedFunc = rootFuncResult.selected;
	const funcDef = registry[selectedFunc];
	if (!funcDef) {
		return undefined;
	}

	const resolvedArgs: Record<string, unknown> = {};
	const argConfidences: Record<string, DecisionConfidence> = {
		__function__: rootFuncResult.confidence,
	};
	const requiredConfidences: DecisionConfidence[] = [rootFuncResult.confidence];

	for (const [paramName, paramDef] of Object.entries(funcDef.parameters)) {
		const decisionId = `${selectedFunc}__${paramName}`;
		const argResult = evaluation.results[decisionId];

		if (argResult) {
			if (argResult.kind === "choice") {
				resolvedArgs[paramName] = argResult.selected;
				argConfidences[paramName] = argResult.confidence;
				requiredConfidences.push(argResult.confidence);
			} else if (argResult.kind === "boolean") {
				resolvedArgs[paramName] = argResult.value;
				argConfidences[paramName] = argResult.confidence;
				requiredConfidences.push(argResult.confidence);
			}
		} else if (paramDef.optional && paramDef.defaultValue !== undefined) {
			// ADR-016: Optional semantic function parameters support defaults/applicability
			resolvedArgs[paramName] = paramDef.defaultValue;
		}
	}

	// ADR-015: Weakest-link call confidence
	const callConfidence = weakestCallConfidence(requiredConfidences, evaluation.engine.confidence_provenance);

	return {
		kind: "function_call",
		name: selectedFunc,
		arguments: resolvedArgs,
		confidence: callConfidence,
		argumentConfidences: argConfidences,
	};
}
