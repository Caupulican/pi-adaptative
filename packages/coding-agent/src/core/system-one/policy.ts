import {
	type NoulBand,
	type NoulBandThresholds,
	type NoulDirection,
	noulBand,
	settledFromBand,
} from "../decision/noul.ts";
import { DEFAULT_SYSTEM_ONE_CONFIG, type SystemOneConfig, type SystemOneThresholds } from "./config.ts";
import type { CompletionGate, ExecutionState, ToolImpact } from "./types.ts";

/** Re-exported so the System One layer keeps one name for the band, defined in `decision/noul.ts`. */
export type NoulEvaluation = NoulBand;

export interface ChoiceEvaluation {
	choice: string;
	confidence: number;
	margin: number;
	accepted: boolean;
	reasons?: string[];
}

export interface CompletionRejectionDetail {
	id: string;
	reason: string;
	required_next_proof: string;
}

export interface FinalCompletionVerdict {
	verdict: "complete" | "verify_more" | "retrieve_more" | "rework" | "blocked_external";
	failed_gates: CompletionRejectionDetail[];
}

/**
 * Evaluate a Noul probability against calibrated thresholds.
 * R-038: For Noul, policy MUST distinguish probability of yes from certainty; a value near 0 can be a highly certain no.
 */
export function noulFromAnswer(answer: unknown, fallback: boolean): number | boolean {
	if (typeof answer === "boolean" || typeof answer === "number") return answer;
	if (answer && typeof answer === "object") {
		const record = answer as { noul?: unknown; boolean?: unknown; value?: unknown };
		if (typeof record.noul === "number" && Number.isFinite(record.noul)) return record.noul;
		if (typeof record.boolean === "boolean") return record.boolean;
		if (typeof record.value === "boolean") return record.value;
		if (typeof record.value === "number" && Number.isFinite(record.value)) return record.value;
	}
	return fallback;
}

/** The operator's configured numbers, in the shape the band arithmetic takes. */
export function noulBandThresholds(
	thresholds: SystemOneThresholds = DEFAULT_SYSTEM_ONE_CONFIG.thresholds,
): NoulBandThresholds {
	return {
		requiredTrue: {
			hardPass: thresholds.noul_required_true.hard_pass,
			softPass: thresholds.noul_required_true.soft_pass,
			hardFail: thresholds.noul_required_true.hard_fail,
		},
		requiredFalse: {
			hardPassMax: thresholds.noul_required_false.hard_pass_max,
			softPassMax: thresholds.noul_required_false.soft_pass_max,
			hardFailMin: thresholds.noul_required_false.hard_fail_min,
		},
	};
}

export function evaluateNoul(
	p: number | boolean,
	direction: NoulDirection,
	thresholds: SystemOneThresholds = DEFAULT_SYSTEM_ONE_CONFIG.thresholds,
): NoulEvaluation {
	// A literal boolean is P=1 or P=0 and lands in a decisive band either way.
	const probability = typeof p === "boolean" ? (p ? 1 : 0) : p;
	return noulBand(probability as number, direction, noulBandThresholds(thresholds));
}

/**
 * The yes/no a noul answer settles on, or undefined when it settles nothing.
 * The one sanctioned way to get a boolean out of a probability: there is no 0.5 cutoff anywhere.
 */
export function settledNoul(
	answer: unknown,
	direction: NoulDirection,
	fallback: boolean,
	thresholds: SystemOneThresholds = DEFAULT_SYSTEM_ONE_CONFIG.thresholds,
): boolean | undefined {
	return settledFromBand(evaluateNoul(noulFromAnswer(answer, fallback), direction, thresholds), direction);
}

/**
 * The answer settles on a yes in the required direction.
 *
 * A soft pass counts: it is provisional, and the doctrine lets the current step continue on it. An
 * ambiguous answer does not, because it decided nothing. This is the ordinary gate; use
 * `noulHoldsDecisively` for the two things a provisional answer may not do -- close a goal, or
 * authorize a destructive or outward-facing action.
 */
