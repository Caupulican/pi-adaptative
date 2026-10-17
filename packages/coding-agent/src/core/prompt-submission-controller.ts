/**
 * Foreground prompt submission, slash-command and template expansion, queued-submission
 * serialization, routed-turn preflight/postflight, and post-turn recall scoring.
 */

import type { Api, AssistantMessage, ImageContent, Model, TextContent } from "@caupulican/pi-ai";
import { type Agent, AgentBusyError } from "../kernel/agent.ts";
import { type CustomMessage, createCustomMessage } from "../kernel/messages.ts";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import type { AgentMessage } from "../kernel/types.ts";
import type { AdaptiveRuntimeReadiness } from "./adaptive/adaptive-runtime-readiness.ts";
import { resourceDir } from "./agent-paths.ts";
import type { AgentSessionEvent, PromptOptions } from "./agent-session-contracts.ts";
import { executeSystemOnePostflight, executeSystemOnePreflight } from "./agent-session-guards.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import type { RouteDecision } from "./autonomy/contracts.ts";
import type { BackgroundLaneController } from "./background-lane-controller.ts";
import type { CompactionController } from "./compaction-controller.ts";
import type { CacheCustody } from "./context/cache-custody.ts";
import { cacheLaneKey } from "./context/cache-observation-recorder.ts";
import type { CostGuardController } from "./cost-guard-controller.ts";
import type { ContextUsage, ExtensionRunner } from "./extensions/index.ts";
import type { ForegroundRecoveryController, ForegroundSubmissionLease } from "./foreground-recovery-controller.ts";
import {
	GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE,
	OBJECTIVE_ROUTE_PROMPT_PREFIX,
} from "./goals/goal-continuation-prompt.ts";
import type { GoalSessionController } from "./goals/goal-session-controller.ts";
import { type ExplicitGoalStartAuthority, parseExplicitGoalStartAuthority } from "./goals/natural-language-goal.ts";
import type { LocalPrefixWarmController } from "./local-prefix-warm-controller.ts";
import type { LocalRuntimeController } from "./local-runtime-controller.ts";
import type { MemoryController } from "./memory-controller.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { AccountModelCatalog } from "./model-router/account-models.ts";
import type { ModelRouterController } from "./model-router-controller.ts";
import type { PendingInputHandle, PendingInputQueueController } from "./pending-input-queue-controller.ts";
import { createActivePipelineContextMessage, type PipelineRun } from "./pipelines/index.ts";
import type { DurableOwnerRuleStore } from "./project-rules/durable-owner-rules.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ReflectionController } from "./reflection-controller.ts";
import type { ReflectionTurnLifecycle } from "./reflection-turn-lifecycle.ts";
import { CONVERSATION_TALKER_CUSTOM_TYPE } from "./reply-route.ts";
import type { RuntimeBuilder } from "./runtime-builder.ts";
import type { OwnerRequestClassificationOutcome } from "./session-edge-intent-controller.ts";
import { isSessionSettled, type SessionSettlementState } from "./session-settlement.ts";
import type { SessionWorkState } from "./session-work-state.ts";
import type { MemorySystem } from "./settings/settings-schema.ts";
import { assistantAnswerText } from "./system-one/claim-delivery.ts";
import type { SystemOneController } from "./system-one/controller.ts";
import type { OwnerPolicyQueue } from "./system-one/owner-policy-queue.ts";
import type { SystemPromptBuilder } from "./system-prompt-builder.ts";
import { formatTaskStepsContext, type TaskStepsState } from "./tasks/task-state.ts";
import type { ToolProtocolController } from "./tool-protocol-controller.ts";

/** An owner interrupt arrived while a submission was still preparing its turn (see `prompt`). */
export class SubmissionPreflightAborted extends Error {
	constructor() {
		super("The submission was interrupted before its turn started.");
		this.name = "SubmissionPreflightAborted";
	}
}

export interface OwnerRequestClassificationResult {
	readonly status: string;
	readonly cancelled?: boolean;
	readonly contextChanged?: boolean;
	readonly superseded?: boolean;
	readonly reason?: string;
	readonly [key: string]: unknown;
}

export interface PromptSubmissionControllerDeps {
	readonly agent: Agent;
	readonly sessionManager: Pick<SessionManager, "getLatestCustomEntryOnBranch" | "getMessageEntryId">;
	readonly pendingQueue: PendingInputQueueController;
	readonly compaction: Pick<CompactionController, "cancelIdlePreparation">;
	readonly ownerRules: Pick<DurableOwnerRuleStore, "record">;
	readonly backgroundLanes: Pick<BackgroundLaneController, "clearGoalAutoContinueTimer">;
	readonly reflectionTurnLifecycle: Pick<ReflectionTurnLifecycle, "preemptFor" | "startDueTurn">;
	readonly foregroundRecovery: Pick<
		ForegroundRecoveryController,
		| "tryAcquireSubmission"
		| "releaseSubmission"
		| "hasLiveConsumer"
		| "acquireSubmissionOrJoinLiveConsumer"
		| "bindSubmissionSignal"
	>;
	readonly toolProtocol: Pick<
		ToolProtocolController,
		"applyRepairLayerSettings" | "resetTurnState" | "recordParseOutcomeFromLastAssistant"
	>;
	readonly localPrefixWarm: Pick<LocalPrefixWarmController, "cancel">;
	readonly goals: Pick<
		GoalSessionController,
		| "resumeSystemBlockedGoal"
		| "startOwnerChatGoal"
		| "beginExecution"
		| "setStartAuthority"
		| "endQueuedOwnerChatGoalExecution"
		| "endExecution"
	>;
	readonly costGuard: Pick<CostGuardController, "beginForegroundTurn">;
	readonly reflection: Pick<ReflectionController, "markOwnerInput" | "queueExternalRootTurnCue">;
	readonly earlyDisplayedUserMessages: Set<AgentMessage>;
	readonly ownerPolicy: Pick<OwnerPolicyQueue<OwnerRequestClassificationOutcome>, "settle">;
	/** Owner words join the owner-policy queue, with the judgment they received at submission if any (`SessionEdgeIntentController.enqueueOwnerWords`). */
	enqueueOwnerWords(
		text: string,
		acceptedOrder: number | undefined,
		judgment: OwnerRequestClassificationOutcome | undefined,
		signal?: AbortSignal,
	): void;
	readonly accountModels: Pick<AccountModelCatalog, "ready">;
	readonly custody: Pick<CacheCustody, "sanction" | "withdraw" | "request">;
	readonly localRuntimeController: Pick<LocalRuntimeController, "ensureForegroundModelReady">;
	readonly modelRegistry: Pick<ModelRegistry, "hasConfiguredAuth" | "isUsingOAuth">;
	readonly memory: Pick<
		MemoryController,
		"clearAdmittedRecall" | "shouldAttemptRecall" | "prefetchRecall" | "takeAdmittedRecall" | "recordRecallOutcome"
	>;
	readonly pendingNextTurnMessages: CustomMessage[];
	readonly systemPromptBuilder: Pick<SystemPromptBuilder, "getBaseSystemPromptOptions">;
	readonly runtimeBuilder: Pick<RuntimeBuilder, "withTaskDirectoryContext">;
	readonly modelRouter: Pick<ModelRouterController, "routeOwnerMessage" | "runRoutedTurn">;
	readonly sessionSettlementState: SessionSettlementState;
	getExtensionRunner(): Pick<
		ExtensionRunner,
		"getCommand" | "hasHandlers" | "emitInput" | "emitBeforeAgentStart" | "emit"
	>;
	getBaseSystemPrompt(): string;

