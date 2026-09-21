import type { Consequence } from "../decision/primitives.ts";
import type { IntegrityGateResult } from "../hooks/index.ts";
import type { JevAdapter } from "./adapter.ts";
import { AuditStore } from "./audit.ts";
import { getQuestionPack, hashQuestionPack, SYSTEM_ONE_CATALOG_VERSION, SYSTEM_ONE_PINNED_MODEL } from "./catalog.ts";
import { DEFAULT_SYSTEM_ONE_CONFIG, type SystemOneConfig } from "./config.ts";
import type { ExecutionStore } from "./execution-state.ts";
import type { IntegrityHookCoordinator } from "./integrity-hooks.ts";
import {
	decideFinalCompletion,
	decidePostflight,
	decidePreflight,
	decideToolGate,
	evaluateChoice,
	evaluateDeterministicCompletionGates,
	evaluateNoul,
	type FinalCompletionVerdict,
} from "./policy.ts";
import { StateProjector } from "./projector.ts";
import type { SemanticEvaluationObserver } from "./semantic-evaluation-ledger.ts";
import type { ExecutionState, ToolImpact, ValidationDecision, ValidationStage } from "./types.ts";

export interface SystemOneControllerDeps {
	store: ExecutionStore;
	adapter: JevAdapter;
	projector?: StateProjector;
	audit?: AuditStore;
	config?: SystemOneConfig;
	userKeys?: readonly string[];
	hookCoordinator?: IntegrityHookCoordinator;
	/** The session's one Jev evaluation sink; every stage validation reports through it. */
	evaluationObserver?: SemanticEvaluationObserver;
}

/** The consequence class a stage's tool impact maps to, for the evaluation record. */
function consequenceForImpact(impact: ToolImpact): Consequence {
	switch (impact) {
		case "read_only":
			return "low";
		case "local_reversible":
			return "medium";
		case "repo_mutation":
			return "high";
		default:
			return "critical";
	}
}

/**
 * SystemOneController: Top-level orchestrator for System One validation.
 * Enforces the full lifecycle: intake -> preflight -> tool-gate -> postflight -> drift -> completion transaction.
 */
export class SystemOneController {
	readonly store: ExecutionStore;
	readonly adapter: JevAdapter;
	readonly projector: StateProjector;
	readonly audit: AuditStore;
	readonly config: SystemOneConfig;
	readonly hookCoordinator?: IntegrityHookCoordinator;
	private evaluationObserver?: SemanticEvaluationObserver;

	constructor(deps: SystemOneControllerDeps) {
		this.store = deps.store;
		this.adapter = deps.adapter;
		this.projector = deps.projector ?? new StateProjector(deps.userKeys ?? []);
		this.audit = deps.audit ?? new AuditStore();
		this.config = deps.config ?? DEFAULT_SYSTEM_ONE_CONFIG;
		this.hookCoordinator = deps.hookCoordinator;
		this.evaluationObserver = deps.evaluationObserver;
	}

	/** Binds the session's evaluation sink; late-bound because the controller is built before the session. */
	setEvaluationObserver(observer: SemanticEvaluationObserver | undefined): void {
		this.evaluationObserver = observer;
	}

	/**
	 * Seals a stage decision: the durable record (the store mints the one id both stores key), the
	 * audit trail under that same id, and the operator-visible verdict on the evaluation ledger.
	 */
	private sealDecision(decision: ValidationDecision, policyResult: string, evaluationId: string | undefined): void {
		decision.policy_result = policyResult;
		const { id: _provisional, timestamp: _drafted, ...draft } = decision;
		const sealed = this.store.recordDecision(draft);
		decision.id = sealed.id;
		decision.timestamp = sealed.timestamp;
		this.audit.recordDecision(this.store.runId, sealed);
		if (evaluationId !== undefined) this.evaluationObserver?.noteVerdict(evaluationId, policyResult);
	}

