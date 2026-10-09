import { isDecisivelyFalse, isDecisivelyTrue } from "../decision/noul.ts";
import type { Consequence } from "../decision/primitives.ts";
import {
	lightweightQuestionId,
	MAX_ROUTE_CHOICE_REQUEST_CHARACTERS,
	ROUTE_CHOICE_QUESTION_ID,
	supersededQuestionId,
} from "../expert-routing/system-one-choice.ts";
import type { IntegrityGateResult } from "../hooks/index.ts";
import { MODEL_POOLS, type ModelPool, type ModelPoolChange } from "../model-router/owner-model-policy.ts";
import {
	MAX_OPTIONAL_TOOL_INTENT_TOOLS,
	MAX_OPTIONAL_TOOL_REQUEST_CHARACTERS,
	type OptionalToolIntent,
	type OptionalToolRequestContext,
	optionalToolIntentFromAnswers,
	traceOptionalToolJudgments,
} from "../tool-applicability-gate.ts";
import type { JevAdapter } from "./adapter.ts";
import { AuditStore } from "./audit.ts";
import { confidenceGate } from "./authority-line.ts";
import {
	hashQuestions,
	modelPoolFollowUp,
	modelPoolQuestions,
	optionalToolRequestQuestions,
	ownerWordsScreenQuestion,
	type QuestionDefinition,
	type QuestionPack,
	SYSTEM_ONE_CATALOG_VERSION,
	SYSTEM_ONE_PINNED_MODEL,
	selectQuestions,
	toTypeSafeEvaluationQuestions,
	USER_AUTHORIZATION_QUESTIONS,
} from "./catalog.ts";
import { type CodeUnit, duplicateQuestionId } from "./code-duplicates.ts";
import {
	type AccountClaim,
	type AccountPassStore,
	accountOutcome,
	type CompletionAccount,
	checkCompletionAccount,
	judgeAccountClaims,
	patchPaths,
} from "./completion-account.ts";
import { DEFAULT_SYSTEM_ONE_CONFIG, type SystemOneConfig } from "./config.ts";
import {
	directiveFromPostflight,
	directiveFromPreflight,
	directiveFromToolReplan,
	isSameLaneVerificationDirective,
	SAME_LANE_VERIFICATION_REASON_CODE,
	type SystemOneControlDirective,
	sameLaneVerificationDirective,
} from "./control-directive.ts";
import type { CanonicalHydration, ExecutionStore } from "./execution-state.ts";
import type { IntegrityHookCoordinator } from "./integrity-hooks.ts";
import { planModelEvaluations } from "./model-evaluation-batches.ts";
import {
	type CompletionRejectionDetail,
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
import {
	doubtReason,
	type SemanticEvaluationObserver,
	type SemanticQuestionState,
} from "./semantic-evaluation-ledger.ts";
import type { ExecutionState, ToolImpact, ValidationDecision, ValidationStage } from "./types.ts";
import { CONSULT_GROUNDING_QUESTIONS, RESERVED_DECISION_KINDS, unsettledQuestionId } from "./unsettled-ladder.ts";
import { VerificationCoordinator, type VerificationHost } from "./verification-coordinator.ts";
import { hasRepositoryOutcome, type WorkDiff } from "./work-diff.ts";

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

/** The owner's request as it is classified, or undefined when it carries no content to classify. */
export function normalizeUserRequest(request: string): string | undefined {
	const userRequest = request.trim();
	return userRequest || undefined;
}

export interface UserRequestClassification {
	readonly optionalToolIntent?: OptionalToolIntent;
	/** Not a clear no: the request may turn a kind of model on or off; ask the pool questions. */
	readonly mayChangeModelPools: boolean;
	readonly capabilitiesAuthorized: boolean;
	readonly localCommitsOnly: boolean;
	readonly liftsDeliveryBlock: boolean;
	readonly rulesDiffer: boolean;
	readonly overridesWrittenRules: boolean;
	readonly fullHandoff: boolean;
	readonly requestHolds: boolean;
}

/**
 * `skipped` means no semantic evaluation ran, so there is no judgment either way: the request was empty,
 * no question could change anything, or no System One controller was bound (the normal-off path). It never
 * means a classified "nothing changed". `unavailable` means the question was asked and System One did not
 * answer -- which is not the same as a clean "no".
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
	/** The work under completion as the repository shows it; read once per completion check. */
	workDiffSource?: () => WorkDiff | undefined;
}

