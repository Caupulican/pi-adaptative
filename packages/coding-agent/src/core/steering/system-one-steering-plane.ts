/**
 * System One Steering Plane.
 * Root semantic control plane backed by TypeSafe Decision Kernel.
 * Implements S1A-001..S1A-010, S1A-161, S1A-176, PH-001..PH-012.
 */

import { randomUUID } from "node:crypto";
import type { SemanticDecisionEngine } from "../decision/engine.ts";
import type { DecisionEngineRouter } from "../decision/engine-router.ts";
import { TypeSafeSystemOneDecisionEngine } from "../decision/engines/typesafe-system-one-engine.ts";
import type { DecisionEvaluation } from "../decision/evaluation.ts";
import { isForbiddenRequiredProvenance } from "../decision/policy.ts";
import type { DecisionProgram } from "../decision/program.ts";
import type { JevAdapter } from "../system-one/adapter.ts";
import { type AuthorityKind, authorityForCheckpoint, decideByAuthority } from "../system-one/authority-line.ts";
import { evaluateChoice, evaluateNoul, noulFromAnswer } from "../system-one/policy.ts";
import { type SemanticEvaluationObserver, verdictFromCertificate } from "../system-one/semantic-evaluation-ledger.ts";
import { canonicalDigest } from "./canonical.ts";
import { SteeringCertificateStore } from "./certificate-store.ts";
import {
	CONSEQUENCE_THRESHOLDS,
	computePolicyDigest,
	DEFAULT_STEERING_POLICY,
	PINNED_JEV_MODEL,
	STEERING_POLICY_ID,
	type SteeringPolicyConfig,
} from "./policy.ts";
import { compileDecisionProgramForCheckpoint } from "./programs.ts";
import {
	type SteeringCertificate,
	type SteeringCheckpointRequest,
	type SteeringDirective,
	SteeringProtocolError,
	type SteeringResult,
	SteeringSemanticFailedError,
	type SteeringSemanticOutcome,
} from "./types.ts";

export function isCertificateSemanticallyPassed(cert: SteeringCertificate): boolean {
	return (
		cert.semantic_outcome === "pass" &&
		(!cert.failed_semantic_predicates || cert.failed_semantic_predicates.length === 0)
	);
}

export class SystemOneSteeringUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SystemOneSteeringUnavailableError";
	}
}

/**
 * The engine gave no judgment for a checkpoint. Carries what the judgment would have decided, so the
 * caller applies the authority line: reversible work proceeds with the outage visible, an objective
 * transition holds, an irreversible operation goes to the operator.
 */
export class SteeringJudgmentUnavailableError extends SystemOneSteeringUnavailableError {
	readonly checkpointId: string;
	readonly authority: AuthorityKind;

	constructor(checkpointId: string, authority: AuthorityKind, cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = "SteeringJudgmentUnavailableError";
		this.checkpointId = checkpointId;
		this.authority = authority;
	}
}

export interface SystemOneSteeringPlaneDeps {
	readonly decisionEngine?: SemanticDecisionEngine;
	readonly router?: DecisionEngineRouter;
	readonly adapter?: JevAdapter;
	readonly certificates?: SteeringCertificateStore;
	readonly policy?: SteeringPolicyConfig;
	readonly persistentPath?: string;
}

export class SystemOneSteeringPlane {
	private evaluationObserver?: SemanticEvaluationObserver;
	readonly certificates: SteeringCertificateStore;
	readonly policy: SteeringPolicyConfig;
	readonly decisionEngine?: SemanticDecisionEngine;
	readonly router?: DecisionEngineRouter;
	private readonly adapter?: JevAdapter;
	/**
	 * Predicates whose band came back ambiguous during the current `evaluateSemanticOutcome` call.
	 * Scoped to that one synchronous call, which resets it on entry and drains it before returning;
	 * it is never read across calls.
	 */
	private openDoubts: string[] = [];
	/** Evidence passes already requested per (objective, task, checkpoint, evidence revision). */
	private readonly gatherCounts = new Map<string, number>();

	constructor(deps: SystemOneSteeringPlaneDeps = {}) {
		this.certificates = deps.certificates ?? new SteeringCertificateStore(deps.persistentPath);
		this.policy = deps.policy ?? DEFAULT_STEERING_POLICY;
		this.adapter = deps.adapter;
		this.router = deps.router;

		if (deps.decisionEngine) {
			this.decisionEngine = deps.decisionEngine;
		} else if (deps.adapter) {
			const model = this.policy.model.id || PINNED_JEV_MODEL;
			this.decisionEngine = new TypeSafeSystemOneDecisionEngine(deps.adapter, model);
		}
	}

	computeDigest(data: unknown): string {
		return canonicalDigest(data);
	}