	getSessionWorkState(): SessionWorkState;
	emitQueueUpdate(): void;
	classifyOwnerRequest(
		request: string,
		rules?: string,
		capabilitiesPending?: boolean,
		signal?: AbortSignal,
		acceptedOrder?: number,
	): Promise<OwnerRequestClassificationResult>;
	/**
	 * The full classification of a queued owner input's words, once, before it is admitted; applied where the owner-policy
	 * queue settles it (see `SessionEdgeIntentController.judgeOwnerRequest`).
	 */
	judgeQueuedOwnerRequest(
		request: string,
		signal: AbortSignal | undefined,
		acceptedOrder: number | undefined,
	): Promise<OwnerRequestClassificationOutcome>;
	getOperatorBlocker(): string | undefined;
	setOperatorBlocker(blocker: string | undefined): void;
	/** Input admitted to the agent's queue that no live consumer is left to drain returns to the pending queue, held. */
	holdUndeliveredQueue(): void;
	isStreaming(): boolean;
	getPromptTemplates(): readonly PromptTemplate[];
	isDisposed(): boolean;
	getAdaptiveReadiness(): AdaptiveRuntimeReadiness | undefined;
	flushPendingBashMessages(): void;
	emit(event: AgentSessionEvent): void;
	leaveUnavailableSessionModel(): Promise<unknown>;
	getContextUsage(): ContextUsage | undefined;
	sideTripApproves(model: Model<Api>, text: string): boolean;
	ensureRouteModelReady(
		routeInfo: { decision: RouteDecision; model: Model<Api> } | undefined,
	): Promise<{ decision: RouteDecision; model: Model<Api> } | undefined>;
	adoptTalker(model: Model<Api>, decision: RouteDecision): Promise<void>;
	getModel(): Model<Api> | undefined;
	checkContextWindowUsageWarning(): void;
	findLastAssistantMessage(): AssistantMessage | undefined;
	checkCompaction(lastAssistant: AssistantMessage, continueAfter: boolean): Promise<boolean>;
	getTaskStepsStateSnapshot(): TaskStepsState | undefined;
	getMemorySystem(): MemorySystem;
	getAgentDir(): string;
	getCwd(): string;
	getPipelineRunSnapshot(): PipelineRun | undefined;
	isSystemPromptCold(routedTurnModel: Model<Api> | undefined): boolean;
	atColdMoment(reason: string): void;
	noteSystemOneTaskDirectoryUnavailable(error: unknown): void;
	getSystemOneController(): SystemOneController | undefined;
	enableCapabilitiesAuthorizedByUser(
		userRequest: string,
		signal?: AbortSignal,
		trustedOwner?: boolean,
		acceptedOrder?: number,
	): Promise<string | undefined>;
	announceOwnerFollowUpsWhenPresent(): void;
	runToolkitHit(scriptName: string, messages: readonly AgentMessage[], signal?: AbortSignal): Promise<void>;
	/** The turn is found from its opening message: the first message its run sends. */
	claimCorrection(turnOpening: AgentMessage): Promise<string | undefined> | undefined;
	flushOwnerItems(lease?: ForegroundSubmissionLease): Promise<void>;
	scheduleIdleWork(options: PromptOptions | undefined, afterPrompt: boolean): void;
	hasPendingIdleContinuation(): boolean;
	isSessionSettled?(): boolean;
	checkOrphanedObjectiveWatchdog(): unknown;
}

export class PromptSubmissionController {
	private readonly deps: PromptSubmissionControllerDeps;
	private streamingPromptSubmissionTail: Promise<void> = Promise.resolve();
	private submissionAbort: AbortController | undefined;
	private foregroundPromptLeaseValue: ForegroundSubmissionLease | undefined;
	private lastUserRequestValue = "";
	private ownerSubmissionOrder = 0;

	constructor(deps: PromptSubmissionControllerDeps) {
		this.deps = deps;
	}

	get isPreparingSubmission(): boolean {
		return Boolean(this.submissionAbort && !this.deps.isStreaming());
	}

	get foregroundPromptLease(): ForegroundSubmissionLease | undefined {
		return this.foregroundPromptLeaseValue;
	}

	get lastUserRequest(): string {
		return this.lastUserRequestValue;
	}

	setLastUserRequest(value: string): void {
		this.lastUserRequestValue = value;
	}

	/**
	 * The owner's words submitted through `steer()`/`followUp()`: they take the next owner submission order and are the
	 * owner speaking, exactly as a prompt's words are (see `noteOwnerSpoke`). Returns the order their judgment carries.
	 */
	acceptQueuedOwnerWords(text: string): number {
		const acceptedOrder = ++this.ownerSubmissionOrder;
		this.noteOwnerSpoke(text);
		return acceptedOrder;
	}

	/** Only the owner's own words are policy and answer a blocker: an extension's message or a host-authored turn is neither. */
	private noteOwnerSpoke(text: string): void {
		// An owner development directive is policy, not prompt text: it is captured durably here,
		// before the turn that carried it can be compacted away.
		this.deps.ownerRules.record(text);
		// The owner spoke: an operator blocker waited for exactly that.
		if (this.deps.getOperatorBlocker() !== undefined) this.deps.setOperatorBlocker(undefined);
	}

	abortSubmission(reason?: unknown): void {
		this.submissionAbort?.abort(reason);
	}