	private async runStageValidation(
		stage: ValidationStage,
		stateView: Record<string, unknown>,
		impact: ToolImpact = "read_only",
	): Promise<{ decision: ValidationDecision; answers: Record<string, unknown>; evaluationId: string | undefined }> {
		const questions = getQuestionPack(stage);
		const questionsHash = hashQuestionPack(stage);
		const stateHash = this.store.computeStateHash();
		const pinnedModel = this.config.model.production || SYSTEM_ONE_PINNED_MODEL;

		const evaluationId = this.evaluationObserver?.start({
			programId: `system-one:${stage}`,
			consequence: consequenceForImpact(impact),
			model: pinnedModel,
		});
		let response: Awaited<ReturnType<JevAdapter["evaluate"]>>;
		try {
			response = await this.adapter.evaluate(
				{
					model: pinnedModel,
					state: stateView,
					questions,
				},
				{ impact },
			);
		} catch (error) {
			if (evaluationId !== undefined) this.evaluationObserver?.settleFailed(evaluationId, error);
			throw error;
		}
		// The policy result is decided by the caller; the record settles now and gets its verdict then.
		if (evaluationId !== undefined) this.evaluationObserver?.settleOk(evaluationId);

		const decision: ValidationDecision = {
			id: `DEC-${stage}-${Date.now()}`,
			stage,
			model: response.model,
			question_catalog_version: SYSTEM_ONE_CATALOG_VERSION,
			questions_hash: questionsHash,
			state_hash: stateHash,
			answers: response.answers,
			policy_result: "pending",
			timestamp: new Date().toISOString(),
			usage: response.usage,
			latency_ms: response.latency_ms,
		};

		return { decision, answers: response.answers, evaluationId };
	}

	/**
	 * Validate task intake.
	 */
	async validateIntake(): Promise<{
		objectiveClear: boolean;
		taskKind: string;
		externalBlockerPresent: boolean;
		decision: ValidationDecision;
	}> {
		const projection = this.projector.intake(this.store.snapshot());
		const { decision, answers, evaluationId } = await this.runStageValidation("intake", projection);

		const clearAns = (answers.objective_clear as { noul?: number } | undefined)?.noul ?? 0;
		const objectiveClear = evaluateNoul(clearAns, "required_true", this.config.thresholds) !== "hard_fail";

		const taskKindAns = answers.task_kind as { choice?: string } | undefined;
		const taskKind = taskKindAns?.choice ?? "implementation";

		const blockerAns = (answers.external_blocker_present as { noul?: number } | undefined)?.noul ?? 0;
		const externalBlockerPresent = evaluateNoul(blockerAns, "required_false", this.config.thresholds) === "hard_fail";

		this.sealDecision(decision, objectiveClear && !externalBlockerPresent ? "accepted" : "blocked", evaluationId);

		if (externalBlockerPresent) {
			this.store.transitionPhase("blocked_external", true);
		} else if (this.store.phase === "init") {
			this.store.transitionPhase("discovery", true);
		}

		return { objectiveClear, taskKind, externalBlockerPresent, decision };
	}

	/**
	 * Validate preflight step before execution.
	 * R-018: A semantic preflight validation MUST run before each repo mutation and before high-impact external actions.
	 */
	async validatePreflight(stepId: string): Promise<{
		route: "allow" | "retrieve" | "replan" | "test" | "block" | "escalate";
		decision: ValidationDecision;
	}> {
		const projection = this.projector.preflight(this.store.snapshot(), stepId);
		const { decision, answers, evaluationId } = await this.runStageValidation("preflight", projection);

		const route = decidePreflight(answers, this.config);
		this.sealDecision(decision, route, evaluationId);

		if (route === "replan") {
			this.store.transitionPhase("replan_required", true);
		}

		return { route, decision };
	}

