/**
 * System One Steering Plane.
 * Root semantic control plane backed by TypeSafe Decision Kernel.
 * Implements S1A-001..S1A-010, S1A-161, S1A-176, PH-001..PH-012.
 */

import { randomUUID } from "node:crypto";
import type { AccountingOrigin } from "../cost/accounting-evidence.ts";
import type { SemanticDecisionEngine, SemanticEvaluationOccupancy } from "../decision/engine.ts";
import type { DecisionEngineRouter } from "../decision/engine-router.ts";
import { TypeSafeSystemOneDecisionEngine } from "../decision/engines/typesafe-system-one-engine.ts";
import type { DecisionEvaluation } from "../decision/evaluation.ts";
import { type NoulBandThresholds, noulProbability, readNoul } from "../decision/noul.ts";
import { isForbiddenRequiredProvenance } from "../decision/policy.ts";
import type { Consequence } from "../decision/primitives.ts";
import { createDecisionProgram, type DecisionProgram } from "../decision/program.ts";
import { CONSEQUENCE_MIN_CONFIDENCE, choiceProbability, STEERING_CUTS } from "../decision/thresholds.ts";
import type { JevAdapter } from "../system-one/adapter.ts";
import { type AuthorityKind, authorityForCheckpoint, decideByAuthority } from "../system-one/authority-line.ts";
import type { SystemOneThresholds } from "../system-one/config.ts";
import { completionPackFailures, isAdverseAnswer, noulBandThresholds } from "../system-one/policy.ts";
import {
	type SemanticDecisionTrace,
	type SemanticEvaluationObserver,
	type SemanticTraceGate,
	semanticWorkerTaskScope,
	traceJudgmentsFromEvaluation,
	verdictFromCertificate,
} from "../system-one/semantic-evaluation-ledger.ts";
import { canonicalDigest } from "./canonical.ts";
import { SteeringCertificateStore } from "./certificate-store.ts";
import {
	computePolicyDigest,
	DEFAULT_STEERING_POLICY,
	PINNED_JEV_MODEL,
	STEERING_POLICY_ID,
	type SteeringPolicyConfig,
} from "./policy.ts";
import { compileDecisionProgramForCheckpoint, readAdaptationTier, readObjectiveWorkClass } from "./programs.ts";
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
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SystemOneSteeringUnavailableError";
	}
}

/**
 * The error a failed engine or router call surfaces as. In every steering mode a call that returned no
 * judgment is an outage, so callers apply the authority line to it instead of meeting an unclassified
 * error; the original failure stays the cause. A cancellation stays a cancellation.
 */
function engineCallFailure(
	err: unknown,
	signal: AbortSignal | undefined,
	checkpointId: string,
	source: string,
	required: boolean,
): unknown {
	if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) return err;
	if (err instanceof SystemOneSteeringUnavailableError) return err;
	return new SystemOneSteeringUnavailableError(
		`${source} unavailable for ${required ? "mandatory " : ""}checkpoint ${checkpointId}: ${String(err)}`,
		{ cause: err },
	);
}

/**
 * The engine gave no judgment for a checkpoint. Carries what the judgment would have decided, so the
 * caller applies the authority line: reversible work proceeds with the outage visible, an objective
 * transition holds.
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
	/** The System One config's yes/no bands: the plane's own band reads and the engine it builds use them. */
	readonly thresholds?: SystemOneThresholds;
	/** The session's accounting origin, taken when a checkpoint asks, so its spend is the turn that asked. */
	readonly captureOrigin?: () => AccountingOrigin;
}

/** Recent certificates whose trace a consumer may still extend; older ones keep the plane's trace only. */
const CERTIFICATE_TRACE_LIMIT = 64;

/** A completion gate id (`JEV-outcomes_achieved`, `JEV-CHALLENGE-hidden_assumption`) as its predicate name. */
function completionPredicate(gateId: string): string {
	return gateId.replace(/^JEV-(?:CHALLENGE-)?/u, "");
}

