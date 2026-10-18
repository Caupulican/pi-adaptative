import type { Api, AssistantMessage, Model } from "@caupulican/pi-ai";
import { isContextOverflow } from "@caupulican/pi-ai/overflow";
import { type Agent, AgentBusyError } from "../kernel/agent.ts";
import {
	type ClassifiedError,
	classifyFailure,
	computeRetryDelayMs,
	DEFAULT_RETRY_POLICY,
	type RetryBackoffEnd,
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
import { SYSTEM_TIMER_SOURCE, type TimerSource } from "./util/timer-port.ts";
import {
	createWaitStatus,
	type WaitEndReason,
	type WaitEndReport,
	type WaitStatusEvent,
	waitFor,
} from "./util/wait.ts";

/**
 * How long a wait for the foreground (submission, live-run join, history claim, idle) runs before its status reports it
 * overdue, naming what holds the foreground, and again each time this elapses. It never ends such a wait: giving up
 * would let two owners run the foreground at once or strand the waiter's work.
 */
export const FOREGROUND_WAIT_OVERDUE_MS = 60_000;

/**
 * Why the owner steer never ends a retry backoff: the retry continuation is the live consumer that delivers input queued
 * while it waits (the retry window queues every prompt as steering), and ending the backoff early only re-sends into the
 * rate limit or transient failure the delay waits out.
 */
const RETRY_BACKOFF_STEER_EXEMPTION =
	"the retry continuation delivers the steer; ending the backoff early only re-sends into the limit or failure it waits out";

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
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "continuous_chat_prefix_wait";
			phase: "start" | "progress" | "end";
			built: number;
			needed: number;
			failed: number;
			end?: WaitEndReport;
	  }
	| WaitStatusEvent;

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

/**
 * The owner's admitted input as this owner hands it to runs (`PendingInputQueueController`). Admitted input goes to the
 * agent's queue only while a run consumes that queue (`hasLiveConsumer`); otherwise it waits here, and the next run that
 * consumes takes it, or this owner starts a delivery run for it once the foreground is idle (`serviceWaitingInput`).
 */
export interface ForegroundInputPort {
	/** Whether admitted input waits to be handed: the next input of a kind, in submission order, is decided and not handed. */
	hasHandableInput(): boolean;
	/** Hands every such input to the agent's queue, in submission order. */
	handOff(): void;
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
	/**
	 * The session timers: the `foreground` port runs the overdue watchdog of the foreground waits, the `foreground-retry`
	 * port the auto-retry backoff. Defaults to the system timers.
	 */
	timers?: TimerSource;
	/** The ICM chat's turns, undefined while no chat runs. Every provider run begins one, as its own, and ends it. */
	chatTurns?(): Pick<IcmTurnCoordinator, "begin" | "end"> | undefined;
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
	/**
	 * The submission holding `lease` is releasing the foreground, whatever its run's outcome (a retry window closed or
	 * abandoned, an abort, an error, no run at all): what it owned ends here, before the foreground is free for another.
	 */
	onSubmissionReleased?(lease: ForegroundSubmissionLease): void;
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
	/**
	 * Set while a run is inside its delivery rounds: from its first provider round through its stranded-input delivery. Only
	 * then does input handed to the agent's queue have a consumer; a run's preparation and its cleanup (`afterRun`) deliver
	 * nothing. Cleared in the same synchronous step as the run's last queue check, so nothing is admitted behind it unseen.
	 */
	private consumingRun = false;
	/** Whether the round now running is followed by a recovery classification: false at the stall cap and in stranded delivery. */
	private recoveryRoundAvailable = false;
	/**
	 * Tree navigations rewriting the history, each from its start until its new branch is installed or it ends. A run
	 * and a rewrite of the history it executes on exclude each other here: see `beginHistoryRewrite`.
	 */
	private readonly historyRewrites = new Set<symbol>();
	/** Set while a run owns the history: from before its preparation through its last delivery round, not its cleanup. */
	private runOwnsHistory = false;
	/**
	 * The submission preparing a turn for an input it carries: from the moment it takes that turn (`beginTurnPreparation`)
	 * until a run of it owns the history (`claimRunHistory`) or it releases the foreground. Its input was accepted in the
	 * history it prepares on, so a navigation is refused meanwhile, exactly as while a run owns the history.
	 */
	private preparingTurn: ForegroundSubmissionLease | undefined;
	private submissionLease: ForegroundSubmissionLease | undefined;
	/** Next epoch to assign. Starts at 1 so the first successful `tryAcquireSubmission()` yields
	 * epoch 1; only ever increases, including across releases -- it identifies a submission, not a
	 * count of currently-held leases. */
	private nextSubmissionEpoch = 1;
	private shutdownReason: Error | undefined;
	/** The admitted input this owner hands to runs (`bindInput`). */
	private input: ForegroundInputPort | undefined;
	/** Submissions waiting for the foreground (`acquireSubmission`, `acquireSubmissionOrJoinLiveConsumer`): the first run is theirs. */
	private submissionWaiters = 0;
	/** Set while `serviceWaitingInput` runs: the activity it causes itself is already being serviced. */
	private servicingInput = false;
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
			(delayMs, signal) => this.waitRetryBackoff(delayMs, signal),
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
			this.historyRewrites.size > 0 ||
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

