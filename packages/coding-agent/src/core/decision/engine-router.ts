import { DecisionActionPolicy } from "./action-policy.ts";
import { supportsProgram } from "./capabilities.ts";
import type { DecisionOptions, SemanticDecisionEngine } from "./engine.ts";
import type { DecisionEvaluation } from "./evaluation.ts";
import { type DecisionEnginePolicy, DefaultDecisionEnginePolicy } from "./policy.ts";
import type { Consequence } from "./primitives.ts";
import type { DecisionProgram } from "./program.ts";

export class DecisionEngineRouter {
	private readonly engines: readonly SemanticDecisionEngine[];
	private readonly policy: DecisionEnginePolicy;
	private readonly actionPolicy: DecisionActionPolicy;

	constructor(
		engines: readonly SemanticDecisionEngine[],
		policy: DecisionEnginePolicy = new DefaultDecisionEnginePolicy(),
		actionPolicy: DecisionActionPolicy = new DecisionActionPolicy(),
	) {
		this.engines = engines;
		this.policy = policy;
		this.actionPolicy = actionPolicy;
	}

	getEngines(): readonly SemanticDecisionEngine[] {
		return this.engines;
	}

	select(program: DecisionProgram, consequence: Consequence = "medium"): SemanticDecisionEngine | undefined {
		const candidates = this.engines.filter(
			(engine) => supportsProgram(engine.capabilities(), program) && this.policy.allowed(engine, consequence),
		);

		if (candidates.length === 0) {
			return undefined;
		}

		return candidates
			.slice()
			.sort((a, b) => this.policy.score(b, consequence) - this.policy.score(a, consequence))[0];
	}

	async evaluateOrFallback(
		program: DecisionProgram,
		state: unknown,
		options?: DecisionOptions,
	): Promise<DecisionEvaluation> {
		const consequence = options?.consequence ?? "medium";
		const candidates = this.engines
			.filter(
				(engine) => supportsProgram(engine.capabilities(), program) && this.policy.allowed(engine, consequence),
			)
			.sort((a, b) => this.policy.score(b, consequence) - this.policy.score(a, consequence));

		if (candidates.length === 0) {
			throw new Error(
				`No decision engine available that supports program ${program.id} under consequence ${consequence}`,
			);
		}

		let lastError: unknown;
		let lastEvaluation: DecisionEvaluation | undefined;
		const fallbackChain: string[] = [];

		for (const engine of candidates) {
			fallbackChain.push(engine.id);
			try {
				const evaluation = await engine.evaluate(program, state, options);
				lastEvaluation = evaluation;

				const policyResult = this.actionPolicy.evaluate(evaluation, {
					consequence,
					requiredDecisionIds: program.decisions.map((d) => d.id),
				});

				if (policyResult.disposition === "accept" || policyResult.disposition === "gather_more") {
					return {
						...evaluation,
						audit: {
							...evaluation.audit,
							engineId: engine.id,
							model: engine.model,
							programId: program.id,
							programVersion: program.version,
							confidenceProvenance: evaluation.engine.confidence_provenance,
							consequence,
							fallbackChain,
							policyDisposition: policyResult.disposition,
						},
					};
				}

				// disposition === "try_next_engine" -> continue to next compatible engine
			} catch (err) {
				lastError = err;
				// Cascade to next engine in fallback chain
			}
		}

		if (lastEvaluation) {
			return {
				...lastEvaluation,
				audit: {
					...lastEvaluation.audit,
					engineId: lastEvaluation.engine.id,
					model: lastEvaluation.engine.model,
					programId: program.id,
					programVersion: program.version,
					confidenceProvenance: lastEvaluation.engine.confidence_provenance,
					consequence,
					fallbackChain,
					policyDisposition: "fallback_exhausted",
				},
			};
		}

		throw lastError ?? new Error(`All decision engines failed for program ${program.id}`);
	}
}
