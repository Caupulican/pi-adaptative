import { type ConfidenceProvenance, type DecisionConfidence, weakestCallConfidence } from "./confidence.ts";
import { type DecisionEvaluation, type FunctionCallDecisionResult, settledBoolean } from "./evaluation.ts";
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

			if (paramDef.optional) {
				// FIN-040: Compile <function>__<arg>__stated decision
				decisions.push({
					kind: "boolean",
					id: `${funcName}__${paramName}__stated`,
					instruction: `Determine whether optional argument ${paramName} is explicitly stated or applicable for function ${funcName}`,
				});
			}

			// Generate argument decision
			const decisionId = `${funcName}__${paramName}`;
			if (paramDef.kind === "choice") {
				const argOptions: Record<string, { description: string; notFor?: string }> = {};
				for (const opt of paramDef.options) {
					argOptions[opt] = {
						description: paramDef.descriptions?.[opt] ?? `Option ${opt} for ${paramName}`,
						...(paramDef.notFor?.[opt] ? { notFor: paramDef.notFor[opt] } : {}),
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

		let shouldApplyArg = false;
		if (paramDef.optional) {
			const statedResult = evaluation.results[`${selectedFunc}__${paramName}__stated`];
			// An undecided "was this stated?" is not a yes: fall back to the parameter's default.
			const isStated =
				statedResult?.kind === "boolean"
					? settledBoolean(statedResult) === true
					: argResult !== undefined && !statedResult;

			if (isStated) {
				if (statedResult && statedResult.kind === "boolean") {
					argConfidences[`${paramName}__stated`] = statedResult.confidence;
					requiredConfidences.push(statedResult.confidence);
				}
				shouldApplyArg = true;
			} else {
				// FIN-041: Optional argument not stated, use default and do not force choice into confidences
				if (paramDef.defaultValue !== undefined) {
					resolvedArgs[paramName] = paramDef.defaultValue;
				}
			}
		} else {
			shouldApplyArg = true;
		}

		if (shouldApplyArg && argResult) {
			if (argResult.kind === "choice") {
				resolvedArgs[paramName] = argResult.selected;
				argConfidences[paramName] = argResult.confidence;
				requiredConfidences.push(argResult.confidence);
			} else if (argResult.kind === "boolean") {
				// An ambiguous band decided nothing, so there is no argument to pass. Leaving it out
				// keeps the omission visible instead of inventing a false from a coin-flip probability.
				const settled = settledBoolean(argResult);
				if (settled !== undefined) {
					resolvedArgs[paramName] = settled;
					argConfidences[paramName] = argResult.confidence;
					requiredConfidences.push(argResult.confidence);
				}
			}
		}
	}

	// ADR-015 / FIN-043: Weakest-link call confidence
	const provenance: ConfidenceProvenance = evaluation.engine?.confidence_provenance ?? "heuristic";
	const callConfidence = weakestCallConfidence(requiredConfidences, provenance);

	return {
		kind: "function_call",
		name: selectedFunc,
		arguments: resolvedArgs,
		confidence: callConfidence,
		argumentConfidences: argConfidences,
	};
}

export interface FunctionAuthorizationContext {
	readonly registry: SemanticFunctionRegistry;
	readonly authorityEnvelope?: {
		readonly allowedFunctions?: readonly string[];
		readonly blockedFunctions?: readonly string[];
	};
	readonly workerCapabilities?: readonly string[];
	readonly deterministicPreconditions?: (funcName: string, args: Record<string, unknown>) => boolean;
}

export interface FunctionAuthorizationResult {
	readonly authorized: boolean;
	readonly reason?: string;
}

/**
 * FIN-044: Mechanically authorizes a proposed semantic function call before execution.
 */
export function authorizeFunctionCall(
	call: FunctionCallDecisionResult,
	context: FunctionAuthorizationContext,
): FunctionAuthorizationResult {
	const funcDef = context.registry[call.name];
	if (!funcDef) {
		return { authorized: false, reason: `Function '${call.name}' is not in registry.` };
	}

	// Validate required arguments
	for (const [paramName, paramDef] of Object.entries(funcDef.parameters)) {
		if (!paramDef.optional && !(paramName in call.arguments)) {
			return {
				authorized: false,
				reason: `Missing required argument '${paramName}' for function '${call.name}'.`,
			};
		}
		if (paramName in call.arguments && paramDef.kind === "choice") {
			const val = call.arguments[paramName];
			if (typeof val !== "string" || !paramDef.options.includes(val)) {
				return {
					authorized: false,
					reason: `Invalid value '${String(val)}' for choice argument '${paramName}'.`,
				};
			}
		}
	}

	// Validate authority envelope
	if (context.authorityEnvelope?.blockedFunctions?.includes(call.name)) {
		return { authorized: false, reason: `Function '${call.name}' is blocked by authority envelope.` };
	}
	if (context.authorityEnvelope?.allowedFunctions && !context.authorityEnvelope.allowedFunctions.includes(call.name)) {
		return { authorized: false, reason: `Function '${call.name}' is not permitted by authority envelope.` };
	}

	// Validate worker capability
	if (context.workerCapabilities && !context.workerCapabilities.includes(call.name)) {
		return { authorized: false, reason: `Worker lacks capability for function '${call.name}'.` };
	}

	// Validate deterministic preconditions
	if (context.deterministicPreconditions && !context.deterministicPreconditions(call.name, call.arguments)) {
		return { authorized: false, reason: `Deterministic preconditions failed for function '${call.name}'.` };
	}

	return { authorized: true };
}
