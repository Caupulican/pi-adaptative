import type { SystemOneReceipt } from "../../review/system-one-review-port.ts";
import { canonicalDigest } from "../../steering/canonical.ts";
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
import { YES_NO_BANDS } from "../thresholds.ts";

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
			requestBudget: this.adapter.requestBudget === true,
			requestLifecycle: this.adapter.requestLifecycle === true,
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
		if (options?.budget && !this.adapter.requestBudget)
			throw new RequestSpendRefusal("The selected semantic adapter cannot enforce a request budget.");
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
				// An option's exclusion is its own field, not prose pasted into the description. When any
				// option carries one, every option is sent in the structured form so the criteria stay uniform.
				const structured = Object.values(d.options).some((opt) => opt.notFor);
				const criteria: Record<string, string | { what: string; not_for?: string }> = {};
				for (const [key, opt] of Object.entries(d.options)) {
					criteria[key] = structured
						? { what: opt.description, ...(opt.notFor ? { not_for: opt.notFor } : {}) }
						: opt.description;
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
				budget: options?.budget,
				origin: options?.origin,
				onRequestAdmitted: options?.onRequestAdmitted,
			},
		);
		const latencyMs = Date.now() - startTime;
		const receipts: readonly SystemOneReceipt[] = response.receipts ?? [];
		// Every rejected output keeps the receipts of the paid response it came from, so their persistence is still owed.
		const protocolError = (message: string, details?: Record<string, unknown>): DecisionEngineProtocolError =>
			new DecisionEngineProtocolError(message, details, receipts);

		const results: Record<string, DecisionResult> = {};

		for (const d of program.decisions) {
			const raw = response.answers[d.id];
			if (d.kind === "boolean") {
				if (!raw || typeof raw !== "object") {
					throw protocolError(`Missing answer for boolean decision '${d.id}'`, {
						decisionId: d.id,
					});
				}
				const ans = raw as { type?: string; noul?: number };
				if (ans.type !== "noul" || !isNoulProbability(ans.noul)) {
					throw protocolError(
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
					throw protocolError(`Missing answer for choice decision '${d.id}'`, {
						decisionId: d.id,
					});
				}
				const ans = raw as {
					type?: string;
					choice?: string;
					confidence?: number;
					probabilities?: Record<string, number>;
				};
				if (
					ans.type !== "choice" ||
					typeof ans.choice !== "string" ||
					(!d.options[ans.choice] && d.allowUnlistedChoice !== true)
				) {
					throw protocolError(`Invalid choice '${ans.choice}' for decision '${d.id}'`, {
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
					throw protocolError(`Invalid confidence for choice decision '${d.id}'`, {
						decisionId: d.id,
						raw,
					});
				}
				if (!ans.probabilities || typeof ans.probabilities !== "object") {
					throw protocolError(`Missing probabilities for choice decision '${d.id}'`, {
						decisionId: d.id,
						raw,
					});
				}
				let sum = 0;
				const sortedProbs: number[] = [];
				for (const [k, p] of Object.entries(ans.probabilities)) {
					if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
						throw protocolError(`Invalid probability for option '${k}' in decision '${d.id}'`, {
							decisionId: d.id,
							raw,
						});
					}
					sum += p;
					sortedProbs.push(p);
				}
				if (Math.abs(sum - 1.0) > 0.1) {
					throw protocolError(`Probabilities for choice decision '${d.id}' do not sum to 1 (sum = ${sum})`, {
						decisionId: d.id,
						raw,
					});
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
					throw protocolError(`Missing answer for score decision '${d.id}'`, {
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
					throw protocolError(`Invalid score for decision '${d.id}'`, { decisionId: d.id, raw });
				}
				if (
					typeof ans.confidence !== "number" ||
					!Number.isFinite(ans.confidence) ||
					ans.confidence < 0 ||
					ans.confidence > 1
				) {
					throw protocolError(`Invalid confidence for score decision '${d.id}'`, {
						decisionId: d.id,
						raw,
					});
				}
				if (!ans.probabilities || typeof ans.probabilities !== "object") {
					throw protocolError(`Missing probabilities for score decision '${d.id}'`, {
						decisionId: d.id,
						raw,
					});
				}
				const numericDistribution: Record<number, number> = {};
				let sum = 0;
				for (const [k, p] of Object.entries(ans.probabilities)) {
					const numKey = Number(k);
					if (Number.isNaN(numKey) || typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
						throw protocolError(`Invalid score probability for key '${k}' in decision '${d.id}'`, {
							decisionId: d.id,
							raw,
						});
					}
					numericDistribution[numKey] = p;
					sum += p;
				}
				if (Math.abs(sum - 1.0) > 0.1) {
					throw protocolError(`Score probabilities for decision '${d.id}' do not sum to 1 (sum = ${sum})`, {
						decisionId: d.id,
						raw,
					});
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
				// A member is in at the advisory pass cut (or the program's own threshold), out at or below the
				// advisory fail cut, and unsettled between: an undecided member is never silently "out".
				const advisory = YES_NO_BANDS.advisory.requiredTrue;
				const memberIn = d.threshold ?? advisory.hardPass;
				const selected: string[] = [];
				const unsettled: string[] = [];
				const memberships: Record<string, number> = {};
				let minConf = 1.0;

				for (const memberKey of Object.keys(d.members)) {
					const qId = `${d.id}__${memberKey}`;
					const memberRaw = response.answers[qId];
					if (!memberRaw || typeof memberRaw !== "object") {
						throw protocolError(`Missing answer for set item '${qId}'`, { decisionId: qId });
					}
					const ans = memberRaw as { type?: string; noul?: number };
					if (ans.type !== "noul" || !isNoulProbability(ans.noul)) {
						throw protocolError(`Invalid noul answer for set item '${qId}': expected finite number in [0, 1]`, {
							decisionId: qId,
							raw: memberRaw,
						});
					}
					const prob = ans.noul;
					memberships[memberKey] = prob;
					if (prob >= memberIn) selected.push(memberKey);
					else if (prob > advisory.hardFail) unsettled.push(memberKey);
					const conf = noulCertainty(prob);
					if (conf < minConf) {
						minConf = conf;
					}
				}

				results[d.id] = {
					kind: "set",
					selected,
					...(unsettled.length > 0 ? { unsettled } : {}),
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
				...(response.provider ? { provider: response.provider } : {}),
				model: response.model || this.model,
				programId: program.id,
				programVersion: program.version,
				programDigest: canonicalDigest(questions),
				stateDigest: canonicalDigest(state),
				confidenceProvenance: "native_calibrated",
				latencyMs,
				...(options?.consequence ? { consequence: options.consequence } : {}),
				receipts,
			},
			rawAnswers: response.answers,
		});
		return evaluation;
	}
}

import { RequestSpendRefusal } from "../../cost/request-spend-budget.ts";
