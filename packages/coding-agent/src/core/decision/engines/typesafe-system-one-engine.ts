import type { JevAdapter } from "../../system-one/adapter.ts";
import { SYSTEM_ONE_PINNED_MODEL } from "../../system-one/catalog.ts";
import type { DecisionEngineCapabilities } from "../capabilities.ts";
import type { DecisionOptions, SemanticDecisionEngine } from "../engine.ts";
import { createDecisionEvaluation, type DecisionEvaluation, type DecisionResult } from "../evaluation.ts";
import {
	DEFAULT_NOUL_BAND_THRESHOLDS,
	isNoulProbability,
	type NoulBandThresholds,
	noulBand,
	noulCertainty,
} from "../noul.ts";
import type { DecisionProgram } from "../program.ts";
import { DecisionEngineProtocolError } from "../protocol-error.ts";

export class TypeSafeSystemOneDecisionEngine implements SemanticDecisionEngine {
	readonly id = "typesafe-system-one";
	readonly model: string;
	private readonly adapter: JevAdapter;
	private readonly thresholds: NoulBandThresholds;

	constructor(
		adapter: JevAdapter,
		model: string = SYSTEM_ONE_PINNED_MODEL,
		thresholds: NoulBandThresholds = DEFAULT_NOUL_BAND_THRESHOLDS,
	) {
		this.adapter = adapter;
		this.model = model;
		this.thresholds = thresholds;
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
					...(d.criteria
						? {
								criteria: {
									true: d.criteria.true ?? "Condition holds true",
									false: d.criteria.false ?? "Condition does not hold",
								},
							}
						: {}),
				};
			} else if (d.kind === "choice") {
				const criteria: Record<string, string> = {};
				for (const [key, opt] of Object.entries(d.options)) {
					if (opt.notFor) {
						criteria[key] = `${opt.description} (NOT for: ${opt.notFor})`;
					} else {
						criteria[key] = opt.description;
					}
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

		const startTime = Date.now();
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
		const latencyMs = Date.now() - startTime;

		const results: Record<string, DecisionResult> = {};

		for (const d of program.decisions) {
			const raw = response.answers[d.id];
			if (d.kind === "boolean") {
				if (!raw || typeof raw !== "object") {
					throw new DecisionEngineProtocolError(`Missing answer for boolean decision '${d.id}'`, {
						decisionId: d.id,
					});
				}
				const ans = raw as { type?: string; noul?: number };
				if (ans.type !== "noul" || !isNoulProbability(ans.noul)) {
					throw new DecisionEngineProtocolError(
						`Invalid noul answer for boolean decision '${d.id}': expected finite number in [0, 1]`,
						{ decisionId: d.id, raw },
					);
				}
				const prob = ans.noul;
				const direction = d.direction ?? "required_true";

				results[d.id] = {
					kind: "boolean",
					probabilityTrue: prob,
					direction,
					band: noulBand(prob, direction, this.thresholds),
					confidence: {
						value: noulCertainty(prob),
						provenance: "derived_calibrated_probability",
						isCalibrated: true,
						noulProbabilityTrue: prob,
					},
				};
			} else if (d.kind === "choice") {
				if (!raw || typeof raw !== "object") {
					throw new DecisionEngineProtocolError(`Missing answer for choice decision '${d.id}'`, {
						decisionId: d.id,
					});
				}
				const ans = raw as {
					type?: string;
					choice?: string;
					confidence?: number;
					probabilities?: Record<string, number>;
				};
				const allowUnlisted = d.allowUnlistedChoice === true || d.id === "specialist_domain";
				if (ans.type !== "choice" || typeof ans.choice !== "string" || (!d.options[ans.choice] && !allowUnlisted)) {
					throw new DecisionEngineProtocolError(`Invalid choice '${ans.choice}' for decision '${d.id}'`, {
						decisionId: d.id,
						raw,
					});
				}
				if (
					typeof ans.confidence !== "number" ||
					!Number.isFinite(ans.confidence) ||
					ans.confidence < 0 ||
					ans.confidence > 1
				) {
					throw new DecisionEngineProtocolError(`Invalid confidence for choice decision '${d.id}'`, {
						decisionId: d.id,
						raw,
					});
				}
				if (!ans.probabilities || typeof ans.probabilities !== "object") {
					throw new DecisionEngineProtocolError(`Missing probabilities for choice decision '${d.id}'`, {
						decisionId: d.id,
						raw,
					});
				}
				let sum = 0;
				const sortedProbs: number[] = [];
				for (const [k, p] of Object.entries(ans.probabilities)) {
					if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
						throw new DecisionEngineProtocolError(`Invalid probability for option '${k}' in decision '${d.id}'`, {
							decisionId: d.id,
							raw,
						});
					}
					sum += p;
					sortedProbs.push(p);
				}
				if (Math.abs(sum - 1.0) > 0.1) {
					throw new DecisionEngineProtocolError(
						`Probabilities for choice decision '${d.id}' do not sum to 1 (sum = ${sum})`,
						{ decisionId: d.id, raw },
					);
				}
				sortedProbs.sort((a, b) => b - a);
				const top = sortedProbs[0] ?? 1.0;
				const second = sortedProbs[1] ?? 0.0;
				const margin = top - second;

				results[d.id] = {
					kind: "choice",
					selected: ans.choice,
					distribution: ans.probabilities,
					margin,
					confidence: {
						value: ans.confidence,
						provenance: "native_calibrated",
						isCalibrated: true,
					},
				};
			} else if (d.kind === "score") {
				if (!raw || typeof raw !== "object") {
					throw new DecisionEngineProtocolError(`Missing answer for score decision '${d.id}'`, {
						decisionId: d.id,
					});
				}
				const ans = raw as {
					type?: string;
					score?: number;
					confidence?: number;
					probabilities?: Record<string, number>;
				};
				if (ans.type !== "score" || typeof ans.score !== "number" || !Number.isFinite(ans.score)) {
					throw new DecisionEngineProtocolError(`Invalid score for decision '${d.id}'`, { decisionId: d.id, raw });
				}
				if (
					typeof ans.confidence !== "number" ||
					!Number.isFinite(ans.confidence) ||
					ans.confidence < 0 ||
					ans.confidence > 1
				) {
					throw new DecisionEngineProtocolError(`Invalid confidence for score decision '${d.id}'`, {
						decisionId: d.id,
						raw,
					});
				}
				if (!ans.probabilities || typeof ans.probabilities !== "object") {
					throw new DecisionEngineProtocolError(`Missing probabilities for score decision '${d.id}'`, {
						decisionId: d.id,
						raw,
					});
				}
				const numericDistribution: Record<number, number> = {};
				let sum = 0;
				for (const [k, p] of Object.entries(ans.probabilities)) {
					const numKey = Number(k);
					if (Number.isNaN(numKey) || typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
						throw new DecisionEngineProtocolError(
							`Invalid score probability for key '${k}' in decision '${d.id}'`,
							{ decisionId: d.id, raw },
						);
					}
					numericDistribution[numKey] = p;
					sum += p;
				}
				if (Math.abs(sum - 1.0) > 0.1) {
					throw new DecisionEngineProtocolError(
						`Score probabilities for decision '${d.id}' do not sum to 1 (sum = ${sum})`,
						{ decisionId: d.id, raw },
					);
				}

				results[d.id] = {
					kind: "score",
					value: ans.score,
					distribution: numericDistribution,
					confidence: {
						value: ans.confidence,
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
					const memberRaw = response.answers[qId];
					if (!memberRaw || typeof memberRaw !== "object") {
						throw new DecisionEngineProtocolError(`Missing answer for set item '${qId}'`, { decisionId: qId });
					}
					const ans = memberRaw as { type?: string; noul?: number };
					if (ans.type !== "noul" || !isNoulProbability(ans.noul)) {
						throw new DecisionEngineProtocolError(
							`Invalid noul answer for set item '${qId}': expected finite number in [0, 1]`,
							{ decisionId: qId, raw: memberRaw },
						);
					}
					const prob = ans.noul;
					memberships[memberKey] = prob;
					if (prob >= (d.threshold ?? 0.5)) {
						selected.push(memberKey);
					}
					const conf = noulCertainty(prob);
					if (conf < minConf) {
						minConf = conf;
					}
				}

				results[d.id] = {
					kind: "set",
					selected,
					memberships,
					confidence: {
						value: minConf,
						provenance: "derived_calibrated_probability",
						isCalibrated: true,
					},
				};
			}
		}

		const evaluation = createDecisionEvaluation({
			programId: program.id,
			programVersion: program.version,
			engineId: this.id,
			model: response.model || this.model,
			confidenceProvenance: "native_calibrated",
			results,
			audit: {
				engineId: this.id,
				provider: "typesafe",
				model: response.model || this.model,
				programId: program.id,
				programVersion: program.version,
				confidenceProvenance: "native_calibrated",
				latencyMs,
			},
		});
		(evaluation as unknown as Record<string, unknown>).rawAnswers = response.answers;
		return evaluation;
	}
}
