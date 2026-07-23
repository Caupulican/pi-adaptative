import type { Agent, AgentMessage, RetryPolicy, ThinkingLevel } from "@caupulican/pi-agent-core";
import { classifyFailure, computeRetryDelayMs, DEFAULT_RETRY_POLICY, sleepAbortable } from "@caupulican/pi-agent-core";
import {
	type CompactionEntry,
	type CompactionPreparation,
	type CompactionResult,
	type CompactionSettings,
	calculateContextTokens,
	compact,
	createDeterministicCompaction,
	estimateContextTokens,
	getLatestCompactionEntry,
	prepareCompaction,
	runCompactionLoop,
	type SessionManager,
	shouldCompact,
} from "@caupulican/pi-agent-core/node";
import type { Api, AssistantMessage, Model } from "@caupulican/pi-ai";
import { isContextOverflow } from "@caupulican/pi-ai";
import { formatNoModelSelectedMessage } from "./auth-guidance.ts";
import type { ExtensionRunner, SessionBeforeCompactResult } from "./extensions/index.ts";
import type { FailureCorpusRecorder } from "./failure-corpus.ts";
import type { SettingsManager } from "./settings-manager.ts";

export type AutoCompactionReason = "overflow" | "threshold";

type CompactionControllerEvent =
	| { type: "compaction_start"; reason: "manual" | AutoCompactionReason }
	| {
			type: "compaction_end";
			reason: "manual" | AutoCompactionReason;
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			skipReason?: string;
	  }
	| { type: "warning"; message: string };

export interface CompactionControllerDeps {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	getModel(): Model<Api> | undefined;
	getAdaptedSettings(): CompactionSettings;
	getRequestAuth(model: Model<Api>): Promise<{ apiKey?: string; headers?: Record<string, string> }>;
	resolveModelAndAuth(
		compactionModel: Model<Api>,
		sessionModel: Model<Api>,
	): Promise<{ model: Model<Api>; apiKey?: string; headers?: Record<string, string>; failure?: string }>;
	resolveModel(sessionModel: Model<Api>): Model<Api>;
	getSelectionReason(): string | undefined;
	resolveThinkingLevel(compactionModel: Model<Api>, sessionModel: Model<Api>): ThinkingLevel | undefined;
	describeSummarizer(): string;
	getExtensionRunner(): ExtensionRunner;
	isRawStream(): boolean;
	disconnectAgent(): void;
	reconnectAgent(): void;
	abortForeground(): Promise<void>;
	emit(event: CompactionControllerEvent): void;
	estimateCurrentContextTokens(messages: AgentMessage[]): number;
	buildPreDigest(): ((text: string, signal?: AbortSignal) => Promise<string>) | undefined;
	refreshAfterCompaction(): void;
	getFailureCorpus(): FailureCorpusRecorder;
	measureLiveContextTokens(): number;
	runAutoCompaction(reason: AutoCompactionReason, willRetry: boolean): Promise<boolean>;
	compactWithRetry(
		run: () => Promise<CompactionResult>,
		signal: AbortSignal,
		provider?: string,
	): Promise<CompactionResult>;
}

export async function runCompactionWithRetry<T>(options: {
	run(): Promise<T>;
	signal: AbortSignal;
	provider?: string;
	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number };
	recordFailure(record: Parameters<FailureCorpusRecorder["record"]>[0]): void;
}): Promise<T> {
	const retrySettings = options.getRetrySettings();
	const maxAttempts = retrySettings.enabled ? Math.max(1, retrySettings.maxRetries + 1) : 1;
	const policy: RetryPolicy = {
		maxAttempts,
		baseDelayMs: retrySettings.baseDelayMs,
		maxDelayMs: DEFAULT_RETRY_POLICY.maxDelayMs,
		jitterRatio: 0,
	};
	for (let attempt = 1; ; attempt++) {
		try {
			return await options.run();
		} catch (error) {
			if (options.signal.aborted || attempt >= maxAttempts) throw error;
			const message = error instanceof Error ? error.message : String(error);
			const classified = classifyFailure({ message, provider: options.provider });
			options.recordFailure({ provider: options.provider, message, classified });
			if (!classified.retryable) throw error;
			await sleepAbortable(
				computeRetryDelayMs(policy, attempt, { retryAfterMs: classified.retryAfterMs }),
				options.signal,
			);
		}
	}
}