	consumeEarlyDisplayedUserMessage(message: AgentMessage): boolean {
		return this.deps.earlyDisplayedUserMessages.delete(message);
	}

	get earlyDisplayedUserMessages(): Set<AgentMessage> {
		return this.deps.earlyDisplayedUserMessages;
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		// The owner's submission order, fixed now: every judgment of this submission carries it.
		const acceptedOrder =
			options?.internalContextType || options?.source === "extension" ? undefined : ++this.ownerSubmissionOrder;
		// A queued submission (the owner's, or an extension's such as a peer message) is pending from this
		// moment, in submission order, before anything below can await: it is visible, takeable, and
		// cancelled with the pending queue. Only the owner's words are classified as owner intent.
		const queuedOwnerInput =
			this.deps.getSessionWorkState().busy && options?.streamingBehavior && !options.internalContextType
				? this.deps.pendingQueue.register(options.streamingBehavior, text, options.images, options.origin)
				: undefined;
		if (queuedOwnerInput) this.deps.emitQueueUpdate();
		// Judged in full once, here: the same judgment decides whether it is admitted and is applied where it is read.
		const queuedOwnerClassification =
			queuedOwnerInput && acceptedOrder !== undefined
				? this.deps.judgeQueuedOwnerRequest(
						text,
						options?.signal
							? AbortSignal.any([options.signal, queuedOwnerInput.signal])
							: queuedOwnerInput.signal,
						acceptedOrder,
					)
				: undefined;
		try {
			// The owner spoke: a summary being prepared while the lane idled never makes them wait.
			this.deps.compaction.cancelIdlePreparation();
			// `acceptedOrder` is defined for owner input only: an extension's message (a peer's) is not the owner speaking.
			if (acceptedOrder !== undefined) this.noteOwnerSpoke(text);
			if (options?.autoContinueGoal !== false) {
				this.deps.backgroundLanes.clearGoalAutoContinueTimer();
			}
			await this.deps.reflectionTurnLifecycle.preemptFor(options);
		} catch (error) {
			if (queuedOwnerInput) this.withdrawQueuedOwnerInput(queuedOwnerInput);
			throw error;
		}
		const submissionLease = this.deps.foregroundRecovery.tryAcquireSubmission();
		if (!submissionLease && this.deps.getSessionWorkState().busy && options?.streamingBehavior) {
			// Queued submissions prepare one at a time, in submission order, but the next one waits only
			// for this one's PREPARATION (queued, withdrawn, or its own turn started), never its whole turn.
			const { promise: preparedGate, resolve: prepared } = Promise.withResolvers<void>();
			const start = () =>
				this.runPromptSubmission(
					text,
					options,
					undefined,
					queuedOwnerClassification,
					queuedOwnerInput,
					prepared,
					acceptedOrder,
				);
			const run = this.streamingPromptSubmissionTail.then(start, start);
			this.streamingPromptSubmissionTail = preparedGate;
			return run;
		}
		return this.runPromptSubmission(
			text,
			options,
			submissionLease,
			queuedOwnerClassification,
			queuedOwnerInput,
			undefined,
			acceptedOrder,
		);
	}

	/**
	 * Give back a queued owner input whose submission ends without admitting it: withdrawn while still pending, or held
	 * when its own turn took it and never delivered it. A no-op once it is admitted, or delivered by its turn.
	 */
	withdrawQueuedOwnerInput(input: PendingInputHandle): void {
		const changed = this.deps.pendingQueue.withdraw(input) || this.deps.pendingQueue.reclaim(input);
		if (changed) this.deps.emitQueueUpdate();
	}

	/**
	 * Release the early-painted echo of a turn that never reached its run. An echo of a queued owner input is withdrawn
	 * from the transcript, because that input is held in the pending queue instead and must not read as sent.
	 */
	private releaseEarlyDisplayedUserMessage(
		message: AgentMessage | undefined,
		queuedOwnerInput: PendingInputHandle | undefined,
	): void {
		if (message === undefined || !this.deps.earlyDisplayedUserMessages.delete(message)) return;
		if (queuedOwnerInput !== undefined) this.deps.emit({ type: "user_message_withdrawn", message });
	}

	/**
	 * A queued owner input's own turn ended. Its message in the transcript delivers the input; a message that never
	 * reached it (a buffered cheap-route turn that failed, say) is retracted from the echo, and its input is held.
	 */
	private settleOrRetractOwnedEcho(message: AgentMessage): void {
		if (this.deps.sessionManager.getMessageEntryId(message) !== undefined) {
			this.deps.pendingQueue.settleOwnedMessage(message);
		} else {
			this.deps.emit({ type: "user_message_withdrawn", message });
		}
	}

	private async runPromptSubmission(
		text: string,
		options?: PromptOptions,
		initialSubmissionLease?: ForegroundSubmissionLease,
		queuedOwnerClassification?: Promise<OwnerRequestClassificationOutcome>,
		queuedOwnerInput?: PendingInputHandle,
		prepared?: () => void,
		acceptedOrder?: number,
	): Promise<void> {
		const submission = { lease: initialSubmissionLease };
		if (submission.lease) this.foregroundPromptLeaseValue = submission.lease;
		// The submission's own abort: before its run exists (routing, System One classification) an owner
		// interrupt reaches it through `abort()`; the caller's signal still aborts it too. A queued
		// submission prepares while another turn may own the foreground, so it takes the interrupt slot
		// only once it owns the foreground itself; until then the pending queue cancels it.
		const submissionAbort = new AbortController();
		const ownsForeground = (): void => {
			this.submissionAbort = submissionAbort;
		};
		if (submission.lease) ownsForeground();
		const signal = options?.signal
			? AbortSignal.any([options.signal, submissionAbort.signal])
			: submissionAbort.signal;
		try {
			await this.promptUnserialized(
				text,
				{ ...options, signal },
				submission,
				queuedOwnerClassification,
				queuedOwnerInput,
				{
					acceptedOrder,
					ownsForeground: () => {
						ownsForeground();
						// Its preparation is complete: the next queued submission may prepare while this turn runs.
						prepared?.();
					},
				},
			);
		} finally {
			prepared?.();
			// Every exit that did not admit it (cancelled, handled, a command, an error) gives it back: withdrawn while
			// pending, held when its own turn took it and never delivered it.
			if (queuedOwnerInput) this.withdrawQueuedOwnerInput(queuedOwnerInput);
			if (this.submissionAbort === submissionAbort) this.submissionAbort = undefined;
			if (submission.lease) {
				if (this.foregroundPromptLeaseValue === submission.lease) this.foregroundPromptLeaseValue = undefined;
				this.deps.foregroundRecovery.releaseSubmission(submission.lease);
			}
			// Input admitted to the agent's queue waits for a run to drain it. When this submission leaves no live
			// consumer behind (its preparation ended without a run), that input is held rather than stranded.
			if (!this.deps.foregroundRecovery.hasLiveConsumer && this.deps.agent.hasQueuedMessages()) {
				this.deps.holdUndeliveredQueue();
			}
		}
		// Started after the lease is released, never before: the reflection turn is an ordinary
		// submission and would deadlock against the lease this one still holds inside the try above.
		// NOT awaited — the caller's answer must not wait on reflection — but tracked by the lifecycle.
		this.deps.reflectionTurnLifecycle.startDueTurn(options);
	}