	/** What holds the foreground right now, as an overdue foreground wait reports it. */
	private foregroundHolder(): string {
		const holders = [
			this.submissionLease ? `submission #${this.submissionLease.epoch}` : undefined,
			this.activeRuns > 0 ? "a run" : undefined,
			this.deps.agent.state.isStreaming ? "a streaming response" : undefined,
			this.isRetrying ? "a provider retry" : undefined,
			this.historyRewrites.size > 0 ? `${this.historyRewrites.size} history rewrite(s)` : undefined,
			this.deps.isCompacting?.() === true ? "compaction" : undefined,
			this.deps.isExtendedBusy?.() === true ? "extended foreground work" : undefined,
			this.deps.hasPendingIdleContinuation?.() === true ? "an armed continuation" : undefined,
		].filter((holder) => holder !== undefined);
		return holders.length > 0 ? holders.join(", ") : "nothing (the waiter is waking)";
	}

	/**
	 * The status stream of one wait for the foreground: `start` when the wait first blocks, `overdue` naming the
	 * holder every `FOREGROUND_WAIT_OVERDUE_MS` while it stays blocked, and one `end`. A wait that never blocks
	 * reports nothing. The owner steer never ends these waits (`steerExemption` says why); nor does time.
	 */
	private watchForegroundWait(
		id: string,
		wake: readonly string[],
		steerExemption: string,
	): { blocked(): void; end(end: WaitEndReason): void } {
		const clock = (this.deps.timers ?? SYSTEM_TIMER_SOURCE).port("foreground");
		const holder = (): string => this.foregroundHolder();
		const status = createWaitStatus({
			id,
			wake,
			steer: { mode: "exempt", reason: steerExemption },
			bound: { kind: "watchdog", overdueMs: FOREGROUND_WAIT_OVERDUE_MS, holder },
			report: (event) => this.deps.emit(event),
			now: () => clock.now(),
		});
		let started = false;
		let timer: unknown;
		const arm = (): void => {
			timer = clock.setTimeout(() => {
				status.overdue(holder());
				arm();
			}, FOREGROUND_WAIT_OVERDUE_MS);
		};
		return {
			blocked: () => {
				if (started) return;
				started = true;
				status.start();
				arm();
			},
			end: (end) => {
				if (timer !== undefined) clock.clearTimeout(timer);
				timer = undefined;
				status.end(end);
			},
		};
	}

	/** How a foreground wait that threw ended: the session shut down, or what it waited on failed. */
	private foregroundWaitFailure(error: unknown): WaitEndReason {
		if (this.shutdownReason !== undefined) return { kind: "disposed" };
		return { kind: "unavailable", cause: error instanceof Error ? error.message : String(error) };
	}