	/**
	 * Derives a SteeringDirective from the evaluated question pack and answers.
	 * Checks checkpoint pass predicates and rejects missing answers.
	 */
	private composeDirective(
		checkpointId: string,
		answers: Record<string, unknown>,
		_program: DecisionProgram,
	): SteeringDirective {
		const reasonCodes: string[] = [];

		if (checkpointId === "JEV-004") {
			const completionAns = answers.completion_plausible as { noul?: number } | undefined;
			const gapAns = answers.capability_gap_suspected as { noul?: number } | undefined;
			const missingWorkAns = answers.missing_work_class as { choice?: string } | undefined;

			if (completionAns?.noul == null || gapAns?.noul == null || !missingWorkAns?.choice) {
				throw new SteeringProtocolError(
					`Checkpoint ${checkpointId} missing required answers for directive composition`,
					checkpointId,
					answers,
				);
			}

			const completionPlausible = completionAns.noul;
			const gapSuspected = gapAns.noul;
			const missingWork = missingWorkAns.choice;

			if (completionPlausible >= 0.8) {
				return { action: "completion_candidate", reasonCodes: ["completion_plausible"] };
			}
			if (gapSuspected >= 0.7 || missingWork === "resolve_capability") {
				return { action: "resolve_capability", reasonCodes: ["capability_gap_suspected"] };
			}
			if (missingWork === "investigate") {
				return { action: "investigate", reasonCodes: ["investigation_needed"] };
			}
			if (missingWork === "replan") {
				return { action: "replan", reasonCodes: ["replan_needed"] };
			}
			if (missingWork === "deterministic_verify") {
				return { action: "deterministic_verify", reasonCodes: ["verify_needed"] };
			}
			if (missingWork === "independent_review") {
				return { action: "independent_review", reasonCodes: ["independent_review_needed"] };
			}
			return { action: "implement", reasonCodes: ["work_remaining"] };
		}

		if (checkpointId === "JEV-007" || checkpointId === "JEV-008") {
			const needsCapAns = answers.needs_capability as { noul?: number } | undefined;
			const gapRemainsAns = answers.gap_remains as { noul?: number } | undefined;

			if (checkpointId === "JEV-007" && needsCapAns?.noul == null) {
				throw new SteeringProtocolError("Checkpoint JEV-007 missing needs_capability answer", checkpointId);
			}
			if (checkpointId === "JEV-008" && gapRemainsAns?.noul == null) {
				throw new SteeringProtocolError("Checkpoint JEV-008 missing gap_remains answer", checkpointId);
			}

			const needsCap = needsCapAns?.noul ?? 0;
			const gapRemains = gapRemainsAns?.noul ?? 0;

			if (needsCap >= 0.6 || gapRemains >= 0.6) {
				return { action: "synthesize_capability", reasonCodes: ["capability_gap_proven"] };
			}
			return { action: "continue_current_work", reasonCodes: ["existing_capability_adequate"] };
		}

		if (checkpointId === "JEV-010") {
			const adaptationAns = answers.adaptation_class as { choice?: string } | undefined;
			if (!adaptationAns?.choice) {
				throw new SteeringProtocolError("Checkpoint JEV-010 missing adaptation_class answer", checkpointId);
			}
			const adaptationClass = adaptationAns.choice;
			return {
				action: "synthesize_capability",
				reasonCodes: [`adaptation_level_${adaptationClass}`],
				metadata: { adaptationClass },
			};
		}

		if (checkpointId === "JEV-013" || checkpointId === "JEV-014") {
			const fulfilledAns = answers.spec_fulfilled as { noul?: number } | undefined;
			if (checkpointId === "JEV-013" && fulfilledAns?.noul == null) {
				throw new SteeringProtocolError("Checkpoint JEV-013 missing spec_fulfilled answer", checkpointId);
			}
			const fulfilled = fulfilledAns?.noul ?? 0;
			if (fulfilled >= 0.7) {
				return { action: "activate_capability", reasonCodes: ["pre_activation_verified"] };
			}
			return { action: "repair_capability", reasonCodes: ["spec_not_fulfilled"] };
		}

		if (checkpointId === "JEV-024") {
			const completionAns = answers.completion_plausible as { noul?: number } | undefined;
			if (completionAns?.noul == null) {
				throw new SteeringProtocolError("Checkpoint JEV-024 missing completion_plausible answer", checkpointId);
			}
			if (completionAns.noul >= 0.75) {
				return { action: "completion_candidate", reasonCodes: ["completion_plausible"] };
			}
			return { action: "continue_current_work", reasonCodes: ["work_remaining"] };
		}

		if (checkpointId === "JEV-040") {
			const lowestAns = answers.lowest_adequate_adaptation as { choice?: string } | undefined;
			if (!lowestAns?.choice) {
				throw new SteeringProtocolError(
					"Checkpoint JEV-040 missing lowest_adequate_adaptation answer",
					checkpointId,
				);
			}
			const lowest = lowestAns.choice;
			if (lowest === "expert_reroute") {
				return { action: "reroute_expert", reasonCodes: ["expert_reroute_selected"] };
			}
			if (lowest === "specialist") {
				return {
					action: "resolve_capability",
					reasonCodes: ["specialist_synthesis_selected"],
					metadata: { dimension: "specialist" },
				};
			}
			if (lowest === "capability") {
				return {
					action: "resolve_capability",
					reasonCodes: ["capability_synthesis_selected"],
					metadata: { dimension: "capability" },
				};
			}
			if (lowest === "runtime") {
				return {
					action: "synthesize_capability",
					reasonCodes: ["runtime_patch_selected"],
					metadata: { dimension: "runtime" },
				};
			}
			return { action: "replan", reasonCodes: ["strategy_adaptation_selected"] };
		}

		if (checkpointId === "JEV-041" || checkpointId === "JEV-042") {
			const dispositionAns = answers.recommended_disposition as { choice?: string } | undefined;
			if (checkpointId === "JEV-042" && !dispositionAns?.choice) {
				throw new SteeringProtocolError("Checkpoint JEV-042 missing recommended_disposition answer", checkpointId);
			}
			const disposition = dispositionAns?.choice ?? "unique";
			if (disposition === "insufficient_evidence") {
				return { action: "retrieve_more", reasonCodes: ["insufficient_evidence"] };
			}
			return {
				action: "continue_current_work",
				reasonCodes: [`disposition_${disposition}`],
				metadata: { disposition },
			};
		}

		if (checkpointId === "JEV-WORKER-SUPERVISION") {
			// Each of these asks whether a problem is present, so the required end is "no". A decisive
			// yes -- the hard_fail band -- is what moves a worker. A coin flip used to be enough, which
			// rerouted healthy workers on ignorance; an undecided signal now leaves the work alone and
			// is carried as a doubt instead.
			const risk = (answer: unknown): boolean =>
				evaluateNoul(noulFromAnswer(answer, false), "required_false") === "hard_fail";

			if (risk(answers.specialist_gap_present)) {
				return {
					action: "reroute_expert",
					reasonCodes: ["specialist_gap_detected"],
					metadata: { dimension: "specialist" },
				};
			}
			if (risk(answers.capability_gap_present)) {
				return {
					action: "resolve_capability",
					reasonCodes: ["capability_gap_detected"],
					metadata: { dimension: "capability" },
				};
			}
			if (risk(answers.needs_independent_verification)) {
				return {
					action: "independent_review",
					reasonCodes: ["independent_verification_needed"],
				};
			}
			// meaningful_progress asks the opposite way round: a decisive NO is the adverse answer.
			const noProgress =
				evaluateNoul(noulFromAnswer(answers.meaningful_progress, true), "required_true") === "hard_fail";
			const reasons: string[] = [];
			if (risk(answers.work_off_track)) reasons.push("worker_off_track");
			if (risk(answers.worker_stuck)) reasons.push("worker_stuck");
			if (risk(answers.strategy_repetition)) reasons.push("strategy_repetition");
			if (noProgress) reasons.push("meaningful_progress_insufficient");
			if (reasons.length > 0) {
				return { action: "replan", reasonCodes: reasons };
			}
			return {
				action: "continue_current_work",
				reasonCodes: ["worker_progressing_normally"],
			};
		}

		return { action: "continue_current_work", reasonCodes };
	}