/** Owns compaction detection, execution, retry, persistence, notification, and cancellation. */
export class CompactionController {
	private manualAbortController: AbortController | undefined;
	private autoAbortController: AbortController | undefined;
	private overflowRecoveryAttempted = false;
	private readonly deps: CompactionControllerDeps;

	constructor(deps: CompactionControllerDeps) {
		this.deps = deps;
	}

	isRunning(): boolean {
		return this.manualAbortController !== undefined || this.autoAbortController !== undefined;
	}

	resetOverflowRecovery(): void {
		this.overflowRecoveryAttempted = false;
	}

	abort(): void {
		this.manualAbortController?.abort();
		this.autoAbortController?.abort();
	}

	checkContextWindowUsageWarning(): void {
		const model = this.deps.getModel();
		if (!model) return;
		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return;

		const systemPromptTokens = Math.ceil((this.deps.agent.state.systemPrompt ?? "").length / 4);
		let toolsChars = 0;
		for (const tool of this.deps.agent.state.tools || []) {
			toolsChars += tool.name.length;
			toolsChars += tool.description?.length ?? 0;
			if (tool.parameters) toolsChars += JSON.stringify(tool.parameters).length;
		}
		const baseTokens = systemPromptTokens + Math.ceil(toolsChars / 4);

		if (baseTokens >= contextWindow) {
			this.deps.emit({
				type: "warning",
				message: `Base configuration (system prompt and active tools) consumes ${baseTokens} tokens, which exceeds the model's context window of ${contextWindow} tokens. The model cannot process any prompts in this state.`,
			});
		} else if (baseTokens >= contextWindow * 0.7) {
			this.deps.emit({
				type: "warning",
				message: `Base configuration (system prompt and active tools) consumes ${baseTokens} tokens (${Math.round((baseTokens / contextWindow) * 100)}% of the ${contextWindow} context window). This leaves very little room for conversation history and may cause immediate compaction or context overflow.`,
			});
		}
	}

	async maybeCompactBeforeContextTransform(
		messages: AgentMessage[],
		projectContextGc: (messages: AgentMessage[]) => AgentMessage[],
	): Promise<boolean> {
		const settings = this.deps.getAdaptedSettings();
		const model = this.deps.getModel();
		const contextWindow = model?.contextWindow ?? 0;
		if (!settings.enabled || !model || contextWindow <= 0 || this.isRunning()) return false;

		const triggerTokens = model.autoCompactionTriggerTokens;
		const contextTokens = this.deps.estimateCurrentContextTokens(messages);
		if (!shouldCompact(contextTokens, contextWindow, settings, triggerTokens)) return false;
		const projectedMessages = projectContextGc(messages);
		const projectedTokens = this.deps.estimateCurrentContextTokens(projectedMessages);
		if (!shouldCompact(projectedTokens, contextWindow, settings, triggerTokens)) return false;

		const latestBefore = getLatestCompactionEntry(this.deps.sessionManager.getBranch())?.id;
		await this.deps.runAutoCompaction("threshold", false);
		const latestAfter = getLatestCompactionEntry(this.deps.sessionManager.getBranch())?.id;
		return Boolean(latestAfter && latestAfter !== latestBefore);
	}

