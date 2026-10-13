import type { Api, AssistantMessage, Model } from "@caupulican/pi-ai";
import { isContextOverflow } from "@caupulican/pi-ai/overflow";
import { type Agent, AgentBusyError } from "../kernel/agent.ts";
import {
	type ClassifiedError,
	classifyFailure,
	computeRetryDelayMs,
	DEFAULT_RETRY_POLICY,
	RetryController,
	RetryDelayExceededError,
} from "../kernel/reliability/index.ts";
import type { AgentEvent, AgentMessage } from "../kernel/types.ts";
import { BillingFailoverController, ExhaustedProviderRegistry } from "./billing-failover-controller.ts";
import type { FailureCorpusRecorder } from "./failure-corpus.ts";
import type { IcmTurnCoordinator, IcmTurnHandle } from "./memory/continuous-chat-turn-coordinator.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { ModelRouterFailoverStatus } from "./model-router/status.ts";
import { IndependentObserverSet } from "./observer-dispatch.ts";
import type { AutonomySettings, FailoverSettings } from "./settings/settings-schema.ts";

/** The settings this module reads, declared by the module itself; the composition root passes the SettingsManager. */
export interface ForegroundRecoveryControllerSettingsSource {
	getAutonomySettings(): Required<AutonomySettings>;
	getFailoverSettings(): Required<FailoverSettings>;
	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number };
	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number };
}

type ForegroundRecoveryEvent =
	| { type: "warning"; message: string }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };

const foregroundSubmissionLeaseMarker: unique symbol = Symbol("foregroundSubmissionLease");

/** Identity-bound authority to prepare and execute one logical foreground submission. */
export interface ForegroundSubmissionLease {
	readonly [foregroundSubmissionLeaseMarker]: true;
	/** Monotonic submission epoch assigned when this lease was acquired -- see
	 * `ForegroundRecoveryController.getCurrentSubmissionEpoch`. */
	readonly epoch: number;
}

/** The message a chat turn starts from. `alreadyLogged`: the chat logged it before the turn, so it is never an arrival. */
interface ChatTurnStart {
	readonly message: AgentMessage;
	readonly alreadyLogged: boolean;
}

export interface ForegroundRecoveryResourceSnapshot {
	readonly shutdown: boolean;
	readonly activeRuns: number;
	readonly submissionEpoch: number | undefined;
	readonly idleWaiters: number;
	readonly activityListeners: number;
	readonly retrying: boolean;
}

export interface ForegroundRecoveryControllerDeps {
	agent: Agent;
	/** The ICM chat's turns, undefined while no chat runs. A provider run outside a turn begins one, as its own. */
	chatTurns?(): Pick<IcmTurnCoordinator, "begin" | "current" | "end"> | undefined;
	/** See `BillingFailoverControllerDeps.applyFailoverModel`. */
	applyFailoverModel(failed: Model<Api>, hop: Model<Api>): Model<Api> | undefined;
	/** See `BillingFailoverControllerDeps.resolveFallbackModel`. */
	resolveFallbackModel?(failed: Model<Api>): Model<Api> | undefined;
	settingsManager: ForegroundRecoveryControllerSettingsSource;
	modelRegistry: ModelRegistry;
	failureCorpus: FailureCorpusRecorder;
	getContextWindow(): number;
	/** Directory the exhausted-provider registry shares with sibling processes; omitted keeps it process-local. */
	exhaustedStoreDir?: string;
	emit(event: ForegroundRecoveryEvent): void;
	checkCompaction(message: AssistantMessage): Promise<boolean>;
	/** The provider refused the model for this account: move the turn to a replacement, returning its ref. */
	replaceUnsupportedModel?(message: AssistantMessage): Promise<string | undefined>;
	/** The provider answered that the account's usage limit is reached (billing or quota). */
	onUsageLimitReached?(message: AssistantMessage): void;
	onSuccessfulAssistant(): void;
	prepareRun(): Promise<void>;
	afterRun(): Promise<void>;
	/** Runs at an idle Agent boundary while foreground submission authority is still held. */
	settleRuntimeUpdate?(signal?: AbortSignal): Promise<"continue" | "stop" | undefined>;
	/** Input admitted to the agent's queue that no round could deliver returns to the pending queue, held. */
	holdUndeliveredQueue?(): void;
	isCompacting?: () => boolean;
	isExtendedBusy?: () => boolean;
	hasPendingIdleContinuation?: () => boolean;
}