export function noulHolds(
	answer: unknown,
	direction: NoulDirection,
	thresholds: SystemOneThresholds = DEFAULT_SYSTEM_ONE_CONFIG.thresholds,
): boolean {
	return settledNoul(answer, direction, false, thresholds) === true;
}

/** Only a `hard_pass`. A soft pass is provisional and an ambiguous answer decided nothing. */
export function noulHoldsDecisively(
	answer: unknown,
	direction: NoulDirection,
	thresholds: SystemOneThresholds = DEFAULT_SYSTEM_ONE_CONFIG.thresholds,
): boolean {
	return evaluateNoul(noulFromAnswer(answer, false), direction, thresholds) === "hard_pass";
}

/**
 * Evaluate a Choice answer against confidence and top-two margin.
 * R-039: For hard Choice gates, policy MUST inspect returned confidence and SHOULD inspect top-two probability margin.
 */
export function evaluateChoice(
	answer: { choice: string; confidence: number; probabilities: Record<string, number> },
	mode: "normal" | "hard" = "normal",
	thresholds: SystemOneThresholds = DEFAULT_SYSTEM_ONE_CONFIG.thresholds,
): ChoiceEvaluation {
	const minConfidence =
		mode === "hard" ? thresholds.choice.hard_gate_auto_confidence : thresholds.choice.normal_auto_confidence;
	const minMargin =
		mode === "hard" ? thresholds.choice.min_top2_margin_hard : thresholds.choice.min_top2_margin_normal;

	const sortedProbs = Object.entries(answer.probabilities ?? {})
		.map(([_, prob]) => prob)
		.sort((a, b) => b - a);

	const topProb = sortedProbs[0] ?? answer.confidence ?? 0;
	const secondProb = sortedProbs[1] ?? 0;
	const margin = topProb - secondProb;

	const reasons: string[] = [];
	if (answer.confidence < minConfidence) {
		reasons.push(`Confidence ${answer.confidence.toFixed(2)} is below required ${minConfidence.toFixed(2)}`);
	}
	if (sortedProbs.length > 1 && margin < minMargin) {
		reasons.push(`Top-two probability margin ${margin.toFixed(2)} is below minimum ${minMargin.toFixed(2)}`);
	}

	return {
		choice: answer.choice,
		confidence: answer.confidence,
		margin,
		accepted: reasons.length === 0,
		reasons: reasons.length > 0 ? reasons : undefined,
	};
}

/**
 * Preflight policy routing.
 * Evaluates step relevance, evidence sufficiency, assumptions, and route.
 */
export function decidePreflight(
	answers: Record<string, unknown>,
	config: SystemOneConfig = DEFAULT_SYSTEM_ONE_CONFIG,
): "allow" | "retrieve" | "replan" | "test" | "block" | "escalate" {
	// step_relevant (noul: required_true)
	const stepRelevantAns = noulFromAnswer(answers.step_relevant, false);
	const stepRelevant = evaluateNoul(stepRelevantAns, "required_true", config.thresholds);
	if (stepRelevant === "hard_fail") return "replan";

	// unsupported_assumption_present (noul: required_false)
	const assumptionAns = noulFromAnswer(answers.unsupported_assumption_present, true);
	const assumptionEval = evaluateNoul(assumptionAns, "required_false", config.thresholds);
	if (assumptionEval === "hard_fail") return "retrieve";

	// evidence_sufficient_to_act (noul: required_true)
	const evidenceAns = noulFromAnswer(answers.evidence_sufficient_to_act, false);
	const evidenceEval = evaluateNoul(evidenceAns, "required_true", config.thresholds);
	if (evidenceEval === "hard_fail" || evidenceEval === "ambiguous") return "retrieve";

	// route choice
	const routeAns = answers.route as
		| { choice: string; confidence: number; probabilities: Record<string, number> }
		| undefined;
	if (routeAns) {
		const evalRoute = evaluateChoice(routeAns, "normal", config.thresholds);
		if (evalRoute.accepted) {
			switch (evalRoute.choice) {
				case "inspect":
				case "retrieve":
					return "retrieve";
				case "test":
					return "test";
				case "replan":
					return "replan";
				case "blocked":
					return "block";
				case "edit":
				case "reason":
					return "allow";
			}
		}
	}

	return "allow";
}