interface StageValidation {
	decision: ValidationDecision;
	answers: Record<string, unknown>;
	evaluationId: string | undefined;
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
/**
 * The longest a stage or an intake classification waits for System One, retries and backoff included: p99 of
 * the recorded stage calls is under 3 s. Past it the call is an outage, which each consumer already handles,
 * instead of holding a turn for the transport's own limit (50 s per attempt, retried).
 */
export const SYSTEM_ONE_STAGE_DEADLINE_MS = 5_000;

/** The one question every route choice asks; a set of option sets asks it once per set. */
function routeChoiceQuestion(options: readonly { id: string; description: string }[]): QuestionDefinition {
	return {
		type: "choice",
		instructions:
			"Which host-approved option best satisfies the selection criteria in `request`? Choose only from the supplied options and follow the request's priorities. Preserve uncertainty when the evidence does not distinguish the options; do not invent confidence.",
		criteria: Object.fromEntries(options.map((option) => [option.id, option.description])),
	};
}

export class SystemOneController {
	readonly store: ExecutionStore;
	readonly adapter: JevAdapter;
	readonly projector: StateProjector;
	readonly audit: AuditStore;
	readonly config: SystemOneConfig;
	readonly hookCoordinator?: IntegrityHookCoordinator;
	private evaluationObserver?: SemanticEvaluationObserver;
	private truthSource?: () => CanonicalHydration | undefined;
	private workDiffSource?: () => WorkDiff | undefined;
	private pendingDirective?: SystemOneControlDirective;
	readonly verification: VerificationCoordinator;

	constructor(deps: SystemOneControllerDeps) {
		this.store = deps.store;
		this.adapter = deps.adapter;
		this.projector = deps.projector ?? new StateProjector(deps.userKeys ?? []);
		this.audit = deps.audit ?? new AuditStore();
		this.config = deps.config ?? DEFAULT_SYSTEM_ONE_CONFIG;
		this.hookCoordinator = deps.hookCoordinator;
		this.evaluationObserver = deps.evaluationObserver;
		this.truthSource = deps.truthSource;
		this.workDiffSource = deps.workDiffSource;
		let verificationRecord: ReturnType<VerificationHost["storage"]["readRecords"]>;
		this.verification = new VerificationCoordinator(
			{
				storage: {
					getBranchKey: () => this.store.runId,
					readRecords: () => verificationRecord,
					appendRecord: (_branch, record) => {
						verificationRecord = record;
					},
				},
				getReceiverId: () => this.store.runId,
				getCandidate: () => ({
					id: this.store.snapshot().repo.baseline_revision,
					scope: this.store.snapshot().repo.root,
					kind: "repository",
				}),
				captureFence: () => () => true,
			},
			async (state, questions, signal) => {
				const result = await this.runStageValidation("evidence_check", state, "read_only", [], questions, signal);
				this.sealDecision(result.decision, "verification_evaluated", result.evaluationId);
				return { id: result.decision.id, answers: result.answers };
			},
		);
	}

	setVerificationHost(host: VerificationHost): void {
		this.verification.bindHost(host);
	}

	/** Binds the session's evaluation sink; late-bound because the controller is built before the session. */
	setEvaluationObserver(observer: SemanticEvaluationObserver | undefined): void {
		this.evaluationObserver = observer;
	}

	/** The session's evaluation sink, for host programs that judge outside a catalog stage (file locate). */
	getEvaluationObserver(): SemanticEvaluationObserver | undefined {
		return this.evaluationObserver;
	}

	/** Late-bound like the truth source. */
	setWorkDiffSource(source: (() => WorkDiff | undefined) | undefined): void {
		this.workDiffSource = source;
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
		if (isSameLaneVerificationDirective(directive)) {
			this.verification.require(
				directive.source,
				directive.reasonCodes.filter((reason) => reason !== SAME_LANE_VERIFICATION_REASON_CODE),
			);
			this.pendingDirective = undefined;
			return;
		}
		this.pendingDirective = directive;
	}

	peekControlDirective(): SystemOneControlDirective | undefined {
		return this.verification.directive() ?? this.pendingDirective;
	}

	consumeControlDirective(expected?: SystemOneControlDirective): SystemOneControlDirective | undefined {
		// Execution acknowledges a route, never the finding that caused it.
		if (this.verification.directive()) return undefined;
		if (expected !== undefined && this.pendingDirective !== expected) return undefined;
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
		questionStates?: readonly SemanticQuestionState[],
	): void {
		decision.policy_result = policyResult;
		const { id: _provisional, timestamp: _drafted, ...draft } = decision;
		const sealed = this.store.recordDecision(draft);
		decision.id = sealed.id;
		decision.timestamp = sealed.timestamp;
		this.audit.recordDecision(this.store.runId, sealed);
		if (evaluationId !== undefined)
			this.evaluationObserver?.noteVerdict(evaluationId, policyResult, reasons, questionStates);
	}

	/** The model's latest account of its work; the completion transaction reads it, whoever asks. */
	private completionAccount: CompletionAccount | undefined;
	/** Times a claim over the same evidence was left unsettled: the model is asked for evidence twice, then the doubt stands. */
	private readonly accountPasses = new Map<string, number>();
	private accountPassStore: AccountPassStore | undefined;
	private accountPassesRead = false;
	private accountPassFailure: string | undefined;