	private hardPass(answer: unknown, direction: "required_true" | "required_false"): boolean {
		const fallback = direction !== "required_true";
		return evaluateNoul(noulFromAnswer(answer, fallback), direction) === "hard_pass";
	}

	private hardComplete(answer: unknown): boolean {
		if (!answer || typeof answer !== "object") return false;
		const record = answer as {
			choice?: unknown;
			selected?: unknown;
			confidence?: unknown;
			probabilities?: unknown;
			distribution?: unknown;
		};
		const choice =
			typeof record.choice === "string"
				? record.choice
				: typeof record.selected === "string"
					? record.selected
					: undefined;
		const probabilities = (record.probabilities ?? record.distribution) as Record<string, number> | undefined;
		if (!choice || typeof record.confidence !== "number" || !probabilities) return false;
		const verdict = evaluateChoice({ choice, confidence: record.confidence, probabilities }, "hard");
		return verdict.accepted && verdict.choice === "complete";
	}

	/**
	 * Does this answer carry a yes?
	 *
	 * With no `threshold` the calibrated band decides: `hard_pass` and `soft_pass` are a yes,
	 * `hard_fail` is a no, and an `ambiguous` answer is neither -- it is recorded as a doubt and
	 * reported as a no here, so the checkpoint does not proceed on it. A doubt is not a failure:
	 * `evaluateSemanticOutcome` turns a checkpoint whose only problem is doubt into `gather_more`,
	 * which looks again rather than rejecting the work.
	 *
	 * A `threshold` is a deliberate per-checkpoint calibration (JEV-004's 0.75, JEV-013's 0.7) and
	 * reads the probability directly, as the doctrine requires. There is no 0.5 default: a coin flip
	 * is ignorance, and it used to pass here.
	 */
	private isTruthy(ans: unknown, threshold?: number, predicate?: string): boolean {
		if (ans == null) return false;
		if (typeof threshold === "number") {
			const probability = noulFromAnswer(ans, false);
			return typeof probability === "number" ? probability >= threshold : probability === true;
		}
		if (typeof ans === "object") {
			const band = evaluateNoul(noulFromAnswer(ans, false), "required_true");
			if (band === "ambiguous") {
				if (predicate) this.openDoubts.push(predicate);
				return false;
			}
			return band !== "hard_fail";
		}
		return Boolean(ans);
	}

	private getScoreValue(ans: unknown): number {
		if (ans == null) return 0;
		if (typeof ans === "object") {
			const obj = ans as Record<string, unknown>;
			if (typeof obj.value === "number") return obj.value;
			if (typeof obj.score === "number") return obj.score;
		}
		return typeof ans === "number" ? ans : 0;
	}

	private getChoiceValue(ans: unknown): string | undefined {
		if (ans == null) return undefined;
		if (typeof ans === "object") {
			const obj = ans as Record<string, unknown>;
			if (typeof obj.choice === "string") return obj.choice;
			if (typeof obj.selected === "string") return obj.selected;
		}
		return typeof ans === "string" ? ans : undefined;
	}