/**
 * Tool gate policy routing.
 * R-034: Tool authorization MUST be decided by deterministic capability, ownership, path, environment.
 * Evaluates tool_call_relevant, tool_call_semantic_scope_risk, repo_text_injection_like.
 */
export interface ToolGateDecisionOptions {
	/**
	 * Whether the projection carried a `current_step` for the relevance question to compare against.
	 * Without one (a plain session with no objective) the relevance answer is not evidence of anything.
	 */
	relevanceEvaluable?: boolean;
}

export function decideToolGate(
	answers: Record<string, unknown>,
	impact: ToolImpact,
	config: SystemOneConfig = DEFAULT_SYSTEM_ONE_CONFIG,
	options: ToolGateDecisionOptions = {},
): "allow" | "confirm" | "block" | "replan" {
	// Check prompt injection first
	const injectionAns = noulFromAnswer(answers.repo_text_injection_like, false);
	const injectionEval = evaluateNoul(injectionAns, "required_false", config.thresholds);
	if (injectionEval === "hard_fail") {
		// Injection-like text detected
		return "block";
	}

	// Tool relevance, only when there was a step to be relevant to.
	if (options.relevanceEvaluable !== false) {
		const relevantAns = noulFromAnswer(answers.tool_call_relevant, false);
		const relevantEval = evaluateNoul(relevantAns, "required_true", config.thresholds);
		if (relevantEval === "hard_fail") {
			return "replan";
		}
	}

	// Semantic scope risk score (0 to 3)
	const scopeRiskAns = answers.tool_call_semantic_scope_risk as { score?: number; confidence?: number } | undefined;
	const score = scopeRiskAns?.score ?? 0;
	if (score >= 3) {
		// Potentially destructive or far outside requested scope
		return impact === "destructive" || impact === "external_side_effect" ? "block" : "confirm";
	}
	if (score >= 2 && (impact === "repo_mutation" || impact === "external_side_effect")) {
		return "confirm";
	}

	return "allow";
}

/**
 * Postflight policy routing.
 * Evaluates action_accomplished_step, conclusions_supported, scope_violation, next_status.
 */
export function decidePostflight(
	answers: Record<string, unknown>,
	config: SystemOneConfig = DEFAULT_SYSTEM_ONE_CONFIG,
): "continue" | "verify" | "retrieve_more" | "replan" | "rollback" | "completion_candidate" | "blocked" {
	// Check scope violation
	const scopeViolAns = noulFromAnswer(answers.scope_violation, false);
	if (evaluateNoul(scopeViolAns, "required_false", config.thresholds) === "hard_fail") {
		return "rollback";
	}

	// Check replan required
	const replanAns = noulFromAnswer(answers.replan_required, false);
	if (evaluateNoul(replanAns, "required_false", config.thresholds) === "hard_fail") {
		return "replan";
	}

	// Check conclusions supported
	const conclAns = noulFromAnswer(answers.conclusions_supported, true);
	if (evaluateNoul(conclAns, "required_true", config.thresholds) === "hard_fail") {
		return "retrieve_more";
	}

	// Choice next_status
	const nextStatusAns = answers.next_status as
		| { choice: string; confidence: number; probabilities: Record<string, number> }
		| undefined;
	if (nextStatusAns) {
		const evalChoice = evaluateChoice(nextStatusAns, "normal", config.thresholds);
		if (evalChoice.accepted) {
			const validStatuses = [
				"continue",
				"verify",
				"retrieve_more",
				"replan",
				"rollback",
				"completion_candidate",
				"blocked",
			] as const;
			if (validStatuses.includes(evalChoice.choice as any)) {
				return evalChoice.choice as any;
			}
		}
	}

	return "continue";
}

