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
import { ObjectiveExecutionInterruptedError } from "./objective-execution/current-objective-execution.ts";
import {
	type OwnerInputEnd,
	type OwnerInputId,
	type OwnerInputLedger,
	type OwnerInputSource,
	stampOwnerInput,
} from "./owner-input-ledger.ts";
import type { PendingInputHandle, PendingInputQueueController } from "./pending-input-queue-controller.ts";
import { createActivePipelineContextMessage, type PipelineRun } from "./pipelines/index.ts";
import type { DurableOwnerRuleStore } from "./project-rules/durable-owner-rules.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ReflectionController } from "./reflection-controller.ts";
import type { ReflectionTurnLifecycle } from "./reflection-turn-lifecycle.ts";
import { CONVERSATION_TALKER_CUSTOM_TYPE } from "./reply-route.ts";
import type { RuntimeBuilder } from "./runtime-builder.ts";
import type { RuntimeWorkLease } from "./runtime-generation-admission.ts";
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
import { boundedLine } from "./util/bounded-line.ts";
import { runReleaseSteps } from "./util/resource-release.ts";

/** An owner interrupt arrived while a submission was still preparing its turn (see `prompt`). */
export class SubmissionPreflightAborted extends Error {
	constructor() {
		super("The submission was interrupted before its turn started.");
		this.name = "SubmissionPreflightAborted";
	}
}

/** One accepted input: its identity, its owner order when its words are the owner's, and how it ended undelivered. */
interface AcceptedInput {
	readonly inputId: OwnerInputId;
	readonly acceptedOrder?: number;
	/** Set by the ledger when the input ends without being delivered. */
	ended?: OwnerInputEnd;
}

/** One submission's input and the points of its preparation the caller acts on. */
interface SubmissionLifecycle {
	/** The input this submission carries; a hidden internal turn carries none. */
	readonly input?: AcceptedInput;
	/** Its entry in the pending queue, from the moment it is queued (at submission, or when it found the session busy). */
	queued?: PendingInputHandle;
	/** Set where an extension handled the submission: why its input never reaches a turn. */
	handled?: string;
	ownsForeground(): void;
}

export interface PromptSubmissionControllerDeps {
	readonly agent: Agent;
	readonly sessionManager: Pick<SessionManager, "getLatestCustomEntryOnBranch" | "getMessageEntryId">;
	readonly pendingQueue: PendingInputQueueController;
	/** Mints each accepted submission's owner-input identity, owns its state, and runs its effects at their commit point. */
	readonly ownerInputs: Pick<
		OwnerInputLedger,
		"accept" | "move" | "end" | "stateOf" | "whenDelivered" | "whenUndelivered"
	>;
	readonly compaction: Pick<CompactionController, "cancelIdlePreparation">;
	readonly ownerRules: Pick<DurableOwnerRuleStore, "record">;
	readonly backgroundLanes: Pick<BackgroundLaneController, "clearGoalAutoContinueTimer">;
	readonly reflectionTurnLifecycle: Pick<ReflectionTurnLifecycle, "preemptFor" | "startDueTurn">;
	readonly foregroundRecovery: Pick<
		ForegroundRecoveryController,
		| "tryAcquireSubmission"
		| "releaseSubmission"
		| "ownsSubmission"
		| "hasLiveConsumer"
		| "acquireSubmissionOrJoinLiveConsumer"
		| "bindSubmissionSignal"
		| "beginTurnPreparation"
	>;
	readonly toolProtocol: Pick<
		ToolProtocolController,
		"applyRepairLayerSettings" | "resetTurnState" | "recordParseOutcomeFromLastAssistant"
	>;
	readonly localPrefixWarm: Pick<LocalPrefixWarmController, "cancel">;
	readonly goals: Pick<
		GoalSessionController,
		| "previewOwnerPromptGoal"
		| "applyDeliveredOwnerPrompt"
		| "beginExecution"
		| "setStartAuthority"
		| "assertExecutionGoalCurrent"
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
	/** Owner words accepted with their submission order wait for an optional-tool judgment to carry them (`SessionEdgeIntentController.registerOwnerWords`). */
	registerOwnerWords(acceptedOrder: number, text: string): void;
	/** Accepted owner words that never became owner input are carried by no judgment (`SessionEdgeIntentController.releaseOwnerWords`). */
	releaseOwnerWords(acceptedOrder: number | undefined): void;
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
	 * The owner's words submitted through `steer()`/`followUp()`: accepted exactly as a prompt's words are (see `acceptInput`),
	 * under the next owner submission order. Returns the identity and the order their judgment carries.
	 */
	acceptQueuedOwnerWords(
		kind: "steer" | "followUp",
		text: string,
	): { readonly inputId: OwnerInputId; readonly acceptedOrder: number } {
		const acceptedOrder = ++this.ownerSubmissionOrder;
		return { inputId: this.acceptInput(kind, text, acceptedOrder).inputId, acceptedOrder };
	}

