import type { Consequence } from "../decision/primitives.ts";
import type { IntegrityGateResult } from "../hooks/index.ts";
import type { JevAdapter } from "./adapter.ts";
import { AuditStore } from "./audit.ts";
import {
	hashQuestions,
	type QuestionPack,
	SYSTEM_ONE_CATALOG_VERSION,
	SYSTEM_ONE_PINNED_MODEL,
	selectQuestions,
	toTypeSafeEvaluationQuestions,
	USER_AUTHORIZATION_QUESTIONS,
} from "./catalog.ts";
import { type CodeUnit, duplicateQuestionId } from "./code-duplicates.ts";
import { DEFAULT_SYSTEM_ONE_CONFIG, type SystemOneConfig } from "./config.ts";
import {
	directiveFromPostflight,
	directiveFromPreflight,
	directiveFromToolReplan,
	type SystemOneControlDirective,
} from "./control-directive.ts";
import type { CanonicalHydration, ExecutionStore } from "./execution-state.ts";
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
	noulFromAnswer,
} from "./policy.ts";
import { StateProjector } from "./projector.ts";
import type { SemanticEvaluationObserver } from "./semantic-evaluation-ledger.ts";
import type { ExecutionState, ToolImpact, ValidationDecision, ValidationStage } from "./types.ts";

/** The four questions that only mean something when written rules were supplied. */
/** Asked only when written rules exist. `full_handoff` is not among them: it governs owner questions too. */
const RULE_AUTHORITY_QUESTION_IDS: ReadonlySet<string> = new Set([
	"rules_differ",
	"overrides_written_rules",
	"request_holds",
]);

/**
 * Hard ceiling on the rule text one classification carries. The caller decides which rules fit;
 * this only stops a pathological instruction file from crowding out the request itself.
 */
export const USER_REQUEST_RULE_BUDGET = 8_000;

export interface UserRequestClassification {
	readonly capabilitiesAuthorized: boolean;
	readonly localCommitsOnly: boolean;
	readonly liftsDeliveryBlock: boolean;
	readonly rulesDiffer: boolean;
	readonly overridesWrittenRules: boolean;
	readonly fullHandoff: boolean;
	readonly requestHolds: boolean;
}

/**
 * `skipped` means nothing could have changed, so nothing was asked. `unavailable` means the
 * question was asked and System One did not answer -- which is not the same as a clean "no".
 */
export type UserRequestClassificationOutcome =
	| { readonly status: "classified"; readonly classification: UserRequestClassification }
	| { readonly status: "skipped" }
	| { readonly status: "unavailable"; readonly reason: string };

export interface TerminalCompletionProof {
	readonly objectiveId: string;
	readonly candidateDigest: string;
	readonly deliveryCertificateId?: string;
	readonly finalCommit?: string;
	readonly pushRefs?: readonly string[];
}

export class TerminalCompletionConflictError extends Error {
	readonly reason: "conflict" | "invalid_phase" | "empty_proof";

	constructor(reason: "conflict" | "invalid_phase" | "empty_proof") {
		super(`Terminal completion rejected: ${reason}`);
		this.name = "TerminalCompletionConflictError";
		this.reason = reason;
	}
}

/** The terminal hook refused or failed before complete was stored. The store is unchanged. */
export class TerminalHookRejectedError extends Error {
	constructor(detail: string) {
		super(detail || "terminal_hook_rejected");
		this.name = "TerminalHookRejectedError";
	}
}