export class SystemOneSteeringPlane {
	private evaluationObserver?: SemanticEvaluationObserver;
	readonly certificates: SteeringCertificateStore;
	readonly policy: SteeringPolicyConfig;
	readonly decisionEngine?: SemanticDecisionEngine;
	readonly router?: DecisionEngineRouter;
	private readonly adapter?: JevAdapter;
	private readonly bands: NoulBandThresholds;
	private readonly captureOrigin?: () => AccountingOrigin;
	/**
	 * Predicates whose band came back ambiguous during the current `evaluateSemanticOutcome` call.
	 * Scoped to that one synchronous call, which resets it on entry and drains it before returning;
	 * it is never read across calls.
	 */
	private openDoubts: string[] = [];
	/** Evidence passes already requested per (objective, task, checkpoint, evidence revision). */
	private readonly gatherCounts = new Map<string, number>();
	/** The trace each recent certificate's evaluation carries, so the decision's owner can add its own gates. */
	private readonly certificateTraces = new Map<string, { evaluationId: string; trace: SemanticDecisionTrace }>();

	constructor(deps: SystemOneSteeringPlaneDeps = {}) {
		this.certificates = deps.certificates ?? new SteeringCertificateStore(deps.persistentPath);
		this.policy = deps.policy ?? DEFAULT_STEERING_POLICY;
		this.adapter = deps.adapter;
		this.router = deps.router;
		this.bands = noulBandThresholds(deps.thresholds);
		this.captureOrigin = deps.captureOrigin;

		if (deps.decisionEngine) {
			this.decisionEngine = deps.decisionEngine;
		} else if (deps.adapter) {
			const model = this.policy.model.id || PINNED_JEV_MODEL;
			this.decisionEngine = new TypeSafeSystemOneDecisionEngine(deps.adapter, model, this.bands);
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
			const completionPlausible = noulProbability(answers.completion_plausible);
			const gapSuspected = noulProbability(answers.capability_gap_suspected);
			const workClass = readObjectiveWorkClass(answers.missing_work_class);

			if (completionPlausible === undefined || gapSuspected === undefined || !workClass?.chosen) {
				throw new SteeringProtocolError(
					`Checkpoint ${checkpointId} missing required answers for directive composition`,
					checkpointId,
					answers,
				);
			}

			if (completionPlausible >= STEERING_CUTS.routeCompletionPlausible) {
				return { action: "completion_candidate", reasonCodes: ["completion_plausible"] };
			}
			if (gapSuspected >= STEERING_CUTS.routeCapabilityGap) {
				return { action: "resolve_capability", reasonCodes: ["capability_gap_suspected"] };
			}
			// The work class is acted on only at its risk's floor; an unsure one gathers evidence, as the route does.
			if (workClass.reading !== "act") {
				return { action: "retrieve_more", reasonCodes: ["insufficient_evidence"] };
			}
			const missingWork = workClass.workClass;
			if (missingWork === "resolve_capability") {
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
			const needsCap = noulProbability(answers.needs_capability);
			const gapRemains = noulProbability(answers.gap_remains);

			if (checkpointId === "JEV-007" && needsCap === undefined) {
				throw new SteeringProtocolError("Checkpoint JEV-007 missing needs_capability answer", checkpointId);
			}
			if (checkpointId === "JEV-008" && gapRemains === undefined) {
				throw new SteeringProtocolError("Checkpoint JEV-008 missing gap_remains answer", checkpointId);
			}

			// Each checkpoint asks only its own question; the other is not asked and proves nothing.
			if ([needsCap, gapRemains].some((p) => p !== undefined && p >= STEERING_CUTS.capabilityNeed)) {
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

		// JEV-014 asks scope and rollback questions, not spec_fulfilled: its outcome is its verdict.
		if (checkpointId === "JEV-013") {
			const fulfilled = noulProbability(answers.spec_fulfilled);
			if (fulfilled === undefined) {
				throw new SteeringProtocolError("Checkpoint JEV-013 missing spec_fulfilled answer", checkpointId);
			}
			if (fulfilled >= STEERING_CUTS.specFulfilled) {
				return { action: "activate_capability", reasonCodes: ["pre_activation_verified"] };
			}
			return { action: "repair_capability", reasonCodes: ["spec_not_fulfilled"] };
		}

		if (checkpointId === "JEV-024") {
			const completionPlausible = noulProbability(answers.completion_plausible);
			if (completionPlausible === undefined) {
				throw new SteeringProtocolError("Checkpoint JEV-024 missing completion_plausible answer", checkpointId);
			}
			if (completionPlausible >= STEERING_CUTS.transitionDirective) {
				return { action: "completion_candidate", reasonCodes: ["completion_plausible"] };
			}
			return { action: "continue_current_work", reasonCodes: ["work_remaining"] };
		}

		if (checkpointId === "JEV-040") {
			const adaptation = readAdaptationTier(answers.lowest_adequate_adaptation);
			if (!adaptation?.chosen) {
				throw new SteeringProtocolError(
					"Checkpoint JEV-040 missing lowest_adequate_adaptation answer",
					checkpointId,
				);
			}
			const lowest = adaptation.tier;
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
			return {
				action: "replan",
				reasonCodes: [adaptation.reading === "act" ? "strategy_adaptation_selected" : "adaptation_tier_unsure"],
			};
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
			// The plane records the judgment and does not act on it: the supervisor owns the mapping from
			// answers to a worker action (it holds the steer history the mapping depends on). Which answers
			// were adverse is read from their bands, which the decisions' declared directions made correct;
			// they are carried as reason codes so the certificate and the evaluation ledger show them.
			const adverse = Object.entries(answers)
				.filter(([, answer]) => isAdverseAnswer(answer))
				.map(([id]) => `adverse_${id}`);
			return {
				action: "continue_current_work",
				reasonCodes: adverse.length > 0 ? adverse : ["worker_progressing_normally"],
			};
		}

		return { action: "continue_current_work", reasonCodes };
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
	 * A `threshold` is a deliberate per-checkpoint cut from `STEERING_CUTS` (JEV-004/JEV-024's
	 * `outcomeCompletionPlausible`, JEV-013's `specFulfilled`) and reads the probability directly, as
	 * the doctrine requires. There is no 0.5 default: a coin flip is ignorance, and it used to pass here.
	 *
	 * Every asked question has a result (`certify` rejects a program result that is missing), so an
	 * answer without a probability is malformed, not undecided: it is a no, as it always was.
	 */
	private isTruthy(ans: unknown, threshold?: number, predicate?: string): boolean {
		if (ans == null) return false;
		if (typeof threshold === "number") {
			const probability = noulProbability(ans);
			return probability !== undefined && probability >= threshold;
		}
		if (typeof ans === "object") {
			const band = readNoul(ans, "required_true", this.bands);
			if (band === "unasked") return false;
			if (band === "ambiguous") {
				if (predicate) this.openDoubts.push(predicate);
				return false;
			}
			return band !== "hard_fail";
		}
		return Boolean(ans);
	}

	/**
	 * How much of a Score answer's probability falls on the levels `inLevels` accepts. A Score is a
	 * distribution over discrete levels, so a question about levels reads the mass on them: its mean
	 * is not a level, and a mean compared against a level boundary flips on tail mass alone (measured:
	 * 0.72 on "minor, defaults resolve it" and 0.15 on "significant" averages to 1.08, past a `> 1`
	 * cutoff). A score without a distribution is certain at its value; a missing one is undefined.
	 */
	private scoreMass(ans: unknown, inLevels: (level: number) => boolean): number | undefined {
		if (ans == null) return undefined;
		const obj = typeof ans === "object" ? (ans as Record<string, unknown>) : { value: ans };
		const distribution = obj.distribution ?? obj.probabilities;
		if (distribution && typeof distribution === "object") {
			let mass = 0;
			for (const [level, probability] of Object.entries(distribution as Record<string, unknown>)) {
				if (typeof probability === "number" && Number.isFinite(probability) && inLevels(Number(level)))
					mass += probability;
			}
			return mass;
		}
		const value = typeof obj.value === "number" ? obj.value : typeof obj.score === "number" ? obj.score : undefined;
		return value === undefined ? undefined : inLevels(value) ? 1 : 0;
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
				// Most of the belief on "different readings lead to different work" or worse.
				if (
					(this.scoreMass(answers.ambiguity_severity, (level) => level >= 2) ?? 0) >=
					STEERING_CUTS.scoreAdverseMass
				) {
					failed.push("ambiguity_severity_acceptable");
				}
				if (this.isTruthy(answers.missing_information, undefined, "missing_information")) {
					failed.push("no_missing_information");
				}
				// Only a decisively incoherent objective ends admission. Ambiguity and missing information
				// are answered by gathering evidence or asking the owner, never by refusing the objective.
				const incoherent = readNoul(answers.objective_coherent, "required_true", this.bands) === "hard_fail";
				if (failed.length > 0) outcome = incoherent ? "fail" : "gather_more";
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
					if (
						!this.isTruthy(
							answers.completion_plausible,
							STEERING_CUTS.outcomeCompletionPlausible,
							"completion_plausible",
						)
					) {
						failed.push("completion_plausible");
						outcome = "fail";
					}
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
				if (!this.isTruthy(answers.spec_fulfilled, STEERING_CUTS.specFulfilled, "spec_fulfilled"))
					failed.push("spec_fulfilled");
				// Not asked when code already verified the candidate (see `unlessSettledByCode`).
				if (answers.tests_valid !== undefined && !this.isTruthy(answers.tests_valid, undefined, "tests_valid"))
					failed.push("tests_valid");
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
				// The activation and the smoke check are not asked when code already established them.
				if (
					answers.activation_succeeded !== undefined &&
					!this.isTruthy(answers.activation_succeeded, undefined, "activation_succeeded")
				)
					failed.push("activation_succeeded");
				if (
					answers.runtime_healthy !== undefined &&
					!this.isTruthy(answers.runtime_healthy, undefined, "runtime_healthy")
				)
					failed.push("runtime_healthy");
				if (!this.isTruthy(answers.capability_available, undefined, "capability_available"))
					failed.push("capability_available");
				if (failed.length > 0) outcome = "fail";
				break;
			}

			case "JEV-016": {
				if (
					answers.task_proof_passed !== undefined &&
					!this.isTruthy(answers.task_proof_passed, undefined, "task_proof_passed")
				)
					failed.push("task_proof_passed");
				if (!this.isTruthy(answers.regression_absent, undefined, "regression_absent"))
					failed.push("regression_absent");
				if (!this.isTruthy(answers.commit_approved, undefined, "commit_approved")) failed.push("commit_approved");
				if (failed.length > 0) outcome = "fail";
				break;
			}

			case "JEV-024": {
				if (
					!this.isTruthy(
						answers.completion_plausible,
						STEERING_CUTS.outcomeCompletionPlausible,
						"completion_plausible",
					)
				) {
					failed.push("completion_plausible");
					outcome = "fail";
				}
				break;
			}

			case "JEV-025": {
				// The same questions and bounds the goal tool's completion judges with.
				failed.push(...completionPackFailures("completion", answers).map((gate) => completionPredicate(gate.id)));
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-026": {
				failed.push(
					...completionPackFailures("completion_challenge", answers).map((gate) => completionPredicate(gate.id)),
				);
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
				if (
					answers.dependencies_resolved !== undefined &&
					!this.isTruthy(answers.dependencies_resolved, undefined, "dependencies_resolved")
				)
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
			occupancy?: SemanticEvaluationOccupancy;
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
						occupancy: options.occupancy,
					}
				: requestOrCheckpointId;
		const bound = this.bindCheckpoint(request);
		const cached = this.cachedResult(bound);
		if (cached) return cached;

		const evaluationId = this.startObserved(bound);
		try {
			const evaluation = await this.runEngine(request.checkpointId, bound.program, request, bound.consequence);
			return await this.certify(bound, evaluation, evaluationId);
		} catch (error) {
			this.settleObservedFailure(evaluationId, request, error);
			throw error;
		}
	}

	/**
	 * Several checkpoints judged on the same state, sent as ONE engine request: their questions are
	 * independent, so fanning them out together costs one round trip instead of one each. Each checkpoint
	 * still gets its own certificate, cache key, outcome and evaluation record; a cached checkpoint is
	 * not asked again. All requests share the first request's signal, consequence and occupancy.
	 */
	async evaluateTogether(
		requests: readonly SteeringCheckpointRequest[],
	): Promise<PromiseSettledResult<SteeringResult>[]> {
		const bounds = requests.map((request) => this.bindCheckpoint(request));
		const results: PromiseSettledResult<SteeringResult>[] = [];
		const fresh: number[] = [];
		for (const [index, bound] of bounds.entries()) {
			const cached = this.cachedResult(bound);
			if (cached) results[index] = { status: "fulfilled", value: cached };
			else fresh.push(index);
		}
		const first = fresh.length > 0 ? bounds[fresh[0]] : undefined;
		if (!first) return results;

		const label = fresh.map((index) => bounds[index].request.checkpointId).join("+");
		// One request carries one state: checkpoints judged on different states cannot share it.
		if (fresh.some((index) => bounds[index].stateDigest !== first.stateDigest))
			throw new Error(`Checkpoints ${label} are judged on different states and cannot share one request.`);
		const decisions = fresh.flatMap((index) => bounds[index].program.decisions);
		const ids = new Set(decisions.map((decision) => decision.id));
		if (ids.size !== decisions.length) throw new Error(`Checkpoints ${label} ask overlapping question ids.`);
		const program =
			fresh.length === 1 ? first.program : createDecisionProgram({ id: `pi:steering:together:${label}`, decisions });

		const evaluationIds = fresh.map((index) => this.startObserved(bounds[index]));
		let evaluation: DecisionEvaluation;
		try {
			evaluation = await this.runEngine(label, program, first.request, first.consequence);
		} catch (error) {
			for (const [position, index] of fresh.entries()) {
				this.settleObservedFailure(evaluationIds[position], bounds[index].request, error);
				results[index] = { status: "rejected", reason: error };
			}
			return results;
		}
		for (const [position, index] of fresh.entries()) {
			try {
				results[index] = {
					status: "fulfilled",
					value: await this.certify(bounds[index], evaluation, evaluationIds[position]),
				};
			} catch (error) {
				this.settleObservedFailure(evaluationIds[position], bounds[index].request, error);
				results[index] = { status: "rejected", reason: error };
			}
		}
		return results;
	}

	/** Binds the session's one evaluation sink; late-bound because the plane is built before the session. */
	setEvaluationObserver(observer: SemanticEvaluationObserver | undefined): void {
		this.evaluationObserver = observer;
	}

	/** The checkpoint's program and every key its certificate is cached under. */
	private bindCheckpoint(request: SteeringCheckpointRequest): BoundCheckpoint {
		const program = compileDecisionProgramForCheckpoint(request.checkpointId, request.state);
		return {
			request,
			program,
			stateDigest: canonicalDigest(request.state),
			programDigest: canonicalDigest(program),
			policyDigest: computePolicyDigest(this.policy),
			model: this.policy.model.id || PINNED_JEV_MODEL,
			provider: this.policy.model.provider || "typesafe",
			consequence: request.consequence ?? "medium",
			objectiveId: request.objectiveId ?? (request.taskId ? `obj-${request.taskId}` : `obj-${request.checkpointId}`),
			evidenceRevision: request.evidenceRevision ?? 1,
		};
	}

	/** A certificate already issued under the full key binding, with its directive recomposed. */
	private cachedResult(bound: BoundCheckpoint): SteeringResult | undefined {
		const existing = this.certificates.findCurrent({
			objectiveId: bound.objectiveId,
			checkpointId: bound.request.checkpointId,
			stateDigest: bound.stateDigest,
			evidenceRevision: bound.evidenceRevision,
			policyDigest: bound.policyDigest,
			programDigest: bound.programDigest,
			provider: bound.provider,
			model: bound.model,
		});
		if (!existing) return undefined;
		return {
			certificate: existing,
			directive: this.composeDirective(bound.request.checkpointId, existing.answers, bound.program),
		};
	}

	/**
	 * A cache hit records nothing: no evaluation ran. From here on one did, and the one recorder learns
	 * its start, its verdict and its failure or cancellation.
	 */
	private startObserved(bound: BoundCheckpoint): string | undefined {
		const { request } = bound;
		return this.evaluationObserver?.start({
			programId: bound.program.id,
			consequence: bound.consequence,
			occupancy: request.occupancy,
			...(request.objectiveId && request.taskId
				? { evaluationScope: semanticWorkerTaskScope(request.objectiveId, request.taskId) }
				: {}),
		});
	}

	private settleObservedFailure(
		evaluationId: string | undefined,
		request: SteeringCheckpointRequest,
		error: unknown,
	): void {
		if (evaluationId === undefined) return;
		if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
			this.evaluationObserver?.settleCancelled(evaluationId);
			return;
		}
		// The ledger diagnoses the engine's own failure (its kind and receipt), not the outage wrapper.
		const cause =
			error instanceof SystemOneSteeringUnavailableError && error.cause !== undefined ? error.cause : error;
		this.evaluationObserver?.settleFailed(evaluationId, cause);
	}

	/** One engine or router request for `program`; every failure to judge is the plane's unavailable error. */
	private async runEngine(
		label: string,
		program: DecisionProgram,
		request: SteeringCheckpointRequest,
		consequence: Consequence,
	): Promise<DecisionEvaluation> {
		const required = this.policy.mode === "system_one_required";
		let evaluation: DecisionEvaluation;
		// Taken as the checkpoint asks: the adapter resolves its access, and may retry, before its reviewer would take it.
		const origin = this.captureOrigin?.();

		if (this.router) {
			try {
				evaluation = await this.router.evaluateOrFallback(program, request.state, {
					consequence,
					occupancy: request.occupancy,
					...(origin ? { origin } : {}),
				});
			} catch (err) {
				throw engineCallFailure(err, request.signal, label, "Decision router", required);
			}
		} else if (this.decisionEngine) {
			try {
				evaluation = await this.decisionEngine.evaluate(program, request.state, {
					consequence,
					occupancy: request.occupancy,
					...(request.objectiveId && request.taskId
						? { evaluationScope: semanticWorkerTaskScope(request.objectiveId, request.taskId) }
						: {}),
					...(request.signal ? { signal: request.signal } : {}),
					...(origin ? { origin } : {}),
				});
			} catch (err) {
				throw engineCallFailure(err, request.signal, label, "System One steering engine", required);
			}
		} else {
			if (required) {
				throw new SystemOneSteeringUnavailableError(
					`Decision engine missing for mandatory checkpoint ${label} in system_one_required mode.`,
				);
			}
			throw new SystemOneSteeringUnavailableError(`No decision engine configured for checkpoint ${label}.`);
		}

		if (required) {
			const provenance = evaluation.engine.confidence_provenance;
			if (isForbiddenRequiredProvenance(provenance)) {
				throw new SystemOneSteeringUnavailableError(
					`Required checkpoint ${label} cannot be satisfied by ${provenance} provenance (engine ${evaluation.engine.id}).`,
				);
			}
		}

		if (!evaluation?.results || Object.keys(evaluation.results).length === 0) {
			throw new SteeringProtocolError(
				`Empty evaluation response from decision engine for checkpoint ${label}`,
				label,
			);
		}
		return evaluation;
	}

	/** The certificate for one checkpoint, read from the results of the request that asked its questions. */
	private async certify(
		bound: BoundCheckpoint,
		evaluation: DecisionEvaluation,
		evaluationId: string | undefined,
	): Promise<SteeringResult> {
		const {
			request,
			program,
			stateDigest,
			programDigest,
			policyDigest,
			model,
			provider,
			consequence,
			objectiveId,
			evidenceRevision,
		} = bound;
		const floor = CONSEQUENCE_MIN_CONFIDENCE[consequence];

		// Map normalized results to answers. Raw answers are kept only for this program's own questions
		// (a set decision's members are `<id>__<member>`), so a request shared with other checkpoints
		// never leaks their answers into this certificate.
		const answers: Record<string, unknown> = {};
		const own = new Set(program.decisions.map((decision) => decision.id));
		for (const [id, answer] of Object.entries(evaluation.rawAnswers ?? {})) {
			if (own.has(id) || own.has(id.split("__")[0] ?? id)) answers[id] = answer;
		}
		// A Noul has no confidence (TypeSafe docs): its probability is the certainty, and its band already
		// says whether it settled anything. A Choice is read on P(chosen option), never on its confidence;
		// a Score or Set on its confidence.
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
				const settled = result.kind === "choice" ? (choiceProbability(result) ?? 0) : result.confidence.value;
				confidences.push(settled);
				if (settled < floor) lowConfidence.push(d.id);
			}
		}

		// A low-confidence answer is a doubt about that decision, routed like an ambiguous band. It never
		// throws: an exception here used to end the whole objective run.
		const actionConfidence = confidences.length > 0 ? Math.min(...confidences) : 1;

		const directive = this.composeDirective(request.checkpointId, answers, program);
		const judged = this.evaluateSemanticOutcome(request.checkpointId, answers, directive);
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
			const { verdict, reasons, questionStates } = verdictFromCertificate(certificate);
			this.evaluationObserver?.settleOk(evaluationId, verdict, reasons, questionStates);
			// How code reached the verdict: the directive and outcome gates, the floor that turned a pass
			// into a doubt, and this checkpoint's own judgments (a shared request carries other checkpoints').
			const unsettled = new Set([...failed_semantic_predicates, ...unsure_semantic_predicates]);
			const gates: SemanticTraceGate[] = [
				{ id: "directive", result: directive.action, decided: true },
				{ id: "semantic_outcome", result: judged.semantic_outcome, decided: judged.semantic_outcome !== "pass" },
			];
			if (lowConfidence.length > 0)
				gates.push({
					id: `${consequence}_floor_${floor}`,
					result: lowConfidence.join(","),
					decided: judged.semantic_outcome === "pass",
				});
			const trace = {
				decision: `${request.checkpointId} ${semantic_outcome}: ${directive.action}`,
				gates,
				judgments: traceJudgmentsFromEvaluation(
					{
						...evaluation,
						results: Object.fromEntries(program.decisions.map((d) => [d.id, evaluation.results[d.id]])),
					},
					program.decisions.map((d) => d.id).filter((id) => unsettled.has(id)),
				),
				facts: directive.reasonCodes,
			};
			this.evaluationObserver?.noteTrace?.(evaluationId, trace);
			this.rememberTrace(certificate.certificate_id, evaluationId, trace);
		}
		return { certificate, directive };
	}

