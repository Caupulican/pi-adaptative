import type { DecisionEngineCapabilities } from "../capabilities.ts";
import type { DecisionOptions, SemanticDecisionEngine } from "../engine.ts";
import { createDecisionEvaluation, type DecisionEvaluation, type DecisionResult } from "../evaluation.ts";
import type { DecisionProgram } from "../program.ts";

export interface LlmCompletionRunner {
	complete(prompt: string, signal?: AbortSignal): Promise<string>;
}

export class StructuredLlmDecisionEngine implements SemanticDecisionEngine {
	readonly id = "structured-llm";
	readonly model: string;
	private readonly runner?: LlmCompletionRunner;

	constructor(model: string = "structured-llm-fallback", runner?: LlmCompletionRunner) {
		this.model = model;
		this.runner = runner;
	}

	capabilities(): DecisionEngineCapabilities {
		return {
			boolean: true,
			choice: true,
			score: true,
			set: true,
			fullDistributions: false,
			parallelIndependentDecisions: false,
			confidenceProvenance: "synthetic_self_report",
			maxStateTokens: 8_000,
		};
	}

	async evaluate(program: DecisionProgram, state: unknown, options?: DecisionOptions): Promise<DecisionEvaluation> {
		let parsedAnswers: Record<string, unknown> = {};

		if (this.runner) {
			const prompt = `Evaluate the following decision program: ${JSON.stringify(program)}\nState: ${JSON.stringify(state)}\nProvide a JSON mapping decision ids to answers.`;
			const raw = await this.runner.complete(prompt, options?.signal);
			try {
				parsedAnswers = JSON.parse(raw);
			} catch {
				parsedAnswers = {};
			}
		}

		const results: Record<string, DecisionResult> = {};

		for (const d of program.decisions) {
			if (d.kind === "boolean") {
				const ans = parsedAnswers[d.id];
				const val = typeof ans === "boolean" ? ans : false;
				results[d.id] = {
					kind: "boolean",
					value: val,
					probabilityTrue: val ? 0.9 : 0.1,
					confidence: {
						value: 0.85,
						provenance: "synthetic_self_report",
						isCalibrated: false,
					},
				};
			} else if (d.kind === "choice") {
				const ans = parsedAnswers[d.id];
				const selected = typeof ans === "string" && d.options[ans] ? ans : (Object.keys(d.options)[0] ?? "unknown");
				results[d.id] = {
					kind: "choice",
					selected,
					distribution: { [selected]: 1.0 },
					margin: 1.0,
					confidence: {
						value: 0.85,
						provenance: "synthetic_self_report",
						isCalibrated: false,
					},
				};
			} else if (d.kind === "score") {
				const ans = parsedAnswers[d.id];
				const value = typeof ans === "number" ? ans : (d.levels[0]?.value ?? 0);
				results[d.id] = {
					kind: "score",
					value,
					distribution: { [value]: 1.0 },
					confidence: {
						value: 0.85,
						provenance: "synthetic_self_report",
						isCalibrated: false,
					},
				};
			} else if (d.kind === "set") {
				const ans = parsedAnswers[d.id];
				const selected = Array.isArray(ans) ? (ans as string[]) : [];
				results[d.id] = {
					kind: "set",
					selected,
					memberships: {},
					confidence: {
						value: 0.85,
						provenance: "synthetic_self_report",
						isCalibrated: false,
					},
				};
			}
		}

		return createDecisionEvaluation({
			programId: program.id,
			programVersion: program.version,
			engineId: this.id,
			model: this.model,
			confidenceProvenance: "synthetic_self_report",
			results,
		});
	}
}