	/**
	 * One auto-retry backoff (`retry.backoff`) on the `foreground-retry` port: its one wake is the backoff's own alarm, which
	 * holds the process open (a one-shot run waits behind it); the retry's abort ends it `aborted`. Its watchdog reports it
	 * overdue, naming the attempt, once the delay plus `FOREGROUND_WAIT_OVERDUE_MS` passed with no alarm, and never ends it.
	 * The owner steer never ends it either (`RETRY_BACKOFF_STEER_EXEMPTION`).
	 */
	private async waitRetryBackoff(delayMs: number, signal: AbortSignal): Promise<RetryBackoffEnd> {
		const clock = (this.deps.timers ?? SYSTEM_TIMER_SOURCE).port("foreground-retry");
		let elapsed = false;
		const outcome = await waitFor<true>({
			id: "retry.backoff",
			wake: [
				{
					id: "retry.backoff_elapsed",
					subscribe: (onWake) => {
						const timer = clock.setTimeout(
							() => {
								elapsed = true;
								onWake();
							},
							delayMs,
							{ keepAlive: true },
						);
						return () => clock.clearTimeout(timer);
					},
					check: () => (elapsed ? { kind: "satisfied", value: true } : undefined),
				},
			],
			signal,
			steer: { mode: "exempt", reason: RETRY_BACKOFF_STEER_EXEMPTION },
			bound: {
				kind: "watchdog",
				overdueMs: delayMs + FOREGROUND_WAIT_OVERDUE_MS,
				holder: () => `the backoff of retry attempt ${this.retry.attempt} (${delayMs} ms)`,
			},
			clock,
			report: (event) => this.deps.emit(event),
		});
		if (outcome.end.kind === "satisfied") return "elapsed";
		if (outcome.end.kind === "aborted") return "aborted";
		// A watchdog wait with an exempt steer and no dispose source ends only satisfied or aborted.
		throw new Error(`Retry backoff ended ${outcome.end.kind}.`);
	}