export function terminalProofRef(input: TerminalCompletionProof): string {
	if (!input.objectiveId.trim() || !input.candidateDigest.trim()) return "";
	return [
		input.objectiveId,
		input.candidateDigest,
		input.deliveryCertificateId ?? "",
		input.finalCommit ?? "",
		...(input.pushRefs ?? []),
	].join("\n");
}

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
	/** Live goal/runtime/verification projection; called before every stage. */
	truthSource?: () => CanonicalHydration | undefined;
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
	private truthSource?: () => CanonicalHydration | undefined;
	private pendingDirective?: SystemOneControlDirective;

	constructor(deps: SystemOneControllerDeps) {
		this.store = deps.store;
		this.adapter = deps.adapter;
		this.projector = deps.projector ?? new StateProjector(deps.userKeys ?? []);
		this.audit = deps.audit ?? new AuditStore();
		this.config = deps.config ?? DEFAULT_SYSTEM_ONE_CONFIG;
		this.hookCoordinator = deps.hookCoordinator;
		this.evaluationObserver = deps.evaluationObserver;
		this.truthSource = deps.truthSource;
	}

	/** Binds the session's evaluation sink; late-bound because the controller is built before the session. */
	setEvaluationObserver(observer: SemanticEvaluationObserver | undefined): void {
		this.evaluationObserver = observer;
	}

	/** Late-bound: the session exists after the controller is constructed. */
	setTruthSource(source: (() => CanonicalHydration | undefined) | undefined): void {
		this.truthSource = source;
	}

	syncCanonicalTruth(): void {
		const hydration = this.truthSource?.();
		if (hydration) this.store.hydrateFromCanonical(hydration);
	}

	hasLiveObjective(): boolean {
		return this.store.hasLiveObjective();
	}

	noteControlDirective(directive: SystemOneControlDirective): void {
		this.pendingDirective = directive;
	}

	peekControlDirective(): SystemOneControlDirective | undefined {
		return this.pendingDirective;
	}

	consumeControlDirective(): SystemOneControlDirective | undefined {
		const directive = this.pendingDirective;
		this.pendingDirective = undefined;
		return directive;
	}

	/**
	 * Seals a stage decision: the durable record (the store mints the one id both stores key), the
	 * audit trail under that same id, and the operator-visible verdict on the evaluation ledger.
	 */
	private sealDecision(
		decision: ValidationDecision,
		policyResult: string,
		evaluationId: string | undefined,
		reasons?: readonly string[],
	): void {
		decision.policy_result = policyResult;
		const { id: _provisional, timestamp: _drafted, ...draft } = decision;
		const sealed = this.store.recordDecision(draft);
		decision.id = sealed.id;
		decision.timestamp = sealed.timestamp;
		this.audit.recordDecision(this.store.runId, sealed);
		if (evaluationId !== undefined) this.evaluationObserver?.noteVerdict(evaluationId, policyResult, reasons);
	}

	private activeEvaluations = 0;
	private evaluationIdleListener?: () => void;

	get isEvaluating(): boolean {
		return this.activeEvaluations > 0;
	}

	/** Fires when the last in-flight stage validation settles. Idle wait uses this instead of polling. */
	setEvaluationIdleListener(listener: (() => void) | undefined): void {
		this.evaluationIdleListener = listener;
	}

	private async runStageValidation(
		stage: ValidationStage,
		stateView: Record<string, unknown>,
		impact: ToolImpact = "read_only",
		omitQuestions: readonly string[] = [],
		/** Questions built for this one evaluation (per-item fan-out); the stage's catalog pack otherwise. */
		builtQuestions?: Readonly<QuestionPack>,
		signal?: AbortSignal,
	): Promise<{ decision: ValidationDecision; answers: Record<string, unknown>; evaluationId: string | undefined }> {
		this.activeEvaluations++;
		try {
			const questions = builtQuestions ?? selectQuestions(stage, omitQuestions);
			const questionsHash = hashQuestions(questions);
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
						questions: toTypeSafeEvaluationQuestions(questions),
					},
					{ impact, ...(signal ? { signal } : {}) },
				);
			} catch (error) {
				if (evaluationId !== undefined) this.evaluationObserver?.settleFailed(evaluationId, error);
				throw error;
			}
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
		} finally {
			this.activeEvaluations--;
			if (this.activeEvaluations === 0) this.evaluationIdleListener?.();
		}
	}

	/**
	 * One classification of the user request: whether it authorizes work, whether delivery is local
	 * commits with push forbidden, and how it stands against the written rules.
	 *
	 * Only questions whose answer can still change something are asked. Every edge class already
	 * granted makes `capabilities_authorized` inert; no written rules makes the four rule questions
	 * inert. An unasked question keeps its neutral answer, so dropping one never changes a verdict.
	 *
	 * A failure is reported as `unavailable`, never as "nothing was asked for". The caller must be
	 * able to tell a classified "no restriction" from a classification that did not run.
	 * Stage-pack intake below is kept for tests and hooks; production admission is SteeringPlane JEV-001..003.
	 */
	async classifyUserRequest(
		request: string,
		writtenRules = "",
		options: { capabilitiesPending?: boolean } = {},
	): Promise<UserRequestClassificationOutcome> {
		const userRequest = request.trim();
		if (!userRequest) return { status: "skipped" };
		const rules = writtenRules.trim().slice(0, USER_REQUEST_RULE_BUDGET);
		const askCapabilities = options.capabilitiesPending !== false;
		const asked: Record<string, unknown> = {};
		for (const [id, question] of Object.entries(USER_AUTHORIZATION_QUESTIONS)) {
			if (id === "capabilities_authorized" && !askCapabilities) continue;
			if (RULE_AUTHORITY_QUESTION_IDS.has(id) && !rules) continue;
			asked[id] = question;
		}
		if (Object.keys(asked).length === 0) return { status: "skipped" };
		let response: Awaited<ReturnType<JevAdapter["evaluate"]>>;
		try {
			response = await this.adapter.evaluate(
				{
					model: this.config.model.production || SYSTEM_ONE_PINNED_MODEL,
					state: {
						user_request: userRequest.slice(0, 4_000),
						written_rules: rules || "(none)",
					},
					questions: toTypeSafeEvaluationQuestions(asked as typeof USER_AUTHORIZATION_QUESTIONS),
				},
				{ impact: "read_only" },
			);
		} catch (error) {
			return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
		}
		// An unasked question is neutral, not false-by-accident: every id here reads "the user is
		// imposing or lifting something", so absent means the request did nothing to that axis.
		const hardYes = (id: string): boolean =>
			id in asked &&
			evaluateNoul(noulFromAnswer(response.answers[id], false), "required_true", this.config.thresholds) ===
				"hard_pass";
		return {
			status: "classified",
			classification: {
				capabilitiesAuthorized: hardYes("capabilities_authorized"),
				localCommitsOnly: hardYes("local_commits_only"),
				liftsDeliveryBlock: hardYes("lifts_delivery_block"),
				rulesDiffer: hardYes("rules_differ"),
				overridesWrittenRules: hardYes("overrides_written_rules"),
				fullHandoff: hardYes("full_handoff"),
				requestHolds: hardYes("request_holds"),
			},
		};
	}

	async validateIntake(): Promise<{
		objectiveClear: boolean;
		taskKind: string;
		externalBlockerPresent: boolean;
		decision: ValidationDecision;
	}> {
		this.syncCanonicalTruth();
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
		this.syncCanonicalTruth();
		const projection = this.projector.preflight(this.store.snapshot(), stepId);
		const { decision, answers, evaluationId } = await this.runStageValidation("preflight", projection);

		const route = decidePreflight(answers, this.config);
		this.sealDecision(decision, route, evaluationId);

		if (route === "replan") {
			this.store.transitionPhase("replan_required", true);
		}
		const directive = directiveFromPreflight(route);
		if (directive) this.noteControlDirective(directive);

		return { route, decision };
	}

	/**
	 * Validate tool gate before execution.
	 * R-020 / R-034 / R-035: Deterministic checks first; Jev cannot override deterministic denials.
	 */
	async validateToolGate(
		toolRequest: { tool: string; intent: string; impact: ToolImpact; args?: unknown; call_id?: string },
		deterministicCheck?: () => { allowed: boolean; reason?: string },
	): Promise<{
		outcome: "allow" | "confirm" | "block" | "replan";
		reason?: string;
		decision?: ValidationDecision;
		toolEventId?: string;
	}> {
		this.syncCanonicalTruth();
		// 1. Run deterministic checks first (R-020, R-034)
		if (deterministicCheck) {
			const det = deterministicCheck();
			if (!det.allowed) {
				// Deterministic failure cannot be overridden by Jev (R-035)
				const denied = this.store.recordToolEvent({
					tool: toolRequest.tool,
					intent: toolRequest.intent,
					impact: toolRequest.impact,
					status: "denied",
					input_payload: toolRequest.args,
					call_id: toolRequest.call_id,
					reason: det.reason,
				});
				return {
					outcome: "block",
					reason: det.reason ?? "Blocked by deterministic tool authorization gate",
					toolEventId: denied.id,
				};
			}
		}

		// 2. Semantic tool gate
		const projection = this.projector.toolGate(this.store.snapshot(), toolRequest);
		// No step to be relevant to (a plain session): the relevance question is not sent at all.
		const relevanceEvaluable = projection.current_step !== undefined;
		const { decision, answers, evaluationId } = await this.runStageValidation(
			"tool_gate",
			projection,
			toolRequest.impact,
			relevanceEvaluable ? [] : ["tool_call_relevant"],
		);

		const outcome = decideToolGate(answers, toolRequest.impact, this.config, { relevanceEvaluable });
		this.sealDecision(decision, outcome, evaluationId);

		const status = outcome === "block" ? "denied" : outcome === "replan" ? "refused" : "allowed";
		if (outcome === "replan") {
			this.noteControlDirective(directiveFromToolReplan(toolRequest.tool));
		}
		const event = this.store.recordToolEvent({
			tool: toolRequest.tool,
			intent: toolRequest.intent,
			impact: toolRequest.impact,
			status,
			input_payload: toolRequest.args,
			call_id: toolRequest.call_id,
			reason: outcome === "replan" ? "not relevant to the current step" : undefined,
		});

		return { outcome, decision, toolEventId: event.id };
	}

	/**
	 * Record a tool call the deterministic gates admitted. No Jev call: relevance and scope are judged
	 * once per step in postflight, over these events, where the step and its evidence are known.
	 */
	recordToolCall(toolRequest: { tool: string; args?: unknown; impact: ToolImpact; call_id: string }): void {
		this.store.recordToolEvent({
			tool: toolRequest.tool,
			intent: describeToolCall(toolRequest.tool, toolRequest.args),
			impact: toolRequest.impact,
			status: "allowed",
			input_payload: toolRequest.args,
			call_id: toolRequest.call_id,
		});
	}

	/**
	 * Ask what the final answer claims, one atomic question per claim kind. Runs with or without a live
	 * objective: a plain session's answer is the user's delivery too. The receipts are combined with
	 * these answers in code; Jev never judges whether something happened from the answer's own words.
	 */
	async evaluateAnswerClaims(finalAnswer: string): Promise<Record<string, unknown>> {
		const { decision, answers, evaluationId } = await this.runStageValidation("claim_delivery", {
			final_answer: this.projector.redactText(finalAnswer),
		});
		// What the ledger keeps: each claim kind with the probability the answer states it.
		const reasons = Object.entries(answers).map(([id, answer]) => `${id} P=${probabilityText(answer)}`);
		this.sealDecision(decision, "evaluated", evaluationId, reasons);
		return answers;
	}

	/**
	 * Every (new unit, candidate) pair in ONE request: Jev evaluates the questions in parallel, so a
	 * change adding three functions with five candidates each costs one call, not three. Each unit and
	 * candidate rides in the state under the key its question names.
	 */
	async evaluateCodeDuplicates(
		pairs: readonly { readonly unit: CodeUnit; readonly candidates: readonly CodeUnit[] }[],
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const state: Record<string, unknown> = {};
		const questions: QuestionPack = {};
		const view = (unit: CodeUnit) => ({
			path: unit.path,
			name: unit.name,
			code: this.projector.redactText(unit.code),
		});
		pairs.forEach(({ unit, candidates }, unitIndex) => {
			state[`u${unitIndex}`] = view(unit);
			candidates.forEach((candidate, candidateIndex) => {
				const key = `u${unitIndex}c${candidateIndex}`;
				state[key] = view(candidate);
				questions[duplicateQuestionId(unitIndex, candidateIndex)] = {
					type: "boolean",
					instructions: `Does \`u${unitIndex}\` do the same job as \`${key}\` (the same inputs lead to the same results or effects), even if written differently?`,
					criteria: {
						true: "Same responsibility: either one could replace the other without changing behavior",
						false: "Different responsibility, or only shares names, types or a few helper calls",
					},
				};
			});
		});
		const { decision, answers, evaluationId } = await this.runStageValidation(
			"code_duplicate",
			state,
			"read_only",
			[],
			questions,
			signal,
		);
		// What the ledger keeps: every judged pair and the probability it is the same job, so a scan or a
		// later review can track duplicates the way a clone report does.
		const reasons = pairs.flatMap(({ unit, candidates }, unitIndex) =>
			candidates.map(
				(candidate, candidateIndex) =>
					`${unit.name} (${unit.path}:${unit.line}) vs ${candidate.name} (${candidate.path}:${candidate.line}) P(same job)=${probabilityText(answers[duplicateQuestionId(unitIndex, candidateIndex)])}`,
			),
		);
		this.sealDecision(decision, "evaluated", evaluationId, reasons);
		return answers;
	}

	/** Record the real terminal after the call ran. No-op when the gate never admitted this call_id. */
	recordToolTerminal(input: { call_id: string; succeeded: boolean; output?: unknown; aborted?: boolean }): void {
		this.store.updateToolEvent(
			{ call_id: input.call_id },
			{
				status: input.aborted ? "aborted" : input.succeeded ? "succeeded" : "failed",
				output_payload: input.output,
			},
		);
	}

	/**
	 * Validate postflight after tool or repo mutation.
	 * R-019: A postflight validation MUST run after each repo mutation, material failed action, or material evidence update.
	 */
	async validatePostflight(stepId: string): Promise<{
		nextStatus: "continue" | "verify" | "retrieve_more" | "replan" | "rollback" | "completion_candidate" | "blocked";
		decision: ValidationDecision;
	}> {
		this.syncCanonicalTruth();
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
		const directive = directiveFromPostflight(nextStatus);
		if (directive) this.noteControlDirective(directive);

		return { nextStatus, decision };
	}

	/**
	 * Production postflight owner for the objective loop. Skips a second Jev call when
	 * the foreground preflight/postflight already recorded a control directive this cycle.
	 */
	async validateObjectivePostflight(objectiveId: string): Promise<void> {
		const pending = this.peekControlDirective();
		if (pending?.source === "preflight" || pending?.source === "postflight") return;
		this.syncCanonicalTruth();
		if (!this.hasLiveObjective()) return;
		await this.validatePostflight(objectiveId);
	}

	/**
	 * Validate claim against cited evidence.
	 * R-009 / R-010: Every material claim MUST reference fresh evidence.
	 */
	/** Stage-pack claim check. Production evidence authority is CompletionCoordinator + runtime evidence. */
	async validateClaimEvidence(
		claimId: string,
		evidenceId: string,
	): Promise<{
		relationship: "supports" | "partially_supports" | "contradicts" | "insufficient" | "unrelated";
		decision: ValidationDecision;
	}> {
		this.syncCanonicalTruth();
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
	 * Duplicate logic stage pack. Production owner is SemanticResponsibilityController + SteeringPlane JEV-041..045.
	 */
	async validateDuplicateLogic(
		candidateExistingLogic: string,
		proposedLogic: string,
	): Promise<{
		sameResponsibility: boolean;
		reusePreferable: "reuse_existing" | "extract_shared" | "separate_required" | "insufficient_evidence";
		decision: ValidationDecision;
	}> {
		this.syncCanonicalTruth();
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
	 * Patch-review stage pack. Production owner is SteeringPlane JEV-025 / completion challenge.
	 */
	async validatePatchReview(changeIds: string[]): Promise<{
		addressesNeed: boolean;
		masksSymptomOnly: boolean;
		architectureFitScore: number;
		regressionSurfaceScore: number;
		decision: ValidationDecision;
	}> {
		this.syncCanonicalTruth();
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
	 * Drift stage pack. Production owner is ObjectiveStallDetector + JEV-004 strategy_repetition.
	 */
	async validateDriftLoop(): Promise<{
		goalDrift: boolean;
		repeatedStrategy: boolean;
		staleContextDependency: boolean;
		decision: ValidationDecision;
	}> {
		this.syncCanonicalTruth();
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
	 * The one production finalization. Records the proof, transitions phase to complete once,
	 * and runs the terminal hook once. A duplicate proof does not transition or hook again.
	 */
	async commitTerminalCompletion(input: TerminalCompletionProof, options?: { signal?: AbortSignal }): Promise<void> {
		const ref = terminalProofRef(input);
		const classified = this.store.classifyTerminalProof(ref);
		if (classified.outcome === "duplicate") return;
		if (classified.outcome === "rejected") {
			throw new TerminalCompletionConflictError(classified.reason);
		}
		// Read-only notification. It runs before complete is stored, so a refusal cannot leave a
		// persisted complete that a later mutation or a failed hook then contradicts.
		if (this.hookCoordinator?.hasExtensions()) {
			const hookResult = await this.hookCoordinator.runHook(
				"terminal",
				{
					schema_version: "1.0",
					run_id: this.store.runId,
					session_id: this.store.runId,
					hook: "terminal",
					impact: "read_only",
				},
				{ signal: options?.signal },
			);
			if (hookResult.decision !== "allow") {
				throw new TerminalHookRejectedError(hookResult.reasonCodes.join("; ") || hookResult.decision);
			}
		}
		const noted = this.store.noteTerminalProof(ref);
		if (noted.outcome === "duplicate") return;
		if (noted.outcome === "rejected") {
			throw new TerminalCompletionConflictError(noted.reason);
		}
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
			persistTerminal?: boolean;
		},
	): Promise<FinalCompletionVerdict> {
		this.syncCanonicalTruth();
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
						impact: "read_only",
					},
					{ signal: options?.signal },
				);
				const mutationRequested = hookResult.reasonCodes.some(
					(code) => code === "mutation_requested" || code === "repo_mutation",
				);
				if (hookResult.decision !== "allow" || mutationRequested) {
					finalVerdict.verdict = hookResult.decision === "replan" ? "rework" : "blocked_external";
					finalVerdict.failed_gates.push({
						id: "external_hook_gate",
						reason: hookResult.reasonCodes.join("; ") || `Completion hook rejected with ${hookResult.decision}`,
						required_next_proof: "Pass external integrity completion hook",
					});
				}
			}
		}

		// 6. Update state phase according to verdict. Omitted or explicit
		// persistTerminal does not persist terminal complete. Only
		// commitTerminalCompletion, called by the outer objective finalization, does.
		if (finalVerdict.verdict === "blocked_external") {
			this.store.transitionPhase("blocked_external", true);
		} else if (finalVerdict.verdict === "rework") {
			this.store.transitionPhase("replan_required", true);
		} else if (this.store.phase !== "complete") {
			this.store.transitionPhase("verifying", true);
		}

		return finalVerdict;
	}
}

const TOOL_INTENT_ARG_KEYS = ["command", "path", "file_path", "pattern", "query", "url", "action", "agentId"] as const;

/**
 * What the call does, from its own arguments: the tool plus its identifying fields, bounded. This is
 * the `intent` postflight judges against the step, so it must describe the call, not just name it.
 */
function describeToolCall(tool: string, args: unknown): string {
	if (!args || typeof args !== "object") return tool;
	const record = args as Record<string, unknown>;
	const parts: string[] = [];
	for (const key of TOOL_INTENT_ARG_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) parts.push(`${key}=${value.trim()}`);
	}
	const text = parts.length > 0 ? `${tool} ${parts.join(" ")}` : tool;
	return text.length <= 240 ? text : `${text.slice(0, 239)}…`;
}

function probabilityText(answer: unknown): string {
	const noul = (answer as { noul?: unknown } | undefined)?.noul;
	return typeof noul === "number" ? noul.toFixed(2) : "none";
}