/** Owns the complete logical foreground run plus retry/failover/compaction recovery ordering. */
export class ForegroundRecoveryController {
	private readonly retry: RetryController;
	private readonly billingFailover: BillingFailoverController;
	private lastAssistantMessage: AssistantMessage | undefined;
	private pendingCompactionRetryKey: string | undefined;
	private activeRuns = 0;
	private submissionLease: ForegroundSubmissionLease | undefined;
	/** Next epoch to assign. Starts at 1 so the first successful `tryAcquireSubmission()` yields
	 * epoch 1; only ever increases, including across releases -- it identifies a submission, not a
	 * count of currently-held leases. */
	private nextSubmissionEpoch = 1;
	private shutdownReason: Error | undefined;
	private readonly idleWaiters = new Set<() => void>();
	private readonly activityListeners = new IndependentObserverSet<() => void>();
	private readonly deps: ForegroundRecoveryControllerDeps;

	constructor(deps: ForegroundRecoveryControllerDeps) {
		this.deps = deps;
		this.retry = new RetryController(
			deps.agent,
			() => this.getRetryPolicy(),
			{
				onRetryStart: (info) => deps.emit({ type: "auto_retry_start", ...info }),
				onRetryEnd: (info) => deps.emit({ type: "auto_retry_end", ...info }),
			},
			deps.getContextWindow,
		);
		this.billingFailover = new BillingFailoverController({
			agent: deps.agent,
			applyFailoverModel: (failed, hop) => deps.applyFailoverModel(failed, hop),
			resolveFallbackModel: (failed) => deps.resolveFallbackModel?.(failed),
			modelRegistry: deps.modelRegistry,
			exhausted: new ExhaustedProviderRegistry(deps.exhaustedStoreDir),
			subscriptionHop: deps.settingsManager.getFailoverSettings().subscriptionHop,
			emit: (event) => deps.emit(event),
			recordFailure: (record) => deps.failureCorpus.record(record),
		});
	}

	private getRetryPolicy() {
		const retry = this.deps.settingsManager.getRetrySettings();
		const providerRetry = this.deps.settingsManager.getProviderRetrySettings();
		return {
			enabled: retry.enabled,
			maxAttempts: retry.maxRetries,
			baseDelayMs: retry.baseDelayMs,
			maxDelayMs: DEFAULT_RETRY_POLICY.maxDelayMs,
			maxRetryAfterMs: providerRetry.maxRetryDelayMs,
			jitterRatio: 0,
		};
	}

	get attempt(): number {
		return this.retry.attempt;
	}

	get isRetrying(): boolean {
		return this.retry.isRetrying;
	}

	get isRunActive(): boolean {
		return this.activeRuns > 0;
	}

	get isBusy(): boolean {
		return this.hasForegroundOccupancy() || this.deps.hasPendingIdleContinuation?.() === true;
	}

	private hasForegroundOccupancy(): boolean {
		return (
			this.submissionLease !== undefined ||
			this.isRunActive ||
			this.deps.agent.state.isStreaming ||
			this.isRetrying ||
			this.deps.isCompacting?.() === true ||
			this.deps.isExtendedBusy?.() === true
		);
	}

	/** Atomically reserve the full foreground lifecycle, including asynchronous prompt preparation. */
	tryAcquireSubmission(): ForegroundSubmissionLease | undefined {
		if (this.shutdownReason || this.hasForegroundOccupancy()) return undefined;
		const lease: ForegroundSubmissionLease = {
			[foregroundSubmissionLeaseMarker]: true,
			epoch: this.nextSubmissionEpoch++,
		};
		this.submissionLease = lease;
		this.notifyActivity();
		return lease;
	}

	/**
	 * Epoch of the currently held submission lease, or undefined when no submission is running.
	 * Ownership identity for the terminal-handoff delivery boundary
	 * (`foreground-terminal-handoff-controller.ts`): a delivery folds into the next provider request
	 * only when its recorded owner epoch equals THIS value at flush time. An absent lease and an
	 * absent owner epoch are different kinds of "unknown" and must never be compared to each other --
	 * callers gate on the owner epoch being defined before reaching this getter at all.
	 */
	getCurrentSubmissionEpoch(): number | undefined {
		return this.submissionLease?.epoch;
	}

