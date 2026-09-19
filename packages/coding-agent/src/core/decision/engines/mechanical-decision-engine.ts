import type { DecisionEngineCapabilities } from "../capabilities.ts";
import type { DecisionOptions, SemanticDecisionEngine } from "../engine.ts";
import { createDecisionEvaluation, type DecisionEvaluation, type DecisionResult } from "../evaluation.ts";
import type { DecisionProgram } from "../program.ts";

export interface MechanicalObjectiveState {
	readonly cancelled?: boolean;
	readonly budgetExhausted?: boolean;
	readonly requiredWorkerInFlight?: boolean;
	readonly requiredToolInFlight?: boolean;
	readonly tasks?: readonly {
		readonly id: string;
		readonly status: string;
		readonly retriesRemaining?: number;
	}[];
	readonly acceptance?: readonly {
		readonly id: string;
		readonly required: boolean;
		readonly satisfied: boolean;
		readonly mechanicalProofRequired?: boolean;
		readonly mechanicalProofPassed?: boolean;
		readonly implementationPresent?: boolean;
	}[];
}

export class MechanicalDecisionEngine implements SemanticDecisionEngine {
	readonly id = "mechanical";
	readonly model = "deterministic-runtime-rules";

	capabilities(): DecisionEngineCapabilities {
		return {
			boolean: true,
			choice: true,
			score: true,
			set: true,
			fullDistributions: false,
			parallelIndependentDecisions: false,
			confidenceProvenance: "none",
			maxStateTokens: undefined,
		};
	}

	async evaluate(program: DecisionProgram, state: unknown, _options?: DecisionOptions): Promise<DecisionEvaluation> {
		const mechState = (state ?? {}) as MechanicalObjectiveState;
		const results: Record<string, DecisionResult> = {};

		const rawObjective = (mechState as any).objective;
		const objectiveCriteria: readonly any[] = rawObjective?.objective?.acceptanceCriteria ?? [];
		const objectiveEvidence: readonly any[] = rawObjective?.evidence ?? [];

		const criteria =
			mechState.acceptance ??
			(objectiveCriteria.length > 0
				? objectiveCriteria.map((ac) => ({
						id: ac.id,
						required: ac.required !== false,
						satisfied: objectiveEvidence.some((e) => e.acceptanceCriterionId === ac.id && e.verdict === "passed"),
					}))
				: []);

		const allSatisfied =
			criteria.length > 0
				? criteria.every((a) => !a.required || a.satisfied)
				: (mechState.tasks?.length ?? 0) === 0 || mechState.tasks?.every((t) => t.status === "completed");

		for (const decision of program.decisions) {
			if (decision.id === "__function__" && decision.kind === "choice") {
				// Mechanical routing rules per MASTER_SPEC and mechanical-fallback-policy
				let selectedFunc = "dispatch_worker";

				const readyTask = mechState.tasks?.find((t) => t.status === "ready");
				const retryableTask = mechState.tasks?.find((t) => t.status === "failed" && (t.retriesRemaining ?? 0) > 0);
				const missingProof = criteria.find(
					(a) => a.required && (a as any).mechanicalProofRequired && !(a as any).mechanicalProofPassed,
				);

				if (allSatisfied) {
					selectedFunc = "completion_candidate";
				} else if (missingProof) {
					selectedFunc = "run_verification";
				} else if (retryableTask) {
					selectedFunc = "replan";
				} else if (readyTask) {
					selectedFunc = "dispatch_worker";
				} else {
					selectedFunc = "dispatch_worker";
				}

				if (!decision.options[selectedFunc]) {
					selectedFunc = Object.keys(decision.options)[0] ?? "dispatch_worker";
				}

				results[decision.id] = {
					kind: "choice",
					selected: selectedFunc,
					distribution: { [selectedFunc]: 1.0 },
					margin: 1.0,
					confidence: {
						value: 1.0,
						provenance: "none",
						isCalibrated: false,
					},
				};
			} else if (decision.kind === "choice") {
				// ADR-033: If decision corresponds to an argument or semantic judgment,
				// use deterministic state if possible, else unsupported/default
				let selected = Object.keys(decision.options)[0];

				if (decision.id === "missing_work_class") {
					selected = allSatisfied ? "none" : "implementation";
					if (!decision.options[selected]) {
						selected = Object.keys(decision.options)[0];
					}
				} else if (decision.id.endsWith("__role")) {
					const unsatisfied = criteria.find((a) => a.required && !(a as any).satisfied);
					selected = (unsatisfied as any)?.implementationPresent ? "verifier" : "investigator";
					if (!decision.options[selected]) {
						selected = Object.keys(decision.options)[0];
					}
				} else if (decision.id.endsWith("__kind") && decision.options.test) {
					selected = "test";
				} else if (decision.id.endsWith("__reason") && decision.options.strategy_failed) {
					selected = "strategy_failed";
				}

				results[decision.id] = {
					kind: "choice",
					selected,
					distribution: { [selected]: 1.0 },
					margin: 1.0,
					confidence: {
						value: 1.0,
						provenance: "none",
						isCalibrated: false,
					},
				};
			} else if (decision.kind === "boolean") {
				let value = false;
				if (decision.id.includes("work_remaining")) {
					value = !allSatisfied;
				}
				results[decision.id] = {
					kind: "boolean",
					value,
					probabilityTrue: value ? 1.0 : 0.0,
					confidence: {
						value: 1.0,
						provenance: "none",
						isCalibrated: false,
					},
				};
			} else if (decision.kind === "score") {
				results[decision.id] = {
					kind: "score",
					value: decision.levels[0]?.value ?? 0,
					distribution: { [decision.levels[0]?.value ?? 0]: 1.0 },
					confidence: {
						value: 1.0,
						provenance: "none",
						isCalibrated: false,
					},
				};
			} else if (decision.kind === "set") {
				results[decision.id] = {
					kind: "set",
					selected: [],
					memberships: {},
					confidence: {
						value: 1.0,
						provenance: "none",
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
			confidenceProvenance: "none",
			results,
		});
	}
}
