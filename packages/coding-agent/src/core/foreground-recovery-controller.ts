import type { Agent, AgentEvent, ClassifiedError } from "@caupulican/pi-agent-core";
import { classifyFailure, DEFAULT_RETRY_POLICY, RetryController } from "@caupulican/pi-agent-core";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { isContextOverflow } from "@caupulican/pi-ai";
import { BillingFailoverController, ExhaustedProviderRegistry } from "./billing-failover-controller.ts";
import type { FailureCorpusRecorder } from "./failure-corpus.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { ModelRouterFailoverStatus } from "./model-router/status.ts";
import type { SettingsManager } from "./settings-manager.ts";

type ForegroundRecoveryEvent =
	| { type: "warning"; message: string }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };

export interface ForegroundRecoveryControllerDeps {
	agent: Agent;
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	failureCorpus: FailureCorpusRecorder;
	getContextWindow(): number;
	emit(event: ForegroundRecoveryEvent): void;
	checkCompaction(message: AssistantMessage): Promise<boolean>;
	onSuccessfulAssistant(): void;
}

/** Owns foreground retry/failover/compaction recovery ordering and its response latch. */
export class ForegroundRecoveryController {
	private readonly retry: RetryController;
	private readonly billingFailover: BillingFailoverController;
	private lastAssistantMessage: AssistantMessage | undefined;
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
			emit: deps.emit,
			recordFailure: (record) => deps.failureCorpus.record(record),
		});
	}

	get attempt(): number {
		return this.retry.attempt;
	}

	get isRetrying(): boolean {
		return this.retry.isRetrying;
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
		if (classified?.retryable && (await this.retry.prepareRetry(message))) return true;
		if (await this.billingFailover.handleAssistantError(message, classified)) return false;

		if (message.stopReason === "error") this.finishRetry(false, message.errorMessage);
		if (await this.deps.checkCompaction(message)) return true;
		return this.deps.agent.hasQueuedMessages();
	}

	private finishRetry(success: boolean, finalError?: string): void {
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