	private async promptUnserialized(
		text: string,
		options: PromptOptions | undefined,
		submission: { lease?: ForegroundSubmissionLease },
		queuedOwnerClassification?: Promise<OwnerRequestClassificationOutcome>,
		queuedOwnerInput?: PendingInputHandle,
		lifecycle?: { acceptedOrder?: number; ownsForeground(): void },
	): Promise<void> {
		const submissionSignal = options?.signal;
		// Fast path for a submission cancelled before it ever started: nothing has been built, painted or
		// queued yet, so there is nothing to unwind. The authoritative check is the one just before the
		// run, which also covers an abort arriving during the preflight awaits below.
		if (submissionSignal?.aborted) {
			options?.preflightResult?.(false);
			return;
		}
		this.deps.toolProtocol.applyRepairLayerSettings();
		this.deps.localPrefixWarm.cancel();
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const processSlashCommands = options?.processSlashCommands ?? expandPromptTemplates;
		const preflightResult = options?.preflightResult;
		let messages: AgentMessage[] | undefined;
		let routedTurnModel: Model<Api> | undefined;
		let routedTurnRouteDecision: RouteDecision | undefined;
		// An exact toolkit hit the harness runs itself, with no model (see `runToolkitHit`).
		let toolkitHit: string | undefined;
		// Built and painted early (see below) so a later throw in this try block — e.g. no model
		// selected/authenticated — can un-register it from earlyDisplayedUserMessages instead of
		// leaking the reference forever.
		let userMessage: AgentMessage | undefined;
		let promptMessage: AgentMessage | undefined;
		let routingStarted = false;
		let pendingNextTurnCount = 0;
		// Effectiveness feedback: remember the extension recall page + the query so we can score, after the
		// response, whether the agent actually used the recalled context. Past-session history is scored
		// from what the prompt memory block admitted (see `takeAdmittedRecall`), not from this page.
		let injectedRecall = "";
		let recallQuery = "";
		let admittedGoalId = options?.goalExecutionId;
		let goalToolStartAuthority: ExplicitGoalStartAuthority | undefined;
		let userRequest = text;
		// The judgment this queued owner input's words already received, if they did: they are never judged again.
		let ownerJudgment: OwnerRequestClassificationOutcome | undefined;

		try {
			if (queuedOwnerClassification) {
				const classified = await queuedOwnerClassification;
				ownerJudgment = classified;
				if ("cancelled" in classified && classified.cancelled && classified.contextChanged && queuedOwnerInput)
					this.deps.pendingQueue.hold(queuedOwnerInput);
				if (submissionSignal?.aborted || ("cancelled" in classified && classified.cancelled)) return;
			}
			// Handle extension commands first. Programmatic extension messages may opt
			// into command handling; if the agent is currently streaming, queue the
			// command for the end of the run instead of sending it to the model.
			if (processSlashCommands && text.startsWith("/")) {
				if (this.deps.isStreaming() && options?.source === "extension" && options?.streamingBehavior) {
					const commandName = this.deps.pendingQueue.parseCommandName(text);
					if (this.deps.getExtensionRunner().getCommand(commandName)) {
						this.deps.pendingQueue.queueExtensionCommand(text);
						this.deps.emitQueueUpdate();
						preflightResult?.(true);
						return;
					}
				}
				const handled = await this.deps.pendingQueue.tryExecuteExtensionCommand(text);
				if (handled) {
					// Extension command executed, no prompt to send
					preflightResult?.(true);
					return;
				}
			}

			// Emit input event for extension interception (before skill/template expansion)
			let currentText = text;
			let currentImages = options?.images;
			if (this.deps.getExtensionRunner().hasHandlers("input")) {
				const inputResult = await this.deps
					.getExtensionRunner()
					.emitInput(
						currentText,
						currentImages,
						options?.source ?? "interactive",
						this.deps.isStreaming() ? options?.streamingBehavior : undefined,
					);
				if (inputResult.action === "handled") {
					preflightResult?.(true);
					return;
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this.deps.pendingQueue.expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.deps.getPromptTemplates()]);
			}

			if (!options?.internalContextType) goalToolStartAuthority = parseExplicitGoalStartAuthority(expandedText);
			userRequest = expandedText;

			// If streaming — or waiting out a retry backoff, which is still an active
			// operation — queue via steer() or followUp() instead of starting a
			// concurrent run that would race the pending retry continuation.
			if (!submission.lease) {
				submission.lease = this.deps.foregroundRecovery.tryAcquireSubmission();
			}
			if (!submission.lease && options?.streamingBehavior && !this.deps.foregroundRecovery.hasLiveConsumer) {
				// Busy, but with no run that would drain the agent's queue (compaction, an answer under
				// evaluation, another submission still preparing or finishing its turn, an extension command):
				// a message handed over now would wait for an unrelated later turn, or be held when that
				// submission ends without a run. It waits for the foreground, still pending, and runs as
				// its own turn; later submissions queue into that turn behind it. If a run that drains the
				// queue starts while it waits, it queues behind that run instead of waiting the whole run out.
				const cancelled = [submissionSignal, queuedOwnerInput?.signal].filter(
					(signal): signal is AbortSignal => signal !== undefined,
				);
				const acquired = await this.deps.foregroundRecovery.acquireSubmissionOrJoinLiveConsumer(
					AbortSignal.any(cancelled),
				);
				if (acquired === undefined) return;
				if (acquired !== "live_consumer") submission.lease = acquired;
			}
			if (!submission.lease) {
				if (!options?.streamingBehavior) {
					throw new AgentBusyError(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.internalContextType) {
					// A hidden internal turn is no one's input: it goes straight to the agent's queue.
					if (options.streamingBehavior === "followUp") {
						this.deps.pendingQueue.queueFollowUp(expandedText, currentImages, goalToolStartAuthority);
					} else {
						this.deps.pendingQueue.queueSteer(expandedText, currentImages, goalToolStartAuthority);
					}
					this.deps.emitQueueUpdate();
					preflightResult?.(true);
					return;
				}
				// Only the owner's words carry owner evidence and are judged as owner intent; an extension's
				// message (a peer's, say) is held in the same pending queue, but never classified.
				const ownerOriginalText = options.source !== "extension" ? text : undefined;
				// An input that became queued only after prompt() returned to its caller's turn registers
				// here; one registered at submission keeps its original place.
				const pending =
					queuedOwnerInput ??
					this.deps.pendingQueue.register(options.streamingBehavior, text, options.images, options.origin);
				let admitted = false;
				// Set when the consumer this input was to join ended while it was being classified and the foreground came
				// free: the input then runs as its own turn below instead of entering a queue that no run drains.
				let ownTurn = false;
				try {
					if (ownerOriginalText !== undefined) {
						const classified = await (queuedOwnerClassification ??
							this.deps.judgeQueuedOwnerRequest(
								ownerOriginalText,
								submissionSignal ? AbortSignal.any([submissionSignal, pending.signal]) : pending.signal,
								lifecycle?.acceptedOrder,
							));
						ownerJudgment = classified;
						if ("cancelled" in classified && classified.cancelled && classified.contextChanged)
							this.deps.pendingQueue.hold(pending);
						if (submissionSignal?.aborted || ("cancelled" in classified && classified.cancelled)) return;
					} else if (submissionSignal?.aborted || pending.signal.aborted) {
						return;
					}
					if (this.deps.isDisposed()) return;
					// The handover needs a consumer that is live now, not only when it was chosen: the classification above
					// awaited, and that run may have delivered its last round meanwhile. Read with no await before `admit`.
					while (!this.deps.foregroundRecovery.hasLiveConsumer) {
						const acquired = await this.deps.foregroundRecovery.acquireSubmissionOrJoinLiveConsumer(
							submissionSignal ? AbortSignal.any([submissionSignal, pending.signal]) : pending.signal,
						);
						if (acquired === undefined) return;
						// Stored before any further exit, so `runPromptSubmission` releases it on every path.
						if (acquired !== "live_consumer") submission.lease = acquired;
						if (this.deps.isDisposed()) return;
						if (submission.lease) {
							ownTurn = true;
							break;
						}
					}
					if (!ownTurn) {
						const judged = ownerJudgment;
						const judgedOrder = lifecycle?.acceptedOrder;
						admitted = this.deps.pendingQueue.admit(pending, {
							text: expandedText,
							...(currentImages ? { images: currentImages } : {}),
							...(goalToolStartAuthority ? { queuedGoalAuthority: goalToolStartAuthority } : {}),
							...(ownerOriginalText !== undefined ? { ownerOriginalText } : {}),
							// The owner's admitted words become policy when the run delivers them, never when they are taken
							// back, cleared or held first: their judgment is applied where it is read.
							...(ownerOriginalText !== undefined && judged !== undefined
								? { onDelivered: () => this.deps.enqueueOwnerWords(ownerOriginalText, judgedOrder, judged) }
								: {}),
						});
					}
				} finally {
					// An input registered at submission that runs as its own turn stays pending: that turn takes it (`promote`).
					if (!ownTurn || pending !== queuedOwnerInput) this.withdrawQueuedOwnerInput(pending);
					this.deps.emitQueueUpdate();
				}
				if (!ownTurn) {
					// An owner submission was accepted when it was submitted; an extension's message is accepted
					// only once the pending queue holds it, so its sender is never told of a message that is gone.
					preflightResult?.(ownerOriginalText !== undefined || admitted);
					return;
				}
			}
			// This submission would run as its own turn now. Only an input still pending here may: one the
			// owner took back, cleared or that changed context meanwhile never runs. Ownership moves to
			// the turn without cancelling it.
			if (queuedOwnerInput) {
				if (!this.deps.pendingQueue.promote(queuedOwnerInput)) {
					this.deps.emitQueueUpdate();
					preflightResult?.(false);
					return;
				}
				this.deps.emitQueueUpdate();
			}
			lifecycle?.ownsForeground();
			this.foregroundPromptLeaseValue = submission.lease;

			if (!options?.internalContextType) {
				// The owner's own prompt: a system-blocked goal always resumes here and its automatic
				// recovery allowance restarts (goal-state.ts `resume_goal` without source "system").
				const recoveredGoalId = this.deps.goals.resumeSystemBlockedGoal(undefined, "owner");
				const startedGoalId = this.deps.goals.startOwnerChatGoal(expandedText, this.deps.agent.state.messages);
				admittedGoalId = startedGoalId ?? recoveredGoalId ?? admittedGoalId;
				if (admittedGoalId && this.deps.getAdaptiveReadiness()) {
					this.deps.getAdaptiveReadiness()!.assertReady({ adaptiveEnabled: true });
				}
			}

			// Queued steer/follow-up messages remain in the active turn; only a new submission resets the
			// cost controller's spawned-usage baseline shared by every round trip in this turn.
			this.deps.costGuard.beginForegroundTurn();

			// Flush any pending bash messages before the new prompt
			this.deps.flushPendingBashMessages();

			// Build the user message now — before the router judge — and paint it to the UI
			// immediately via a synthetic message_start. The judge is a real bounded LLM completion
			// (seconds), not a regex; awaiting it first made the prompt appear to hang. The
			// authoritative message_start emitted later for this SAME object is suppressed in
			// _handleAgentEvent (see earlyDisplayedUserMessages) so it is still shown exactly once.
			if (options?.internalContextType) {
				if (currentImages && currentImages.length > 0) {
					throw new Error("Internal context turns do not accept image attachments.");
				}
				promptMessage = createCustomMessage(
					options.internalContextType,
					expandedText,
					false,
					undefined,
					new Date().toISOString(),
				);
			} else {
				const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
				if (currentImages) userContent.push(...currentImages);
				userMessage = {
					role: "user",
					content: userContent,
					timestamp: Date.now(),
				};
				if (options?.source !== "extension") this.deps.reflection.markOwnerInput(userMessage, text);
				promptMessage = userMessage;
				// A queued input its own turn took is delivered by this message's persistence, not by the turn's end.
				if (queuedOwnerInput) this.deps.pendingQueue.bindOwnedMessage(queuedOwnerInput, userMessage);
				this.deps.earlyDisplayedUserMessages.add(userMessage);
				this.deps.emit({ type: "message_start", message: userMessage });
			}

			// Bracket the routing/prep phase (judge, model/auth checks, compaction, ...) so the UI can
			// show general "working" feedback for it — otherwise the user stares at their own echoed
			// prompt with nothing happening for however long the judge takes. routing_end is emitted
			// exactly once below: either in the catch block (this phase failed) or right after the try
			// block (this phase succeeded, whether or not it produced a turn to run).
			routingStarted = true;
			this.deps.emit({ type: "routing_start" });

			// Words left from earlier turns that used no tool are read before this turn is routed, so a model
			// pool change they make holds for this turn's allocation as it did when every turn classified.
			// A submission cancelled while it waits here (an owner interrupt, or the session closing) ends as a cancelled preflight,
			// not as the abort error of whatever it was waiting on.
			try {
				await this.deps.ownerPolicy.settle("backlog", submissionSignal);

				// Before anything is routed or sent: what the owner's accounts actually offer.
				await this.deps.accountModels.ready(submissionSignal);
			} catch (error: unknown) {
				if (submissionSignal?.aborted) throw new SubmissionPreflightAborted();
				throw error;
			}
			if (submissionSignal?.aborted) throw new SubmissionPreflightAborted();
			await this.deps.leaveUnavailableSessionModel();
			// Facts a route cannot be chosen without: an image needs a model that reads images, and the
			// context this turn sends must fit the window.
			const routeFacts = {
				hasImages: (currentImages?.length ?? 0) > 0,
				contextTokens: this.deps.getContextUsage()?.tokens ?? 0,
			};
			let resolvedRouteInfo: { decision: RouteDecision; model: Model<Api> } | undefined;
			// Internally generated turns (goal continuation, a route brief, lane follow-ups, reflection) run on
			// the root lane: the talker, on its warm cache, with no tier swap. Work meant for another model
			// goes to a worker through the objective route, never to a swapped root turn.
			if (options?.autoContinueGoal !== false) {
				// An owner message: the talker answers, a small message takes a side trip, and the first
				// substantive message chooses the talker once (conversation-continuity stages 0-1).
				const route = await this.deps.modelRouter.routeOwnerMessage(expandedText, {
					talkerChosen:
						this.deps.sessionManager.getLatestCustomEntryOnBranch(CONVERSATION_TALKER_CUSTOM_TYPE) !== undefined,
					...routeFacts,
					sideTripApproves: (model) => this.deps.sideTripApproves(model, expandedText),
				});
				if (route.kind === "opening") {
					const ready = await this.deps.ensureRouteModelReady(route);
					if (ready) await this.deps.adoptTalker(ready.model, ready.decision);
				} else if (route.kind === "side_trip") {
					resolvedRouteInfo = route;
					// A side trip sends its own small brief, never the lane's earlier one: its first request is a
					// deliberate new prefix on that lane.
					this.deps.custody.sanction("side_trip_brief", "a side trip sends its own small brief", {
						lane: cacheLaneKey(route.model.api, route.model.provider, route.model.id),
					});
				} else if (
					route.kind === "toolkit" &&
					this.deps.agent.state.tools.some((tool) => tool.name === "run_toolkit_script")
				) {
					toolkitHit = route.scriptName;
				}
			}
			// #27: a route landing on a local (ollama) model must not hard-fail the turn just because
			// the server isn't up yet — boot/reuse it here, or escalate to a non-local tier.
			const readyRouteInfo = await this.deps.ensureRouteModelReady(resolvedRouteInfo);
			routedTurnModel = readyRouteInfo?.model;
			routedTurnRouteDecision = readyRouteInfo?.decision;
			const requestModel = routedTurnModel ?? this.deps.getModel();

			// Validate model
			if (!requestModel) {
				throw new Error(formatNoModelSelectedMessage());
			}
			if (currentImages && currentImages.length > 0 && !requestModel.input.includes("image")) {
				throw new Error(
					`Model "${requestModel.provider}/${requestModel.id}" does not accept image input. Select an image-capable model or route the inspection to a vision worker.`,
				);
			}
			// A manual/default local model has no RouteDecision, so the router readiness gate above is
			// intentionally a no-op. It still needs the same managed-runtime boot/residency guarantee.
			if (!resolvedRouteInfo) {
				await this.deps.localRuntimeController.ensureForegroundModelReady(requestModel);
			}

			if (!this.deps.modelRegistry.hasConfiguredAuth(requestModel)) {
				const isOAuth = this.deps.modelRegistry.isUsingOAuth(requestModel);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${requestModel.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${requestModel.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(requestModel.provider));
			}

			this.deps.checkContextWindowUsageWarning();

			// Check if we need to compact before sending (catches aborted responses).
			// Do not call agent.continue() here: the next model turn must include the
			// user's pending prompt, not an empty continuation after compaction.
			const lastAssistant = this.deps.findLastAssistantMessage();
			if (lastAssistant) {
				await this.deps.checkCompaction(lastAssistant, false);
			}

			// Build messages array (recall page, then custom message if any, then user message)
			messages = [];

			// Stable turn-owned timestamps preserve the prompt prefix across requests.
			const turnTimestamp = new Date(promptMessage.timestamp).toISOString();

			// Past-session history is retrieved with the other memory providers and admitted by the prompt
			// memory block. This page carries only extension lifecycle providers' own prefetch output.
			// Recall is data, gated before I/O; ICM and trivial turns skip it.
			this.deps.memory.clearAdmittedRecall();
			if (!options?.internalContextType && this.deps.memory.shouldAttemptRecall(expandedText)) {
				try {
					const recall = await this.deps.memory.prefetchRecall(expandedText);
					if (recall) {
						injectedRecall = recall;
						recallQuery = expandedText;
						// Custom context prevents recalled snippets recirculating through transcript indexing.
						messages.push(createCustomMessage("memory_context", recall, false, undefined, turnTimestamp));
					}
				} catch {
					// recall must never break a turn
				}
			}

			// Queue one durable logical cue. ProviderRequestContextController owns its transient preview
			// and accepted-plan commit, so it never enters or needs cleanup from agent history.
			if (!options?.internalContextType) this.deps.reflection.queueExternalRootTurnCue();

			// Add user message (built earlier, before the router judge, so it could be painted
			// immediately — see the early message_start emit above).
			messages.push(promptMessage);

			// Inject any pending "nextTurn" messages as context alongside the user message
			pendingNextTurnCount = this.deps.pendingNextTurnMessages.length;
			for (const msg of this.deps.pendingNextTurnMessages.slice(0, pendingNextTurnCount)) {
				messages.push(msg);
			}

			// Cheap task-step state must also reach internal continuations (turn-economics B6).
			const taskStepsState = this.deps.getTaskStepsStateSnapshot();
			const taskStepsContext = taskStepsState ? formatTaskStepsContext(taskStepsState, 12) : undefined;
			if (taskStepsState && taskStepsContext) {
				messages.push(
					createCustomMessage(
						"task_steps_context",
						taskStepsContext,
						false,
						{ revision: taskStepsState.revision },
						turnTimestamp,
					),
				);
			}

			const pipelineContextMessage =
				options?.internalContextType && this.deps.getMemorySystem() !== "icm"
					? undefined
					: createActivePipelineContextMessage({
							options: {
								agentPipelinesDir: resourceDir("pipelines", this.deps.getAgentDir()),
								cwd: this.deps.getCwd(),
							},
							snapshot: this.deps.getPipelineRunSnapshot(),
							contextMode: this.deps.getMemorySystem() === "icm" ? "on-demand" : "inline",
							onError: (message) => this.deps.emit({ type: "warning", message }),
							timestamp: turnTimestamp,
						});
			if (pipelineContextMessage) messages.push(pipelineContextMessage);

			// Emit before_agent_start extension event
			const baseSystemPrompt = this.deps.getBaseSystemPrompt();
			const result = await this.deps
				.getExtensionRunner()
				.emitBeforeAgentStart(
					expandedText,
					currentImages,
					baseSystemPrompt,
					this.deps.systemPromptBuilder.getBaseSystemPromptOptions(),
				);
			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						content: msg.content,
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// The extension-modified system prompt, or the base (in case an earlier turn had modifications),
			// through the cache custody gate: a change waits for a cold moment unless the extension asked for
			// it now. A cold turn start is itself that moment.
			const systemPromptCold = this.deps.isSystemPromptCold(routedTurnModel);
			if (systemPromptCold) this.deps.atColdMoment("no warm cache at turn start");
			const nextSystemPrompt = result?.systemPrompt || this.deps.getBaseSystemPrompt();
			if (this.deps.agent.state.systemPrompt === nextSystemPrompt)
				this.deps.custody.withdraw("extension_system_prompt");
			else {
				this.deps.custody.request({
					kind: "extension_system_prompt",
					reason: result?.systemPrompt ? "an extension changed the system prompt" : "the extension prompt ended",
					mandatory: result?.systemPromptUrgency === "now" || systemPromptCold,
					apply: () => {
						this.deps.agent.state.systemPrompt = nextSystemPrompt;
					},
				});
			}
		} catch (error) {
			// The turn never reached the foreground run, so the authoritative message_start that would
			// normally consume this entry (see _handleAgentEvent) never fires — un-register it here
			// instead of leaking the reference.
			this.releaseEarlyDisplayedUserMessage(userMessage, queuedOwnerInput);
			// The routing/prep phase (routing_start above) failed before ever reaching the turn — end
			// it here, or the UI's "working" indicator for it spins forever with nothing behind it.
			if (routingStarted) this.deps.emit({ type: "routing_end" });
			preflightResult?.(false);
			// An owner interrupt while the turn was being prepared: the same unwind, and a quiet end.
			if (error instanceof SubmissionPreflightAborted) return;
			throw error;
		}

		// The routing/prep phase is over — either we're about to hand off into the turn (which emits
		// its own agent_start/streaming events right after), or messages is unexpectedly unset and we
		// bail below. Either way nothing is left "routing" past this point.
		if (routingStarted) this.deps.emit({ type: "routing_end" });

		if (!messages) {
			return;
		}

		// The submission's cancellation point. Listener FIRST, then the `aborted` read: in that order an
		// abort either arrives later and reaches the live run through the listener, or has already
		// arrived and is caught by the read — there is no gap between them for one to fall into. Reversed,
		// an abort landing between the read and the attach would be dropped and the turn would run anyway.
		// The listener is the same edge as `abort()`: a run in flight is unwound by its own controller, and
		// a retry backoff in flight is cut rather than waited out. What the listener cannot reach is a run
		// that does not exist yet — the drive loop still has its own preparation to await before entering
		// one — so the signal also rides into `runRoutedTurn` and is read once more immediately before the
		// run starts (see ForegroundRecoveryController.runAgentExecution). That read is the closing gate.
		let releaseSubmissionSignal: (() => void) | undefined;
		if (submissionSignal) {
			releaseSubmissionSignal = this.deps.foregroundRecovery.bindSubmissionSignal(submissionSignal);
			if (submissionSignal.aborted) {
				releaseSubmissionSignal();
				// Same unwind as the preflight-failure path above: the turn never reached the run, so the
				// authoritative message_start that would normally consume this entry never fires.
				this.releaseEarlyDisplayedUserMessage(userMessage, queuedOwnerInput);
				preflightResult?.(false);
				return;
			}
		}

		// Commit consumption of the next-turn messages only now: after every fallible preflight hook has
		// succeeded AND after the cancellation point above, so a turn that never runs never consumes them.
		// Everything between the last hook and here is synchronous and infallible, which is what lets the
		// commit sit this late without ever landing for a turn a hook rejected. Messages added while the
		// hooks were running sit past `pendingNextTurnCount` and remain queued for the following turn.
		this.deps.pendingNextTurnMessages.splice(0, pendingNextTurnCount);

		preflightResult?.(true);
		const goalExecutionLease = this.deps.goals.beginExecution(admittedGoalId, {
			adoptNewGoal: goalToolStartAuthority !== undefined,
			provisionalTokenBudget: goalToolStartAuthority?.tokenBudget,
			routedPrompt:
				options?.internalContextType === GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE &&
				promptMessage.role === "custom" &&
				typeof promptMessage.content === "string" &&
				promptMessage.content.startsWith(OBJECTIVE_ROUTE_PROMPT_PREFIX)
					? { content: promptMessage.content, timestamp: promptMessage.timestamp }
					: undefined,
		});
		this.deps.goals.setStartAuthority(goalToolStartAuthority);
		try {
			this.deps.toolProtocol.resetTurnState();
			let taskDirectoryUnavailableNoted = false;
			const noteTaskDirectoryUnavailable = (error: unknown): void => {
				if (taskDirectoryUnavailableNoted) return;
				taskDirectoryUnavailableNoted = true;
				this.deps.noteSystemOneTaskDirectoryUnavailable(error);
			};
			let requestNote: string | undefined;
			if (!options?.internalContextType) {
				this.lastUserRequestValue = userRequest;
				if (options?.source !== "extension") {
					// The owner's words are classified where their outcome is read (see OwnerPolicyQueue): a
					// turn that uses no tool never waits for, or pays for, the classification. A queued input
					// that became this turn was judged before it ran: its judgment is applied, never asked again
					// (one a newer request superseded has its owner policy judged alone where the queue settles).
					if (ownerJudgment !== undefined || this.deps.getSystemOneController())
						this.deps.enqueueOwnerWords(text, lifecycle?.acceptedOrder, ownerJudgment, submissionSignal);
					else await this.deps.classifyOwnerRequest(text, "", false, submissionSignal, lifecycle?.acceptedOrder);
				} else if (this.deps.getSystemOneController()) {
					requestNote = await this.deps.runtimeBuilder.withTaskDirectoryContext(
						() => this.deps.enableCapabilitiesAuthorizedByUser(userRequest, submissionSignal, false),
						submissionSignal,
						(error) => {
							noteTaskDirectoryUnavailable(error);
							return undefined;
						},
					);
				} else
					requestNote = await this.deps.enableCapabilitiesAuthorizedByUser(userRequest, submissionSignal, false);
				this.deps.announceOwnerFollowUpsWhenPresent();
			}
			if (requestNote) {
				messages.push(
					createCustomMessage("request_authority", requestNote, false, undefined, new Date().toISOString()),
				);
			}
			if (toolkitHit !== undefined) {
				await this.deps.runToolkitHit(toolkitHit, messages, submissionSignal);
				return;
			}
			const preflight = this.deps.getSystemOneController()
				? await this.deps.runtimeBuilder.withTaskDirectoryContext(
						() =>
							executeSystemOnePreflight(
								this.deps.getSystemOneController(),
								this.deps.agent.state.messages.length,
							),
						submissionSignal,
						(error) => {
							noteTaskDirectoryUnavailable(error);
							return executeSystemOnePreflight(undefined, this.deps.agent.state.messages.length);
						},
					)
				: await executeSystemOnePreflight(undefined, this.deps.agent.state.messages.length);
			if (preflight.proceed) {
				// The run sends `messages[0]` first (it holds at least the prompt message); the claim check finds the turn
				// by it, since a compaction inside the turn can rebuild the history so no length read here marks its start.
				const turnOpening = messages[0];
				await this.deps.modelRouter.runRoutedTurn(
					messages,
					routedTurnModel,
					routedTurnRouteDecision,
					true,
					false,
					submissionSignal,
				);
				// The answer's claims and the objective's postflight read different facts and write nothing
				// the other reads, so they wait on System One together, not one after the other.
				const claimCheck = submissionSignal?.aborted ? undefined : this.deps.claimCorrection(turnOpening);
				// If the postflight below throws first, this check is abandoned: its own failure must not
				// surface as an unhandled rejection. The await further down still sees it when it is used.
				claimCheck?.catch(() => undefined);
				if (this.deps.getSystemOneController() && !submissionSignal?.aborted) {
					await this.deps.runtimeBuilder.withTaskDirectoryContext(
						() =>
							executeSystemOnePostflight(
								this.deps.getSystemOneController(),
								this.deps.agent.state.messages.length,
								submissionSignal?.aborted,
							),
						submissionSignal,
						(error) => {
							noteTaskDirectoryUnavailable(error);
						},
					);
				} else {
					await executeSystemOnePostflight(
						undefined,
						this.deps.agent.state.messages.length,
						submissionSignal?.aborted,
					);
				}
				// Claims against deliveries: a contradicted claim buys one correction turn, never a loop.
				if (claimCheck && !submissionSignal?.aborted) {
					const correction = await claimCheck;
					if (correction && !submissionSignal?.aborted) {
						await this.deps.modelRouter.runRoutedTurn(
							[createCustomMessage("claim_delivery", correction, true, undefined, new Date().toISOString())],
							routedTurnModel,
							routedTurnRouteDecision,
							false,
							false,
							submissionSignal,
						);
					}
					if (!submissionSignal?.aborted) await this.deps.flushOwnerItems(submission.lease);
				}
			}
			// A cancelled submission records no outcome. Cancelled before the run, the last assistant
			// message is the PREVIOUS turn's and scoring it here would count that turn twice; cancelled
			// mid-run, the response is a fragment that is nobody's verdict on the protocol.
			if (!submissionSignal?.aborted) this.deps.toolProtocol.recordParseOutcomeFromLastAssistant();
		} finally {
			releaseSubmissionSignal?.();
			this.deps.goals.endQueuedOwnerChatGoalExecution();
			this.deps.goals.setStartAuthority(undefined);
			this.deps.goals.endExecution(goalExecutionLease);
			// Normally consumed by the authoritative message_start. If execution failed before that
			// event, do not retain the early-painted message identity indefinitely.
			if (userMessage) this.deps.earlyDisplayedUserMessages.delete(userMessage);
			if (queuedOwnerInput && userMessage) this.settleOrRetractOwnedEcho(userMessage);
		}

		// Score whether the agent actually used the recalled context, so the recall gate can adapt.
		// Not for a cancelled submission: it has no response of its own to score (see above).
		const admittedRecall = this.deps.memory.takeAdmittedRecall();
		const scoredRecall = [injectedRecall, admittedRecall?.text].filter(Boolean).join("\n");
		if (scoredRecall && !submissionSignal?.aborted) {
			const responseText = assistantAnswerText(this.deps.findLastAssistantMessage());
			if (responseText) {
				this.deps.memory.recordRecallOutcome(scoredRecall, admittedRecall?.query ?? recallQuery, responseText);
			}
		}

		this.deps.scheduleIdleWork(options, true);

		// Extension-only, and read after the lanes are scheduled so an armed continuation is visible.
		const settled = this.deps.isSessionSettled
			? this.deps.isSessionSettled()
			: isSessionSettled(this.deps.sessionSettlementState, this.deps.hasPendingIdleContinuation());
		if (settled) {
			this.deps.checkOrphanedObjectiveWatchdog();
			await this.deps.getExtensionRunner().emit({ type: "agent_settled" });
		}
	}
}
