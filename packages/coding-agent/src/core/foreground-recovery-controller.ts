import { type Agent, AgentBusyError } from "@caupulican/pi-agent-core/agent";
import {
	type ClassifiedError,
	classifyFailure,
	DEFAULT_RETRY_POLICY,
	RetryController,
} from "@caupulican/pi-agent-core/reliability";
import type { AgentEvent, AgentMessage } from "@caupulican/pi-agent-core/types";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { isContextOverflow } from "@caupulican/pi-ai/overflow";
import { BillingFailoverController, ExhaustedProviderRegistry } from "./billing-failover-controller.ts";
import type { FailureCorpusRecorder } from "./failure-corpus.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { ModelRouterFailoverStatus } from "./model-router/status.ts";
import type { SettingsManager } from "./settings-manager.ts";

type ForegroundRecoveryEvent =
	| { type: "warning"; message: string }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };

const foregroundSubmissionLeaseMarker: unique symbol = Symbol("foregroundSubmissionLease");

/** Identity-bound authority to prepare and execute one logical foreground submission. */
export interface ForegroundSubmissionLease {
	readonly [foregroundSubmissionLeaseMarker]: true;
}

export interface ForegroundRecoveryControllerDeps {
	agent: Agent;
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	failureCorpus: FailureCorpusRecorder;
	getContextWindow(): number;
	emit(event: ForegroundRecoveryEvent): void;
	checkCompaction(message: AssistantMessage): Promise<boolean>;
	onSuccessfulAssistant(): void;
	prepareRun(): Promise<void>;
	afterRun(): Promise<void>;
	isCompacting?: () => boolean;
}

/** Owns the complete logical foreground run plus retry/failover/compaction recovery ordering. */
export class ForegroundRecoveryController {
	private readonly retry: RetryController;
	private readonly billingFailover: BillingFailoverController;
	private lastAssistantMessage: AssistantMessage | undefined;
	private pendingCompactionRetryKey: string | undefined;
	private activeRuns = 0;
	private submissionLease: ForegroundSubmissionLease | undefined;
	private shutdownReason: Error | undefined;
	private readonly idleWaiters = new Set<() => void>();
	private readonly deps: ForegroundRecoveryControllerDeps;

	constructor(deps: ForegroundRecoveryControllerDeps) {
		this.deps = deps;
		this.retry = new RetryController(
			deps.agent,
			() => {
				const retry = deps.settingsManager.getRetrySettings();
				return {
					enabled: retry.enabled,
					maxAttempts: retry.maxRetries,
					baseDelayMs: retry.baseDelayMs,
					maxDelayMs: DEFAULT_RETRY_POLICY.maxDelayMs,
					jitterRatio: 0,
				};
			},
			{
				onRetryStart: (info) => deps.emit({ type: "auto_retry_start", ...info }),
				onRetryEnd: (info) => deps.emit({ type: "auto_retry_end", ...info }),
			},
			deps.getContextWindow,
		);
		this.billingFailover = new BillingFailoverController({
			agent: deps.agent,
			modelRegistry: deps.modelRegistry,
			exhausted: new ExhaustedProviderRegistry(),
			subscriptionHop: deps.settingsManager.getFailoverSettings().subscriptionHop,
			emit: (event) => deps.emit(event),
			recordFailure: (record) => deps.failureCorpus.record(record),
		});
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
		return (
			this.submissionLease !== undefined ||
			this.isRunActive ||
			this.deps.agent.state.isStreaming ||
			this.isRetrying ||
			this.deps.isCompacting?.() === true
		);
	}

	/** Atomically reserve the full foreground lifecycle, including asynchronous prompt preparation. */
	tryAcquireSubmission(): ForegroundSubmissionLease | undefined {
		if (this.shutdownReason || this.isBusy) return undefined;
		const lease: ForegroundSubmissionLease = { [foregroundSubmissionLeaseMarker]: true };
		this.submissionLease = lease;
		return lease;
	}

	/** Wait until foreground ownership can be acquired without a check-then-act gap. */
	async acquireSubmission(): Promise<ForegroundSubmissionLease> {
		while (true) {
			if (this.shutdownReason) throw this.shutdownReason;
			const lease = this.tryAcquireSubmission();
			if (lease) return lease;
			await this.waitForIdle();
		}
	}

	ownsSubmission(lease: ForegroundSubmissionLease | undefined): boolean {
		return lease !== undefined && lease === this.submissionLease;
	}

	releaseSubmission(lease: ForegroundSubmissionLease): void {
		if (!this.ownsSubmission(lease)) {
			throw new Error("Cannot release foreground submission authority owned by another caller");
		}
		this.submissionLease = undefined;
		if (this.activeRuns === 0) {
			this.resolveIdleWaiters();
		}
	}

	async runAgentPrompt(
		messages: AgentMessage | AgentMessage[],
		submissionLease?: ForegroundSubmissionLease,
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
		try {
			const maxGoalLoopRounds = this.deps.settingsManager.getAutonomySettings().maxStallTurns;
			await this.deps.prepareRun();
			let goalLoopRounds = 1;
			await this.deps.agent.prompt(messages);
			while ((maxGoalLoopRounds === 0 || goalLoopRounds < maxGoalLoopRounds) && (await this.handlePostAgentRun())) {
				await this.deps.agent.continue();
				goalLoopRounds++;
			}
		} finally {
			try {
				await this.deps.afterRun();
			} finally {
				this.activeRuns--;
				if (releaseLease && lease && this.ownsSubmission(lease)) this.releaseSubmission(lease);
				if (this.activeRuns === 0 && this.submissionLease === undefined) {
					this.resolveIdleWaiters();
				}
			}
		}
	}

	wakeIdleWaiters(): void {
		this.resolveIdleWaiters();
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
		}
	}

	shutdown(): void {
		this.shutdownReason ??= new Error("Session disposed before foreground submission authority was acquired");
		for (const resolve of this.idleWaiters) resolve();
		this.idleWaiters.clear();
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

	getFailoverStatus(): ModelRouterFailoverStatus {
		return this.billingFailover.getStatus();
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
		if (!settings.enabled || this.retry.attempt >= settings.maxRetries) return false;
		for (let index = event.messages.length - 1; index >= 0; index--) {
			const message = event.messages[index];
			if (message.role === "assistant") return this.classifyAssistantError(message)?.retryable ?? false;
		}
		return false;
	}

	async handlePostAgentRun(): Promise<boolean> {
		const message = this.lastAssistantMessage;
		this.lastAssistantMessage = undefined;
		if (!message) return false;

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
		if (await this.billingFailover.handleAssistantError(message, classified)) return false;

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