	getActivitySnapshot(sessionId: string): { sessionId: string; epoch?: number; busy: boolean } {
		return { sessionId, epoch: this.getCurrentSubmissionEpoch(), busy: this.isBusy };
	}

	/** Derive physical ownership without releasing a lease or constructing another runtime owner. */
	getResourceSnapshot(): ForegroundRecoveryResourceSnapshot {
		return {
			shutdown: this.shutdownReason !== undefined,
			activeRuns: this.activeRuns,
			submissionEpoch: this.submissionLease?.epoch,
			idleWaiters: this.idleWaiters.size,
			activityListeners: this.activityListeners.size,
			retrying: this.retry.isRetrying,
		};
	}

	/** Attach before the caller checks aborted; preparation still needs the level-triggered run gate. */
	bindSubmissionSignal(signal: AbortSignal): () => void {
		const onAbort = () => {
			this.abortRetry();
			this.deps.agent.abort("submission superseded");
		};
		signal.addEventListener("abort", onAbort, { once: true });
		return () => signal.removeEventListener("abort", onAbort);
	}

	/** Observe authority changes; consumers still await waitForIdle before declaring settlement. */
	subscribeActivity(listener: () => void): () => void {
		return this.activityListeners.subscribe(listener);
	}

	private notifyActivity(): void {
		this.activityListeners.notify(
			(listener) => listener(),
			() => this.deps.emit({ type: "warning", message: "Foreground activity observer failed." }),
		);
	}

	/** Wait until foreground ownership can be acquired without a check-then-act gap. */
	async acquireSubmission(): Promise<ForegroundSubmissionLease> {
		while (true) {
			if (this.shutdownReason) throw this.shutdownReason;
			const lease = this.tryAcquireSubmission();
			if (lease) return lease;
			// Streaming owns the Agent's native idle signal. Future continuation settlement does
			// not own submission authority, so the remaining wait uses the admission predicate.
			await this.deps.agent.waitForIdle();
			await new Promise<void>((resolve) => {
				const stop = (): void => {
					unsubscribe();
					this.idleWaiters.delete(stop);
					resolve();
				};
				const unsubscribe = this.activityListeners.subscribe(stop);
				this.idleWaiters.add(stop);
				try {
					// Register before rechecking. A newly started stream returns to the native idle
					// wait above instead of depending on a host activity notification for its end.
					if (this.shutdownReason || !this.hasForegroundOccupancy() || this.deps.agent.state.isStreaming) stop();
				} catch (error) {
					unsubscribe();
					this.idleWaiters.delete(stop);
					throw error;
				}
			});
		}
	}

	/**
	 * Whether a submission, run, stream or retry is live. Only then does a message handed to the agent's
	 * queue have a consumer: compaction, an answer under evaluation and an armed continuation make the
	 * foreground busy without any run that would ever drain that queue.
	 */
	get hasLiveConsumer(): boolean {
		return (
			this.submissionLease !== undefined || this.isRunActive || this.deps.agent.state.isStreaming || this.isRetrying
		);
	}

	/**
	 * Wait for the foreground to be either free or consumed by a live run, whichever comes first. Returns
	 * the lease when it was free; "live_consumer" when a run that drains the agent's queue is live (the
	 * caller queues behind it rather than waiting out that whole run); undefined when `signal` aborts.
	 * Woken by every foreground activity change, never by polling.
	 */
	async acquireSubmissionOrJoinLiveConsumer(
		signal: AbortSignal,
	): Promise<ForegroundSubmissionLease | "live_consumer" | undefined> {
		while (!signal.aborted) {
			if (this.shutdownReason) throw this.shutdownReason;
			const lease = this.tryAcquireSubmission();
			if (lease) return lease;
			if (this.hasLiveConsumer) return "live_consumer";
			await new Promise<void>((resolve) => {
				const stop = (): void => {
					unsubscribe();
					this.idleWaiters.delete(stop);
					signal.removeEventListener("abort", stop);
					resolve();
				};
				const unsubscribe = this.activityListeners.subscribe(stop);
				this.idleWaiters.add(stop);
				signal.addEventListener("abort", stop, { once: true });
				// Register first, then recheck, so a change landing before the registration is not lost.
				if (signal.aborted || this.shutdownReason || !this.isBusy || this.hasLiveConsumer) stop();
			});
		}
		return undefined;
	}