/**
 * Deterministic completion gates evaluation.
 * R-020: Deterministic checks MUST run before semantic checks whenever code can answer the question exactly.
 * R-035: A deterministic failure (compile/test/path/auth) MUST NOT be overridden by a favorable Jev answer.
 * R-050: Every required acceptance criterion MUST be satisfied or explicitly waived.
 * R-051: Every hard constraint MUST be verified or explicitly waived.
 * R-052: Compile/build status MUST be recorded when the project offers a build path.
 * R-054: No completion-critical claim may remain unverified, partially supported, contradicted, or stale.
 * R-055: No high or critical risk may remain open.
 */
export function evaluateDeterministicCompletionGates(state: ExecutionState): {
	passed: boolean;
	gates: CompletionGate[];
	failedReasons: CompletionRejectionDetail[];
} {
	const gates: CompletionGate[] = [];
	const failedReasons: CompletionRejectionDetail[] = [];

	// Gate: G-OBJ: a live objective's required acceptance criteria are satisfied or waived.
	// Empty criteria on a real objective, or completion with no objective, must not pass.
	const liveObjective = state.objective.request.trim().length > 0 || state.objective.normalized_goal.trim().length > 0;
	const unsatisfiedACs = state.objective.acceptance_criteria.filter(
		(ac) => ac.required && ac.status !== "satisfied" && ac.status !== "waived",
	);
	if (!liveObjective) {
		gates.push({
			id: "G-OBJ",
			kind: "deterministic",
			required: true,
			status: "failed",
			details: "No live objective",
		});
		failedReasons.push({
			id: "G-OBJ",
			reason: "No live objective is bound; completion cannot run against an empty store.",
			required_next_proof: "Bind the current objective requirements before requesting completion.",
		});
	} else if (state.objective.acceptance_criteria.length === 0) {
		gates.push({
			id: "G-OBJ",
			kind: "deterministic",
			required: true,
			status: "failed",
			details: "Live objective has no acceptance criteria",
		});
		failedReasons.push({
			id: "G-OBJ",
			reason: "Live objective has no acceptance criteria; empty criteria must not make completion easier.",
			required_next_proof: "Record required acceptance criteria and evidence before completion.",
		});
	} else if (unsatisfiedACs.length > 0) {
		gates.push({
			id: "G-OBJ",
			kind: "deterministic",
			required: true,
			status: "failed",
			details: `Unsatisfied acceptance criteria: ${unsatisfiedACs.map((a) => a.id).join(", ")}`,
		});
		failedReasons.push({
			id: "G-OBJ",
			reason: `Acceptance criteria ${unsatisfiedACs.map((a) => a.id).join(", ")} not satisfied or waived.`,
			required_next_proof: "Run verification proving all required acceptance criteria or obtain waiver.",
		});
	} else {
		gates.push({ id: "G-OBJ", kind: "deterministic", required: true, status: "passed" });
	}

	// Gate: G-CONSTRAINTS: Hard constraints verified
	const unverifiedConstraints = state.objective.constraints.filter((c) => c.severity === "hard" && !c.verified);
	if (unverifiedConstraints.length > 0) {
		gates.push({
			id: "G-CONSTRAINTS",
			kind: "deterministic",
			required: true,
			status: "failed",
			details: `Unverified hard constraints: ${unverifiedConstraints.map((c) => c.id).join(", ")}`,
		});
		failedReasons.push({
			id: "G-CONSTRAINTS",
			reason: `Hard constraints ${unverifiedConstraints.map((c) => c.id).join(", ")} not verified.`,
			required_next_proof: "Verify hard constraints before completion.",
		});
	} else {
		gates.push({ id: "G-CONSTRAINTS", kind: "deterministic", required: true, status: "passed" });
	}

	// Gate: G-TEST: Tests must pass when present
	const testRuns = state.verification.filter((v) => v.kind === "unit_test" || v.kind === "integration_test");
	const failedTests = testRuns.filter((v) => v.status === "failed");
	if (failedTests.length > 0) {
		gates.push({
			id: "G-TEST",
			kind: "deterministic",
			required: true,
			status: "failed",
			details: `Failed test runs: ${failedTests.map((t) => t.id).join(", ")}`,
		});
		failedReasons.push({
			id: "G-TEST",
			reason: `Tests failed: ${failedTests.map((t) => t.id).join(", ")}.`,
			required_next_proof: "Fix failing tests before completion.",
		});
	} else {
		gates.push({ id: "G-TEST", kind: "deterministic", required: true, status: "passed" });
	}

	// Gate: G-BUILD: Build must pass if a build run exists
	const buildRuns = state.verification.filter((v) => v.kind === "compile");
	const failedBuilds = buildRuns.filter((v) => v.status === "failed");
	if (failedBuilds.length > 0) {
		gates.push({
			id: "G-BUILD",
			kind: "deterministic",
			required: true,
			status: "failed",
			details: `Failed build runs: ${failedBuilds.map((b) => b.id).join(", ")}`,
		});
		failedReasons.push({
			id: "G-BUILD",
			reason: "Build/compile failed.",
			required_next_proof: "Fix compilation errors before completion.",
		});
	} else {
		gates.push({ id: "G-BUILD", kind: "deterministic", required: true, status: "passed" });
	}

	// Gate: G-VERIFY: unresolved non-test/non-build verification (open obligations) cannot complete.
	const openVerify = state.verification.filter(
		(v) => v.status === "failed" && v.kind !== "unit_test" && v.kind !== "integration_test" && v.kind !== "compile",
	);
	if (openVerify.length > 0) {
		gates.push({
			id: "G-VERIFY",
			kind: "deterministic",
			required: true,
			status: "failed",
			details: `Unresolved verification: ${openVerify.map((v) => v.id).join(", ")}`,
		});
		failedReasons.push({
			id: "G-VERIFY",
			reason: `Required verification is missing or failing: ${openVerify.map((v) => v.id).join(", ")}.`,
			required_next_proof: "Resolve open verification obligations before completion.",
		});
	} else {
		gates.push({ id: "G-VERIFY", kind: "deterministic", required: true, status: "passed" });
	}

	// Gate: G-EVIDENCE: Completion-critical claims must have fresh supporting evidence (R-054)
	const invalidClaims = state.claims.filter(
		(c) => c.materiality === "completion_critical" && c.status !== "supported",
	);
	if (invalidClaims.length > 0) {
		gates.push({
			id: "G-EVIDENCE",
			kind: "evidence",
			required: true,
			status: "failed",
			details: `Unverified completion-critical claims: ${invalidClaims.map((c) => c.id).join(", ")}`,
		});
		failedReasons.push({
			id: "G-EVIDENCE",
			reason: `Completion-critical claim(s) [${invalidClaims.map((c) => c.id).join(", ")}] have status '${invalidClaims.map((c) => c.status).join(", ")}'.`,
			required_next_proof: "Obtain fresh supporting evidence or retire unsupported claims.",
		});
	} else {
		gates.push({ id: "G-EVIDENCE", kind: "evidence", required: true, status: "passed" });
	}

	// Gate: G-RISK: No open high or critical risks (R-055)
	const openHighRisks = state.risks.filter(
		(r) => (r.severity === "high" || r.severity === "critical") && r.status === "open",
	);
	if (openHighRisks.length > 0) {
		gates.push({
			id: "G-RISK",
			kind: "deterministic",
			required: true,
			status: "failed",
			details: `Open high/critical risks: ${openHighRisks.map((r) => r.id).join(", ")}`,
		});
		failedReasons.push({
			id: "G-RISK",
			reason: `Open high/critical risks remain: ${openHighRisks.map((r) => r.id).join(", ")}.`,
			required_next_proof: "Mitigate or close high/critical risks before completion.",
		});
	} else {
		gates.push({ id: "G-RISK", kind: "deterministic", required: true, status: "passed" });
	}

	const allPassed = gates.every((g) => g.status === "passed" || g.status === "waived");
	return { passed: allPassed, gates, failedReasons };
}

