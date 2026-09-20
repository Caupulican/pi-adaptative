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
import type { DecisionProgram } from "../decision/program.ts";
import type { JevAdapter } from "../system-one/adapter.ts";
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

export class SteeringConfidenceTooLowError extends Error {
	readonly checkpointId: string;
	readonly confidence: number;
	readonly required: number;

	constructor(checkpointId: string, confidence: number, required: number) {
		super(`Confidence for checkpoint ${checkpointId} (${confidence}) is below required threshold (${required}).`);
		this.name = "SteeringConfidenceTooLowError";
		this.checkpointId = checkpointId;
		this.confidence = confidence;
		this.required = required;
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

		return { action: "continue_current_work", reasonCodes };
	}

	private isTruthy(ans: unknown, threshold = 0.5): boolean {
		if (ans == null) return false;
		if (typeof ans === "object") {
			const obj = ans as Record<string, unknown>;
			if (typeof obj.value === "boolean") return obj.value;
			if (typeof obj.boolean === "boolean") return obj.boolean;
			if (typeof obj.noul === "number") return obj.noul >= threshold;
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
	): {
		semantic_outcome: SteeringSemanticOutcome;
		failed_semantic_predicates: readonly string[];
	} {
		const failed: string[] = [];
		let outcome: SteeringSemanticOutcome = "pass";

		switch (checkpointId) {
			case "JEV-001": {
				if (!this.isTruthy(answers.objective_coherent)) {
					failed.push("objective_coherent");
				}
				if (this.getScoreValue(answers.ambiguity_severity) > 1) {
					failed.push("ambiguity_severity_acceptable");
				}
				if (this.isTruthy(answers.missing_information)) {
					failed.push("no_missing_information");
				}
				if (failed.length > 0) {
					outcome = this.isTruthy(answers.missing_information) ? "gather_more" : "fail";
				}
				break;
			}

			case "JEV-002": {
				if (!this.isTruthy(answers.acceptance_complete)) {
					failed.push("acceptance_complete");
					outcome = "gather_more";
				}
				break;
			}

			case "JEV-003": {
				if (answers.grounding_sufficient !== undefined && !this.isTruthy(answers.grounding_sufficient)) {
					failed.push("grounding_sufficient");
					outcome = "gather_more";
				}
				break;
			}

			case "JEV-004": {
				if (directive.action === "completion_candidate") {
					if (!this.isTruthy(answers.completion_plausible, 0.75)) {
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
				if (this.isTruthy(answers.strategy_repetition)) {
					failed.push("no_strategy_repetition");
					outcome = "replan";
				}
				break;
			}

			case "JEV-009": {
				if (!this.isTruthy(answers.gap_confirmed)) {
					failed.push("gap_confirmed");
				}
				if (!this.isTruthy(answers.adaptation_needed)) {
					failed.push("adaptation_needed");
				}
				if (failed.length > 0) outcome = "fail";
				break;
			}

			case "JEV-010": {
				if (!this.isTruthy(answers.risk_acceptable)) {
					failed.push("risk_acceptable");
					outcome = "block";
				}
				break;
			}

			case "JEV-011": {
				if (!this.isTruthy(answers.spec_complete)) failed.push("spec_complete");
				if (!this.isTruthy(answers.interface_sound)) failed.push("interface_sound");
				if (!this.isTruthy(answers.side_effects_bounded)) failed.push("side_effects_bounded");
				if (!this.isTruthy(answers.test_strategy_viable)) failed.push("test_strategy_viable");
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-012": {
				if (!this.isTruthy(answers.plan_viable)) failed.push("plan_viable");
				if (!this.isTruthy(answers.architecture_fit)) failed.push("architecture_fit");
				if (!this.isTruthy(answers.builder_profile_sound)) failed.push("builder_profile_sound");
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-013": {
				if (!this.isTruthy(answers.spec_fulfilled, 0.7)) failed.push("spec_fulfilled");
				if (!this.isTruthy(answers.tests_valid)) failed.push("tests_valid");
				if (!this.isTruthy(answers.safety_satisfied)) failed.push("safety_satisfied");
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-014": {
				if (!this.isTruthy(answers.scope_bounded)) failed.push("scope_bounded");
				if (!this.isTruthy(answers.rollback_safe)) failed.push("rollback_safe");
				if (!this.isTruthy(answers.invariants_preserved)) failed.push("invariants_preserved");
				if (failed.length > 0) outcome = "block";
				break;
			}

			case "JEV-015": {
				if (!this.isTruthy(answers.activation_succeeded)) failed.push("activation_succeeded");
				if (!this.isTruthy(answers.runtime_healthy)) failed.push("runtime_healthy");
				if (!this.isTruthy(answers.capability_available)) failed.push("capability_available");
				if (failed.length > 0) outcome = "fail";
				break;
			}

			case "JEV-016": {
				if (!this.isTruthy(answers.task_proof_passed)) failed.push("task_proof_passed");
				if (!this.isTruthy(answers.regression_absent)) failed.push("regression_absent");
				if (!this.isTruthy(answers.commit_approved)) failed.push("commit_approved");
				if (failed.length > 0) outcome = "fail";
				break;
			}

			case "JEV-017": {
				if (!this.isTruthy(answers.claim_supported)) failed.push("claim_supported");
				if (!this.isTruthy(answers.evidence_sufficient)) failed.push("evidence_sufficient");
				if (failed.length > 0) outcome = "fail";
				break;
			}

			case "JEV-018": {
				if (!this.isTruthy(answers.patch_matches_requirements)) failed.push("patch_matches_requirements");
				if (!this.isTruthy(answers.side_effects_acceptable)) failed.push("side_effects_acceptable");
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-019": {
				if (!this.isTruthy(answers.bug_reproduced)) failed.push("bug_reproduced");
				if (!this.isTruthy(answers.fix_verified)) failed.push("fix_verified");
				if (!this.isTruthy(answers.causal_link_proven)) failed.push("causal_link_proven");
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-020": {
				if (!this.isTruthy(answers.boundaries_respected)) failed.push("boundaries_respected");
				if (!this.isTruthy(answers.invariants_held)) failed.push("invariants_held");
				if (failed.length > 0) outcome = "block";
				break;
			}

			case "JEV-021": {
				if (!this.isTruthy(answers.test_coverage_sufficient)) failed.push("test_coverage_sufficient");
				if (answers.negative_tests_present !== undefined && !this.isTruthy(answers.negative_tests_present)) {
					failed.push("negative_tests_present");
				}
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-022": {
				if (!this.isTruthy(answers.checks_relevant)) failed.push("checks_relevant");
				if (!this.isTruthy(answers.criteria_covered)) failed.push("criteria_covered");
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-023": {
				if (!this.isTruthy(answers.repairs_sufficient)) failed.push("repairs_sufficient");
				if (!this.isTruthy(answers.root_cause_addressed)) failed.push("root_cause_addressed");
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-024": {
				if (!this.isTruthy(answers.completion_plausible, 0.75)) {
					failed.push("completion_plausible");
					outcome = "fail";
				}
				break;
			}

			case "JEV-025": {
				if (!this.isTruthy(answers.acceptance_satisfied)) failed.push("acceptance_satisfied");
				if (!this.isTruthy(answers.requirements_complete)) failed.push("requirements_complete");
				if (!this.isTruthy(answers.verification_conclusive)) failed.push("verification_conclusive");
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-026": {
				if (this.isTruthy(answers.unhandled_edge_cases)) failed.push("no_unhandled_edge_cases");
				if (this.isTruthy(answers.hidden_regressions)) failed.push("no_hidden_regressions");
				if (this.isTruthy(answers.assumption_violations)) failed.push("no_assumption_violations");
				if (answers.adversarial_approved !== undefined && !this.isTruthy(answers.adversarial_approved)) {
					failed.push("adversarial_approved");
				}
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-027": {
				if (!this.isTruthy(answers.delivery_bundle_truthful)) failed.push("delivery_bundle_truthful");
				if (!this.isTruthy(answers.artifacts_verified)) failed.push("artifacts_verified");
				if (!this.isTruthy(answers.limitations_disclosed)) failed.push("limitations_disclosed");
				if (failed.length > 0) outcome = "fail";
				break;
			}

			case "JEV-028": {
				if (!this.isTruthy(answers.release_ready)) failed.push("release_ready");
				if (!this.isTruthy(answers.package_healthy)) failed.push("package_healthy");
				if (!this.isTruthy(answers.deploy_safe)) failed.push("deploy_safe");
				if (failed.length > 0) outcome = "block";
				break;
			}

			case "JEV-031": {
				if (!this.isTruthy(answers.specialist_needed)) failed.push("specialist_needed");
				if (failed.length > 0) outcome = "fail";
				break;
			}

			case "JEV-033": {
				if (!this.isTruthy(answers.spec_complete)) failed.push("spec_complete");
				if (!this.isTruthy(answers.role_bounded)) failed.push("role_bounded");
				if (!this.isTruthy(answers.tools_skills_sufficient)) failed.push("tools_skills_sufficient");
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-034": {
				if (!this.isTruthy(answers.dependencies_resolved)) failed.push("dependencies_resolved");
				if (!this.isTruthy(answers.capabilities_ready)) failed.push("capabilities_ready");
				if (!this.isTruthy(answers.tools_available)) failed.push("tools_available");
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-035": {
				if (!this.isTruthy(answers.contract_sound)) failed.push("contract_sound");
				if (!this.isTruthy(answers.authority_bounded)) failed.push("authority_bounded");
				if (!this.isTruthy(answers.within_charter)) failed.push("within_charter");
				if (failed.length > 0) outcome = "block";
				break;
			}

			case "JEV-036": {
				if (!this.isTruthy(answers.mission_fulfilled)) failed.push("mission_fulfilled");
				if (!this.isTruthy(answers.proof_satisfied)) failed.push("proof_satisfied");
				if (failed.length > 0) outcome = "fail";
				break;
			}

			case "JEV-041": {
				if (!this.isTruthy(answers.unique_responsibility)) failed.push("unique_responsibility");
				if (this.isTruthy(answers.competing_existing_detected)) failed.push("no_competing_existing_detected");
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
					!this.isTruthy(answers.mutations_conform_to_disposition)
				) {
					failed.push("mutations_conform_to_disposition");
				}
				if (
					answers.no_unauthorized_duplication !== undefined &&
					!this.isTruthy(answers.no_unauthorized_duplication)
				) {
					failed.push("no_unauthorized_duplication");
				}
				if (this.isTruthy(answers.duplicate_responsibility_introduced)) {
					failed.push("no_duplicate_responsibility_introduced");
				}
				if (failed.length > 0) outcome = "repair";
				break;
			}

			case "JEV-044": {
				if (!this.isTruthy(answers.no_hidden_duplicates)) failed.push("no_hidden_duplicates");
				if (!this.isTruthy(answers.single_semantic_owner)) failed.push("single_semantic_owner");
				if (failed.length > 0) outcome = "fail";
				break;
			}

			case "JEV-045": {
				if (!this.isTruthy(answers.waiver_valid)) failed.push("waiver_valid");
				if (!this.isTruthy(answers.architectural_rationale_sound)) failed.push("architectural_rationale_sound");
				if (failed.length > 0) outcome = "block";
				break;
			}

			default: {
				if (answers.approved !== undefined && !this.isTruthy(answers.approved)) {
					failed.push("approved");
					outcome = "fail";
				}
				break;
			}
		}

		if (failed.length > 0 && outcome === "pass") {
			outcome = "fail";
		}

		return {
			semantic_outcome: outcome,
			failed_semantic_predicates: failed,
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
		const confidences: number[] = [];

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
					value: result.value,
					confidence: result.confidence.value,
				};
				confidences.push(result.confidence.value);
			} else if (result.kind === "choice") {
				answers[d.id] = {
					type: "choice",
					choice: result.selected,
					distribution: result.distribution,
					probabilities: result.distribution,
					margin: result.margin,
					confidence: result.confidence.value,
				};
				confidences.push(result.confidence.value);
			} else if (result.kind === "score") {
				answers[d.id] = {
					type: "score",
					score: result.value,
					value: result.value,
					distribution: result.distribution,
					probabilities: result.distribution,
					confidence: result.confidence.value,
				};
				confidences.push(result.confidence.value);
			} else if (result.kind === "set") {
				answers[d.id] = {
					type: "set",
					selected: result.selected,
					memberships: result.memberships,
					confidence: result.confidence.value,
				};
				confidences.push(result.confidence.value);
			}
		}

		// PH-006, PH-007: Weakest-link confidence across required judgments. No global _confidence!
		const actionConfidence = confidences.length > 0 ? Math.min(...confidences) : 0.0;
		if (actionConfidence < thresholds.minimumConfidence) {
			throw new SteeringConfidenceTooLowError(request.checkpointId, actionConfidence, thresholds.minimumConfidence);
		}

		const directive = this.composeDirective(request.checkpointId, answers, program);
		const { semantic_outcome, failed_semantic_predicates } = this.evaluateSemanticOutcome(
			request.checkpointId,
			answers,
			directive,
		);

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

		const result = await this.evaluate({
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