	ownsSubmission(lease: ForegroundSubmissionLease | undefined): boolean {
		return lease !== undefined && lease === this.submissionLease;
	}

	releaseSubmission(lease: ForegroundSubmissionLease): void {
		if (!this.ownsSubmission(lease)) {
			throw new Error("Cannot release foreground submission authority owned by another caller");
		}
		this.submissionLease = undefined;
		this.notifyActivity();
		if (this.activeRuns === 0) {
			this.resolveIdleWaiters();
		}
	}

	/**
	 * @param signal The submission's cancellation signal, if its owner holds one. Level-triggered: it is
	 * read immediately before every run this execution would start, so an abort that lands while no
	 * run exists to receive `agent.abort()` still stops the provider call. Returns normally when
	 * cancelled -- the submission simply never runs.
	 */
	async runAgentPrompt(
		messages: AgentMessage | AgentMessage[],
		submissionLease?: ForegroundSubmissionLease,
		signal?: AbortSignal,
	): Promise<void> {
		await this.runAgentExecution("prompt", messages, submissionLease, signal);
	}

	/** Continue from the already canonical agent history without replaying the original user message. */
	async runAgentContinuation(submissionLease?: ForegroundSubmissionLease, signal?: AbortSignal): Promise<void> {
		await this.runAgentExecution("continue", undefined, submissionLease, signal);
	}

	/**
	 * Begins the chat turn a provider run is about to start, and returns its end. A turn already running is joined, so
	 * nothing begins and nothing ends. Called only where the run reaches its first provider call: a run that ends before
	 * it begins no turn. An abort ends the wait without a turn; the caller re-checks the closing gate after this await.
	 */
	private async beginChatTurn(
		startOf: () => ChatTurnStart,
		signal: AbortSignal | undefined,
	): Promise<(() => void) | undefined> {
		const turns = this.deps.chatTurns?.();
		if (turns === undefined || turns.current() !== undefined) return undefined;
		const start = startOf();
		let turn: IcmTurnHandle;
		try {
			turn = await turns.begin(signal);
		} catch (error) {
			if (signal?.aborted) return undefined;
			throw error;
		}
		turn.markStart(start.message, start.alreadyLogged);
		return () => turns.end(turn);
	}

	/** The prompt's first message starts its turn: the message the run sends first, which the chat has not logged yet. */
	private promptStartOf(messages: AgentMessage | AgentMessage[] | undefined): ChatTurnStart {
		const start = Array.isArray(messages) ? messages[0] : messages;
		if (start === undefined) throw new Error("A prompt with no message cannot start a chat turn.");
		return { message: start, alreadyLogged: false };
	}

	/**
	 * The last message of the agent's history starts a continuation's own turn. That is the message that triggered the
	 * resume (a host handoff or a worker report), or a user, assistant or tool result the run continues from. The chat
	 * logs those as they persist, so the turn's view already holds them and no arrival will release it.
	 */
	private continuationStartOf(): ChatTurnStart {
		const last = this.deps.agent.state.messages.at(-1);
		if (last === undefined) throw new Error("A continuation with no chat turn has no message to start one from.");
		const alreadyLogged = last.role === "user" || last.role === "assistant" || last.role === "toolResult";
		return { message: last, alreadyLogged };
	}