	/** Binds where the unsettled-claim counts live; late-bound like the evaluation observer. */
	setAccountPassStore(store: AccountPassStore | undefined): void {
		this.accountPassStore = store;
		this.accountPassesRead = false;
	}

	noteCompletionAccount(account: CompletionAccount | undefined): void {
		this.completionAccount = account;
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
	): Promise<StageValidation> {
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
					{ impact, timeoutMs: SYSTEM_ONE_STAGE_DEADLINE_MS, ...(signal ? { signal } : {}) },
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
	 * One read-only request about the owner's words, reported on the session's evaluation sink. A failure
	 * is `unavailable` and settles the record; the caller settles a successful one once it has read the
	 * answers.
	 */
	private async evaluateIntake(
		programId: string,
		state: Record<string, unknown>,
		questions: QuestionPack,
		signal: AbortSignal | undefined,
	): Promise<
		| { status: "evaluated"; response: Awaited<ReturnType<JevAdapter["evaluate"]>>; evaluationId: string | undefined }
		| { status: "unavailable"; reason: string }
	> {
		const model = this.config.model.production || SYSTEM_ONE_PINNED_MODEL;
		const evaluationId = this.evaluationObserver?.start({
			programId,
			consequence: consequenceForImpact("read_only"),
			model,
		});
		try {
			const response = await this.adapter.evaluate(
				{ model, state, questions: toTypeSafeEvaluationQuestions(questions) },
				{ impact: "read_only", timeoutMs: SYSTEM_ONE_STAGE_DEADLINE_MS, ...(signal ? { signal } : {}) },
			);
			return { status: "evaluated", response, evaluationId };
		} catch (error) {
			if (evaluationId !== undefined) {
				if (signal?.aborted) this.evaluationObserver?.settleCancelled(evaluationId);
				else this.evaluationObserver?.settleFailed(evaluationId, error);
			}
			return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
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
		/** `signal`: the owner's submission; an abort before the run starts cancels the classification too. */
		options: { capabilitiesPending?: boolean; signal?: AbortSignal; optionalTools?: OptionalToolRequestContext } = {},
	): Promise<UserRequestClassificationOutcome> {
		const userRequest = normalizeUserRequest(request);
		if (userRequest === undefined) return { status: "skipped" };
		const rules = writtenRules.trim().slice(0, USER_REQUEST_RULE_BUDGET);
		const askCapabilities = options.capabilitiesPending !== false;
		const asked: QuestionPack = {};
		for (const [id, question] of Object.entries(USER_AUTHORIZATION_QUESTIONS)) {
			if (id === "capabilities_authorized" && !askCapabilities) continue;
			if (RULE_AUTHORITY_QUESTION_IDS.has(id) && !rules) continue;
			asked[id] = question;
		}
		const optionalTools = options.optionalTools;
		const optionalToolsFit =
			optionalTools !== undefined &&
			userRequest.length <= MAX_OPTIONAL_TOOL_REQUEST_CHARACTERS &&
			optionalTools.candidates.length <= MAX_OPTIONAL_TOOL_INTENT_TOOLS;
		if (optionalToolsFit) Object.assign(asked, optionalToolRequestQuestions(optionalTools));
		if (Object.keys(asked).length === 0) return { status: "skipped" };
		const evaluated = await this.evaluateIntake(
			"system-one:intake",
			{
				user_request: userRequest.slice(0, 4_000),
				written_rules: rules || "(none)",
				...(optionalToolsFit
					? {
							optional_tools: optionalTools.candidates,
							previous_optional_tool_intent: optionalTools.previous ?? null,
							pending_owner_requests: optionalTools.pendingRequests ?? [],
						}
					: {}),
			},
			asked,
			options.signal,
		);
		if (evaluated.status === "unavailable") return evaluated;
		const { response, evaluationId } = evaluated;
		const intentFloor = this.config.thresholds.choice.hard_gate_auto_confidence;
		const optionalToolIntent = optionalTools
			? optionalToolIntentFromAnswers(userRequest, optionalTools, response.answers, intentFloor)
			: undefined;
		if (evaluationId !== undefined) {
			const trace =
				optionalToolsFit && optionalTools
					? traceOptionalToolJudgments(optionalTools, response.answers, intentFloor)
					: [];
			this.evaluationObserver?.settleOk(
				evaluationId,
				optionalToolIntent ? `optional tools ${optionalToolIntent.status}` : "evaluated",
				trace.map((entry) => entry.text),
				trace,
			);
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
				...(optionalToolIntent ? { optionalToolIntent } : {}),
				mayChangeModelPools:
					"changes_model_pools" in asked &&
					evaluateNoul(
						noulFromAnswer(response.answers.changes_model_pools, false),
						"required_true",
						this.config.thresholds,
					) !== "hard_fail",
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

	/**
	 * Which of the queued owner messages may carry an instruction: one request, one question per message.
	 * A message is reported as not carrying one only when the screen's "only small talk" answer is a hard pass; an unsure
	 * answer or an outage reports it as carrying, so the caller classifies it in full. The screen can
	 * cost a call, never lose an instruction.
	 */
	async screenOwnerWords(
		messages: readonly string[],
		options: { signal?: AbortSignal } = {},
	): Promise<{ status: "screened"; carriesInstruction: boolean[] } | { status: "unavailable"; reason: string }> {
		if (messages.length === 0) return { status: "screened", carriesInstruction: [] };
		const asked: QuestionPack = {};
		messages.forEach((_message, index) => {
			asked[`carries_${index}`] = ownerWordsScreenQuestion(index);
		});
		const evaluated = await this.evaluateIntake(
			"system-one:intake-screen",
			{ owner_messages: messages.map((message) => message.trim().slice(0, 1_000)) },
			asked,
			options.signal,
		);
		if (evaluated.status === "unavailable") return evaluated;
		const { response, evaluationId } = evaluated;
		const carriesInstruction = messages.map(
			(_message, index) =>
				evaluateNoul(
					noulFromAnswer(response.answers[`carries_${index}`], false),
					"required_true",
					this.config.thresholds,
				) !== "hard_pass",
		);
		if (evaluationId !== undefined) this.evaluationObserver?.settleOk(evaluationId, "owner words screened", [], []);
		return { status: "screened", carriesInstruction };
	}

	/**
	 * What the request does to each model pool. A pool Choice at 0.90 or above decides; one between
	 * 0.80 and 0.90 is settled by a narrower yes/no follow-up in a second request, all such pools at
	 * once; anything lower changes nothing and is reported as a doubt.
	 */
	async evaluateModelPools(
		request: string,
		signal?: AbortSignal,
	): Promise<{ change: ModelPoolChange; doubts: string[] }> {
		const state = { user_request: this.projector.redactText(request.trim().slice(0, 4_000)) };
		const questions = modelPoolQuestions();
		const first = await this.runStageValidation("intake", state, "read_only", [], questions, signal);
		const change: ModelPoolChange = {};
		const doubts: string[] = [];
		const followUps: QuestionPack = {};
		const followUpDirections = new Map<ModelPool, boolean>();
		const reasons: string[] = [];
		const questionStates: SemanticQuestionState[] = [];
		for (const pool of MODEL_POOLS) {
			const questionId = `model_pool_${pool}`;
			const answer = first.answers[questionId] as { choice?: unknown; confidence?: unknown } | undefined;
			if (answer === undefined) continue;
			if (answer.choice !== "enable" && answer.choice !== "disable" && answer.choice !== "unchanged") {
				const text = `${questionId}: answer was not a recognized choice`;
				doubts.push(`${pool} models: answer was inconclusive, not applied`);
				reasons.push(doubtReason(text));
				questionStates.push({ question: questionId, uncertain: true });
				continue;
			}
			if (answer.choice === "unchanged") {
				if (confidenceGate(answer.confidence) === "decide") {
					reasons.push(`${questionId}: unchanged (${String(answer.confidence)})`);
					questionStates.push({ question: questionId, uncertain: false });
				} else {
					doubts.push(`${pool} models: unchanged at confidence ${String(answer.confidence)}, not applied`);
					reasons.push(doubtReason(`${questionId}: unchanged answer is inconclusive`));
					questionStates.push({ question: questionId, uncertain: true });
				}
				continue;
			}
			const enable = answer.choice === "enable";
			const gate = confidenceGate(answer.confidence);
			if (gate === "decide") {
				change[pool] = enable;
				reasons.push(`${questionId}: ${answer.choice} (${String(answer.confidence)})`);
				questionStates.push({ question: questionId, uncertain: false });
			} else if (gate === "ask_more") {
				followUps[questionId] = modelPoolFollowUp(pool, enable);
				followUpDirections.set(pool, enable);
				reasons.push(doubtReason(`${questionId}: ${answer.choice} awaits a follow-up`));
				questionStates.push({ question: questionId, uncertain: true });
			} else {
				doubts.push(`${pool} models: "${answer.choice}" at confidence ${String(answer.confidence)}, not applied`);
				reasons.push(doubtReason(`${questionId}: ${answer.choice} is below the decision threshold`));
				questionStates.push({ question: questionId, uncertain: true });
			}
		}
		this.sealDecision(first.decision, "evaluated", first.evaluationId, reasons, questionStates);
		if (Object.keys(followUps).length === 0) return { change, doubts };
		const second = await this.runStageValidation("intake", state, "read_only", [], followUps, signal);
		const followUpReasons: string[] = [];
		const followUpQuestionStates: SemanticQuestionState[] = [];
		for (const [pool, enable] of followUpDirections) {
			const questionId = `model_pool_${pool}`;
			const answer = second.answers[questionId];
			if (isDecisivelyTrue(answer)) {
				change[pool] = enable;
				followUpReasons.push(`${questionId}: follow-up confirmed ${enable ? "enable" : "disable"}`);
				followUpQuestionStates.push({ question: questionId, uncertain: false });
			} else if (isDecisivelyFalse(answer)) {
				followUpReasons.push(`${questionId}: follow-up ruled out ${enable ? "enable" : "disable"}`);
				followUpQuestionStates.push({ question: questionId, uncertain: false });
			} else {
				doubts.push(
					`${pool} models: "${enable ? "enable" : "disable"}" not confirmed by the follow-up, not applied`,
				);
				followUpReasons.push(doubtReason(`${questionId}: follow-up remains inconclusive`));
				followUpQuestionStates.push({ question: questionId, uncertain: true });
			}
		}
		this.sealDecision(second.decision, "evaluated", second.evaluationId, followUpReasons, followUpQuestionStates);
		return { change, doubts };
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
	 * Record a tool call the deterministic gates admitted. No System One call: relevance and scope are judged
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
	 * these answers in code; System One never judges whether something happened from the answer's own words.
	 */
	async evaluateAnswerClaims(finalAnswer: string): Promise<Record<string, unknown>> {
		const { decision, answers, evaluationId } = await this.runStageValidation("claim_delivery", {
			final_answer: this.projector.redactText(finalAnswer),
		});
		// What the ledger keeps: the typed claim judgment (including current-vs-historical provenance).
		const reasons = Object.entries(answers).map(([id, answer]) => {
			const typed = answer as { choice?: unknown; confidence?: unknown } | undefined;
			if (typeof typed?.choice === "string") {
				const confidence =
					typeof typed.confidence === "number" &&
					Number.isFinite(typed.confidence) &&
					typed.confidence >= 0 &&
					typed.confidence <= 1
						? typed.confidence.toFixed(2)
						: "none";
				return `${id} choice=${typed.choice} confidence=${confidence}`;
			}
			return `${id} P=${probabilityText(answer)}`;
		});
		this.sealDecision(decision, "evaluated", evaluationId, reasons);
		return answers;
	}

	/**
	 * Every (new unit, candidate) pair in ONE request: System One evaluates the questions in parallel, so a
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

	/**
	 * Whether each piece of evidence shows its statement true, and separately whether it shows it
	 * false: two one-condition Nouls per item, every item in ONE request. Evidence that shows neither
	 * leaves the item unsettled; that is an answer, not a failure.
	 */
	async evaluateUnsettledItems(
		checks: readonly { readonly statement: string; readonly evidence: string }[],
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const state: Record<string, unknown> = {};
		const questions: QuestionPack = {};
		checks.forEach((check, index) => {
			state[`s${index}`] = this.projector.redactText(check.statement);
			state[`e${index}`] = this.projector.redactText(check.evidence);
			// Wording measured against live System One (docs/system-one.md): refutation is asked as "contradict",
			// with criteria naming what a contradicting result looks like.
			questions[unsettledQuestionId("shows_true", index)] = {
				type: "boolean",
				instructions: `Does \`e${index}\` show that \`s${index}\` is true?`,
				criteria: {
					true: "The evidence reports the statement's outcome directly",
					false: "The evidence reports a different outcome, or says nothing about it",
				},
			};
			questions[unsettledQuestionId("shows_false", index)] = {
				type: "boolean",
				instructions: `Does \`e${index}\` contradict \`s${index}\`?`,
				criteria: {
					true: "The evidence reports a result that makes the statement untrue (a failure, a rejection, a different value)",
					false: "The evidence agrees with the statement or says nothing about it",
				},
			};
		});
		const { decision, answers, evaluationId } = await this.runStageValidation(
			"unsettled_item",
			state,
			"read_only",
			[],
			questions,
			signal,
		);
		const reasons = checks.map(
			(check, index) =>
				`${check.statement.slice(0, 120)} P(shown true)=${probabilityText(answers[unsettledQuestionId("shows_true", index)])} P(shown false)=${probabilityText(answers[unsettledQuestionId("shows_false", index)])}`,
		);
		this.sealDecision(decision, "evaluated", evaluationId, reasons);
		return answers;
	}

	/**
	 * Whether a question asks for a decision the owner reserves: one Noul per reserved kind, in one
	 * request. Under a handoff the agents may decide everything else.
	 */
	async evaluateReservedDecision(
		input: { readonly question: string; readonly request: string },
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const questions: QuestionPack = Object.fromEntries(
			Object.entries(RESERVED_DECISION_KINDS).map(([id, question]) => [id, { type: "boolean", ...question }]),
		);
		const { decision, answers, evaluationId } = await this.runStageValidation(
			"unsettled_item",
			{ question: this.projector.redactText(input.question), request: this.projector.redactText(input.request) },
			"read_only",
			[],
			questions,
			signal,
		);
		const reasons = Object.keys(RESERVED_DECISION_KINDS).map((id) => `${id} P=${probabilityText(answers[id])}`);
		this.sealDecision(decision, "evaluated", evaluationId, reasons);
		return answers;
	}

	/** Whether a consult answer's quoted basis tells the agent to do what the answer says. */
	async evaluateConsultGrounding(
		input: { readonly basis: string; readonly question: string; readonly answer: string },
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const redact = (text: string) => this.projector.redactText(text);
		const { decision, answers, evaluationId } = await this.runStageValidation(
			"unsettled_item",
			{ basis: redact(input.basis), question: redact(input.question), answer: redact(input.answer) },
			"read_only",
			[],
			CONSULT_GROUNDING_QUESTIONS,
			signal,
		);
		const reasons = Object.keys(CONSULT_GROUNDING_QUESTIONS).map((id) => `${id} P=${probabilityText(answers[id])}`);
		this.sealDecision(decision, "evaluated", evaluationId, reasons);
		return answers;
	}

	/**
	 * One Choice among host-approved options, following the caller's selection criteria.
	 * The caller validates the choice before applying its model, effort, or peer selection.
	 */
	async evaluateRouteChoice(
		input: { readonly request: string; readonly options: readonly { id: string; description: string }[] },
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		return this.runRouteChoice(
			input.request,
			{ [ROUTE_CHOICE_QUESTION_ID]: routeChoiceQuestion(input.options) },
			input.options,
			signal,
		);
	}

	/**
	 * One Choice per option set over the same request, in ONE request: System One evaluates the questions in
	 * parallel, so the first pass and every narrower follow-up cost one round trip. Each result is shaped as a
	 * single route choice's answers, so a caller reads it exactly as it would read `evaluateRouteChoice`.
	 */
	async evaluateRouteChoiceSet(
		input: {
			readonly request: string;
			readonly optionSets: readonly (readonly { id: string; description: string }[])[];
		},
		signal?: AbortSignal,
	): Promise<Record<string, unknown>[]> {
		const questionId = (index: number) =>
			index === 0 ? ROUTE_CHOICE_QUESTION_ID : `${ROUTE_CHOICE_QUESTION_ID}_set_${index}`;
		const questions: QuestionPack = Object.fromEntries(
			input.optionSets.map((options, index) => [questionId(index), routeChoiceQuestion(options)]),
		);
		const answers = await this.runRouteChoice(input.request, questions, input.optionSets[0] ?? [], signal);
		return input.optionSets.map((_options, index) => ({ [ROUTE_CHOICE_QUESTION_ID]: answers[questionId(index)] }));
	}

	/** The route-choice stage: one request, sealed with what the first question chose among `firstOptions`. */
	private async runRouteChoice(
		request: string,
		questions: QuestionPack,
		firstOptions: readonly { id: string; description: string }[],
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const { decision, answers, evaluationId } = await this.runStageValidation(
			"route_choice",
			{ request: this.projector.redactText(request.slice(0, MAX_ROUTE_CHOICE_REQUEST_CHARACTERS)) },
			"read_only",
			[],
			questions,
			signal,
		);
		const first = answers[ROUTE_CHOICE_QUESTION_ID] as { choice?: unknown; confidence?: unknown } | undefined;
		const chosen = firstOptions.find((option) => option.id === first?.choice);
		this.sealDecision(decision, "evaluated", evaluationId, [
			`chose ${chosen?.description.split(";")[0] ?? String(first?.choice)} at confidence ${String(first?.confidence)} of ${firstOptions.length} options`,
		]);
		return answers;
	}

	/** One Noul per model, with independent evidence grouped into bounded requests. */
	evaluateLightweightModels(
		input: { readonly models: readonly { id: string; description: string }[] },
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		return this.evaluatePerModel(input.models, lightweightQuestionId, "lightweight", signal, (index) => ({
			type: "boolean",
			instructions: `Is \`models.m${index}\` a lightweight variant built for speed and low cost (a flash, mini, lite, fast or spark variant) rather than a full-size model?`,
		}));
	}

	/** One Noul per model; every bounded question batch retains the entire comparison universe. */
	evaluateSupersededModels(
		input: { readonly models: readonly { id: string; description: string }[] },
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		return this.evaluatePerModel(input.models, supersededQuestionId, "superseded", signal, (index) => ({
			type: "boolean",
			instructions: `Is a later version of the same model as \`models.m${index}\` among \`models\`?`,
			criteria: {
				true: "The same model family and tier with a higher version number, such as Flash 3.8 for Flash 3.6",
				false: "No higher version of this same model; a different family, or another effort preset of the same version, does not count",
			},
		}));
	}

	/** One classification owner: admit complete batches, record every evaluation, publish only after all finish. */
	private async evaluatePerModel(
		models: readonly { id: string; description: string }[],
		questionId: (index: number) => string,
		label: "lightweight" | "superseded",
		signal: AbortSignal | undefined,
		question: (index: number) => QuestionDefinition,
	): Promise<Record<string, unknown>> {
		signal?.throwIfAborted();
		const pinnedModel = this.config.model.production || SYSTEM_ONE_PINNED_MODEL;
		let batches: ReturnType<typeof planModelEvaluations>;
		try {
			batches = planModelEvaluations(models, pinnedModel, label === "superseded", questionId, question);
		} catch (error) {
			const id = this.evaluationObserver?.start({
				programId: "system-one:route_choice",
				consequence: "low",
				model: pinnedModel,
			});
			if (id !== undefined) this.evaluationObserver?.settleFailed(id, error);
			throw error;
		}
		const combined: Record<string, unknown> = {};
		for (const batch of batches) {
			signal?.throwIfAborted();
			const { decision, answers, evaluationId } = await this.runStageValidation(
				"route_choice",
				batch.state,
				"read_only",
				[],
				batch.questions,
				signal,
			);
			this.sealDecision(
				decision,
				"evaluated",
				evaluationId,
				batch.indexes.map(
					(index) => `${models[index].id} P(${label})=${probabilityText(answers[questionId(index)])}`,
				),
			);
			signal?.throwIfAborted();
			for (const index of batch.indexes) combined[questionId(index)] = answers[questionId(index)];
		}
		return combined;
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
		this.verification.assertResolved();
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
		this.verification.assertResolved();
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
	 * Bug-fix root-cause findings remain recorded advice after deterministic proof.
	 * R-058: A second completion_challenge pack MUST run after primary completion pack.
	 * Failed deterministic and external gates still refuse completion.
	 * R-060: Blocked external dependencies route to blocked_external.
	 * PI-021: External completion gate runs before terminal transition.
	 */
	/**
	 * What every completion judgment reads: the cold completion projection (outcome evidence per
	 * criterion; the repository diff only when the goal changed the repository) and whether it did.
	 */
	completionView(): { view: Record<string, unknown>; repositoryOutcome: boolean } {
		this.syncCanonicalTruth();
		const work = this.workDiffSource?.();
		const snapshot = this.store.snapshot();
		return {
			view: this.projector.completion(snapshot, work),
			repositoryOutcome: hasRepositoryOutcome(work, snapshot.changes.length),
		};
	}

	private readAccountPasses(): void {
		if (this.accountPassesRead || !this.accountPassStore) return;
		this.accountPassesRead = true;
		try {
			for (const [fingerprint, passes] of Object.entries(this.accountPassStore.read()))
				this.accountPasses.set(fingerprint, Math.max(passes, this.accountPasses.get(fingerprint) ?? 0));
		} catch (error) {
			this.accountPassFailure = error instanceof Error ? error.message : String(error);
		}
	}

	private writeAccountPasses(unsettled: readonly AccountClaim[]): void {
		if (!this.accountPassStore) return;
		try {
			for (const claim of unsettled)
				this.accountPassStore.write(claim.fingerprint, this.accountPasses.get(claim.fingerprint) ?? 0);
		} catch (error) {
			this.accountPassFailure = error instanceof Error ? error.message : String(error);
		}
	}

	async executeCompletionTransaction(
		isBugFix = false,
		options?: {
			externalGate?: (snapshot: ExecutionState) => Promise<IntegrityGateResult | undefined>;
			signal?: AbortSignal;
			persistTerminal?: boolean;
		},
	): Promise<FinalCompletionVerdict> {
		options?.signal?.throwIfAborted();
		this.syncCanonicalTruth();
		const pendingVerification = this.verification.status().obligations;
		if (pendingVerification.length)
			return {
				verdict: "verify_more",
				failed_gates: pendingVerification.map((finding) => ({
					id: finding.id,
					reason: finding.reason,
					required_next_proof:
						"Resolve with receiving-lane evidence through peer resolve before retrying completion.",
				})),
			};
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

		// 2. Cold primary completion pack (R-048, R-049). Code-only questions are asked only when the goal
		// changed the repository; a machine, service or answer outcome is judged on its outcome evidence.
		const work = this.workDiffSource?.();
		if (work?.diagnostic) {
			return {
				verdict: "blocked_external",
				failed_gates: [
					{
						id: "repository_outcome_evidence_unavailable",
						reason: work.diagnostic,
						required_next_proof:
							"Recover the retained repository baseline and read current outcome evidence before retrying completion. This is a host-evidence diagnostic, not a production defect.",
					},
				],
			};
		}
		const snapshot = this.store.snapshot();
		const repositoryOutcome = hasRepositoryOutcome(work, snapshot.changes.length);
		// What needs reasoning about the change is the model's account of it; code checks that it is complete,
		// that its evidence exists and is verified, and System One decides each claim against that evidence.
		const checkedAccount = checkCompletionAccount(
			this.completionAccount,
			{
				objective: snapshot.objective.normalized_goal || snapshot.objective.request,
				acceptance: snapshot.objective.acceptance_criteria.map((criterion) => ({
					id: criterion.id,
					text: criterion.text,
				})),
				changedPaths: [
					...new Set([
						...patchPaths(work?.patch ?? ""),
						...(work?.untracked ?? []),
						...snapshot.changes.map((change) => change.path),
					]),
				],
				patch: work?.patch ?? "",
				...(work?.suppressions ? { suppressions: work.suppressions } : {}),
				state: snapshot,
			},
			{ repositoryOutcome, isBugFix },
		);
		if (checkedAccount.failures.length > 0) return { verdict: "verify_more", failed_gates: checkedAccount.failures };
		const primaryOmit: string[] = [];
		const primaryProjection = this.projector.completion(this.store.snapshot(), work);
		const challengeProjection = this.projector.completionChallenge(this.store.snapshot(), work);
		const stages = new Map<ValidationStage, StageValidation>();
		const unavailable: CompletionRejectionDetail[] = [];
		// The account's claims are judged beside the stages, in the same round trip's time. Started here and
		// awaited below; an abandoned wait must not surface as an unhandled rejection.
		const judgingAccount: Promise<{ refuted: AccountClaim[]; unsettled: AccountClaim[] }> | undefined =
			checkedAccount.claims.length > 0
				? judgeAccountClaims(
						{ evaluateUnsettledItems: (checks, signal) => this.evaluateUnsettledItems(checks, signal) },
						checkedAccount.claims,
						options?.signal,
						this.config,
					)
				: undefined;
		judgingAccount?.catch(() => undefined);
		// Each judgment remains useful if its peer fails. Cancellation is never converted to advice. The stages read
		// the same state and cannot see one another's answers, so they wait on System One together; an abandoned
		// wait must not surface as an unhandled rejection.
		options?.signal?.throwIfAborted();
		const started = (
			[
				["completion", primaryProjection, primaryOmit],
				["completion_challenge", challengeProjection, []],
			] as const
		).map(([stage, projection, omitted]) => {
			const run = this.runStageValidation(stage, projection, "read_only", omitted, undefined, options?.signal);
			run.catch(() => undefined);
			return { stage, run };
		});
		for (const { stage, run } of started) {
			try {
				stages.set(stage, await run);
			} catch (error) {
				options?.signal?.throwIfAborted();
				unavailable.push({
					id: `JEV-${stage}-unavailable`,
					reason: `${stage} advice unavailable: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`,
					required_next_proof: "Inspect the recorded outcome evidence and evaluator diagnostic.",
				});
			}
		}
		options?.signal?.throwIfAborted();
		let accountFailures: CompletionRejectionDetail[] = [];
		let accountAdvisories: CompletionRejectionDetail[] = [];
		if (judgingAccount) {
			try {
				const judged = await judgingAccount;
				this.readAccountPasses();
				({ failures: accountFailures, advisories: accountAdvisories } = accountOutcome(judged, this.accountPasses));
				this.writeAccountPasses(judged.unsettled);
				if (this.accountPassFailure)
					accountAdvisories.push({
						id: "account_passes_not_kept",
						reason: `The count of unsettled claims could not be kept (${this.accountPassFailure}); it lasts for this session only.`,
						required_next_proof: "None required.",
					});
			} catch (error) {
				options?.signal?.throwIfAborted();
				unavailable.push({
					id: "JEV-account-unavailable",
					reason: `account advice unavailable: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`,
					required_next_proof: "Inspect the recorded outcome evidence and evaluator diagnostic.",
				});
			}
		}

		// 4. Policy engine final verdict
		const finalVerdict = decideFinalCompletion({
			deterministicGates: detResult.gates,
			primaryAnswers: stages.get("completion")?.answers,
			challengeAnswers: stages.get("completion_challenge")?.answers,
			accountFailures,
			config: this.config,
		});

		if (unavailable.length > 0 || accountAdvisories.length > 0)
			finalVerdict.advisories = [...unavailable, ...accountAdvisories, ...(finalVerdict.advisories ?? [])];
		// A claim in the model's own account is answered with better evidence, not with a verification obligation
		// that holds every other operation until it is resolved.
		const verifiable = finalVerdict.failed_gates.filter((finding) => !finding.id.startsWith("account_"));
		if (finalVerdict.verdict === "verify_more" && verifiable.length > 0) {
			this.noteControlDirective(
				sameLaneVerificationDirective(
					verifiable.map((finding) => `${finding.id}: ${finding.reason}. ${finding.required_next_proof}`),
				),
			);
		}
		for (const stage of stages.values()) {
			this.sealDecision(
				stage.decision,
				finalVerdict.verdict,
				stage.evaluationId,
				finalVerdict.advisories?.map((item) => `Advice: ${item.reason}`),
			);
		}

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

		if (finalVerdict.verdict === "complete" && this.verification.status().obligations.length) {
			finalVerdict.verdict = "verify_more";
			finalVerdict.failed_gates.push(
				...this.verification.status().obligations.map((finding) => ({
					id: finding.id,
					reason: finding.reason,
					required_next_proof: "Resolve receiving-lane verification.",
				})),
			);
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