	/** Wait until foreground ownership can be acquired without a check-then-act gap. */
	async acquireSubmission(): Promise<ForegroundSubmissionLease> {
		const watch = this.watchForegroundWait(
			"foreground.acquire",
			["agent.idle", "foreground.activity"],
			"the waiter is itself a submission: owner input queues to the run holding the foreground, which reads it",
		);
		let end: WaitEndReason = { kind: "disposed" };
		this.submissionWaiters++;
		try {
			while (true) {
				if (this.shutdownReason) throw this.shutdownReason;
				const lease = this.tryAcquireSubmission();
				if (lease) {
					end = { kind: "satisfied", by: "foreground.activity" };
					return lease;
				}
				watch.blocked();
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
						if (this.shutdownReason || !this.hasForegroundOccupancy() || this.deps.agent.state.isStreaming) {
							stop();
						}
					} catch (error) {
						unsubscribe();
						this.idleWaiters.delete(stop);
						throw error;
					}
				});
			}
		} catch (error) {
			end = this.foregroundWaitFailure(error);
			throw error;
		} finally {
			this.endSubmissionWait();
			watch.end(end);
		}
	}

	/** A submission stopped waiting for the foreground: input waiting for the first run is delivered if no other waits. */
	private endSubmissionWait(): void {
		this.submissionWaiters--;
		this.serviceWaitingInput();
	}

	/**
	 * Whether a run is inside its delivery rounds, streaming or retrying. Only then does a message handed to the agent's
	 * queue have a consumer. A held submission lease alone is not one: the submission may still end without a run (an
	 * extension command, handled input, a failed preflight) or be past its last round (postflight, cleanup). Compaction,
	 * an answer under evaluation and an armed continuation are busy without any consumer either.
	 */
	get hasLiveConsumer(): boolean {
		return this.consumingRun || this.deps.agent.state.isStreaming || this.isRetrying;
	}

	/** Every change of the consumer state is an activity change: a submission waiting to join a live run wakes on it. */
	private setConsumingRun(consuming: boolean): void {
		if (this.consumingRun === consuming) return;
		this.consumingRun = consuming;
		this.notifyActivity();
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
		const watch = this.watchForegroundWait(
			"foreground.acquire_or_join",
			["foreground.activity"],
			"the waiter is itself a submission: owner input queues to the run holding the foreground, which reads it",
		);
		let end: WaitEndReason = { kind: "aborted", reason: signal.reason };
		this.submissionWaiters++;
		try {
			while (!signal.aborted) {
				if (this.shutdownReason) throw this.shutdownReason;
				const lease = this.tryAcquireSubmission();
				if (lease) {
					end = { kind: "satisfied", by: "foreground.activity" };
					return lease;
				}
				if (this.hasLiveConsumer) {
					end = { kind: "satisfied", by: "foreground.live_consumer" };
					return "live_consumer";
				}
				watch.blocked();
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
			end = { kind: "aborted", reason: signal.reason };
			return undefined;
		} catch (error) {
			end = this.foregroundWaitFailure(error);
			throw error;
		} finally {
			this.endSubmissionWait();
			watch.end(end);
		}
	}

	/**
	 * Binds the owner's admitted input: from here every foreground activity change hands it to a live consumer, or starts
	 * a delivery run for it when the foreground is idle (`serviceWaitingInput`).
	 */
	bindInput(input: ForegroundInputPort): void {
		this.input = input;
		this.activityListeners.subscribe(() => this.serviceWaitingInput());
	}

	/** Input was admitted, or became next in order, while no run consumes the agent's queue. */
	noteInputWaiting(): void {
		this.serviceWaitingInput();
	}

	/**
	 * The one owner of admitted input that no run holds yet, run on every foreground activity change and on every admission:
	 * a run that consumes the agent's queue takes it now; with none, an idle foreground starts a delivery run for it, unless a
	 * submission waits for the foreground (its run takes the input instead). A delivery run starts only for input it was
	 * handed, so every run it starts ends that input delivered or held.
	 */
	private serviceWaitingInput(): void {
		const input = this.input;
		if (input === undefined || this.shutdownReason || this.servicingInput || !input.hasHandableInput()) return;
		this.servicingInput = true;
		try {
			if (this.hasLiveConsumer) {
				input.handOff();
				return;
			}
			if (this.submissionWaiters > 0) return;
			const lease = this.tryAcquireSubmission();
			if (lease === undefined) return;
			input.handOff();
			// Every handed input was held for its changed context: there is nothing to deliver.
			if (!this.deps.agent.hasQueuedMessages()) {
				this.releaseSubmission(lease);
				return;
			}
			void this.deliverWaitingInput(lease);
		} finally {
			this.servicingInput = false;
		}
	}

	/** The delivery run: it continues the history with the handed input, as a host handoff resumes it, then releases the foreground. */
	private async deliverWaitingInput(lease: ForegroundSubmissionLease): Promise<void> {
		try {
			await this.runAgentContinuation(lease);
		} catch (error) {
			// The run already held what it did not deliver; its failure is reported, once.
			this.deps.emit({
				type: "warning",
				message: `Queued input could not be delivered: ${error instanceof Error ? error.message : String(error)}`,
			});
		} finally {
			// Called with `void`: a failing release must be reported here, not become an unhandled rejection.
			try {
				this.releaseSubmission(lease);
			} catch (error) {
				this.deps.emit({
					type: "warning",
					message: `Queued input delivery could not release the foreground: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
	}

	/**
	 * A tree navigation takes the history it rewrites; the returned release (idempotent) gives it back. A navigation and a
	 * run exclude each other at this one owner: while a run owns the history, from its preparation through its last
	 * delivery round, or a submission prepares the turn of the input it carries (`beginTurnPreparation`), the navigation is
	 * refused (the run's cleanup, which drains queued extension commands, owns it no longer, nor does a submission's own
	 * extension command, which runs before its turn is taken); while a navigation holds it, every run waits before it
	 * begins (`claimRunHistory`) and no submission is admitted. Several navigations may hold it at once: the newest
	 * supersedes the older ones itself.
	 */
	beginHistoryRewrite(): () => void {
		if (this.runOwnsHistory || this.preparingTurn !== undefined) {
			throw new Error(
				"Cannot navigate the session tree while a turn is running. Wait for the turn to finish or interrupt it first.",
			);
		}
		const rewrite = Symbol("historyRewrite");
		this.historyRewrites.add(rewrite);
		return () => {
			if (!this.historyRewrites.delete(rewrite)) return;
			// The rewrite occupied the foreground: a submission, run or idle waiter parked behind it resumes now.
			this.wakeIdleWaiters();
		};
	}

	/**
	 * The run takes the history once no navigation rewrites it, in the same synchronous step as the last check, so no
	 * navigation starts between them. Woken by the rewrite's release, the submission's abort or shutdown, never polled.
	 * False when the submission closes while it waits.
	 */
	private async claimRunHistory(signal?: AbortSignal): Promise<boolean> {
		const watch = this.watchForegroundWait(
			"foreground.history_claim",
			["history.release"],
			"the waiting run reads owner input once it owns the history; ending this wait would end the run instead",
		);
		const closed = (): WaitEndReason =>
			this.shutdownReason !== undefined ? { kind: "disposed" } : { kind: "aborted", reason: signal?.reason };
		let end: WaitEndReason = { kind: "satisfied", by: "history.release" };
		try {
			while (this.historyRewrites.size > 0) {
				if (this.isClosing(signal)) {
					end = closed();
					return false;
				}
				watch.blocked();
				await new Promise<void>((resolve) => {
					const stop = (): void => {
						unsubscribe();
						this.idleWaiters.delete(stop);
						signal?.removeEventListener("abort", stop);
						resolve();
					};
					const unsubscribe = this.activityListeners.subscribe(stop);
					this.idleWaiters.add(stop);
					signal?.addEventListener("abort", stop, { once: true });
					// Register first, then recheck, so a release landing before the registration is not lost.
					if (this.isClosing(signal) || this.historyRewrites.size === 0) stop();
				});
			}
			if (this.isClosing(signal)) {
				end = closed();
				return false;
			}
			this.runOwnsHistory = true;
			// From here the run owns the history: the turn it prepared for is no longer only being prepared.
			this.preparingTurn = undefined;
			return true;
		} finally {
			watch.end(end);
		}
	}

	ownsSubmission(lease: ForegroundSubmissionLease | undefined): boolean {
		return lease !== undefined && lease === this.submissionLease;
	}

	/**
	 * The submission holding `lease` takes the turn of the input it carries: until a run of it owns the history, or it
	 * releases the foreground, no navigation rewrites the history that input was accepted in (`beginHistoryRewrite`).
	 */
	beginTurnPreparation(lease: ForegroundSubmissionLease): void {
		if (!this.ownsSubmission(lease)) {
			throw new AgentBusyError("Foreground submission authority is no longer active.");
		}
		this.preparingTurn = lease;
	}

	releaseSubmission(lease: ForegroundSubmissionLease): void {
		if (!this.ownsSubmission(lease)) {
			throw new Error("Cannot release foreground submission authority owned by another caller");
		}
		try {
			// What the submission owned ends with it, while it still holds the foreground: no waiter this release wakes
			// starts another submission beside it.
			this.deps.onSubmissionReleased?.(lease);
		} finally {
			if (this.preparingTurn === lease) this.preparingTurn = undefined;
			this.submissionLease = undefined;
			this.notifyActivity();
			if (this.activeRuns === 0) {
				this.resolveIdleWaiters();
			}
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
	 * Begins the chat turn a provider run is about to start, and returns its end. No turn is running here: this is the
	 * only caller of `turns.begin`, runs never overlap (`activeRuns`), and every run that began a turn ends it in its
	 * finally (host disposal ends one too). Called only where the run reaches its first provider call: a run that ends
	 * before it begins no turn. An abort ends the wait without a turn; the caller re-checks the closing gate after this
	 * await.
	 */
	private async beginChatTurn(
		startOf: () => ChatTurnStart,
		signal: AbortSignal | undefined,
	): Promise<(() => void) | undefined> {
		const turns = this.deps.chatTurns?.();
		if (turns === undefined) return undefined;
		const start = startOf();
		let turn: IcmTurnHandle;
		let waitProgress: { built: number; needed: number; failed: number } | undefined;
		let waitStarted = false;
		// How the wait ended, carried by its one `end` (the typed reason of util/wait.ts).
		let end: WaitEndReport = { kind: "satisfied", by: "icm.prefix" };
		try {
			turn = await turns.begin(signal, (progress) => {
				waitProgress = progress;
				this.deps.emit({
					type: "continuous_chat_prefix_wait",
					phase: waitStarted ? "progress" : "start",
					...progress,
				});
				waitStarted = true;
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			end = signal?.aborted ? { kind: "aborted", reason: message } : { kind: "unavailable", cause: message };
			if (signal?.aborted) return undefined;
			throw error;
		} finally {
			// One end for every start, whichever way the wait ends: reserved, aborted, unavailable or stopped.
			if (waitStarted && waitProgress)
				this.deps.emit({ type: "continuous_chat_prefix_wait", phase: "end", ...waitProgress, end });
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
	 * resume (a host handoff or a worker report), or a user or tool result the run continues from. The chat logs those as
	 * they persist, so the turn's view already holds them and no arrival will release it. A history that ends in an
	 * answer, or holds none, continues from the agent's queue instead (`Agent.continue`): the queued message the run sends
	 * first starts the turn, and the chat has not logged it yet.
	 */
	private continuationStartOf(): ChatTurnStart {
		const last = this.deps.agent.state.messages.at(-1);
		const queued = last === undefined || last.role === "assistant" ? this.deps.agent.peekQueuedStart() : undefined;
		if (queued !== undefined) return { message: queued, alreadyLogged: false };
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
			// A navigation rewriting the history this run would execute on finishes first; from here no navigation starts.
			if (!(await this.claimRunHistory(signal))) return;
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
			const atRoundCap = (): boolean => maxGoalLoopRounds !== 0 && goalLoopRounds >= maxGoalLoopRounds;
			// The runtime-update owner asked this run to end so the runtime can be replaced: no further provider round
			// starts on its behalf, stranded delivery included (a stop is "no automatic continuation"). Admitted input is
			// held for its owner by the finally below, never left in the agent's queue for an unrelated next run.
			let stoppedForRuntimeUpdate = false;
			// The provider refused the run's model for its usage limit and the work did not move to another model: a
			// stranded delivery round would go to the same exhausted model. Admitted input is held the same way.
			let stoppedOnUsageLimit = false;
			// From here the run delivers what the agent's queue holds, until its last round.
			this.setConsumingRun(true);
			this.recoveryRoundAvailable = !atRoundCap();
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
					if (atRoundCap()) {
						// The stall cap ends the run before any recovery classifies this failure: its retry window closes here.
						const capped = this.lastAssistantMessage;
						this.lastAssistantMessage = undefined;
						this.finishRetry(false, capped?.errorMessage);
						await this.deps.settleRuntimeUpdate?.(signal);
						break;
					}
					const recovery = await this.handlePostAgentRun();
					if (recovery !== "recover") {
						if (recovery === "usage_limit_stop") stoppedOnUsageLimit = true;
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
						if (atRoundCap()) break;
						const recovery = await this.handlePostAgentRun();
						if (recovery !== "recover") {
							if (recovery === "usage_limit_stop") stoppedOnUsageLimit = true;
							break;
						}
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
				this.recoveryRoundAvailable = !atRoundCap();
				await this.deps.agent.continue();
			}
			// Every `break` above is an exit with no further recovery round: a retry window the loop left open
			// (its last failure had no message to classify, or the session is closing) ends here, before any
			// stranded delivery round could read as the retry's recovery.
			this.recoveryRoundAvailable = false;
			if (this.retry.attempt > 0) this.finishRetry(false, "The run ended before the retry recovered.");
			// Input admitted to the agent's queue is the owner's and is never left behind it: delivered by stranded rounds
			// when another round may run, otherwise held for its owner by the finally below.
			if (!stoppedForRuntimeUpdate && !stoppedOnUsageLimit) {
				await this.deliverStrandedInput(signal);
				deliveredStranded = true;
			}
		} catch (error: unknown) {
			// The run failed. Its owned queued input is held first, then its cleanup runs HERE so that a failing cleanup is joined to
			// the run's failure (both stay in the thrown graph) instead of replacing it from the finally below.
			this.setConsumingRun(false);
			this.runOwnsHistory = false;
			this.recoveryRoundAvailable = false;
			if (this.retry.attempt > 0) this.finishRetry(false, error instanceof Error ? error.message : String(error));
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
			// Any exit that did not reach the stranded-input delivery (a closing exit, a runtime-update or usage-limit stop, or a run
			// whose prompt/continue/recovery threw) leaves the owner's admitted input in the agent's queue: hold it for its owner,
			// visible and recoverable, so it cannot leak into the next prompt's first boundary. Nothing is deleted and no refusal is
			// swallowed. (Messages an extension or the system queued directly on the agent are not owner input; the kernel's queue
			// delivers them at the next boundary.) The run delivers nothing more: it stops being a consumer in the same step as that
			// last queue check, and its cleanup below no longer owns the history (a queued extension command may navigate).
			this.setConsumingRun(false);
			this.runOwnsHistory = false;
			this.recoveryRoundAvailable = false;
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
	 * recovery that declined another round, the stall cap) while the agent's queue still holds admitted
	 * input. A runtime-update stop and a usage-limit stop never come here: neither may start another
	 * round, so their input is held. Each further round delivers what the agent's queue mode releases at a boundary
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
			// The run's last queue check: from here it consumes nothing, so later input waits for the next run instead.
			this.setConsumingRun(false);
			if (this.deps.agent.hasQueuedMessages()) this.deps.holdUndeliveredQueue?.();
		}
	}

	wakeIdleWaiters(): void {
		this.resolveIdleWaiters();
		this.notifyActivity();
	}

	async waitForIdle(): Promise<void> {
		const watch = this.watchForegroundWait(
			"foreground.idle",
			["agent.idle", "foreground.activity"],
			"an idle wait reads no input: the run holding the foreground delivers owner input itself",
		);
		let end: WaitEndReason = { kind: "satisfied", by: "foreground.activity" };
		try {
			while (true) {
				if (this.shutdownReason) {
					end = { kind: "disposed" };
					return;
				}
				if (
					this.submissionLease !== undefined ||
					this.activeRuns > 0 ||
					this.historyRewrites.size > 0 ||
					this.deps.isCompacting?.() === true
				) {
					watch.blocked();
					await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
					continue;
				}
				if (this.deps.agent.state.isStreaming) watch.blocked();
				await this.deps.agent.waitForIdle();
				if (!this.isBusy) return;
				watch.blocked();
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
		} catch (error) {
			end = this.foregroundWaitFailure(error);
			throw error;
		} finally {
			watch.end(end);
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

	/** The quota exhaustion holding for `ref` and its reset time, when one was recorded. */
	modelExhaustion(ref: string): { readonly until: number | undefined } | undefined {
		return this.billingFailover.exhaustion(ref);
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
		// Nor does a round no recovery follows: the stall cap's last round, stranded delivery, or a run outside the loop.
		if (!this.recoveryRoundAvailable) return false;
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

	/**
	 * Classifies the run's last assistant message: "recover" when a further round follows (retry, model switch, failover,
	 * compaction, or queued input), "end" when none does, "usage_limit_stop" when the provider refused the model for its
	 * usage limit and the work stays on that exhausted model, so no round of this run may go to it.
	 */
	private async handlePostAgentRun(): Promise<"recover" | "end" | "usage_limit_stop"> {
		const message = this.lastAssistantMessage;
		this.lastAssistantMessage = undefined;
		if (!message) return "end";
		// A closing session starts no recovery of its own: no retry, no model switch, no failover and no compaction (each of them is a
		// paid provider call). The run's last message is already persisted; whatever remains queued is held by the caller.
		if (this.shutdownReason) return "end";

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
			return "recover";
		}
		if (classified?.retryable && (await this.retry.prepareRetry(message))) {
			this.pendingCompactionRetryKey = compactionRetryKey;
			return "recover";
		}
		if (classified?.reason === "model_unsupported") {
			const replacement = await this.deps.replaceUnsupportedModel?.(message);
			if (replacement && this.retry.prepareModelSwitchRetry(message, `Continuing on ${replacement}.`))
				return "recover";
		}
		if (classified?.reason === "billing_or_quota") this.deps.onUsageLimitReached?.(message);
		const billing = await this.billingFailover.handleAssistantError(message, classified);
		// A quota the work moved off continues at once on the model it moved to, like an unsupported model.
		if (billing.continuedOn && this.retry.prepareModelSwitchRetry(message, `Continuing on ${billing.continuedOn}.`))
			return "recover";
		// No retry continues from here: the retry window ends with this failure, a handled billing stop included.
		if (message.stopReason === "error") this.finishRetry(false, message.errorMessage);
		// The foreground lane is never refused locally on an exhausted model (the owner's re-send must reach the provider),
		// so a handled stop the work did not move off is what keeps this run's further rounds off that model.
		if (billing.handled) return billing.continuedOn ? "end" : "usage_limit_stop";
		if (await this.deps.checkCompaction(message)) return "recover";
		return this.deps.agent.hasQueuedMessages() ? "recover" : "end";
	}

	private finishRetry(success: boolean, finalError?: string): void {
		this.pendingCompactionRetryKey = undefined;
		const attempt = this.retry.attempt;
		if (attempt === 0) return;
		// Settle the counter before emitting: a listener (the session's retry record) may throw, and the
		// retry window must still be closed when it does.
		this.retry.reset();
		this.deps.emit({ type: "auto_retry_end", success, attempt, finalError });
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