	/**
	 * Validate tool gate before execution.
	 * R-020 / R-034 / R-035: Deterministic checks first; Jev cannot override deterministic denials.
	 */
	async validateToolGate(
		toolRequest: { tool: string; intent: string; impact: ToolImpact; args?: unknown },
		deterministicCheck?: () => { allowed: boolean; reason?: string },
	): Promise<{
		outcome: "allow" | "confirm" | "block" | "replan";
		reason?: string;
		decision?: ValidationDecision;
	}> {
		// 1. Run deterministic checks first (R-020, R-034)
		if (deterministicCheck) {
			const det = deterministicCheck();
			if (!det.allowed) {
				// Deterministic failure cannot be overridden by Jev (R-035)
				this.store.recordToolEvent({
					tool: toolRequest.tool,
					intent: toolRequest.intent,
					impact: toolRequest.impact,
					status: "denied",
					input_payload: toolRequest.args,
				});
				return {
					outcome: "block",
					reason: det.reason ?? "Blocked by deterministic tool authorization gate",
				};
			}
		}

		// 2. Semantic tool gate
		const projection = this.projector.toolGate(this.store.snapshot(), toolRequest);
		const { decision, answers, evaluationId } = await this.runStageValidation(
			"tool_gate",
			projection,
			toolRequest.impact,
		);

		const outcome = decideToolGate(answers, toolRequest.impact, this.config, {
			relevanceEvaluable: projection.current_step !== undefined,
		});
		this.sealDecision(decision, outcome, evaluationId);

		this.store.recordToolEvent({
			tool: toolRequest.tool,
			intent: toolRequest.intent,
			impact: toolRequest.impact,
			status: outcome === "block" ? "denied" : "allowed",
			input_payload: toolRequest.args,
		});

		return { outcome, decision };
	}

	/**
	 * Validate postflight after tool or repo mutation.
	 * R-019: A postflight validation MUST run after each repo mutation, material failed action, or material evidence update.
	 */
	async validatePostflight(stepId: string): Promise<{
		nextStatus: "continue" | "verify" | "retrieve_more" | "replan" | "rollback" | "completion_candidate" | "blocked";
		decision: ValidationDecision;
	}> {
		const projection = this.projector.postflight(this.store.snapshot(), stepId);
		const { decision, answers, evaluationId } = await this.runStageValidation("postflight", projection);

		const nextStatus = decidePostflight(answers, this.config);
		this.sealDecision(decision, nextStatus, evaluationId);

		if (nextStatus === "rollback") {
			this.store.transitionPhase("rollback_required", true);
		} else if (nextStatus === "replan") {
			this.store.transitionPhase("replan_required", true);
		} else if (nextStatus === "completion_candidate") {
			this.store.transitionPhase("completion_candidate", true);
		}

		return { nextStatus, decision };
	}

	/**
	 * Validate claim against cited evidence.
	 * R-009 / R-010: Every material claim MUST reference fresh evidence.
	 */
	async validateClaimEvidence(
		claimId: string,
		evidenceId: string,
	): Promise<{
		relationship: "supports" | "partially_supports" | "contradicts" | "insufficient" | "unrelated";
		decision: ValidationDecision;
	}> {
		const projection = this.projector.evidenceCheck(this.store.snapshot(), claimId, evidenceId);
		const { decision, answers, evaluationId } = await this.runStageValidation("evidence_check", projection);

		const relAns = answers.relationship as
			| {
					choice?: string;
					confidence?: number;
					probabilities?: Record<string, number>;
			  }
			| undefined;
		let relationship: "supports" | "partially_supports" | "contradicts" | "insufficient" | "unrelated" =
			"insufficient";

		if (relAns?.choice) {
			const evalChoice = evaluateChoice(relAns as any, "normal", this.config.thresholds);
			if (evalChoice.accepted) {
				relationship = evalChoice.choice as any;
			}
		}

		this.sealDecision(decision, relationship, evaluationId);

		// Update claim status in store
		switch (relationship) {
			case "supports":
				this.store.updateClaimStatus(claimId, "supported", decision.id);
				break;
			case "partially_supports":
				this.store.updateClaimStatus(claimId, "partially_supported", decision.id);
				break;
			case "contradicts":
				this.store.updateClaimStatus(claimId, "contradicted", decision.id);
				break;
			case "insufficient":
			case "unrelated":
				this.store.updateClaimStatus(claimId, "unverified", decision.id);
				break;
		}

		return { relationship, decision };
	}

