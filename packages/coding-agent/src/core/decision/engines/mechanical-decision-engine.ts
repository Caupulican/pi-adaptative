import type { DecisionEngineCapabilities } from "../capabilities.ts";
import type { DecisionOptions, SemanticDecisionEngine } from "../engine.ts";
import {
	certainBooleanResult,
	createDecisionEvaluation,
	type DecisionEvaluation,
	type DecisionResult,
} from "../evaluation.ts";
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
		const rawRuntime = (mechState as any).runtime;
		const rawIntegrity = (mechState as any).integrity;

		const readyTask =
			rawRuntime?.ready_tasks?.length > 0 ? { status: "ready" } : mechState.tasks?.find((t) => t.status === "ready");
		const retryableTask =
			rawRuntime?.failed_retryable_tasks?.length > 0
				? { status: "failed", retriesRemaining: 1 }
				: mechState.tasks?.find((t) => t.status === "failed" && (t.retriesRemaining ?? 0) > 0);
		const runningAttempts = rawRuntime?.running_attempts?.length ?? (mechState as any).activeAttempts?.length ?? 0;

		const objectiveCriteria: readonly any[] =
			rawObjective?.required_criteria ?? rawObjective?.objective?.acceptanceCriteria ?? [];
		const objectiveEvidence: readonly any[] = rawIntegrity?.fresh_evidence ?? rawObjective?.evidence ?? [];

		const criteria =
			mechState.acceptance ??
			(objectiveCriteria.length > 0
				? objectiveCriteria.map((ac) => {
						const critId = typeof ac === "string" ? ac : ac.id;
						const req = typeof ac === "string" ? true : ac.required !== false;
						const sat = objectiveEvidence.some((e) =>
							typeof e === "string"
								? e === critId
								: (e.acceptanceCriterionId === critId || e.requirement_id === critId) && e.verdict !== "failed",
						);
						return {
							id: critId,
							required: req,
							satisfied: sat,
						};
					})
				: []);

		const allSatisfied =
			criteria.length > 0
				? criteria.every((a) => !a.required || a.satisfied)
				: rawRuntime
					? (rawRuntime.ready_tasks?.length ?? 0) === 0 &&
						(rawRuntime.failed_retryable_tasks?.length ?? 0) === 0 &&
						runningAttempts === 0
					: (mechState.tasks?.length ?? 0) === 0 || mechState.tasks?.every((t) => t.status === "completed");

		for (const decision of program.decisions) {
			if (decision.id === "__function__" && decision.kind === "choice") {
				let selectedFunc = "dispatch_worker";

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
					results[decision.id] = {
						kind: "unsupported",
						reason: `mechanical_function_${selectedFunc}_not_in_options`,
					};
					continue;
				}

				results[decision.id] = {
					kind: "choice",
					selected: selectedFunc,
					distribution: { [selectedFunc]: 1.0 },
					margin: 1.0,
					confidence: {
						value: 1.0,
						provenance: "heuristic",
						isCalibrated: false,
					},
				};
			} else if (decision.kind === "choice") {
				let selected: string | undefined;

				if (decision.id === "missing_work_class") {
					const missingProof = criteria.find(
						(a) => a.required && (a as any).mechanicalProofRequired && !(a as any).mechanicalProofPassed,
					);

					if (allSatisfied) {
						selected = "none";
					} else if (missingProof) {
						selected = "verify";
					} else if (retryableTask) {
						selected = "replan";
					} else if (readyTask) {
						selected = "implement";
					}
				} else if (decision.id.endsWith("__role")) {
					const unsatisfied = criteria.find((a) => a.required && !(a as any).satisfied);
					selected = (unsatisfied as any)?.implementationPresent ? "verifier" : "investigator";
				} else if (decision.id.endsWith("__kind") && decision.options.test) {
					selected = "test";
				} else if (decision.id.endsWith("__reason") && decision.options.strategy_failed) {
					selected = "strategy_failed";
				}

				if (selected && decision.options[selected]) {
					results[decision.id] = {
						kind: "choice",
						selected,
						distribution: { [selected]: 1.0 },
						margin: 1.0,
						confidence: {
							value: 1.0,
							provenance: "heuristic",
							isCalibrated: false,
						},
					};
				} else {
					results[decision.id] = {
						kind: "unsupported",
						reason: `semantic_choice_${decision.id}_not_derivable_mechanically`,
					};
				}
			} else if (decision.kind === "boolean") {
				let val: boolean | undefined;
				if (decision.id.includes("work_remaining")) {
					val = !allSatisfied;
				} else if (decision.id.includes("cancelled")) {
					val = Boolean(mechState.cancelled);
				} else if (decision.id.includes("budget_exhausted")) {
					val = Boolean(mechState.budgetExhausted);
				} else if (decision.id === "current_worker_can_continue") {
					val = Boolean(mechState.requiredWorkerInFlight);
				}

				if (val !== undefined) {
					results[decision.id] = certainBooleanResult(val, decision.direction ?? "required_true", {
						value: 1.0,
						provenance: "heuristic",
						isCalibrated: false,
					});
				} else {
					results[decision.id] = {
						kind: "unsupported",
						reason: `semantic_boolean_${decision.id}_not_derivable_mechanically`,
					};
				}
			} else if (decision.kind === "score") {
				if (decision.id === "semantic_progress") {
					const val = allSatisfied ? 3 : criteria.some((c) => c.satisfied) ? 2 : 0;
					results[decision.id] = {
						kind: "score",
						value: val,
						distribution: { [val]: 1.0 },
						confidence: {
							value: 1.0,
							provenance: "heuristic",
							isCalibrated: false,
						},
					};
				} else {
					results[decision.id] = {
						kind: "unsupported",
						reason: `semantic_score_${decision.id}_not_derivable_mechanically`,
					};
				}
			} else if (decision.kind === "set") {
				results[decision.id] = {
					kind: "unsupported",
					reason: `semantic_set_${decision.id}_not_derivable_mechanically`,
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
