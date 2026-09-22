import type { DecisionEngineCapabilities } from "../capabilities.ts";
import type { DecisionOptions, SemanticDecisionEngine } from "../engine.ts";
import {
	certainBooleanResult,
	createDecisionEvaluation,
	type DecisionEvaluation,
	type DecisionResult,
} from "../evaluation.ts";
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
		let parsedAnswers: Record<string, unknown> | null = null;

		if (this.runner) {
			const prompt = `Evaluate the following decision program: ${JSON.stringify(program)}\nState: ${JSON.stringify(state)}\nProvide a JSON mapping decision ids to answers.`;
			try {
				const raw = await this.runner.complete(prompt, options?.signal);
				parsedAnswers = JSON.parse(raw);
			} catch {
				parsedAnswers = null;
			}
		}

		const results: Record<string, DecisionResult> = {};
		let hasDeclaredConfidence = false;

		for (const d of program.decisions) {
			if (!parsedAnswers || typeof parsedAnswers !== "object" || parsedAnswers[d.id] === undefined) {
				results[d.id] = {
					kind: "unsupported",
					reason: `missing_answer_for_${d.id}`,
				};
				continue;
			}

			const rawAns = parsedAnswers[d.id];
			let declaredConf: number | undefined;
			if (typeof rawAns === "object" && rawAns !== null && "confidence" in rawAns) {
				const c = (rawAns as { confidence: unknown }).confidence;
				if (typeof c === "number" && Number.isFinite(c) && c >= 0 && c <= 1) {
					declaredConf = c;
					hasDeclaredConfidence = true;
				}
			}

			const confidenceVal = declaredConf ?? 0.5;
			const provenance = declaredConf !== undefined ? "synthetic_self_report" : "none";

			if (d.kind === "boolean") {
				let val: boolean | undefined;
				if (typeof rawAns === "boolean") {
					val = rawAns;
				} else if (typeof rawAns === "object" && rawAns !== null && "value" in rawAns) {
					const v = (rawAns as { value: unknown }).value;
					if (typeof v === "boolean") val = v;
				}

				if (val === undefined) {
					results[d.id] = {
						kind: "unsupported",
						reason: `invalid_boolean_for_${d.id}`,
					};
					continue;
				}

				results[d.id] = certainBooleanResult(val, d.direction ?? "required_true", {
					value: confidenceVal,
					provenance,
					isCalibrated: false,
				});
			} else if (d.kind === "choice") {
				let selected: string | undefined;
				let distribution: Record<string, number> | undefined;

				if (typeof rawAns === "string" && d.options[rawAns]) {
					selected = rawAns;
					distribution = { [selected]: 1.0 };
				} else if (typeof rawAns === "object" && rawAns !== null) {
					const c = rawAns as {
						choice?: unknown;
						selected?: unknown;
						probabilities?: unknown;
						distribution?: unknown;
					};
					const candidate =
						typeof c.choice === "string" ? c.choice : typeof c.selected === "string" ? c.selected : undefined;
					if (candidate && d.options[candidate]) {
						selected = candidate;
					}
					if (typeof c.probabilities === "object" && c.probabilities !== null) {
						distribution = c.probabilities as Record<string, number>;
					} else if (typeof c.distribution === "object" && c.distribution !== null) {
						distribution = c.distribution as Record<string, number>;
					}
				}

				if (!selected) {
					results[d.id] = {
						kind: "unsupported",
						reason: `unknown_choice_for_${d.id}`,
					};
					continue;
				}

				results[d.id] = {
					kind: "choice",
					selected,
					distribution: distribution ?? { [selected]: 1.0 },
					margin: 1.0,
					confidence: {
						value: confidenceVal,
						provenance,
						isCalibrated: false,
					},
				};
			} else if (d.kind === "score") {
				let val: number | undefined;
				if (typeof rawAns === "number" && Number.isFinite(rawAns)) {
					val = rawAns;
				} else if (typeof rawAns === "object" && rawAns !== null && "value" in rawAns) {
					const v = (rawAns as { value: unknown }).value;
					if (typeof v === "number" && Number.isFinite(v)) val = v;
				}

				if (val === undefined) {
					results[d.id] = {
						kind: "unsupported",
						reason: `invalid_score_for_${d.id}`,
					};
					continue;
				}

				results[d.id] = {
					kind: "score",
					value: val,
					distribution: { [val]: 1.0 },
					confidence: {
						value: confidenceVal,
						provenance,
						isCalibrated: false,
					},
				};
			} else if (d.kind === "set") {
				let selected: string[] | undefined;
				if (Array.isArray(rawAns) && rawAns.every((item) => typeof item === "string" && item in d.members)) {
					selected = rawAns as string[];
				}

				if (!selected) {
					results[d.id] = {
						kind: "unsupported",
						reason: `invalid_set_for_${d.id}`,
					};
					continue;
				}

				results[d.id] = {
					kind: "set",
					selected,
					memberships: {},
					confidence: {
						value: confidenceVal,
						provenance,
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
			confidenceProvenance: hasDeclaredConfidence ? "synthetic_self_report" : "none",
			results,
		});
	}
}