/**
 * Two-stage completion decision engine.
 * R-057: Bug-fix completion MUST pass root_cause_addressed and MUST NOT pass if masks_symptom_only is strongly true.
 * R-058: A second completion_challenge pack MUST run after the primary completion pack.
 * R-059: Any failed hard completion gate routes to verify_more, retrieve_more, rework, or blocked_external; it never degrades to success.
 */
export function decideFinalCompletion(input: {
	deterministicGates: CompletionGate[];
	primaryAnswers: Record<string, unknown>;
	challengeAnswers: Record<string, unknown>;
	isBugFix: boolean;
	config?: SystemOneConfig;
}): FinalCompletionVerdict {
	const config = input.config ?? DEFAULT_SYSTEM_ONE_CONFIG;
	const failedGates: CompletionRejectionDetail[] = [];

	// 1. Check deterministic gates first (R-020, R-035)
	for (const gate of input.deterministicGates) {
		if (gate.required && gate.status !== "passed" && gate.status !== "waived") {
			failedGates.push({
				id: gate.id,
				reason: gate.details ?? `Deterministic gate ${gate.id} failed`,
				required_next_proof: "Resolve deterministic failure before proceeding.",
			});
		}
	}
	if (failedGates.length > 0) {
		return { verdict: "rework", failed_gates: failedGates };
	}

	// 2. Primary completion pack checks
	const { primaryAnswers } = input;

	// implementation_matches_goal (required_true, hard pass)
	const goalMatchAns = noulFromAnswer(primaryAnswers.implementation_matches_goal, false);
	if (evaluateNoul(goalMatchAns, "required_true", config.thresholds) !== "hard_pass") {
		failedGates.push({
			id: "JEV-implementation_matches_goal",
			reason: "Implementation does not sufficiently match the normalized goal and acceptance criteria.",
			required_next_proof: "Align changes with required goal outcomes.",
		});
	}

	// root_cause_addressed for bug fixes (R-015, R-057)
	if (input.isBugFix) {
		const rootCauseAns = noulFromAnswer(primaryAnswers.root_cause_addressed, false);
		if (evaluateNoul(rootCauseAns, "required_true", config.thresholds) !== "hard_pass") {
			failedGates.push({
				id: "JEV-root_cause_addressed",
				reason: "For bug fix, the evidenced causal mechanism was not addressed.",
				required_next_proof: "Address the causal mechanism rather than symptoms.",
			});
		}
	}

	// required_behavior_unverified (required_false)
	const unverifiedAns = noulFromAnswer(primaryAnswers.required_behavior_unverified, true);
	if (evaluateNoul(unverifiedAns, "required_false", config.thresholds) !== "hard_pass") {
		failedGates.push({
			id: "JEV-required_behavior_unverified",
			reason: "Some required behavior remains unverified by fresh evidence.",
			required_next_proof: "Add verification evidence for required behavior.",
		});
	}

	// material_claim_unsupported (required_false)
	const unsuppClaimAns = noulFromAnswer(primaryAnswers.material_claim_unsupported, true);
	if (evaluateNoul(unsuppClaimAns, "required_false", config.thresholds) !== "hard_pass") {
		failedGates.push({
			id: "JEV-material_claim_unsupported",
			reason: "Material claims remain unsupported or based on stale evidence.",
			required_next_proof: "Validate material claims with fresh evidence.",
		});
	}

	// out_of_scope_change_present (required_false)
	const outOfScopeAns = noulFromAnswer(primaryAnswers.out_of_scope_change_present, true);
	if (evaluateNoul(outOfScopeAns, "required_false", config.thresholds) !== "hard_pass") {
		failedGates.push({
			id: "JEV-out_of_scope_change_present",
			reason: "Diff contains changes outside the task's allowed semantic scope.",
			required_next_proof: "Revert or document reasons for out-of-scope changes.",
		});
	}

	// duplicate_responsibility_introduced (required_false)
	const dupRespAns = noulFromAnswer(primaryAnswers.duplicate_responsibility_introduced, true);
	if (evaluateNoul(dupRespAns, "required_false", config.thresholds) !== "hard_pass") {
		failedGates.push({
			id: "JEV-duplicate_responsibility_introduced",
			reason: "Diff introduces duplicate logic for a responsibility with an existing owner.",
			required_next_proof: "Reuse or extract existing owner logic.",
		});
	}

	// completion_verdict (choice: complete with hard confidence and margin)
	const verdictAns = primaryAnswers.completion_verdict as
		| {
				choice: string;
				confidence: number;
				probabilities: Record<string, number>;
		  }
		| undefined;
	if (verdictAns) {
		const evalVerdict = evaluateChoice(verdictAns, "hard", config.thresholds);
		if (!evalVerdict.accepted || evalVerdict.choice !== "complete") {
			failedGates.push({
				id: "JEV-completion_verdict",
				reason: `Completion verdict chose '${evalVerdict.choice}' (confidence ${evalVerdict.confidence.toFixed(2)})`,
				required_next_proof: "Address outstanding completion issues before re-submitting.",
			});
		}
	} else {
		failedGates.push({
			id: "JEV-completion_verdict",
			reason: "Missing completion_verdict answer.",
			required_next_proof: "Provide completion_verdict evaluation.",
		});
	}

	// 3. Challenge pack checks (R-058)
	const { challengeAnswers } = input;

	// missing_requirement (required_false)
	const missingReqAns = noulFromAnswer(challengeAnswers.missing_requirement, true);
	if (evaluateNoul(missingReqAns, "required_false", config.thresholds) !== "hard_pass") {
		failedGates.push({
			id: "JEV-CHALLENGE-missing_requirement",
			reason: "Challenge evaluation found a missing acceptance requirement or constraint.",
			required_next_proof: "Satisfy all required acceptance criteria.",
		});
	}

	// hidden_assumption (required_false)
	const hiddenAssumpAns = noulFromAnswer(challengeAnswers.hidden_assumption, true);
	if (evaluateNoul(hiddenAssumpAns, "required_false", config.thresholds) !== "hard_pass") {
		failedGates.push({
			id: "JEV-CHALLENGE-hidden_assumption",
			reason: "Challenge evaluation found completion depends on an unverified hidden assumption.",
			required_next_proof: "Ground assumptions with concrete observations.",
		});
	}

	// plausible_regression_not_tested (required_false)
	const regressionAns = noulFromAnswer(challengeAnswers.plausible_regression_not_tested, true);
	if (evaluateNoul(regressionAns, "required_false", config.thresholds) !== "hard_pass") {
		failedGates.push({
			id: "JEV-CHALLENGE-plausible_regression_not_tested",
			reason: "Challenge evaluation found untested plausible regression paths in the diff.",
			required_next_proof: "Add regression test coverage for affected paths.",
		});
	}

	// conclusion_overstates_evidence (required_false)
	const overstatesAns = noulFromAnswer(challengeAnswers.conclusion_overstates_evidence, true);
	if (evaluateNoul(overstatesAns, "required_false", config.thresholds) !== "hard_pass") {
		failedGates.push({
			id: "JEV-CHALLENGE-conclusion_overstates_evidence",
			reason: "Conclusion claims more than the evidence package proves.",
			required_next_proof: "Bound claims to verified evidence.",
		});
	}

	if (failedGates.length === 0) {
		return { verdict: "complete", failed_gates: [] };
	}

	// Categorize the failure for routing (R-059)
	const hasUnverified = failedGates.some((g) => g.id.includes("unverified") || g.id.includes("regression"));
	const hasMissingEvidence = failedGates.some((g) => g.id.includes("evidence") || g.id.includes("assumption"));

	if (hasUnverified) {
		return { verdict: "verify_more", failed_gates: failedGates };
	}
	if (hasMissingEvidence) {
		return { verdict: "retrieve_more", failed_gates: failedGates };
	}

	return { verdict: "rework", failed_gates: failedGates };
}