	/**
	 * Duplicate logic check: deterministic candidate discovery followed by Jev semantic equivalence check.
	 * R-013 / R-014: Deterministic repository search MUST produce duplicate-logic candidates before Jev judges semantic equivalence.
	 */
	async validateDuplicateLogic(
		candidateExistingLogic: string,
		proposedLogic: string,
	): Promise<{
		sameResponsibility: boolean;
		reusePreferable: "reuse_existing" | "extract_shared" | "separate_required" | "insufficient_evidence";
		decision: ValidationDecision;
	}> {
		const projection = this.projector.duplicateLogic(candidateExistingLogic, proposedLogic);
		const { decision, answers, evaluationId } = await this.runStageValidation("duplicate_logic", projection);

		const respAns = (answers.same_responsibility as { noul?: number } | undefined)?.noul ?? 0;
		const sameResponsibility = evaluateNoul(respAns, "required_true", this.config.thresholds) !== "hard_fail";

		const reuseAns = answers.reuse_preferable as { choice?: string } | undefined;
		const reusePreferable = (reuseAns?.choice as any) ?? "insufficient_evidence";

		this.sealDecision(decision, `${sameResponsibility ? "duplicate" : "unique"}:${reusePreferable}`, evaluationId);

		return { sameResponsibility, reusePreferable, decision };
	}

	/**
	 * Patch review before completing unit of change.
	 * R-056: The final diff MUST pass semantic scope review.
	 */
	async validatePatchReview(changeIds: string[]): Promise<{
		addressesNeed: boolean;
		masksSymptomOnly: boolean;
		architectureFitScore: number;
		regressionSurfaceScore: number;
		decision: ValidationDecision;
	}> {
		const projection = this.projector.patchReview(this.store.snapshot(), changeIds);
		const { decision, answers, evaluationId } = await this.runStageValidation("patch_review", projection);

		const needAns = (answers.addresses_evidenced_need as { noul?: number } | undefined)?.noul ?? 0;
		const addressesNeed = evaluateNoul(needAns, "required_true", this.config.thresholds) !== "hard_fail";

		const symptomAns = (answers.masks_symptom_only as { noul?: number } | undefined)?.noul ?? 0;
		const masksSymptomOnly = evaluateNoul(symptomAns, "required_false", this.config.thresholds) === "hard_fail";

		const archAns = answers.architecture_fit as { score?: number } | undefined;
		const architectureFitScore = archAns?.score ?? 0;

		const regAns = answers.regression_surface as { score?: number } | undefined;
		const regressionSurfaceScore = regAns?.score ?? 0;

		this.sealDecision(decision, addressesNeed && !masksSymptomOnly ? "pass" : "rework", evaluationId);

		return {
			addressesNeed,
			masksSymptomOnly,
			architectureFitScore,
			regressionSurfaceScore,
			decision,
		};
	}

	/**
	 * Drift and loop detection pack.
	 * R-045: Loop detection.
	 */
	async validateDriftLoop(): Promise<{
		goalDrift: boolean;
		repeatedStrategy: boolean;
		staleContextDependency: boolean;
		decision: ValidationDecision;
	}> {
		const projection = this.projector.driftCheck(this.store.snapshot());
		const { decision, answers, evaluationId } = await this.runStageValidation("drift_loop", projection);

		const driftAns = (answers.goal_drift as { noul?: number } | undefined)?.noul ?? 0;
		const goalDrift = evaluateNoul(driftAns, "required_false", this.config.thresholds) === "hard_fail";

		const repeatAns = (answers.repeated_strategy as { noul?: number } | undefined)?.noul ?? 0;
		const repeatedStrategy = evaluateNoul(repeatAns, "required_false", this.config.thresholds) === "hard_fail";

		const staleAns = (answers.stale_context_dependency as { noul?: number } | undefined)?.noul ?? 0;
		const staleContextDependency = evaluateNoul(staleAns, "required_false", this.config.thresholds) === "hard_fail";

		this.sealDecision(
			decision,
			goalDrift || repeatedStrategy || staleContextDependency ? "drift_detected" : "aligned",
			evaluationId,
		);

		if (repeatedStrategy || goalDrift) {
			this.store.transitionPhase("replan_required", true);
		}

		return { goalDrift, repeatedStrategy, staleContextDependency, decision };
	}

