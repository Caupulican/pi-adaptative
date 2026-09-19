import type { JevAdapter } from "../../system-one/adapter.ts";
import { SYSTEM_ONE_PINNED_MODEL } from "../../system-one/catalog.ts";
import type { DecisionEngineCapabilities } from "../capabilities.ts";
import type { DecisionOptions, SemanticDecisionEngine } from "../engine.ts";
import { createDecisionEvaluation, type DecisionEvaluation, type DecisionResult } from "../evaluation.ts";
import type { DecisionProgram } from "../program.ts";

export class TypeSafeSystemOneDecisionEngine implements SemanticDecisionEngine {
	readonly id = "typesafe-system-one";
	readonly model: string;
	private readonly adapter: JevAdapter;

	constructor(adapter: JevAdapter, model: string = SYSTEM_ONE_PINNED_MODEL) {
		this.adapter = adapter;
		this.model = model;
	}

	capabilities(): DecisionEngineCapabilities {
		return {
			boolean: true,
			choice: true,
			score: true,
			set: true,
			fullDistributions: true,
			parallelIndependentDecisions: true,
			confidenceProvenance: "native_calibrated",
			maxStateTokens: 32_000,
		};
	}

	async evaluate(program: DecisionProgram, state: unknown, options?: DecisionOptions): Promise<DecisionEvaluation> {
		const questions: Record<string, unknown> = {};

		for (const d of program.decisions) {
			if (d.kind === "boolean") {
				questions[d.id] = {
					type: "noul",
					instructions: d.instruction,
					criteria: d.criteria
						? {
								true: d.criteria.true ?? "Condition holds true",
								false: d.criteria.false ?? "Condition does not hold",
							}
						: undefined,
				};
			} else if (d.kind === "choice") {
				const criteria: Record<string, string> = {};
				for (const [key, opt] of Object.entries(d.options)) {
					criteria[key] = opt.description;
				}
				questions[d.id] = {
					type: "choice",
					instructions: d.instruction,
					criteria,
				};
			} else if (d.kind === "score") {
				questions[d.id] = {
					type: "score",
					instructions: d.instruction,
					criteria: d.levels.map((lvl) => lvl.description),
				};
			} else if (d.kind === "set") {
				for (const [memberKey, memberDesc] of Object.entries(d.members)) {
					questions[`${d.id}__${memberKey}`] = {
						type: "noul",
						instructions: `${d.instructionTemplate}: ${memberKey}`,
						criteria: {
							true: `Belongs to set: ${memberDesc}`,
							false: "Does not belong to set",
						},
					};
				}
			}
		}

		const response = await this.adapter.evaluate(
			{
				model: this.model,
				state,
				questions,
			},
			{
				signal: options?.signal,
				timeoutMs: options?.timeoutMs,
			},
		);

		const results: Record<string, DecisionResult> = {};

		for (const d of program.decisions) {
			if (d.kind === "boolean") {
				const ans = (response.answers[d.id] ?? {}) as {
					value?: boolean;
					probability?: number;
					confidence?: number;
				};
				const prob = typeof ans.probability === "number" ? ans.probability : 0.5;
				const val = typeof ans.value === "boolean" ? ans.value : prob >= 0.5;
				const conf = typeof ans.confidence === "number" ? ans.confidence : Math.max(prob, 1 - prob);

				results[d.id] = {
					kind: "boolean",
					value: val,
					probabilityTrue: prob,
					confidence: {
						value: conf,
						provenance: "native_calibrated",
						isCalibrated: true,
						noulProbabilityTrue: prob,
					},
				};
			} else if (d.kind === "choice") {
				const ans = (response.answers[d.id] ?? {}) as {
					choice?: string;
					selected?: string;
					distribution?: Record<string, number>;
					margin?: number;
					confidence?: number;
				};
				const selected = ans.choice ?? ans.selected ?? Object.keys(d.options)[0] ?? "unknown";
				const distribution = ans.distribution ?? { [selected]: 1.0 };
				const margin = typeof ans.margin === "number" ? ans.margin : 1.0;
				const conf = typeof ans.confidence === "number" ? ans.confidence : (distribution[selected] ?? 0.9);

				results[d.id] = {
					kind: "choice",
					selected,
					distribution,
					margin,
					confidence: {
						value: conf,
						provenance: "native_calibrated",
						isCalibrated: true,
					},
				};
			} else if (d.kind === "score") {
				const ans = (response.answers[d.id] ?? {}) as {
					score?: number;
					value?: number;
					distribution?: Record<number, number>;
					confidence?: number;
				};
				const value = typeof ans.score === "number" ? ans.score : (ans.value ?? 0);
				const distribution = ans.distribution ?? { [value]: 1.0 };
				const conf = typeof ans.confidence === "number" ? ans.confidence : 0.9;

				results[d.id] = {
					kind: "score",
					value,
					distribution,
					confidence: {
						value: conf,
						provenance: "native_calibrated",
						isCalibrated: true,
					},
				};
			} else if (d.kind === "set") {
				const selected: string[] = [];
				const memberships: Record<string, number> = {};
				let minConf = 1.0;

				for (const memberKey of Object.keys(d.members)) {
					const qId = `${d.id}__${memberKey}`;
					const ans = (response.answers[qId] ?? {}) as {
						value?: boolean;
						probability?: number;
						confidence?: number;
					};
					const prob = typeof ans.probability === "number" ? ans.probability : 0.0;
					memberships[memberKey] = prob;
					if (prob >= 0.5 || ans.value === true) {
						selected.push(memberKey);
					}
					const conf = typeof ans.confidence === "number" ? ans.confidence : Math.max(prob, 1 - prob);
					if (conf < minConf) minConf = conf;
				}

				results[d.id] = {
					kind: "set",
					selected,
					memberships,
					confidence: {
						value: minConf,
						provenance: "native_calibrated",
						isCalibrated: true,
					},
				};
			}
		}

		return createDecisionEvaluation({
			programId: program.id,
			programVersion: program.version,
			engineId: this.id,
			model: response.model || this.model,
			confidenceProvenance: "native_calibrated",
			results,
		});
	}
}