	private async runAgentExecution(
		mode: "prompt" | "continue",
		messages: AgentMessage | AgentMessage[] | undefined,
		submissionLease?: ForegroundSubmissionLease,
		signal?: AbortSignal,
	): Promise<void> {
		let lease = submissionLease;
		let releaseLease = false;
		if (lease) {
			if (!this.ownsSubmission(lease)) {
				throw new AgentBusyError("Foreground submission authority is no longer active.");
			}
		} else {
			lease = this.tryAcquireSubmission();
			if (!lease) throw new AgentBusyError("Agent is already processing.");
			releaseLease = true;
		}
		if (this.activeRuns > 0) {
			if (releaseLease && lease) this.releaseSubmission(lease);
			throw new AgentBusyError("Agent is already processing.");
		}

		this.activeRuns++;
		// Set once the submission reached its stranded-input delivery, which holds what stays queued; every other exit holds it below.
		let deliveredStranded = false;
		// Set when the failure path already ran `afterRun` (so the finally below does not run it twice).
		let afterRunSettled = false;
		// Ends the chat turn this run began, if it began one; set at the run's first provider call.
		let endChatTurn: (() => void) | undefined;
		try {
			const maxGoalLoopRounds = this.deps.settingsManager.getAutonomySettings().maxStallTurns;
			await this.deps.prepareRun();
			// The submission's closing cancellation gate. `agent.abort()` reaches only a run that already
			// exists, and none exists until the `prompt()`/`continue()` below installs one, so an abort
			// landing during `prepareRun()` -- or anywhere earlier in the submission -- would otherwise
			// run this turn in full. Read here and again after the chat turn's await below, with no await between the last read and the run: both entry
			// points install the run's own abort controller synchronously, so an abort that arrives
			// after this read has a live run to reach, and one that arrived before it is caught by it.
			if (this.isClosing(signal)) return;
			// The chat turn begins where the run reaches its first provider call; a run closed before that begins none.
			endChatTurn = await this.beginChatTurn(
				() => (mode === "prompt" ? this.promptStartOf(messages) : this.continuationStartOf()),
				signal,
			);
			// Re-checked after that await: no await separates this read from the run below.
			if (this.isClosing(signal)) return;
			let goalLoopRounds = 1;
			// The runtime-update owner asked this run to end so the runtime can be replaced: no further provider
			// round starts on its behalf. Admitted input stays in the agent's queue for the next run.
			let stoppedForRuntimeUpdate = false;
			if (mode === "prompt") {
				if (!messages) throw new Error("Foreground prompt execution requires messages.");
				await this.deps.agent.prompt(messages);
			} else {
				await this.deps.agent.continue();
			}
			while (true) {
				const failed = this.lastAssistantMessage?.stopReason === "error" && !signal?.aborted;
				if (failed) {
					// A transport error is not an agent decision to abandon repair. Keep its existing
					// retry/compaction owner, then settle a terminal failure through the update owner.
					if (
						(maxGoalLoopRounds !== 0 && goalLoopRounds >= maxGoalLoopRounds) ||
						!(await this.handlePostAgentRun())
					) {
						await this.deps.settleRuntimeUpdate?.(signal);
						break;
					}
					goalLoopRounds++;
				} else {
					const update = await this.deps.settleRuntimeUpdate?.(signal);
					if (update === "stop") {
						stoppedForRuntimeUpdate = true;
						break;
					}
					if (update !== "continue") {
						if (maxGoalLoopRounds !== 0 && goalLoopRounds >= maxGoalLoopRounds) break;
						if (!(await this.handlePostAgentRun())) break;
						goalLoopRounds++;
					}
				}
				// Same gate before every further round. Post-run recovery awaits too (compaction, retry
				// backoff), and an abort landing there has no run to reach either -- without this the
				// next `continue()` would be a full provider turn on a cancelled submission. A retry the
				// recovery just prepared is closed here as cancelled, not left counting towards a
				// continuation that never comes. A shut-down recovery (the session is closing) starts no further round either.
				if (this.isClosing(signal)) {
					this.finishRetry(false, "Submission cancelled");
					return;
				}
				await this.deps.agent.continue();
			}
			// Every `break` above is an exit with no further round of its own. Input admitted to the
			// agent's queue is the owner's and is never left behind it.
			if (!stoppedForRuntimeUpdate) await this.deliverStrandedInput(signal);
			deliveredStranded = true;
		} catch (error: unknown) {
			// The run failed. Its owned queued input is held first, then its cleanup runs HERE so that a failing cleanup is joined to
			// the run's failure (both stay in the thrown graph) instead of replacing it from the finally below.
			if (!deliveredStranded && this.deps.agent.hasQueuedMessages()) this.deps.holdUndeliveredQueue?.();
			afterRunSettled = true;
			try {
				await this.deps.afterRun();
			} catch (afterRunError: unknown) {
				throw new AggregateError(
					[error, afterRunError],
					error instanceof Error ? error.message : "The run and its cleanup both failed.",
				);
			}
			throw error;
		} finally {
			// Any exit that did not reach the stranded-input delivery (a closing exit, or a run whose prompt/continue/recovery threw)
			// leaves the owner's admitted input in the agent's queue: hold it for its owner, visible and recoverable, so it cannot leak
			// into the next prompt's first boundary. Nothing is deleted and no refusal is swallowed. (Messages an extension or the
			// system queued directly on the agent are not owner input; the kernel's queue delivers them at the next boundary.)
			if (!deliveredStranded && this.deps.agent.hasQueuedMessages()) this.deps.holdUndeliveredQueue?.();
			try {
				if (!afterRunSettled) await this.deps.afterRun();
			} finally {
				// After the run's cleanup, so the turn covers every provider round the run made.
				endChatTurn?.();
				this.activeRuns--;
				if (releaseLease && lease && this.ownsSubmission(lease)) this.releaseSubmission(lease);
				if (this.activeRuns === 0 && this.submissionLease === undefined) {
					this.resolveIdleWaiters();
				}
			}
		}
	}