	/**
	 * Evaluates checkpoint-specific semantic pass/fail predicates according to CHECKPOINT_PASS_SEMANTICS.md.
	 * High-confidence FALSE is a confident FAIL, not a PASS (FC-060, FC-061).
	 */
	evaluateSemanticOutcome(
		checkpointId: string,
		answers: Record<string, unknown>,
		directive: SteeringDirective,
		state?: unknown,
	): {
		semantic_outcome: SteeringSemanticOutcome;
		failed_semantic_predicates: readonly string[];
		/** Predicates the model could not settle. Not failures: reasons to look again. */
		unsure_semantic_predicates: readonly string[];
	} {
		const failed: string[] = [];
		this.openDoubts = [];
		let outcome: SteeringSemanticOutcome = "pass";

		switch (checkpointId) {
			case "JEV-001": {
				if (!this.isTruthy(answers.objective_coherent, undefined, "objective_coherent")) {
					failed.push("objective_coherent");
				}
				if (this.getScoreValue(answers.ambiguity_severity) > 1) {
					failed.push("ambiguity_severity_acceptable");
				}
				if (this.isTruthy(answers.missing_information, undefined, "missing_information")) {
					failed.push("no_missing_information");
				}
				if (failed.length > 0) {
					outcome = this.isTruthy(answers.missing_information, undefined, "missing_information")
						? "gather_more"
						: "fail";
				}
				break;
			}

			case "JEV-002": {
				if (!this.isTruthy(answers.acceptance_complete, undefined, "acceptance_complete")) {
					failed.push("acceptance_complete");
					outcome = "gather_more";
				}
				break;
			}

			case "JEV-003": {
				if (
					answers.grounding_sufficient !== undefined &&
					!this.isTruthy(answers.grounding_sufficient, undefined, "grounding_sufficient")
				) {
					failed.push("grounding_sufficient");
					outcome = "gather_more";
				}
				break;
			}

			case "JEV-004": {
				if (directive.action === "completion_candidate") {
					if (!this.isTruthy(answers.completion_plausible, 0.75, "completion_plausible")) {
						failed.push("completion_plausible");
						outcome = "fail";
					}
				}
				break;
			}

			case "JEV-005": {
				if (this.getScoreValue(answers.semantic_progress) <= 0) {
					failed.push("semantic_progress_positive");
					outcome = "replan";
				}
				break;
			}

			case "JEV-006": {
				if (this.isTruthy(answers.strategy_repetition, undefined, "strategy_repetition")) {
					failed.push("no_strategy_repetition");
					outcome = "replan";
				}
				break;
			}

			case "JEV-009": {
				if (!this.isTruthy(answers.gap_confirmed, undefined, "gap_confirmed")) {
					failed.push("gap_confirmed");
				}
				if (!this.isTruthy(answers.adaptation_needed, undefined, "adaptation_needed")) {
					failed.push("adaptation_needed");
				}
				if (failed.length > 0) outcome = "fail";
				break;
			}

			case "JEV-010": {
				if (!this.isTruthy(answers.risk_acceptable, undefined, "risk_acceptable")) {
					failed.push("risk_acceptable");
					outcome = "block";
				}
				break;
			}

			case "JEV-011": {
				if (!this.isTruthy(answers.spec_complete, undefined, "spec_complete")) failed.push("spec_complete");
				if (!this.isTruthy(answers.interface_sound, undefined, "interface_sound")) failed.push("interface_sound");
				if (!this.isTruthy(answers.side_effects_bounded, undefined, "side_effects_bounded"))
					failed.push("side_effects_bounded");
				if (!this.isTruthy(answers.test_strategy_viable, undefined, "test_strategy_viable"))
					failed.push("test_strategy_viable");
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-012": {
				if (!this.isTruthy(answers.plan_viable, undefined, "plan_viable")) failed.push("plan_viable");
				if (!this.isTruthy(answers.architecture_fit, undefined, "architecture_fit"))
					failed.push("architecture_fit");
				if (!this.isTruthy(answers.builder_profile_sound, undefined, "builder_profile_sound"))
					failed.push("builder_profile_sound");
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-013": {
				if (!this.isTruthy(answers.spec_fulfilled, 0.7, "spec_fulfilled")) failed.push("spec_fulfilled");
				if (!this.isTruthy(answers.tests_valid, undefined, "tests_valid")) failed.push("tests_valid");
				if (!this.isTruthy(answers.safety_satisfied, undefined, "safety_satisfied"))
					failed.push("safety_satisfied");
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-014": {
				if (!this.isTruthy(answers.scope_bounded, undefined, "scope_bounded")) failed.push("scope_bounded");
				if (!this.isTruthy(answers.rollback_safe, undefined, "rollback_safe")) failed.push("rollback_safe");
				if (!this.isTruthy(answers.invariants_preserved, undefined, "invariants_preserved"))
					failed.push("invariants_preserved");
				if (failed.length > 0) outcome = "block";
				break;
			}

			case "JEV-015": {
				if (!this.isTruthy(answers.activation_succeeded, undefined, "activation_succeeded"))
					failed.push("activation_succeeded");
				if (!this.isTruthy(answers.runtime_healthy, undefined, "runtime_healthy")) failed.push("runtime_healthy");
				if (!this.isTruthy(answers.capability_available, undefined, "capability_available"))
					failed.push("capability_available");
				if (failed.length > 0) outcome = "fail";
				break;
			}

			case "JEV-016": {
				if (!this.isTruthy(answers.task_proof_passed, undefined, "task_proof_passed"))
					failed.push("task_proof_passed");
				if (!this.isTruthy(answers.regression_absent, undefined, "regression_absent"))
					failed.push("regression_absent");
				if (!this.isTruthy(answers.commit_approved, undefined, "commit_approved")) failed.push("commit_approved");
				if (failed.length > 0) outcome = "fail";
				break;
			}

			case "JEV-017": {
				if (!this.isTruthy(answers.claim_supported, undefined, "claim_supported")) failed.push("claim_supported");
				if (!this.isTruthy(answers.evidence_sufficient, undefined, "evidence_sufficient"))
					failed.push("evidence_sufficient");
				if (failed.length > 0) outcome = "fail";
				break;
			}

			case "JEV-018": {
				if (!this.isTruthy(answers.patch_matches_requirements, undefined, "patch_matches_requirements"))
					failed.push("patch_matches_requirements");
				if (!this.isTruthy(answers.side_effects_acceptable, undefined, "side_effects_acceptable"))
					failed.push("side_effects_acceptable");
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-019": {
				if (!this.isTruthy(answers.bug_reproduced, undefined, "bug_reproduced")) failed.push("bug_reproduced");
				if (!this.isTruthy(answers.fix_verified, undefined, "fix_verified")) failed.push("fix_verified");
				if (!this.isTruthy(answers.causal_link_proven, undefined, "causal_link_proven"))
					failed.push("causal_link_proven");
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-020": {
				if (!this.isTruthy(answers.boundaries_respected, undefined, "boundaries_respected"))
					failed.push("boundaries_respected");
				if (!this.isTruthy(answers.invariants_held, undefined, "invariants_held")) failed.push("invariants_held");
				if (failed.length > 0) outcome = "block";
				break;
			}

			case "JEV-021": {
				if (!this.isTruthy(answers.test_coverage_sufficient, undefined, "test_coverage_sufficient"))
					failed.push("test_coverage_sufficient");
				if (
					answers.negative_tests_present !== undefined &&
					!this.isTruthy(answers.negative_tests_present, undefined, "negative_tests_present")
				) {
					failed.push("negative_tests_present");
				}
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-022": {
				if (!this.isTruthy(answers.checks_relevant, undefined, "checks_relevant")) failed.push("checks_relevant");
				if (!this.isTruthy(answers.criteria_covered, undefined, "criteria_covered"))
					failed.push("criteria_covered");
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-023": {
				if (!this.isTruthy(answers.repairs_sufficient, undefined, "repairs_sufficient"))
					failed.push("repairs_sufficient");
				if (!this.isTruthy(answers.root_cause_addressed, undefined, "root_cause_addressed"))
					failed.push("root_cause_addressed");
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-024": {
				if (!this.isTruthy(answers.completion_plausible, 0.75, "completion_plausible")) {
					failed.push("completion_plausible");
					outcome = "fail";
				}
				break;
			}

			case "JEV-025": {
				const record = state && typeof state === "object" ? (state as Record<string, unknown>) : {};
				const bugFix = record.bugFix === true || record.isBugFix === true;
				if (!this.hardPass(answers.implementation_matches_goal, "required_true"))
					failed.push("implementation_matches_goal");
				if (bugFix && !this.hardPass(answers.root_cause_addressed, "required_true"))
					failed.push("root_cause_addressed");
				if (!this.hardPass(answers.required_behavior_unverified, "required_false"))
					failed.push("required_behavior_unverified");
				if (!this.hardPass(answers.material_claim_unsupported, "required_false"))
					failed.push("material_claim_unsupported");
				if (!this.hardPass(answers.out_of_scope_change_present, "required_false"))
					failed.push("out_of_scope_change_present");
				if (!this.hardPass(answers.duplicate_responsibility_introduced, "required_false"))
					failed.push("duplicate_responsibility_introduced");
				if (!this.hardComplete(answers.completion_verdict)) failed.push("completion_verdict");
				if (
					answers.acceptance_satisfied !== undefined &&
					!this.hardPass(answers.acceptance_satisfied, "required_true")
				) {
					failed.push("acceptance_satisfied");
				}
				if (
					answers.requirements_complete !== undefined &&
					!this.hardPass(answers.requirements_complete, "required_true")
				) {
					failed.push("requirements_complete");
				}
				if (
					answers.verification_conclusive !== undefined &&
					!this.hardPass(answers.verification_conclusive, "required_true")
				) {
					failed.push("verification_conclusive");
				}
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-026": {
				if (!this.hardPass(answers.missing_requirement, "required_false")) failed.push("missing_requirement");
				if (!this.hardPass(answers.hidden_assumption, "required_false")) failed.push("hidden_assumption");
				if (!this.hardPass(answers.plausible_regression_not_tested, "required_false"))
					failed.push("plausible_regression_not_tested");
				if (!this.hardPass(answers.conclusion_overstates_evidence, "required_false"))
					failed.push("conclusion_overstates_evidence");
				if (
					answers.unhandled_edge_cases !== undefined &&
					!this.hardPass(answers.unhandled_edge_cases, "required_false")
				)
					failed.push("no_unhandled_edge_cases");
				if (
					answers.hidden_regressions !== undefined &&
					!this.hardPass(answers.hidden_regressions, "required_false")
				)
					failed.push("no_hidden_regressions");
				if (
					answers.assumption_violations !== undefined &&
					!this.hardPass(answers.assumption_violations, "required_false")
				) {
					failed.push("no_assumption_violations");
				}
				if (
					answers.adversarial_approved !== undefined &&
					!this.hardPass(answers.adversarial_approved, "required_true")
				) {
					failed.push("adversarial_approved");
				}
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-027": {
				if (!this.isTruthy(answers.delivery_bundle_truthful, undefined, "delivery_bundle_truthful"))
					failed.push("delivery_bundle_truthful");
				if (!this.isTruthy(answers.artifacts_verified, undefined, "artifacts_verified"))
					failed.push("artifacts_verified");
				if (!this.isTruthy(answers.limitations_disclosed, undefined, "limitations_disclosed"))
					failed.push("limitations_disclosed");
				if (failed.length > 0) outcome = "fail";
				break;
			}

			case "JEV-028": {
				if (!this.isTruthy(answers.release_ready, undefined, "release_ready")) failed.push("release_ready");
				if (!this.isTruthy(answers.package_healthy, undefined, "package_healthy")) failed.push("package_healthy");
				if (!this.isTruthy(answers.deploy_safe, undefined, "deploy_safe")) failed.push("deploy_safe");
				if (failed.length > 0) outcome = "block";
				break;
			}

			case "JEV-031": {
				if (!this.isTruthy(answers.specialist_needed, undefined, "specialist_needed"))
					failed.push("specialist_needed");
				if (failed.length > 0) outcome = "fail";
				break;
			}

			case "JEV-033": {
				if (!this.isTruthy(answers.spec_complete, undefined, "spec_complete")) failed.push("spec_complete");
				if (!this.isTruthy(answers.role_bounded, undefined, "role_bounded")) failed.push("role_bounded");
				if (!this.isTruthy(answers.tools_skills_sufficient, undefined, "tools_skills_sufficient"))
					failed.push("tools_skills_sufficient");
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-034": {
				if (!this.isTruthy(answers.dependencies_resolved, undefined, "dependencies_resolved"))
					failed.push("dependencies_resolved");
				if (!this.isTruthy(answers.capabilities_ready, undefined, "capabilities_ready"))
					failed.push("capabilities_ready");
				if (!this.isTruthy(answers.tools_available, undefined, "tools_available")) failed.push("tools_available");
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-035": {
				if (!this.isTruthy(answers.contract_sound, undefined, "contract_sound")) failed.push("contract_sound");
				if (!this.isTruthy(answers.authority_bounded, undefined, "authority_bounded"))
					failed.push("authority_bounded");
				if (!this.isTruthy(answers.within_charter, undefined, "within_charter")) failed.push("within_charter");
				if (failed.length > 0) outcome = "block";
				break;
			}

			case "JEV-036": {
				if (!this.isTruthy(answers.mission_fulfilled, undefined, "mission_fulfilled"))
					failed.push("mission_fulfilled");
				if (!this.isTruthy(answers.proof_satisfied, undefined, "proof_satisfied")) failed.push("proof_satisfied");
				if (failed.length > 0) outcome = "fail";
				break;
			}

			case "JEV-041": {
				if (!this.isTruthy(answers.unique_responsibility, undefined, "unique_responsibility"))
					failed.push("unique_responsibility");
				if (this.isTruthy(answers.competing_existing_detected, undefined, "competing_existing_detected"))
					failed.push("no_competing_existing_detected");
				if (failed.length > 0) outcome = "fail";
				break;
			}

			case "JEV-042": {
				const disp = this.getChoiceValue(answers.recommended_disposition);
				if (!disp || disp === "insufficient_evidence") {
					failed.push("valid_disposition");
					outcome = "gather_more";
				}
				break;
			}

			case "JEV-043": {
				if (
					answers.mutations_conform_to_disposition !== undefined &&
					!this.isTruthy(answers.mutations_conform_to_disposition, undefined, "mutations_conform_to_disposition")
				) {
					failed.push("mutations_conform_to_disposition");
				}
				if (
					answers.no_unauthorized_duplication !== undefined &&
					!this.isTruthy(answers.no_unauthorized_duplication, undefined, "no_unauthorized_duplication")
				) {
					failed.push("no_unauthorized_duplication");
				}
				if (
					this.isTruthy(
						answers.duplicate_responsibility_introduced,
						undefined,
						"duplicate_responsibility_introduced",
					)
				) {
					failed.push("no_duplicate_responsibility_introduced");
				}
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-044": {
				if (!this.isTruthy(answers.no_hidden_duplicates, undefined, "no_hidden_duplicates"))
					failed.push("no_hidden_duplicates");
				if (!this.isTruthy(answers.single_semantic_owner, undefined, "single_semantic_owner"))
					failed.push("single_semantic_owner");
				if (failed.length > 0) outcome = "fail";
				break;
			}

			case "JEV-045": {
				if (!this.isTruthy(answers.waiver_valid, undefined, "waiver_valid")) failed.push("waiver_valid");
				if (!this.isTruthy(answers.architectural_rationale_sound, undefined, "architectural_rationale_sound"))
					failed.push("architectural_rationale_sound");
				if (failed.length > 0) outcome = "block";
				break;
			}

			case "JEV-WORKER-SUPERVISION": {
				// Valid adverse answers (stuck/off-track/gap) are judgments, not protocol failures.
				break;
			}

			default: {
				if (answers.approved !== undefined && !this.isTruthy(answers.approved, undefined, "approved")) {
					failed.push("approved");
					outcome = "fail";
				}
				break;
			}
		}

		if (failed.length > 0 && outcome === "pass") {
			outcome = "fail";
		}

		// A predicate that only came back unsure is a doubt, not a rejection. Every failed predicate
		// here is also a doubt (isTruthy reports ambiguous as a no), so a doubt on its own -- nothing
		// decisively wrong, something undecided -- routes to gather_more: look again, do not reject.
		const unsure = [...new Set(this.openDoubts)];
		this.openDoubts = [];
		const onlyDoubt = unsure.filter((predicate) => !failed.includes(predicate));
		if (outcome === "fail" && failed.every((predicate) => unsure.includes(predicate))) {
			outcome = "gather_more";
		} else if (outcome === "pass" && onlyDoubt.length > 0) {
			outcome = "gather_more";
		}

		return {
			semantic_outcome: outcome,
			failed_semantic_predicates: failed,
			unsure_semantic_predicates: unsure,
		};
	}