	async compact(customInstructions?: string): Promise<CompactionResult> {
		this.deps.disconnectAgent();
		await this.deps.abortForeground();
		this.manualAbortController = new AbortController();
		this.deps.emit({ type: "compaction_start", reason: "manual" });

		try {
			const sessionModel = this.deps.getModel();
			if (!sessionModel) throw new Error(formatNoModelSelectedMessage());

			const selectedCompactionModel = this.deps.resolveModel(sessionModel);
			if (this.deps.isRawStream()) await this.deps.getRequestAuth(selectedCompactionModel);
			const selectionReason = this.deps.getSelectionReason() ?? "unknown";
			const settings = this.deps.getAdaptedSettings();
			const initialBranch = this.deps.sessionManager.getBranch();
			const initialPreparation = prepareCompaction(initialBranch, settings);
			if (!initialPreparation) {
				const lastEntry = initialBranch[initialBranch.length - 1];
				if (lastEntry?.type === "compaction") throw new Error("Already compacted");
				throw new Error("Nothing to compact (session too small)");
			}

			const signal = this.manualAbortController.signal;
			const extension = await this.getExtensionCompaction(
				initialPreparation,
				initialBranch,
				customInstructions,
				signal,
			);
			if (extension.cancelled) throw new Error("Compaction cancelled");
			if (extension.result) {
				await this.applyResult(extension.result, true);
				this.deps.emit({
					type: "compaction_end",
					reason: "manual",
					result: extension.result,
					aborted: false,
					willRetry: false,
				});
				return extension.result;
			}

			let appliedResult: CompactionResult | undefined;
			const outcome = await runCompactionLoop({
				measureLiveTokens: () =>
					Math.max(this.deps.estimateCurrentContextTokens(this.deps.agent.state.messages), 1),
				shouldCompact: () => true,
				getPostApplyMargin: () => 0,
				getBranch: () => this.deps.sessionManager.getBranch(),
				getBaseKeepRecentTokens: () => settings.keepRecentTokens,
				resolveModelAndAuth: async (modelTier) => {
					const model = modelTier === "cheap" ? selectedCompactionModel : sessionModel;
					return this.deps.resolveModelAndAuth(model, sessionModel);
				},
				summarizeAndVerify: async (params, model, apiKey, headers, branch) => {
					const preparation = prepareCompaction(
						branch,
						{ ...settings, keepRecentTokens: params.keepRecentTokens },
						{ allowTrailingCompactionAsPrevious: true },
					);
					if (!preparation) throw new Error("Nothing to compact (session too small)");
					const compactionThinkingLevel = this.deps.resolveThinkingLevel(model, sessionModel);
					const result = await this.deps.compactWithRetry(
						() =>
							compact(
								preparation,
								model,
								apiKey,
								headers,
								customInstructions,
								signal,
								compactionThinkingLevel,
								this.deps.agent.streamFn,
								this.deps.buildPreDigest(),
								{ chunked: params.chunked },
							),
						signal,
						model.provider,
					);
					return { result };
				},
				buildDeterministicCheckpoint: () => ({ result: createDeterministicCompaction(initialPreparation) }),
				apply: async (result) => {
					if (signal.aborted) throw new Error("Compaction cancelled");
					await this.applyResult(result, false);
					appliedResult = result;
				},
				verifyPostApplyEffect: () => false,
				onTransition: ({ cycle, cause, detail }) => {
					this.deps.emit({
						type: "warning",
						message: `manual compaction cycle ${cycle}: ${cause}${detail ? ` (${detail})` : ""} — retrying from step 0 (${this.deps.describeSummarizer()})`,
					});
				},
				signal,
			});

			if (outcome.kind === "failed") {
				if (outcome.reason === "aborted") throw new Error("Compaction cancelled");
				throw new Error(
					`manual compaction failed after retry ladder using ${selectedCompactionModel.provider}/${selectedCompactionModel.id} (${selectionReason}); first failure: ${outcome.reason}`,
				);
			}
			if (outcome.kind === "skip" || !appliedResult) {
				throw new Error(outcome.kind === "skip" ? outcome.reason : "Compaction failed");
			}
			this.deps.emit({
				type: "compaction_end",
				reason: "manual",
				result: appliedResult,
				aborted: false,
				willRetry: false,
			});
			return appliedResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			this.deps.emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			});
			throw error;
		} finally {
			this.manualAbortController = undefined;
			this.deps.reconnectAgent();
		}
	}

	async check(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		const settings = this.deps.getAdaptedSettings();
		if (!settings.enabled) return false;
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const model = this.deps.getModel();
		const contextWindow = model?.contextWindow ?? 0;
		const sameModel = model && assistantMessage.provider === model.provider && assistantMessage.model === model.id;
		const compactionEntry = getLatestCompactionEntry(this.deps.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) return false;

		if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
			if (this.overflowRecoveryAttempted) {
				this.deps.emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return false;
			}
			this.overflowRecoveryAttempted = true;
			const messages = this.deps.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.deps.agent.state.messages = messages.slice(0, -1);
			}
			return this.deps.runAutoCompaction("overflow", true);
		}

		let contextTokens: number;
		if (assistantMessage.stopReason === "error") {
			const messages = this.deps.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			if (estimate.lastUsageIndex === null) return false;
			const usageMessage = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMessage.role === "assistant" &&
				usageMessage.timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return false;
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = calculateContextTokens(assistantMessage.usage);
			const estimate = estimateContextTokens(this.deps.agent.state.messages);
			if (estimate.lastUsageIndex !== null) {
				const usageMessage = this.deps.agent.state.messages[estimate.lastUsageIndex];
				const usageIsPostCompaction = !(
					compactionEntry &&
					usageMessage.role === "assistant" &&
					usageMessage.timestamp <= new Date(compactionEntry.timestamp).getTime()
				);
				if (usageIsPostCompaction) contextTokens = Math.max(contextTokens, estimate.tokens);
			}
		}
		if (shouldCompact(contextTokens, contextWindow, settings, model?.autoCompactionTriggerTokens)) {
			return this.deps.runAutoCompaction("threshold", false);
		}
		return false;
	}

	measureLiveContextTokens(): number {
		const estimatedTokens = this.deps.estimateCurrentContextTokens(this.deps.agent.state.messages);
		const assistantMessage = this.findLastAssistantMessage();
		if (!assistantMessage || assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
			return estimatedTokens;
		}
		const compactionEntry = getLatestCompactionEntry(this.deps.sessionManager.getBranch());
		if (compactionEntry && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime()) {
			return estimatedTokens;
		}
		return Math.max(calculateContextTokens(assistantMessage.usage), estimatedTokens);
	}

	async runAuto(reason: AutoCompactionReason, willRetry: boolean): Promise<boolean> {
		const settings = this.deps.getAdaptedSettings();
		const model = this.deps.getModel();
		this.deps.emit({ type: "compaction_start", reason });
		const hadQueuedMessages = this.deps.agent.hasQueuedMessages();
		this.autoAbortController = new AbortController();
		const signal = this.autoAbortController.signal;
		let fromExtension = false;
		let lastCompaction: CompactionResult | undefined;
		let extensionCancelled = false;
		try {
			if (!model) {
				this.deps.emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipReason: "no model selected",
				});
				return hadQueuedMessages || this.deps.agent.hasQueuedMessages();
			}

			const contextWindow = model.contextWindow;
			const margin = Math.max(0, Math.floor(0.01 * contextWindow));
			const outcome = await runCompactionLoop({
				getBranch: () => this.deps.sessionManager.getBranch(),
				measureLiveTokens: () => this.deps.measureLiveContextTokens(),
				shouldCompact:
					reason === "overflow"
						? () => true
						: (tokens) => shouldCompact(tokens, contextWindow, settings, model.autoCompactionTriggerTokens),
				getPostApplyMargin: () => margin,
				getBaseKeepRecentTokens: () => settings.keepRecentTokens,
				resolveModelAndAuth: async (modelTier) =>
					this.deps.resolveModelAndAuth(modelTier === "session" ? model : this.deps.resolveModel(model), model),
				summarizeAndVerify: async (params, compactModel, apiKey, headers, branchEntries) => {
					fromExtension = false;
					const preparation = prepareCompaction(branchEntries, {
						...settings,
						keepRecentTokens: params.keepRecentTokens,
					});
					if (!preparation) throw new Error("already compacted");
					const compactionThinkingLevel = this.deps.resolveThinkingLevel(compactModel, model);
					const extension = await this.getExtensionCompaction(preparation, branchEntries, undefined, signal);
					if (extension.cancelled) {
						extensionCancelled = true;
						throw new Error("auto-compaction-cancelled");
					}
					if (extension.result) {
						fromExtension = true;
						return { result: extension.result };
					}
					const result = await this.deps.compactWithRetry(
						() =>
							compact(
								preparation,
								compactModel,
								apiKey,
								headers,
								undefined,
								signal,
								compactionThinkingLevel,
								this.deps.agent.streamFn,
								this.deps.buildPreDigest(),
								{ chunked: params.chunked },
							),
						signal,
						compactModel.provider,
					);
					return { result };
				},
				buildDeterministicCheckpoint: () => {
					const preparation = prepareCompaction(this.deps.sessionManager.getBranch(), settings);
					if (!preparation) throw new Error("already compacted");
					fromExtension = false;
					return { result: createDeterministicCompaction(preparation) };
				},
				apply: async (result) => {
					lastCompaction = result;
					await this.applyResult(result, fromExtension);
				},
				verifyPostApplyEffect: reason === "overflow" ? () => false : undefined,
				onTransition: ({ cycle, cause, detail }) => {
					this.deps.emit({
						type: "warning",
						message: `auto-compaction cycle ${cycle}: ${cause}${detail ? ` (${detail})` : ""} — retrying from step 0 (${this.deps.describeSummarizer()})`,
					});
				},
				signal,
			});

			if (outcome.kind === "skip") {
				this.deps.emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipReason: outcome.reason,
				});
				return hadQueuedMessages || this.deps.agent.hasQueuedMessages();
			}
			if (outcome.kind === "failed") {
				if (outcome.reason === "aborted") {
					this.deps.emit({ type: "compaction_end", reason, result: undefined, aborted: true, willRetry: false });
					return hadQueuedMessages || this.deps.agent.hasQueuedMessages();
				}
				throw new Error(outcome.reason);
			}
			if (extensionCancelled || signal.aborted) {
				this.deps.emit({ type: "compaction_end", reason, result: undefined, aborted: true, willRetry: false });
				return hadQueuedMessages || this.deps.agent.hasQueuedMessages();
			}

			const result = outcome.kind === "success" ? outcome.result : lastCompaction;
			if (!result) throw new Error("Auto-compaction succeeded without a result");
			this.deps.emit({ type: "compaction_end", reason, result, aborted: false, willRetry });
			if (willRetry) {
				const messages = this.deps.agent.state.messages;
				const lastMessage = messages[messages.length - 1];
				if (lastMessage?.role === "assistant" && lastMessage.stopReason === "error") {
					this.deps.agent.state.messages = messages.slice(0, -1);
				}
				return true;
			}
			return hadQueuedMessages || this.deps.agent.hasQueuedMessages();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			this.deps.emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage:
					reason === "overflow"
						? `Context overflow recovery failed: ${errorMessage}`
						: `Auto-compaction failed: ${errorMessage}`,
			});
			return hadQueuedMessages || this.deps.agent.hasQueuedMessages();
		} finally {
			this.autoAbortController = undefined;
		}
	}

	async compactWithRetry(
		run: () => Promise<CompactionResult>,
		signal: AbortSignal,
		provider?: string,
	): Promise<CompactionResult> {
		return runCompactionWithRetry({
			run,
			signal,
			provider,
			getRetrySettings: () => this.deps.settingsManager.getRetrySettings(),
			recordFailure: (record) => this.deps.getFailureCorpus().record(record),
		});
	}

	private findLastAssistantMessage(): AssistantMessage | undefined {
		for (let index = this.deps.agent.state.messages.length - 1; index >= 0; index--) {
			const message = this.deps.agent.state.messages[index];
			if (message.role === "assistant") return message;
		}
		return undefined;
	}

	private async getExtensionCompaction(
		preparation: CompactionPreparation,
		branchEntries: ReturnType<SessionManager["getBranch"]>,
		customInstructions: string | undefined,
		signal: AbortSignal,
	): Promise<{ cancelled: boolean; result?: CompactionResult }> {
		const extensionRunner = this.deps.getExtensionRunner();
		if (!extensionRunner.hasHandlers("session_before_compact")) return { cancelled: false };
		const extensionResult = (await extensionRunner.emit({
			type: "session_before_compact",
			preparation,
			branchEntries,
			customInstructions,
			signal,
		})) as SessionBeforeCompactResult | undefined;
		return { cancelled: extensionResult?.cancel === true, result: extensionResult?.compaction };
	}

	private async applyResult(result: CompactionResult, fromExtension: boolean): Promise<void> {
		this.deps.sessionManager.appendCompaction(
			result.summary,
			result.firstKeptEntryId,
			result.tokensBefore,
			result.details,
			fromExtension,
		);
		this.deps.refreshAfterCompaction();
		const savedEntry = this.deps.sessionManager
			.getEntries()
			.find((entry) => entry.type === "compaction" && entry.summary === result.summary) as
			| CompactionEntry
			| undefined;
		if (savedEntry) {
			await this.deps.getExtensionRunner().emit({
				type: "session_compact",
				compactionEntry: savedEntry,
				fromExtension,
			});
		}
	}
}