	/**
	 * The one closing gate for every point where this submission could start a provider round: the submission was cancelled, or
	 * the session is shutting down. `agent.abort()` reaches only a run that already exists and does not clear admitted queues, so
	 * each start (the first prompt/continue after `prepareRun()`, every further round, and stranded-input delivery) asks here.
	 * Admitted input is never deleted by this gate; whatever stays queued is held for the owner by `deliverStrandedInput`.
	 */
	private isClosing(signal?: AbortSignal): boolean {
		return signal?.aborted === true || this.shutdownReason !== undefined;
	}

	/** Messages that entered the transcript as input (user or custom), the measure of queue delivery. */
	private countInputMessages(): number {
		let count = 0;
		for (const message of this.deps.agent.state.messages) {
			if (message.role === "user" || message.role === "custom") count++;
		}
		return count;
	}

	/**
	 * A run ended by an exit that has no round of its own left (no assistant message to classify, a
	 * handled billing stop, a runtime-update stop, the stall cap) while the agent's queue still holds
	 * admitted input. Each further round delivers what the agent's queue mode releases at a boundary
	 * (all, or one per round) until the queue is empty. A round that delivers nothing, or an abort, ends
	 * it, and whatever is still queued goes back to the pending queue, held, visible and recoverable.
	 */
	private async deliverStrandedInput(signal?: AbortSignal): Promise<void> {
		try {
			while (this.deps.agent.hasQueuedMessages() && !this.isClosing(signal)) {
				const before = this.countInputMessages();
				await this.deps.agent.continue();
				if (this.countInputMessages() === before) break;
			}
		} finally {
			if (this.deps.agent.hasQueuedMessages()) this.deps.holdUndeliveredQueue?.();
		}
	}

	wakeIdleWaiters(): void {
		this.resolveIdleWaiters();
		this.notifyActivity();
	}

	async waitForIdle(): Promise<void> {
		while (true) {
			if (this.shutdownReason) return;
			if (this.submissionLease !== undefined || this.activeRuns > 0 || this.deps.isCompacting?.() === true) {
				await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
				continue;
			}
			await this.deps.agent.waitForIdle();
			if (!this.isBusy) return;
			// Evaluation, semantic health, or an armed continuation is still occupancy.
			// Those owners wake this waiter when they clear. Register first, then recheck,
			// so a clear that lands between the check and the registration is not lost.
			await new Promise<void>((resolve) => {
				let settled = false;
				const finish = (): void => {
					if (settled) return;
					settled = true;
					this.idleWaiters.delete(waiter);
					resolve();
				};
				const waiter = (): void => finish();
				this.idleWaiters.add(waiter);
				if (this.shutdownReason || !this.isBusy) finish();
			});
		}
	}

	shutdown(): void {
		this.shutdownReason ??= new Error("Session disposed before foreground submission authority was acquired");
		for (const resolve of this.idleWaiters) resolve();
		this.idleWaiters.clear();
		this.activityListeners.clear();
	}

	private resolveIdleWaiters(): void {
		if (this.submissionLease !== undefined || this.activeRuns > 0) return;
		for (const resolve of this.idleWaiters) resolve();
		this.idleWaiters.clear();
	}

	abortRetry(): void {
		this.retry.abort();
	}

	isModelExhausted(ref: string): boolean {
		return this.billingFailover.isExhausted(ref);
	}

	/** Record a quota exhaustion another lane met (see BillingFailoverController.markModelExhausted). */
	markModelExhausted(ref: string, retryAfterMs?: number): void {
		this.billingFailover.markModelExhausted(ref, retryAfterMs);
	}