	async evaluate(
		requestOrCheckpointId: SteeringCheckpointRequest | string,
		state?: unknown,
		options: {
			objectiveId?: string;
			taskId?: string;
			workUnitId?: string;
			evidenceRevision?: number;
			consequence?: "low" | "medium" | "high" | "critical";
			parentCertificateIds?: readonly string[];
			signal?: AbortSignal;
		} = {},
	): Promise<SteeringResult> {
		const request: SteeringCheckpointRequest =
			typeof requestOrCheckpointId === "string"
				? {
						checkpointId: requestOrCheckpointId,
						state,
						objectiveId: options.objectiveId,
						taskId: options.taskId,
						workUnitId: options.workUnitId,
						evidenceRevision: options.evidenceRevision,
						consequence: options.consequence,
						parentCertificateIds: options.parentCertificateIds,
						signal: options.signal,
					}
				: requestOrCheckpointId;
		const stateDigest = canonicalDigest(request.state);
		const program = compileDecisionProgramForCheckpoint(request.checkpointId, request.state);
		const programDigest = canonicalDigest(program);
		const policyDigest = computePolicyDigest(this.policy);

		const model = this.policy.model.id || PINNED_JEV_MODEL;
		const provider = this.policy.model.provider || "typesafe";
		const consequence = request.consequence ?? "medium";

		const objectiveId =
			request.objectiveId ?? (request.taskId ? `obj-${request.taskId}` : `obj-${request.checkpointId}`);
		const evidenceRevision = request.evidenceRevision ?? 1;

		// Check if a fresh certificate already exists in cache with full key binding
		const existing = this.certificates.findCurrent({
			objectiveId,
			checkpointId: request.checkpointId,
			stateDigest,
			evidenceRevision,
			policyDigest,
			programDigest,
			provider,
			model,
		});
		if (existing) {
			const directive = this.composeDirective(request.checkpointId, existing.answers, program);
			return { certificate: existing, directive };
		}

		// A cache hit above records nothing: no evaluation ran. From here on one did, and the one
		// recorder learns its start, its verdict and its failure or cancellation.
		const evaluationId = this.evaluationObserver?.start({ programId: program.id, consequence });
		try {
			return await this.evaluateFresh(request, program, evaluationId, {
				stateDigest,
				programDigest,
				policyDigest,
				model,
				provider,
				consequence,
				objectiveId,
				evidenceRevision,
			});
		} catch (error) {
			if (evaluationId !== undefined) {
				if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
					this.evaluationObserver?.settleCancelled(evaluationId);
				} else {
					this.evaluationObserver?.settleFailed(evaluationId, error);
				}
			}
			throw error;
		}
	}

	/** Binds the session's one evaluation sink; late-bound because the plane is built before the session. */
	setEvaluationObserver(observer: SemanticEvaluationObserver | undefined): void {
		this.evaluationObserver = observer;
	}

	private async evaluateFresh(
		request: SteeringCheckpointRequest,
		program: DecisionProgram,
		evaluationId: string | undefined,
		bound: {
			stateDigest: string;
			programDigest: string;
			policyDigest: string;
			model: string;
			provider: string;
			consequence: "low" | "medium" | "high" | "critical";
			objectiveId: string;
			evidenceRevision: number;
		},
	): Promise<SteeringResult> {
		const { stateDigest, programDigest, policyDigest, model, provider, consequence, objectiveId, evidenceRevision } =
			bound;
		const thresholds = CONSEQUENCE_THRESHOLDS[consequence];
		let evaluation: DecisionEvaluation;

		if (this.router) {
			try {
				evaluation = await this.router.evaluateOrFallback(program, request.state, { consequence });
			} catch (err) {
				if (this.policy.mode === "system_one_required") {
					throw new SystemOneSteeringUnavailableError(
						`Decision router unavailable for mandatory checkpoint ${request.checkpointId}: ${String(err)}`,
					);
				}
				throw err;
			}
		} else if (this.decisionEngine) {
			try {
				evaluation = await this.decisionEngine.evaluate(program, request.state, {
					consequence,
					...(request.signal ? { signal: request.signal } : {}),
				});
			} catch (err) {
				if (this.policy.mode === "system_one_required") {
					throw new SystemOneSteeringUnavailableError(
						`System One steering engine unavailable for mandatory checkpoint ${request.checkpointId}: ${String(err)}`,
					);
				}
				throw err;
			}
		} else {
			if (this.policy.mode === "system_one_required") {
				throw new SystemOneSteeringUnavailableError(
					`Decision engine missing for mandatory checkpoint ${request.checkpointId} in system_one_required mode.`,
				);
			}
			throw new SystemOneSteeringUnavailableError(
				`No decision engine configured for checkpoint ${request.checkpointId}.`,
			);
		}

		if (this.policy.mode === "system_one_required") {
			const provenance = evaluation.engine.confidence_provenance;
			if (isForbiddenRequiredProvenance(provenance)) {
				throw new SystemOneSteeringUnavailableError(
					`Required checkpoint ${request.checkpointId} cannot be satisfied by ${provenance} provenance (engine ${evaluation.engine.id}).`,
				);
			}
		}

		if (!evaluation?.results || Object.keys(evaluation.results).length === 0) {
			throw new SteeringProtocolError(
				`Empty evaluation response from decision engine for checkpoint ${request.checkpointId}`,
				request.checkpointId,
			);
		}

		// Map normalized results to answers
		const answers: Record<string, unknown> = {};
		if (
			(evaluation as unknown as Record<string, unknown>).rawAnswers &&
			typeof (evaluation as unknown as Record<string, unknown>).rawAnswers === "object"
		) {
			Object.assign(answers, (evaluation as unknown as Record<string, unknown>).rawAnswers);
		}
		// Confidence belongs to Choice, Score and Set answers only. A Noul has none (TypeSafe docs): its
		// probability is the certainty, and its band already says whether it settled anything.
		const confidences: number[] = [];
		const lowConfidence: string[] = [];

		for (const d of program.decisions) {
			const result = evaluation.results[d.id];
			if (!result) {
				throw new SteeringProtocolError(
					`Missing required decision result for '${d.id}' in checkpoint ${request.checkpointId}`,
					request.checkpointId,
				);
			}

			if (result.kind === "boolean") {
				answers[d.id] = {
					type: "noul",
					noul: result.probabilityTrue,
					direction: result.direction,
					band: result.band,
					confidence: result.confidence.value,
				};
			} else if (result.kind === "choice") {
				answers[d.id] = {
					type: "choice",
					choice: result.selected,
					distribution: result.distribution,
					probabilities: result.distribution,
					margin: result.margin,
					confidence: result.confidence.value,
				};
			} else if (result.kind === "score") {
				answers[d.id] = {
					type: "score",
					score: result.value,
					value: result.value,
					distribution: result.distribution,
					probabilities: result.distribution,
					confidence: result.confidence.value,
				};
			} else if (result.kind === "set") {
				answers[d.id] = {
					type: "set",
					selected: result.selected,
					memberships: result.memberships,
					confidence: result.confidence.value,
				};
			}
			if (result.kind === "choice" || result.kind === "score" || result.kind === "set") {
				confidences.push(result.confidence.value);
				if (result.confidence.value < thresholds.minimumConfidence) lowConfidence.push(d.id);
			}
		}

		// A low-confidence answer is a doubt about that decision, routed like an ambiguous band. It never
		// throws: an exception here used to end the whole objective run.
		const actionConfidence = confidences.length > 0 ? Math.min(...confidences) : 1;

		const directive = this.composeDirective(request.checkpointId, answers, program);
		const judged = this.evaluateSemanticOutcome(request.checkpointId, answers, directive, request.state);
		const failed_semantic_predicates = judged.failed_semantic_predicates;
		const unsure_semantic_predicates = [
			...judged.unsure_semantic_predicates,
			...lowConfidence.filter((id) => !judged.unsure_semantic_predicates.includes(id)),
		];
		const semantic_outcome =
			judged.semantic_outcome === "pass" && lowConfidence.length > 0 ? "gather_more" : judged.semantic_outcome;

		const certificate: SteeringCertificate = {
			schema_version: "1.0",
			certificate_id: `SCERT-${request.checkpointId}-${Date.now()}-${randomUUID().slice(0, 8)}`,
			objective_id: objectiveId,
			task_id: request.taskId ?? null,
			work_unit_id: request.workUnitId ?? null,
			checkpoint_id: request.checkpointId,
			state_digest: stateDigest,
			evidence_revision: evidenceRevision,
			policy: {
				id: STEERING_POLICY_ID,
				version: this.policy.version,
				digest: policyDigest,
			},
			question_pack: {
				id: program.id,
				version: program.version,
				digest: programDigest,
			},
			engine: {
				provider,
				model,
			},
			answers,
			directive: directive.action,
			action_confidence: actionConfidence,
			policy_result: semantic_outcome === "pass" ? "accepted" : "rejected",
			semantic_outcome,
			failed_semantic_predicates,
			unsure_semantic_predicates,
			parent_certificate_ids: request.parentCertificateIds ? [...request.parentCertificateIds] : undefined,
			usage: evaluation.audit as Record<string, unknown> | undefined,
			created_at: new Date().toISOString(),
		};

		// PH-021, PH-022: Atomic fail-closed persistence
		await this.certificates.persist(certificate);

		if (evaluationId !== undefined) {
			const { verdict, reasons } = verdictFromCertificate(certificate);
			this.evaluationObserver?.settleOk(evaluationId, verdict, reasons);
		}
		return { certificate, directive };
	}

	/**
	 * Convenience helper: require a certificate or evaluate fresh.
	 */
	async requireCertificate(
		checkpointId: string,
		state: unknown,
		options: {
			objectiveId?: string;
			taskId?: string;
			workUnitId?: string;
			evidenceRevision?: number;
			consequence?: "low" | "medium" | "high" | "critical";
			parentCertificateIds?: readonly string[];
			signal?: AbortSignal;
			requirePass?: boolean;
		} = {},
	): Promise<SteeringCertificate> {
		if (options.signal?.aborted) {
			throw new Error(`Steering evaluation aborted for ${checkpointId}`);
		}

		const objectiveId = options.objectiveId ?? "obj_default";
		const evidenceRevision = options.evidenceRevision ?? 1;

		const authority = authorityForCheckpoint(checkpointId);
		let result: SteeringResult;
		try {
			result = await this.evaluate({
				checkpointId,
				objectiveId,
				taskId: options.taskId,
				workUnitId: options.workUnitId,
				state,
				evidenceRevision,
				consequence: options.consequence,
				parentCertificateIds: options.parentCertificateIds,
				// The abort reaches the engine: an aborted checkpoint settles as cancelled, not failed.
				signal: options.signal,
			});
		} catch (error) {
			if (error instanceof SystemOneSteeringUnavailableError && !(error instanceof SteeringJudgmentUnavailableError))
				throw new SteeringJudgmentUnavailableError(checkpointId, authority, error);
			throw error;
		}

		// An ambiguous judgment asks for evidence at most GATHER_MORE_LIMIT times on the same evidence
		// revision. After that, reversible work proceeds with the doubt on the certificate; an objective
		// transition keeps failing closed (it never closes on a doubt).
		if (result.certificate.semantic_outcome === "gather_more") {
			const key = `${objectiveId}\u0000${options.taskId ?? ""}\u0000${checkpointId}\u0000${evidenceRevision}`;
			const gatherCount = this.gatherCounts.get(key) ?? 0;
			this.gatherCounts.set(key, gatherCount + 1);
			if (decideByAuthority(authority, "ambiguous", gatherCount).action === "proceed_with_doubt") {
				return result.certificate;
			}
		}

		const requirePass = options.requirePass ?? true;
		if (requirePass && result.certificate.semantic_outcome !== "pass") {
			throw new SteeringSemanticFailedError(
				checkpointId,
				result.certificate.semantic_outcome ?? "fail",
				result.certificate.failed_semantic_predicates ?? [],
			);
		}

		return result.certificate;
	}
}