	private rememberTrace(certificateId: string, evaluationId: string, trace: SemanticDecisionTrace): void {
		this.certificateTraces.set(certificateId, { evaluationId, trace });
		if (this.certificateTraces.size > CERTIFICATE_TRACE_LIMIT) {
			const oldest = this.certificateTraces.keys().next().value;
			if (oldest !== undefined) this.certificateTraces.delete(oldest);
		}
	}

	/**
	 * Adds the gates a certificate's consumer applied after the plane (the route policy after JEV-004,
	 * a transition after its checkpoint) to that evaluation's trace, and names the final decision. A
	 * certificate from the cache, or one no longer remembered, has no evaluation to trace.
	 */
	noteDecision(
		certificateId: string,
		decision: string,
		gates: readonly SemanticTraceGate[],
		facts: readonly string[] = [],
	): void {
		const remembered = this.certificateTraces.get(certificateId);
		if (!remembered) return;
		const trace: SemanticDecisionTrace = {
			...remembered.trace,
			decision,
			gates: [...gates, ...(remembered.trace.gates ?? [])],
			facts: [...facts, ...(remembered.trace.facts ?? [])],
		};
		remembered.trace = trace;
		this.evaluationObserver?.noteTrace?.(remembered.evaluationId, trace);
	}

	/**
	 * Convenience helper: require a certificate or evaluate fresh.
	 */
	async requireCertificate(
		checkpointId: string,
		state: unknown,
		options: RequireCertificateOptions = {},
	): Promise<SteeringCertificate> {
		if (options.signal?.aborted) {
			throw new Error(`Steering evaluation aborted for ${checkpointId}`);
		}
		let result: SteeringResult;
		try {
			result = await this.evaluate(certificateRequest(checkpointId, state, options));
		} catch (error) {
			throw judgmentUnavailable(checkpointId, error);
		}
		return this.acceptCertificate(checkpointId, result, options);
	}

