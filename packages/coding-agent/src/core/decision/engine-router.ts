import { supportsProgram } from "./capabilities.ts";
import type { DecisionOptions, SemanticDecisionEngine } from "./engine.ts";
import type { DecisionEvaluation } from "./evaluation.ts";
import { type DecisionEnginePolicy, DefaultDecisionEnginePolicy } from "./policy.ts";
import type { Consequence } from "./primitives.ts";
import type { DecisionProgram } from "./program.ts";

export class DecisionEngineRouter {
	private readonly engines: readonly SemanticDecisionEngine[];
	private readonly policy: DecisionEnginePolicy;

	constructor(
		engines: readonly SemanticDecisionEngine[],
		policy: DecisionEnginePolicy = new DefaultDecisionEnginePolicy(),
	) {
		this.engines = engines;
		this.policy = policy;
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
		for (const engine of candidates) {
			try {
				return await engine.evaluate(program, state, options);
			} catch (err) {
				lastError = err;
				// Cascade to next engine in fallback chain
			}
		}

		throw lastError ?? new Error(`All decision engines failed for program ${program.id}`);
	}
}