	/**
	 * Accept one input: its identity is minted now and every effect it has is registered against it in the ledger. Owner
	 * words (`acceptedOrder` defined; an extension's message or a host-authored turn is not the owner speaking) wait,
	 * registered, for a judgment to carry them, and become owner policy and the answer to an operator blocker when the input
	 * is delivered, never before: an input taken back, held or cancelled first decides nothing. However the input ends
	 * undelivered, its words are released.
	 */
	private acceptInput(source: OwnerInputSource, text: string, acceptedOrder: number | undefined): AcceptedInput {
		const input: AcceptedInput = {
			inputId: this.deps.ownerInputs.accept(source),
			...(acceptedOrder !== undefined ? { acceptedOrder } : {}),
		};
		if (acceptedOrder !== undefined) {
			this.deps.registerOwnerWords(acceptedOrder, text);
			this.deps.ownerInputs.whenDelivered(input.inputId, ({ entryId }) => this.noteOwnerSpoke(text, entryId));
		}
		this.deps.ownerInputs.whenUndelivered(input.inputId, (end) => {
			input.ended = end;
			this.deps.releaseOwnerWords(acceptedOrder);
		});
		return input;
	}

	/** The owner's delivered words, persisted as `entryId`. */
	private noteOwnerSpoke(text: string, entryId: string): void {
		// An owner development directive is policy, not prompt text: it is captured durably here, with the entry that carried
		// it, before that turn can be compacted away.
		this.deps.ownerRules.record(text, entryId);
		// The owner's words reached the session: an operator blocker waited for exactly that.
		if (this.deps.getOperatorBlocker() !== undefined) this.deps.setOperatorBlocker(undefined);
	}

	/** A submission's input that ends there without being delivered, and why. */
	private submissionEnd(
		aborted: boolean,
		failure: { readonly error: unknown } | undefined,
		handled?: string,
	): OwnerInputEnd {
		if (failure !== undefined)
			return {
				state: "refused",
				reason: failure.error instanceof Error ? failure.error.message : String(failure.error),
			};
		if (handled !== undefined) return { state: "refused", reason: handled };
		if (this.deps.isDisposed()) return { state: "cancelled", reason: "the session closed" };
		return {
			state: "cancelled",
			reason: aborted ? "interrupted" : "its submission ended before the input was delivered",
		};
	}