	/**
	 * `requireCertificate` for several checkpoints judged on one state, asked in ONE engine request
	 * (`evaluateTogether`). Each checkpoint settles on its own: its certificate, its gather counter, its
	 * pass requirement and its outage error under its own authority.
	 */
	async requireCertificates(
		checkpointIds: readonly string[],
		state: unknown,
		options: RequireCertificateOptions = {},
	): Promise<PromiseSettledResult<SteeringCertificate>[]> {
		if (options.signal?.aborted) {
			throw new Error(`Steering evaluation aborted for ${checkpointIds.join("+")}`);
		}
		const evaluated = await this.evaluateTogether(
			checkpointIds.map((checkpointId) => certificateRequest(checkpointId, state, options)),
		);
		return evaluated.map((outcome, index): PromiseSettledResult<SteeringCertificate> => {
			const checkpointId = checkpointIds[index];
			try {
				if (outcome.status === "rejected") throw judgmentUnavailable(checkpointId, outcome.reason);
				return { status: "fulfilled", value: this.acceptCertificate(checkpointId, outcome.value, options) };
			} catch (reason) {
				return { status: "rejected", reason };
			}
		});
	}

	private acceptCertificate(
		checkpointId: string,
		result: SteeringResult,
		options: RequireCertificateOptions,
	): SteeringCertificate {
		const authority = authorityForCheckpoint(checkpointId);
		// An ambiguous judgment asks for evidence at most GATHER_MORE_LIMIT times on the same evidence
		// revision. After that, reversible work proceeds with the doubt on the certificate; an objective
		// transition keeps failing closed (it never closes on a doubt).
		if (result.certificate.semantic_outcome === "gather_more") {
			const objectiveId = options.objectiveId ?? "obj_default";
			const evidenceRevision = options.evidenceRevision ?? 1;
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

interface RequireCertificateOptions {
	objectiveId?: string;
	taskId?: string;
	workUnitId?: string;
	evidenceRevision?: number;
	consequence?: Consequence;
	parentCertificateIds?: readonly string[];
	signal?: AbortSignal;
	occupancy?: SemanticEvaluationOccupancy;
	requirePass?: boolean;
}

/** A checkpoint request bound to its program and to every key its certificate is cached under. */
interface BoundCheckpoint {
	readonly request: SteeringCheckpointRequest;
	readonly program: DecisionProgram;
	readonly stateDigest: string;
	readonly programDigest: string;
	readonly policyDigest: string;
	readonly model: string;
	readonly provider: string;
	readonly consequence: Consequence;
	readonly objectiveId: string;
	readonly evidenceRevision: number;
}

function certificateRequest(
	checkpointId: string,
	state: unknown,
	options: RequireCertificateOptions,
): SteeringCheckpointRequest {
	return {
		checkpointId,
		objectiveId: options.objectiveId ?? "obj_default",
		taskId: options.taskId,
		workUnitId: options.workUnitId,
		state,
		evidenceRevision: options.evidenceRevision ?? 1,
		consequence: options.consequence,
		parentCertificateIds: options.parentCertificateIds,
		// The abort reaches the engine: an aborted checkpoint settles as cancelled, not failed.
		signal: options.signal,
		occupancy: options.occupancy,
	};
}

/** The plane's outage error named for the checkpoint and its authority; any other error passes through. */
function judgmentUnavailable(checkpointId: string, error: unknown): unknown {
	if (error instanceof SystemOneSteeringUnavailableError && !(error instanceof SteeringJudgmentUnavailableError))
		return new SteeringJudgmentUnavailableError(checkpointId, authorityForCheckpoint(checkpointId), error);
	return error;
}