	/** The provider's limits were reset (a redeemed subscription reset): none of its exhaustions holds. */
	clearProviderExhaustion(provider: string): void {
		this.billingFailover.clearProviderExhaustion(provider);
	}

	getFailoverStatus(): ModelRouterFailoverStatus {
		return { ...this.billingFailover.getStatus(), failureStats: this.deps.failureCorpus.stats() };
	}

	observeAssistant(message: AssistantMessage): void {
		this.lastAssistantMessage = message;
		if (message.stopReason === "error") return;
		if (message.stopReason === "aborted") {
			this.finishRetry(false, message.errorMessage ?? "Retry aborted");
			return;
		}
		this.deps.onSuccessfulAssistant();
		this.finishRetry(true);
	}

	willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const settings = this.deps.settingsManager.getRetrySettings();
		// The same answer handlePostAgentRun gives: a closing session starts no retry, so it must not advertise one.
		if (this.shutdownReason) return false;
		if (!settings.enabled || this.retry.attempt >= settings.maxRetries) return false;
		for (let index = event.messages.length - 1; index >= 0; index--) {
			const message = event.messages[index];
			if (message.role !== "assistant") continue;
			const classified = this.classifyAssistantError(message);
			if (!classified?.retryable) return false;
			try {
				computeRetryDelayMs(this.getRetryPolicy(), this.retry.attempt + 1, {
					retryAfterMs: classified.retryAfterMs,
				});
				return true;
			} catch (error) {
				if (error instanceof RetryDelayExceededError) return false;
				throw error;
			}
		}
		return false;
	}

	async handlePostAgentRun(): Promise<boolean> {
		const message = this.lastAssistantMessage;
		this.lastAssistantMessage = undefined;
		if (!message) return false;
		// A closing session starts no recovery of its own: no retry, no model switch, no failover and no compaction (each of them is a
		// paid provider call). The run's last message is already persisted; whatever remains queued is held by the caller.
		if (this.shutdownReason) return false;

		const classified = this.classifyAssistantError(message);
		if (classified) {
			this.deps.failureCorpus.record({
				provider: message.provider,
				modelId: message.model,
				message: message.errorMessage ?? "",
				classified,
			});
		}
		const compactionRetryKey =
			classified?.retryable && classified.shouldCompact
				? `${message.provider}\u0000${message.model}\u0000${classified.reason}\u0000${message.errorMessage ?? ""}`
				: undefined;
		const repeatedCompactionFailure =
			compactionRetryKey !== undefined && compactionRetryKey === this.pendingCompactionRetryKey;
		if (!repeatedCompactionFailure) this.pendingCompactionRetryKey = undefined;
		if (repeatedCompactionFailure && (await this.deps.checkCompaction(message))) {
			return true;
		}
		if (classified?.retryable && (await this.retry.prepareRetry(message))) {
			this.pendingCompactionRetryKey = compactionRetryKey;
			return true;
		}
		if (classified?.reason === "model_unsupported") {
			const replacement = await this.deps.replaceUnsupportedModel?.(message);
			if (replacement && this.retry.prepareModelSwitchRetry(message, `Continuing on ${replacement}.`)) return true;
		}
		if (classified?.reason === "billing_or_quota") this.deps.onUsageLimitReached?.(message);
		const billing = await this.billingFailover.handleAssistantError(message, classified);
		// A quota the work moved off continues at once on the model it moved to, like an unsupported model.
		if (billing.continuedOn && this.retry.prepareModelSwitchRetry(message, `Continuing on ${billing.continuedOn}.`))
			return true;
		if (billing.handled) return false;

		if (message.stopReason === "error") this.finishRetry(false, message.errorMessage);
		if (await this.deps.checkCompaction(message)) return true;
		return this.deps.agent.hasQueuedMessages();
	}

	private finishRetry(success: boolean, finalError?: string): void {
		this.pendingCompactionRetryKey = undefined;
		if (this.retry.attempt === 0) return;
		this.deps.emit({ type: "auto_retry_end", success, attempt: this.retry.attempt, finalError });
		this.retry.reset();
	}

	private classifyAssistantError(message: AssistantMessage): ClassifiedError | undefined {
		if (message.stopReason !== "error" || !message.errorMessage) return undefined;
		return classifyFailure({
			message: message.errorMessage,
			contextOverflow: isContextOverflow(message, this.deps.getContextWindow()),
			provider: message.provider,
		});
	}
}