	/**
	 * The submission ended: an input it still holds ends as `end`. Its queued entry is withdrawn while still pending, or held
	 * when its own turn took it and never delivered it; an input it never queued ends unless it was delivered, held when the
	 * session closed while the own-turn record kept it (`PendingInputQueueController.holdClosedPreparing`), as the next
	 * session restores it. An input admitted to the pending queue is that queue's, and one already held or delivered has ended.
	 */
	private endSubmissionInput(lifecycle: SubmissionLifecycle, end: OwnerInputEnd): void {
		const queued = lifecycle.queued;
		if (queued && (this.deps.pendingQueue.withdraw(queued, end) || this.deps.pendingQueue.reclaim(queued)))
			this.deps.emitQueueUpdate();
		const input = lifecycle.input;
		if (input === undefined) return;
		const state = this.deps.ownerInputs.stateOf(input.inputId);
		if (
			(state === "accepted" || state === "judged" || state === "own_turn") &&
			!this.deps.pendingQueue.holdClosedPreparing(input.inputId)
		)
			this.deps.ownerInputs.end(input.inputId, end);
	}

	/** Its words received their judgment: an input nothing else moved on (taken back or held meanwhile) is judged. */
	private noteJudged(lifecycle: SubmissionLifecycle): void {
		const input = lifecycle.input;
		if (input && this.deps.ownerInputs.stateOf(input.inputId) === "accepted")
			this.deps.ownerInputs.move(input.inputId, "judged");
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
	async prompt(text: string, options?: PromptOptions, runtimeLease?: RuntimeWorkLease): Promise<void> {
		// The owner's submission order, fixed now: every judgment of this submission carries it.
		const acceptedOrder =
			options?.internalContextType || options?.source === "extension" ? undefined : ++this.ownerSubmissionOrder;
		// Its identity, minted at acceptance for every source (an extension's message on its untrusted path): the message it
		// becomes carries it, and its persistence delivers it. A hidden internal turn is no one's input and has none. Its
		// words are judged only where their outcome is read (a fresh turn's at its first tool call), so a queued input judged
		// before then carries them; until something judges, carries or releases them, they wait registered.
		const input = options?.internalContextType
			? undefined
			: this.acceptInput(options?.source === "extension" ? "extension" : "prompt", text, acceptedOrder);
		const inputId = input?.inputId;
		const busyAtSubmission = this.deps.getSessionWorkState().busy;
		const queuedBehavior = options?.internalContextType ? undefined : options?.streamingBehavior;
		// A queued submission (the owner's, or an extension's such as a peer message) is pending from this
		// moment, in submission order, before anything below can await: it is visible, takeable, and
		// cancelled with the pending queue. Only the owner's words are classified as owner intent. Input kept
		// for later (`PendingInputQueueController.keep`) is this submission's: pending again as this input when
		// the submission queues, gone from the queue when it does not; one taken back meanwhile submits nothing.
		const kept = options?.heldInput;
		const queuedOwnerInput =
			queuedBehavior && (kept !== undefined || busyAtSubmission)
				? kept
					? this.deps.pendingQueue.resubmit(kept, queuedBehavior, text, options?.images, options?.origin, inputId)
					: this.deps.pendingQueue.register(queuedBehavior, text, options?.images, options?.origin, inputId)
				: undefined;
		// An input that does not queue here runs as its own turn: it is recorded from now until it is delivered or ends, so a
		// crash or a restart while its turn is prepared restores it held. One that queues later is the queued record's then.
		// It is recorded before a kept input it replaces leaves the queued record, so no cut between the two loses its words.
		if (input && !queuedOwnerInput)
			this.deps.pendingQueue.trackOwnTurn(
				input.inputId,
				queuedBehavior ?? "followUp",
				text,
				options?.images,
				options?.origin,
			);
		const keptTaken = kept !== undefined && !queuedBehavior && this.deps.pendingQueue.takeKept(kept);
		if (queuedOwnerInput || kept) this.deps.emitQueueUpdate();
		if (kept && !queuedOwnerInput && !keptTaken) {
			if (input)
				this.deps.ownerInputs.end(input.inputId, { state: "withdrawn", reason: "taken back before it was sent" });
			options?.preflightResult?.(false, input?.ended);
			return;
		}
		// Judged in full once, here: the same judgment decides whether it is admitted and is applied where it is read.
		const queuedOwnerClassification =
			queuedOwnerInput && busyAtSubmission && acceptedOrder !== undefined
				? this.deps.judgeQueuedOwnerRequest(
						text,
						options?.signal
							? AbortSignal.any([options.signal, queuedOwnerInput.signal])
							: queuedOwnerInput.signal,
						acceptedOrder,
					)
				: undefined;
		// Classification can fail while preemption or an earlier queued submission still owns
		// preparation. Observe it now, retaining the original promise for normal failure propagation.
		void queuedOwnerClassification?.catch(() => undefined);
		try {
			// The owner spoke: a summary being prepared while the lane idled never makes them wait.
			this.deps.compaction.cancelIdlePreparation();
			if (options?.autoContinueGoal !== false) {
				this.deps.backgroundLanes.clearGoalAutoContinueTimer();
			}
			await this.deps.reflectionTurnLifecycle.preemptFor(options);
		} catch (error) {
			// The submission ends before it starts: its input is refused, and its submitter hears that once.
			const lifecycle: SubmissionLifecycle = {
				...(input ? { input } : {}),
				...(queuedOwnerInput ? { queued: queuedOwnerInput } : {}),
				ownsForeground: () => {},
			};
			this.endSubmissionInput(lifecycle, this.submissionEnd(false, { error }));
			options?.preflightResult?.(false, input?.ended);
			throw error;
		}
		const submissionLease = this.deps.foregroundRecovery.tryAcquireSubmission(runtimeLease);
		if (!submissionLease && this.deps.getSessionWorkState().busy && options?.streamingBehavior) {
			// Queued submissions prepare one at a time, in submission order, but the next one waits only
			// for this one's PREPARATION (queued, withdrawn, or its own turn started), never its whole turn.
			// An input that became queued while the preemption above awaited is pending from here, before that
			// wait: visible, takeable and recorded in submission order, as one queued at submission is.
			const lateQueuedInput =
				queuedOwnerInput ??
				(input && queuedBehavior
					? this.deps.pendingQueue.register(queuedBehavior, text, options.images, options.origin, inputId)
					: undefined);
			if (lateQueuedInput !== queuedOwnerInput) this.deps.emitQueueUpdate();
			const { promise: preparedGate, resolve: prepared } = Promise.withResolvers<void>();
			const start = () =>
				this.runPromptSubmission(
					text,
					options,
					undefined,
					queuedOwnerClassification,
					lateQueuedInput,
					prepared,
					input,
					runtimeLease,
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
			input,
			runtimeLease,
		);
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
	 * A queued owner input's own turn ended. Its persisted message already delivered the input (the ledger's Delivered
	 * point); a message that never reached the transcript (a buffered cheap-route turn that failed, say) is retracted from
	 * the echo, and its input is held.
	 */
	private retractUnpersistedOwnedEcho(message: AgentMessage): void {
		if (this.deps.sessionManager.getMessageEntryId(message) === undefined) {
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
		input?: AcceptedInput,
		runtimeLease?: RuntimeWorkLease,
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
		const lifecycle: SubmissionLifecycle = {
			...(input ? { input } : {}),
			...(queuedOwnerInput ? { queued: queuedOwnerInput } : {}),
			ownsForeground: () => {
				ownsForeground();
				// Its preparation is complete: the next queued submission may prepare while this turn runs.
				prepared?.();
			},
		};
		// The submitter hears exactly one verdict: accepted (queued for delivery, or its turn is about to run), or how its
		// input ended without delivery. The preparation reports only acceptance; every other exit is reported here, once.
		let verdictGiven = false;
		const giveVerdict = (accepted: boolean, ended?: OwnerInputEnd): void => {
			if (verdictGiven) return;
			verdictGiven = true;
			options?.preflightResult?.(accepted, ended);
		};
		let failure: { readonly error: unknown } | undefined;
		try {
			await this.promptUnserialized(
				text,
				{
					...options,
					signal,
					...(options?.preflightResult ? { preflightResult: (accepted: boolean) => giveVerdict(accepted) } : {}),
				},
				submission,
				queuedOwnerClassification,
				lifecycle,
				runtimeLease,
			);
		} catch (error) {
			failure = { error };
			throw error;
		} finally {
			runReleaseSteps(
				[
					() => prepared?.(),
					// Every undelivered input ends visibly; a queued input its own turn took is held instead of lost.
					() => this.endSubmissionInput(lifecycle, this.submissionEnd(signal.aborted, failure, lifecycle.handled)),
					() => {
						if (this.submissionAbort === submissionAbort) this.submissionAbort = undefined;
					},
					() => {
						// Only this foreground owner may hold its stranded queue, before release publishes availability.
						// Release can synchronously hand input to a new run that has not become a live consumer yet.
						if (
							submission.lease &&
							this.deps.foregroundRecovery.ownsSubmission(submission.lease) &&
							!this.deps.foregroundRecovery.hasLiveConsumer &&
							this.deps.agent.hasQueuedMessages()
						)
							this.deps.holdUndeliveredQueue();
					},
					() => {
						if (submission.lease) {
							if (this.foregroundPromptLeaseValue === submission.lease)
								this.foregroundPromptLeaseValue = undefined;
							this.deps.foregroundRecovery.releaseSubmission(submission.lease);
						}
					},
					() => giveVerdict(false, lifecycle.input?.ended),
				],
				"Prompt submission cleanup failed.",
				failure,
			);
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
		queuedOwnerClassification: Promise<OwnerRequestClassificationOutcome> | undefined,
		lifecycle: SubmissionLifecycle,
		runtimeLease: RuntimeWorkLease | undefined,
	): Promise<void> {
		const submissionSignal = options?.signal;
		// The input queued at submission, if any; one queued here later is `lifecycle.queued` only.
		const queuedOwnerInput = lifecycle.queued;
		// Fast path for a submission cancelled before it ever started: nothing has been built, painted or
		// queued yet, so there is nothing to unwind. The authoritative check is the one just before the
		// run, which also covers an abort arriving during the preflight awaits below.
		if (submissionSignal?.aborted) return;
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
		// The goal this execution is admitted to from its start (a continuation's); the owner's own prompt binds its goal when
		// it is delivered.
		const admittedGoalId = options?.goalExecutionId;
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
				this.noteJudged(lifecycle);
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
						lifecycle.handled = "queued as an extension command";
						preflightResult?.(true);
						return;
					}
				}
				const handled = await this.deps.pendingQueue.tryExecuteExtensionCommand(text, runtimeLease);
				if (handled) {
					// Extension command executed, no prompt to send
					lifecycle.handled = "handled as an extension command";
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
					lifecycle.handled = "handled by an extension";
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
				submission.lease = this.deps.foregroundRecovery.tryAcquireSubmission(runtimeLease);
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
					runtimeLease,
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
					this.deps.pendingQueue.register(
						options.streamingBehavior,
						text,
						options.images,
						options.origin,
						lifecycle.input?.inputId,
					);
				lifecycle.queued = pending;
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
								lifecycle.input?.acceptedOrder,
							));
						ownerJudgment = classified;
						if ("cancelled" in classified && classified.cancelled && classified.contextChanged)
							this.deps.pendingQueue.hold(pending);
						if (submissionSignal?.aborted || ("cancelled" in classified && classified.cancelled)) return;
						this.noteJudged(lifecycle);
					} else if (submissionSignal?.aborted || pending.signal.aborted) {
						return;
					}
					if (this.deps.isDisposed()) return;
					// The handover needs a consumer that is live now, not only when it was chosen: the classification above
					// awaited, and that run may have delivered its last round meanwhile. Read with no await before `admit`.
					while (!this.deps.foregroundRecovery.hasLiveConsumer) {
						const acquired = await this.deps.foregroundRecovery.acquireSubmissionOrJoinLiveConsumer(
							submissionSignal ? AbortSignal.any([submissionSignal, pending.signal]) : pending.signal,
							runtimeLease,
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
					// Taken back, cleared or held while it waited: it is no longer pending and is never admitted.
					if (!ownTurn && !pending.signal.aborted) {
						const judged = ownerJudgment;
						const judgedOrder = lifecycle.input?.acceptedOrder;
						// The owner's admitted words become policy when the run delivers them, never when they are taken back,
						// cleared or held first: their judgment is applied where it is read.
						if (ownerOriginalText !== undefined && judged !== undefined)
							this.deps.ownerInputs.whenDelivered(pending.inputId, () =>
								this.deps.enqueueOwnerWords(ownerOriginalText, judgedOrder, judged),
							);
						admitted = this.deps.pendingQueue.admit(pending, {
							text: expandedText,
							...(currentImages ? { images: currentImages } : {}),
							...(goalToolStartAuthority ? { queuedGoalAuthority: goalToolStartAuthority } : {}),
							...(ownerOriginalText !== undefined ? { ownerOriginalText } : {}),
						});
					}
				} finally {
					this.deps.emitQueueUpdate();
				}
				if (!ownTurn) {
					// Accepted only once the pending queue holds it: a submitter is never told of an input that is gone. Every
					// other exit ends the input where the submission ends (`runPromptSubmission`), and reports how.
					if (admitted) preflightResult?.(true);
					return;
				}
			}
			// This submission would run as its own turn now. Only an input still pending here may: one the
			// owner took back, cleared or that changed context meanwhile never runs. Ownership moves to
			// the turn without cancelling it.
			if (lifecycle.queued) {
				const promoted = this.deps.pendingQueue.promote(lifecycle.queued);
				this.deps.emitQueueUpdate();
				if (!promoted) return;
			} else if (lifecycle.input && !this.deps.pendingQueue.claimOwnTurn(lifecycle.input.inputId)) {
				this.deps.emitQueueUpdate();
				return;
			}
			lifecycle.ownsForeground();
			if (lifecycle.input) {
				// The input was accepted in this history: no navigation rewrites it while its turn is prepared.
				if (submission.lease) this.deps.foregroundRecovery.beginTurnPreparation(submission.lease);
			}
			this.foregroundPromptLeaseValue = submission.lease;

			if (lifecycle.input) {
				// The owner's own prompt resumes a system-stopped goal or starts an explicit chat goal when it is delivered (its
				// user entry persisted), never before: a prompt that ends undelivered changes no goal, and its run works on that
				// goal only from its delivery. The goal it would own is read now, for the readiness that goal work needs.
				const ownerGoalId = this.deps.goals.previewOwnerPromptGoal(expandedText, this.deps.agent.state.messages);
				this.deps.ownerInputs.whenDelivered(lifecycle.input.inputId, () =>
					this.deps.goals.applyDeliveredOwnerPrompt(expandedText, this.deps.agent.state.messages),
				);
				if ((ownerGoalId ?? admittedGoalId) && this.deps.getAdaptiveReadiness()) {
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
				// The message carries the input it is: its persistence delivers that input (a queued input its own turn took
				// included), matched by this identity, never by the turn's end or the message's text.
				if (lifecycle.input) stampOwnerInput(userMessage, lifecycle.input.inputId);
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
			this.releaseEarlyDisplayedUserMessage(userMessage, lifecycle.queued);
			// The routing/prep phase (routing_start above) failed before ever reaching the turn — end
			// it here, or the UI's "working" indicator for it spins forever with nothing behind it.
			if (routingStarted) this.deps.emit({ type: "routing_end" });
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
		if (submissionSignal)
			releaseSubmissionSignal = this.deps.foregroundRecovery.bindSubmissionSignal(submissionSignal);
		// A queued input its own turn took that was held while the turn prepared (its context changed) never runs either.
		if (submissionSignal?.aborted || lifecycle.queued?.signal.aborted) {
			releaseSubmissionSignal?.();
			// Same unwind as the preflight-failure path above: the turn never reached the run, so the
			// authoritative message_start that would normally consume this entry never fires.
			this.releaseEarlyDisplayedUserMessage(userMessage, lifecycle.queued);
			return;
		}

		let submissionFailure: { readonly error: unknown } | undefined;
		try {
			// The captured goal must still own this turn after the awaited hooks, before context is consumed
			// or acceptance is reported. Its execution ends with the foreground submission on every outcome.
			this.deps.goals.beginExecution(admittedGoalId, {
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
			// Messages added while hooks ran remain past this captured count for the following turn.
			this.deps.pendingNextTurnMessages.splice(0, pendingNextTurnCount);
			preflightResult?.(true);
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
					// They join the owner-policy queue when this turn delivers them (its user entry is persisted),
					// exactly once, and never when the turn ends before that. Delivered words stay registered until
					// an optional-tool intent covers them: a queued input judged before this turn's first tool call
					// reads them into its staged judgment.
					const input = lifecycle.input;
					if (input)
						this.deps.ownerInputs.whenDelivered(input.inputId, () =>
							this.deps.enqueueOwnerWords(text, input.acceptedOrder, ownerJudgment, submissionSignal),
						);
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
				// Observe immediately and join before releasing the submission even if postflight is interrupted.
				const claimSettlement = Promise.allSettled([claimCheck]);
				let postflightFailure: { readonly error: unknown } | undefined;
				try {
					if (this.deps.getSystemOneController() && !submissionSignal?.aborted) {
						await this.deps.runtimeBuilder.withTaskDirectoryContext(
							() => {
								this.deps.goals.assertExecutionGoalCurrent();
								return executeSystemOnePostflight(
									this.deps.getSystemOneController(),
									this.deps.agent.state.messages.length,
									submissionSignal?.aborted,
								);
							},
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
				} catch (error) {
					postflightFailure = { error };
				}
				const [claimResult] = await claimSettlement;
				if (postflightFailure) {
					const error = postflightFailure.error;
					if (claimResult.status === "rejected") {
						if (error instanceof ObjectiveExecutionInterruptedError) {
							const failures: unknown[] = [claimResult.reason];
							try {
								this.deps.emit({
									type: "warning",
									message: boundedLine(
										`Claim verification failed while postflight was interrupted: ${claimResult.reason instanceof Error ? claimResult.reason.message : String(claimResult.reason)}`,
										1_000,
									),
								});
							} catch (warningError) {
								failures.push(warningError);
							}
							error.cause = new AggregateError(
								[...(error.cause === undefined ? [] : [error.cause]), ...failures],
								"Claim verification failed while postflight was interrupted.",
							);
						} else throw new AggregateError([error, claimResult.reason], "Post-turn verification failed.");
					}
					throw error;
				}
				if (claimResult.status === "rejected" && !submissionSignal?.aborted) throw claimResult.reason;
				// Claims against deliveries: a contradicted claim buys one correction turn, never a loop.
				if (claimCheck && claimResult.status === "fulfilled" && !submissionSignal?.aborted) {
					const correction = claimResult.value;
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
		} catch (error) {
			submissionFailure = { error };
			throw error;
		} finally {
			// Every release runs whatever an earlier one threw; their failures surface together, with the turn's own.
			runReleaseSteps(
				[
					() => releaseSubmissionSignal?.(),
					// Normally consumed by the authoritative message_start. If execution failed before that
					// event, do not retain the early-painted message identity indefinitely.
					() => {
						if (userMessage) this.deps.earlyDisplayedUserMessages.delete(userMessage);
					},
					() => {
						if (lifecycle.queued && userMessage) this.retractUnpersistedOwnedEcho(userMessage);
					},
				],
				"Prompt submission release failed.",
				submissionFailure,
			);
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