	/**
	 * Two-stage completion transaction.
	 * R-001: The worker MUST NOT mark a run complete. It may only emit completion_candidate=true.
	 * R-002: Only the deterministic policy engine may transition phase to complete.
	 * R-020: Deterministic checks MUST run before semantic checks.
	 * R-035: A deterministic failure MUST NOT be overridden by Jev.
	 * R-048: Final completion validation MUST use a fresh cold projection.
	 * R-049: The worker final summary MUST NOT be the primary state.
	 * R-057: Bug-fix completion MUST pass root_cause_addressed.
	 * R-058: A second completion_challenge pack MUST run after primary completion pack.
	 * R-059: Any failed hard completion gate routes to verify_more, retrieve_more, rework, or blocked_external.
	 * R-060: Blocked external dependencies route to blocked_external.
	 * PI-021: External completion gate runs before terminal transition.
	 */
	async executeCompletionTransaction(
		isBugFix = false,
		options?: {
			externalGate?: (snapshot: ExecutionState) => Promise<IntegrityGateResult | undefined>;
			signal?: AbortSignal;
		},
	): Promise<FinalCompletionVerdict> {
		// 1. Evaluate all deterministic gates first (R-020, R-035)
		const detResult = evaluateDeterministicCompletionGates(this.store.snapshot());
		for (const g of detResult.gates) {
			this.store.recordCompletionGate(g);
		}

		if (!detResult.passed) {
			return {
				verdict: "rework",
				failed_gates: detResult.failedReasons,
			};
		}

		// 2. Cold primary completion pack (R-048, R-049)
		const primaryProjection = this.projector.completion(this.store.snapshot());
		const primaryStage = await this.runStageValidation("completion", primaryProjection);

		// 3. Cold challenge pack (R-058)
		const challengeProjection = this.projector.completionChallenge(this.store.snapshot());
		const challengeStage = await this.runStageValidation("completion_challenge", challengeProjection);

		// 4. Policy engine final verdict
		const finalVerdict = decideFinalCompletion({
			deterministicGates: detResult.gates,
			primaryAnswers: primaryStage.answers,
			challengeAnswers: challengeStage.answers,
			isBugFix,
			config: this.config,
		});

		this.sealDecision(primaryStage.decision, finalVerdict.verdict, primaryStage.evaluationId);
		this.sealDecision(challengeStage.decision, finalVerdict.verdict, challengeStage.evaluationId);

		// 5. External completion gate and hooks check (PI-021)
		if (finalVerdict.verdict === "complete") {
			if (options?.externalGate) {
				const extGateResult = await options.externalGate(this.store.snapshot());
				if (extGateResult && extGateResult.decision !== "allow") {
					finalVerdict.verdict = extGateResult.decision === "replan" ? "rework" : "blocked_external";
					finalVerdict.failed_gates.push({
						id: "external_completion_gate",
						reason:
							extGateResult.reasonCodes.join("; ") || `External gate rejected with ${extGateResult.decision}`,
						required_next_proof: "Pass external integrity completion gate",
					});
				}
			}

			if (this.hookCoordinator?.hasExtensions() && finalVerdict.verdict === "complete") {
				const hookResult = await this.hookCoordinator.runHook(
					"completion_candidate",
					{
						schema_version: "1.0",
						run_id: this.store.runId,
						session_id: this.store.runId,
						hook: "completion_candidate",
						impact: "repo_mutation",
					},
					{ signal: options?.signal },
				);
				if (hookResult.decision !== "allow") {
					finalVerdict.verdict = hookResult.decision === "replan" ? "rework" : "blocked_external";
					finalVerdict.failed_gates.push({
						id: "external_hook_gate",
						reason: hookResult.reasonCodes.join("; ") || `Completion hook rejected with ${hookResult.decision}`,
						required_next_proof: "Pass external integrity completion hook",
					});
				}
			}
		}

		// 6. Update state phase according to verdict
		if (finalVerdict.verdict === "complete") {
			// Harness policy transitions to complete (R-002)
			this.store.transitionPhase("complete", true);
			if (this.hookCoordinator?.hasExtensions()) {
				await this.hookCoordinator.runHook(
					"terminal",
					{
						schema_version: "1.0",
						run_id: this.store.runId,
						session_id: this.store.runId,
						hook: "terminal",
						impact: "repo_mutation",
					},
					{ signal: options?.signal },
				);
			}
		} else if (finalVerdict.verdict === "blocked_external") {
			this.store.transitionPhase("blocked_external", true);
		} else if (finalVerdict.verdict === "rework") {
			this.store.transitionPhase("replan_required", true);
		} else {
			this.store.transitionPhase("verifying", true);
		}

		return finalVerdict;
	}
}
