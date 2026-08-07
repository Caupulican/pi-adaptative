import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { compact } from "@caupulican/pi-agent-core/compaction/compaction";
import {
	classifyFailure,
	computeRetryDelayMs,
	type RetryPolicy,
	sleepAbortable,
} from "@caupulican/pi-agent-core/reliability";
import { sanitizeToolFailureContext } from "@caupulican/pi-agent-core/tool-failure-memory";
import type { AgentMessage, ThinkingLevel } from "@caupulican/pi-agent-core/types";
import { addUsage, createEmptyUsage } from "@caupulican/pi-agent-core/usage";
import type { Api, AssistantMessage, Message, Model, Usage } from "@caupulican/pi-ai";
import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "../agent-session-contracts.ts";
import type { WorkerRequest } from "../autonomy/contracts.ts";
import type { LaneToolSurface } from "../autonomy/lane-tool-surface.ts";
import { safeRealpathSync } from "../autonomy/path-scope.ts";
import { composeSubagentSystemPrompt } from "../autonomy/subagent-prompt.ts";
import type { ModelCapabilityProfile } from "../model-capability.ts";
import { attemptUsageFromGatewayUsage, EMPTY_ATTEMPT_USAGE } from "../orchestration/attempt-usage.ts";
import {
	CapabilityGatewayDeniedError,
	type GatewayUsageDelta,
	type ProviderBudgetReservation,
} from "../orchestration/capability-gateway.ts";
import type { AttemptUsageSnapshot, ExecutionGrant } from "../orchestration/contracts.ts";
import type { StartedDelegationAttempt } from "../orchestration/delegation-ledger.ts";
import { WorkerActionJournal } from "./worker-action-journal.ts";
import type { AppliedActionsReport, WorkerAction } from "./worker-actions.ts";
import type { WorkerAgentControlCoordinator } from "./worker-agent-control-coordinator.ts";
import { WorkerConversationOwnershipError } from "./worker-conversation-revision.ts";
import type { WorkerConversation, WorkerConversationRetentionPolicy } from "./worker-conversation-store.ts";
import type { WorkerExecutionPlan } from "./worker-execution-policy.ts";
import type { WorkerLifecycle } from "./worker-lifecycle.ts";
import { runWorker, type WorkerRunOutcome } from "./worker-runner.ts";
import { WorkerTreeBudgetExceededError } from "./worker-tree-budget-coordinator.ts";

export interface RecoveredWorkerTerminalCompletion {
	text: string;
	usage: Usage;
	stopReason: string;
}

/** The live mutable state that must be visible to session disposal before provider work yields. */
export interface WorkerAttemptExecutionLedger {
	changedFiles: Set<string>;
	getUsage(): AttemptUsageSnapshot;
}

export interface WorkerAttemptExecutionResult {
	rawOutcome: WorkerRunOutcome;
	usage: AttemptUsageSnapshot;
	changedFiles: readonly string[];
}

/**
 * Backoff policy for transient worker provider failures. Without it, a dropped provider socket
 * kills the attempt instantly at $0 spend and an immediate re-dispatch hits the same dead
 * connection (field session 019fd4dc: paired $0 `completion_error` lanes ~10s apart). Jitter
 * de-synchronizes sibling workers that all lost the same connection at once.
 */
const WORKER_PROVIDER_RETRY_POLICY: RetryPolicy = {
	maxAttempts: 3,
	baseDelayMs: 2_000,
	maxDelayMs: 30_000,
	jitterRatio: 0.2,
};

export async function runProviderCompletionWithBackoff(args: {
	attempt: () => Promise<IsolatedCompletionResult>;
	/** Release per-attempt provider reservations before waiting; the final failure is rethrown. */
	onAttemptFailure: () => void;
	provider: string;
	laneId: string;
	warn: (message: string) => void;
	signal?: AbortSignal;
}): Promise<IsolatedCompletionResult> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await args.attempt();
		} catch (error) {
			args.onAttemptFailure();
			if (args.signal?.aborted) throw error;
			if (
				error instanceof WorkerCompletionProtocolError ||
				error instanceof WorkerConversationOwnershipError ||
				error instanceof CapabilityGatewayDeniedError ||
				error instanceof WorkerTreeBudgetExceededError
			) {
				throw error;
			}
			const classified = classifyFailure({
				message: error instanceof Error ? error.message : String(error),
				provider: args.provider,
			});
			if (!classified.retryable || attempt >= WORKER_PROVIDER_RETRY_POLICY.maxAttempts) throw error;
			const delayMs = computeRetryDelayMs(WORKER_PROVIDER_RETRY_POLICY, attempt, {
				...(classified.retryAfterMs !== undefined ? { retryAfterMs: classified.retryAfterMs } : {}),
			});
			args.warn(
				`Worker ${args.laneId} provider request failed (${classified.reason}); retrying in ${Math.ceil(delayMs / 1000)}s (attempt ${attempt + 1}/${WORKER_PROVIDER_RETRY_POLICY.maxAttempts}).`,
			);
			await sleepAbortable(delayMs, args.signal);
		}
	}
}

/**
 * The provider/tool-loop portion of a prepared worker attempt.
 *
 * Admission, durable leasing, grant compilation, terminalization, notification, verification, and
 * scheduling remain outside this boundary. This unit owns only the ordered child conversation:
 * persist assistant tool requests before execution, append messages before mailbox acknowledgements,
 * checkpoint cumulative usage before later boundaries, and compact only the provider projection.
 */
export interface WorkerAttemptExecutorOptions {
	request: WorkerRequest;
	grant: ExecutionGrant;
	executionPlan: WorkerExecutionPlan;
	toolSurface: LaneToolSurface;
	conversation: WorkerConversation;
	lifecycle: Pick<WorkerLifecycle, "checkpoint">;
	laneId: string;
	agentId: string;
	durableHandle: StartedDelegationAttempt;
	parentSessionId: string;
	agentDir: string;
	cwd: string;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	laneCapability: Pick<ModelCapabilityProfile, "laneMaxOutputTokens">;
	soul?: string;
	workerResourceSystemPrompt: string;
	initialUsage: AttemptUsageSnapshot;
	hasPersistedUsageCheckpoint: boolean;
	usageReportId: string;
	processCapable: boolean;
	verificationSubjectTaskId?: string;
	recoveredTerminal?: RecoveredWorkerTerminalCompletion;
	retentionPolicy?: WorkerConversationRetentionPolicy;
	signal?: AbortSignal;
	runIsolatedCompletion(options: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
	agentControl: Pick<WorkerAgentControlCoordinator, "acknowledgeMailboxMessage" | "mailboxMessagesForConversation">;
	applyActions?(actions: readonly WorkerAction[], actionJournal?: WorkerActionJournal): AppliedActionsReport;
	warn(message: string): void;
}

function recordAssistantUsage(surface: LaneToolSurface, message: Extract<Message, { role: "assistant" }>): void {
	surface.gateway?.recordUsage({
		inputTokens: message.usage.input,
		outputTokens: message.usage.output,
		cacheReadTokens: message.usage.cacheRead,
		cacheWriteTokens: message.usage.cacheWrite,
		totalTokens: message.usage.totalTokens,
		costUsd: message.usage.cost.total,
	});
}

function positiveProviderUsageDelta(reported: Usage, accounted: Usage): Required<GatewayUsageDelta> {
	return {
		inputTokens: Math.max(0, reported.input - accounted.input),
		outputTokens: Math.max(0, reported.output - accounted.output),
		cacheReadTokens: Math.max(0, reported.cacheRead - accounted.cacheRead),
		cacheWriteTokens: Math.max(0, reported.cacheWrite - accounted.cacheWrite),
		totalTokens: Math.max(0, reported.totalTokens - accounted.totalTokens),
		costUsd: Math.max(0, reported.cost.total - accounted.cost.total),
	};
}

function recordSupplementalProviderUsage(surface: LaneToolSurface, reported: Usage, accounted: Usage): boolean {
	const gateway = surface.gateway;
	if (!gateway) return false;
	const delta = positiveProviderUsageDelta(reported, accounted);
	if (
		delta.inputTokens === 0 &&
		delta.outputTokens === 0 &&
		delta.cacheReadTokens === 0 &&
		delta.cacheWriteTokens === 0 &&
		delta.totalTokens === 0 &&
		delta.costUsd === 0
	) {
		return false;
	}
	gateway.recordUsage(delta);
	return true;
}

function isToolRequest(message: Message): boolean {
	return message.role === "assistant" && message.content.some((content) => content.type === "toolCall");
}

class WorkerCompletionProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerCompletionProtocolError";
	}
}

function workerCompletionCallbackFailure(error: unknown): Error {
	if (
		error instanceof WorkerCompletionProtocolError ||
		error instanceof WorkerConversationOwnershipError ||
		error instanceof CapabilityGatewayDeniedError ||
		error instanceof WorkerTreeBudgetExceededError
	) {
		return error;
	}
	return new WorkerCompletionProtocolError(
		"Worker completion callback failed before its authority and durable transcript were verified.",
	);
}

class WorkerProviderReservationFence {
	private readonly acquire: () => Promise<ProviderBudgetReservation>;
	private readonly signal: AbortSignal;
	private readonly onFailure: (error: unknown) => void;
	private held: ProviderBudgetReservation | undefined;
	private heldConsumed = false;
	private inFlight = false;
	private generation = 0;
	private closed = false;
	private successfulPreflights = 0;
	private consumedPreflights = 0;

	constructor(options: {
		acquire(): Promise<ProviderBudgetReservation>;
		signal: AbortSignal;
		onFailure(error: unknown): void;
	}) {
		this.acquire = options.acquire;
		this.signal = options.signal;
		this.onFailure = options.onFailure;
	}

	async requestPreflight(): Promise<{ maxTokens: number }> {
		if (this.closed || this.inFlight || (this.held && !this.heldConsumed)) {
			const error = new WorkerCompletionProtocolError(
				"Worker completion attempted an overlapping or out-of-order provider preflight.",
			);
			this.generation += 1;
			this.onFailure(error);
			this.releaseHeldReservation();
			throw error;
		}
		// The previous provider turn is fully usage-accounted. Release its remaining capacity only
		// when the adapter proves a next turn is starting; a terminal turn stays fenced until the
		// returned result has been reconciled.
		this.releaseHeldReservation();
		this.inFlight = true;
		const generation = ++this.generation;
		let acquired: ProviderBudgetReservation | undefined;
		try {
			acquired = await this.acquire();
			this.signal.throwIfAborted();
			if (this.closed || generation !== this.generation) {
				throw new WorkerCompletionProtocolError(
					"Worker completion provider preflight resolved after its ownership fence closed.",
				);
			}
			this.held = acquired;
			this.heldConsumed = false;
			acquired = undefined;
			this.successfulPreflights += 1;
			return { maxTokens: this.held.maxTokens };
		} catch (error) {
			this.onFailure(error);
			acquired?.release();
			this.releaseHeldReservation();
			throw error;
		} finally {
			this.inFlight = false;
		}
	}

	assertAssistantReservation(): void {
		if (this.held && !this.heldConsumed) return;
		throw new WorkerCompletionProtocolError(
			"Worker completion attempted to persist an assistant without a held provider reservation.",
		);
	}

	consumeAssistantReservation(): void {
		this.assertAssistantReservation();
		this.consumedPreflights += 1;
		this.heldConsumed = true;
	}

	consumeToolAssistantReservation(): void {
		this.consumeAssistantReservation();
		this.releaseHeldReservation();
	}

	assertAllSuccessfulPreflightsConsumed(): void {
		if (
			!this.inFlight &&
			(!this.held || this.heldConsumed) &&
			this.consumedPreflights === this.successfulPreflights
		) {
			return;
		}
		throw new WorkerCompletionProtocolError(
			"Worker completion returned with a provider preflight authority epoch that no assistant consumed.",
		);
	}

	releaseHeldReservation(): void {
		const held = this.held;
		this.held = undefined;
		this.heldConsumed = false;
		held?.release();
	}

	hasSuccessfulPreflight(): boolean {
		return this.successfulPreflights > 0;
	}

	close(): void {
		if (!this.closed) {
			this.closed = true;
			this.generation += 1;
		}
		this.releaseHeldReservation();
	}
}

function callbackEvidencedCompletion(
	result: IsolatedCompletionResult,
	historyLength: number,
	emittedMessages: readonly Message[],
): { completion: IsolatedCompletionResult; suffix: Message[] } {
	if (result.messages !== undefined && result.messages.length < historyLength) {
		throw new WorkerCompletionProtocolError(
			"Worker completion protocol returned fewer messages than its input history.",
		);
	}
	let suffix: Message[];
	if (result.messages !== undefined) {
		suffix = result.messages.slice(historyLength);
		if (!isDeepStrictEqual(suffix, emittedMessages)) {
			throw new WorkerCompletionProtocolError(
				"Worker completion protocol returned a suffix without exact callback evidence.",
			);
		}
	} else {
		suffix = [...emittedMessages];
	}
	if (suffix.length === 0) {
		throw new WorkerCompletionProtocolError("Worker completion protocol returned no durable message suffix.");
	}
	if (!suffix.some((message) => message.role === "assistant")) {
		throw new WorkerCompletionProtocolError(
			"Worker completion protocol returned no assistant in its durable suffix.",
		);
	}
	const assistants = emittedMessages.filter((message): message is AssistantMessage => message.role === "assistant");
	const finalMessage = emittedMessages.at(-1);
	if (!finalMessage || finalMessage.role !== "assistant") {
		throw new WorkerCompletionProtocolError(
			"Worker completion protocol did not durably emit an assistant as its terminal message.",
		);
	}
	const usage = createEmptyUsage();
	for (const assistant of assistants) addUsage(usage, assistant.usage);
	const text = finalMessage.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("");
	if (
		result.text !== text ||
		result.stopReason !== finalMessage.stopReason ||
		!isDeepStrictEqual(result.usage, usage)
	) {
		throw new WorkerCompletionProtocolError(
			"Worker completion result disagrees with its durable callback-evidenced terminal assistant.",
		);
	}
	return {
		suffix,
		completion: {
			text,
			usage,
			stopReason: finalMessage.stopReason,
		},
	};
}

/**
 * Constructs one execution exactly once. The caller registers {@link ledger} before calling
 * {@link run}, allowing synchronous disposal to observe mutations and cumulative usage while the
 * provider/tool loop is suspended.
 */
export function createWorkerAttemptExecutor(options: WorkerAttemptExecutorOptions): {
	ledger: WorkerAttemptExecutionLedger;
	checkpointUsage(summary: string): AttemptUsageSnapshot;
	run(): Promise<WorkerAttemptExecutionResult>;
} {
	const changedFiles = new Set(options.conversation.getChangedFiles(options.durableHandle.attemptId));
	const toolIssues = new Set<string>();
	const recordChangedFile = (filePath: string): void => {
		changedFiles.add(filePath);
		try {
			options.conversation.recordChangedFile(options.durableHandle.attemptId, filePath);
		} catch (error) {
			toolIssues.add("worker changed-file progress could not be persisted; parent review is required");
			options.warn(
				`Worker changed-file progress persistence failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};
	const actionJournal = options.request.envelope.capabilities.includes("filesystem.write")
		? new WorkerActionJournal({
				agentDir: options.agentDir,
				parentSessionId: options.parentSessionId,
				taskId: options.durableHandle.taskId,
				attemptId: options.durableHandle.attemptId,
				fencingToken: options.durableHandle.fencingToken,
			})
		: undefined;
	let retentionWarningEmitted = false;
	let firstMailboxPoll = true;
	let ran = false;

	const currentUsage = (): AttemptUsageSnapshot =>
		attemptUsageFromGatewayUsage(
			options.toolSurface.gateway?.getUsage() ?? {
				...EMPTY_ATTEMPT_USAGE,
				wallClockMs: options.initialUsage.activeWallClockMs,
			},
		);
	const checkpointUsage = (summary: string): AttemptUsageSnapshot => {
		const usage = currentUsage();
		options.lifecycle.checkpoint(options.laneId, { summary, usage });
		return usage;
	};
	const remainingAttemptTokens = (): number | undefined => options.toolSurface.gateway?.remainingAttemptTokenBudget();
	const reserveProviderBudget = async (
		requestedMaxTokens: number,
		subject: string,
		signal?: AbortSignal,
	): Promise<ProviderBudgetReservation> => {
		if (options.toolSurface.gateway) {
			return options.toolSurface.gateway.reserveProviderBudget(requestedMaxTokens, subject, signal);
		}
		if (signal?.aborted) throw signal.reason;
		return { maxTokens: requestedMaxTokens, release: () => undefined };
	};
	const createRetentionPolicy = (completeSignal: AbortSignal): WorkerConversationRetentionPolicy | undefined => {
		if (!options.retentionPolicy) return undefined;
		let failedCompactionUsage: Usage | undefined;
		return {
			...options.retentionPolicy,
			generateVerifiedCompaction: async (preparation: Parameters<typeof compact>[0]) => {
				const compactionUsage = createEmptyUsage();
				failedCompactionUsage = compactionUsage;
				return compact(
					preparation,
					options.model,
					undefined,
					undefined,
					undefined,
					completeSignal,
					options.thinkingLevel,
					undefined,
					undefined,
					{
						completion: async (model, context, requestOptions): Promise<AssistantMessage> => {
							const requestSignal = requestOptions.signal ?? completeSignal;
							requestSignal.throwIfAborted();
							if (model.provider !== options.model.provider || model.id !== options.model.id) {
								throw new Error("Worker compaction attempted to select a model outside the lane binding.");
							}
							options.toolSurface.gateway?.assertBudgetAvailable("worker_compaction_provider_completion");
							const availableTokens = remainingAttemptTokens();
							if (availableTokens !== undefined && availableTokens <= 0) {
								throw new Error("Worker token budget exhausted before compaction provider completion.");
							}
							const requestedMaxTokens = requestOptions.maxTokens;
							const configuredMaxTokens =
								typeof requestedMaxTokens === "number" &&
								Number.isSafeInteger(requestedMaxTokens) &&
								requestedMaxTokens > 0
									? requestedMaxTokens
									: options.laneCapability.laneMaxOutputTokens;
							const maxTokens = Math.min(configuredMaxTokens, availableTokens ?? configuredMaxTokens);
							if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
								throw new Error("Worker compaction provider completion has no valid remaining token budget.");
							}
							let preflightFailed = false;
							let preflightFailure: unknown;
							const reservationFence = new WorkerProviderReservationFence({
								acquire: () =>
									reserveProviderBudget(maxTokens, "worker_compaction_provider_completion", requestSignal),
								signal: requestSignal,
								onFailure: (error) => {
									if (preflightFailed) return;
									preflightFailed = true;
									preflightFailure = error;
								},
							});
							try {
								let completion: IsolatedCompletionResult;
								try {
									completion = await options.runIsolatedCompletion({
										systemPrompt: context.systemPrompt ?? "",
										messages: context.messages,
										model: options.model,
										thinkingLevel: options.thinkingLevel,
										maxTokens,
										requestPreflight: () => reservationFence.requestPreflight(),
										signal: requestSignal,
										cacheRetention: "none",
										laneKind: "worker-compaction",
									});
								} catch (error) {
									reservationFence.close();
									requestSignal.throwIfAborted();
									if (preflightFailed) throw workerCompletionCallbackFailure(preflightFailure);
									throw error;
								}
								requestSignal.throwIfAborted();
								const response: AssistantMessage = {
									role: "assistant",
									content: completion.text ? [{ type: "text", text: completion.text }] : [],
									api: options.model.api,
									provider: options.model.provider,
									model: options.model.id,
									usage: completion.usage,
									stopReason: completion.stopReason,
									timestamp: Date.now(),
									...(completion.stopReason === "error"
										? { errorMessage: completion.text || "Worker compaction provider request failed." }
										: {}),
								};
								addUsage(compactionUsage, completion.usage);
								recordAssistantUsage(options.toolSurface, response);
								checkpointUsage("Persisted worker compaction provider usage before verification.");
								if (reservationFence.hasSuccessfulPreflight()) {
									try {
										reservationFence.consumeAssistantReservation();
									} catch (error) {
										if (!preflightFailed) {
											preflightFailed = true;
											preflightFailure = error;
										}
									}
								}
								reservationFence.close();
								requestSignal.throwIfAborted();
								if (preflightFailed) throw workerCompletionCallbackFailure(preflightFailure);
								if (!reservationFence.hasSuccessfulPreflight()) {
									throw new WorkerCompletionProtocolError(
										"Worker compaction returned provider output without a successful authority preflight.",
									);
								}
								return response;
							} finally {
								reservationFence.close();
							}
						},
					},
				);
			},
			getFailedCompactionUsage: () => failedCompactionUsage,
		};
	};
	const ledger: WorkerAttemptExecutionLedger = {
		changedFiles,
		getUsage: currentUsage,
	};

	return {
		ledger,
		checkpointUsage,
		async run(): Promise<WorkerAttemptExecutionResult> {
			if (ran) throw new Error("A worker attempt executor may run only once.");
			ran = true;
			options.conversation.beginAttemptUsage(options.durableHandle.attemptId);
			if (!options.hasPersistedUsageCheckpoint) {
				checkpointUsage("Persisted deterministic cumulative usage baseline for the durable worker transcript.");
			}
			const rawOutcome = await runWorker({
				request: options.request,
				maxUsd: options.grant.budget.maxCostUsd,
				maxWallClockMs: options.grant.budget.maxWallClockMs ?? 0,
				usageReportId: options.usageReportId,
				getChangedFiles: () => [...changedFiles],
				signal: options.signal,
				cwd: options.cwd,
				processCapable: options.processCapable,
				delegationCapable: options.toolSurface.allowedTools.includes("delegate"),
				...(options.verificationSubjectTaskId
					? { verificationSubjectTaskId: options.verificationSubjectTaskId }
					: {}),
				...(options.applyActions
					? {
							applyActions: (actions: readonly WorkerAction[]) => {
								const report = options.applyActions!(actions, actionJournal);
								for (const filePath of report.changedFiles) recordChangedFile(filePath);
								return report;
							},
						}
					: {}),
				complete: async ({ systemPrompt, userPrompt, signal }) => {
					if (options.recoveredTerminal) {
						checkpointUsage("Reused the persisted terminal worker assistant response after recovery.");
						return {
							text: options.recoveredTerminal.text,
							costUsd: options.initialUsage.costUsd,
							stopReason: options.recoveredTerminal.stopReason,
						};
					}
					const retentionPolicy = createRetentionPolicy(signal);
					const persistedToolAssistantIds = new Set<string>();
					const pendingToolAssistants = new Map<string, AssistantMessage>();
					let activeReservationFence: WorkerProviderReservationFence | undefined;
					const closeActiveReservationFence = (): void => {
						const active = activeReservationFence;
						activeReservationFence = undefined;
						active?.close();
					};
					options.toolSurface.gateway?.assertBudgetAvailable("worker_provider_completion");
					const availableTokens = remainingAttemptTokens();
					if (availableTokens !== undefined && availableTokens <= 0) {
						throw new Error("Worker token budget exhausted before provider completion.");
					}
					options.conversation.ensureAttemptUserPrompt(options.durableHandle.attemptId, userPrompt);
					let history: Message[] = [];
					let completion: IsolatedCompletionResult;
					const attemptProviderCompletion = async (): Promise<IsolatedCompletionResult> => {
						// Later attempts resume from the durably persisted transcript, not a stale snapshot.
						const transcriptCommit = options.conversation.beginTranscriptCommit();
						history = transcriptCommit.history;
						const historyLength = history.length;
						const transcriptCursor = transcriptCommit.cursor;
						const durableCallbackMessages: Message[] = [];
						const accountedCompletionUsage = createEmptyUsage();
						let callbackFailed = false;
						let callbackFailure: unknown;
						const retainCallbackFailure = (error: unknown): void => {
							if (callbackFailed) return;
							callbackFailed = true;
							callbackFailure = error;
						};
						const reservationFence = new WorkerProviderReservationFence({
							acquire: () =>
								reserveProviderBudget(
									options.laneCapability.laneMaxOutputTokens,
									"worker_provider_completion",
									signal,
								),
							signal,
							onFailure: retainCallbackFailure,
						});
						activeReservationFence = reservationFence;
						const accountAssistantUsage = (message: AssistantMessage): void => {
							recordAssistantUsage(options.toolSurface, message);
							addUsage(accountedCompletionUsage, message.usage);
						};
						const persistToolRequest = (message: AssistantMessage): void => {
							signal.throwIfAborted();
							const toolCallIds = message.content.flatMap((content) =>
								content.type === "toolCall" ? [content.id] : [],
							);
							if (toolCallIds.length === 0 || toolCallIds.every((id) => persistedToolAssistantIds.has(id)))
								return;
							reservationFence.assertAssistantReservation();
							accountAssistantUsage(message);
							options.conversation.appendMessage(message);
							for (const id of toolCallIds) {
								persistedToolAssistantIds.add(id);
								pendingToolAssistants.delete(id);
							}
							checkpointUsage("Persisted worker assistant tool request and its cumulative provider usage.");
							reservationFence.consumeToolAssistantReservation();
							durableCallbackMessages.push(message);
						};
						let committed = false;
						const abortTranscriptCursor = (): void => {
							reservationFence.close();
							options.conversation.abortTranscriptCommit(transcriptCursor);
						};
						signal.addEventListener("abort", abortTranscriptCursor, { once: true });
						try {
							signal.throwIfAborted();
							let result: IsolatedCompletionResult;
							try {
								result = await options.runIsolatedCompletion({
									systemPrompt: composeSubagentSystemPrompt({
										soul: options.soul,
										rolePrompt: [systemPrompt, options.workerResourceSystemPrompt]
											.filter(Boolean)
											.join("\n\n"),
									}),
									history,
									messages: [],
									model: options.model,
									thinkingLevel: options.thinkingLevel,
									maxTokens: Math.min(
										options.laneCapability.laneMaxOutputTokens,
										availableTokens ?? Number.POSITIVE_INFINITY,
									),
									tools: options.toolSurface.tools,
									requestPreflight: () => reservationFence.requestPreflight(),
									beforeToolCall: async (context, toolSignal) => {
										try {
											signal.throwIfAborted();
											persistToolRequest(context.assistantMessage);
											const decision = await options.toolSurface.beforeToolCall(context, toolSignal);
											signal.throwIfAborted();
											if (decision?.block) {
												toolIssues.add(
													`${context.toolCall.name} blocked: ${decision.reason ?? "capability denied"}`,
												);
											} else {
												checkpointUsage(
													`Authorized worker tool '${context.toolCall.name}' under its durable grant.`,
												);
											}
											return decision;
										} catch (error) {
											retainCallbackFailure(error);
											throw error;
										}
									},
									afterToolCall: async ({ toolCall, args, isError }) => {
										try {
											if (
												(toolCall.name === "write" || toolCall.name === "edit") &&
												args &&
												typeof args === "object" &&
												!Array.isArray(args)
											) {
												const rawPath = (args as Record<string, unknown>).path;
												if (typeof rawPath === "string" && rawPath.length > 0) {
													const absolutePath = path.isAbsolute(rawPath)
														? path.resolve(rawPath)
														: path.resolve(options.cwd, rawPath);
													let canonicalPath = absolutePath;
													try {
														canonicalPath = safeRealpathSync(absolutePath);
													} catch {
														// The operation entered execution; retain its lexical target if canonicalization failed.
													}
													recordChangedFile(
														path.relative(options.cwd, canonicalPath).split(path.sep).join("/"),
													);
												}
											}
											if (isError) toolIssues.add(`${toolCall.name} failed during isolated execution`);
											signal.throwIfAborted();
											return undefined;
										} catch (error) {
											retainCallbackFailure(error);
											throw error;
										}
									},
									onMessage: (message) => {
										try {
											signal.throwIfAborted();
											if (message.role === "assistant" && isToolRequest(message)) {
												// Known calls are normalized before beforeToolCall and persist from that hook.
												// Retain the request only so immediate unknown/malformed results can close the
												// transcript without freezing pre-repair arguments into durable history.
												for (const content of message.content) {
													if (content.type === "toolCall") pendingToolAssistants.set(content.id, message);
												}
												return;
											}
											if (
												message.role === "toolResult" &&
												!persistedToolAssistantIds.has(message.toolCallId)
											) {
												const pending = pendingToolAssistants.get(message.toolCallId);
												if (pending) persistToolRequest(pending);
											}
											if (message.role === "assistant") {
												reservationFence.assertAssistantReservation();
												accountAssistantUsage(message);
											}
											options.conversation.appendMessage(message);
											options.agentControl.acknowledgeMailboxMessage(options.agentId, message);
											if (message.role === "assistant") {
												checkpointUsage(
													"Persisted worker assistant response and its cumulative provider usage.",
												);
												reservationFence.consumeAssistantReservation();
											}
											if (message.role === "toolResult")
												checkpointUsage(`Persisted worker tool result '${message.toolCallId}'.`);
											durableCallbackMessages.push(message);
										} catch (error) {
											retainCallbackFailure(error);
											throw error;
										}
									},
									getSteeringMessages: async (): Promise<AgentMessage[]> => {
										try {
											signal.throwIfAborted();
											const includeFollowUp = firstMailboxPoll;
											firstMailboxPoll = false;
											const messages = options.agentControl.mailboxMessagesForConversation(
												options.agentId,
												options.conversation,
												includeFollowUp,
											);
											signal.throwIfAborted();
											return messages;
										} catch (error) {
											retainCallbackFailure(error);
											throw error;
										}
									},
									getFollowUpMessages: async (): Promise<AgentMessage[]> => {
										try {
											signal.throwIfAborted();
											const messages = options.agentControl.mailboxMessagesForConversation(
												options.agentId,
												options.conversation,
												true,
											);
											signal.throwIfAborted();
											return messages;
										} catch (error) {
											retainCallbackFailure(error);
											throw error;
										}
									},
									...(retentionPolicy
										? {
												transformContext: async (messages: AgentMessage[]) => {
													try {
														signal.throwIfAborted();
														const retained = await options.conversation.compactProviderContext(
															retentionPolicy,
															signal,
														);
														signal.throwIfAborted();
														if (
															retained.contextUsage.tokens > retentionPolicy.maxContextTokens &&
															!retentionWarningEmitted
														) {
															retentionWarningEmitted = true;
															options.warn(
																`Worker ${options.laneId} has one retained turn larger than its context policy; provider overflow recovery may be required.`,
															);
														}
														if (
															retained.status !== "compacted_verified" &&
															retained.status !== "compacted_deterministic"
														) {
															return messages;
														}
														return sanitizeToolFailureContext(retained.context.messages, "").messages;
													} catch (error) {
														if (signal.aborted) {
															retainCallbackFailure(error);
															signal.throwIfAborted();
														}
														if (error instanceof WorkerConversationOwnershipError) {
															retainCallbackFailure(error);
															throw error;
														}
														if (!retentionWarningEmitted) {
															retentionWarningEmitted = true;
															options.warn(
																`Worker context retention failed: ${error instanceof Error ? error.message : String(error)}`,
															);
														}
														return messages;
													}
												},
											}
										: {}),
									signal,
									cacheRetention: "short",
									laneKind: "worker",
								});
							} catch (error) {
								reservationFence.close();
								if (signal.aborted) throw error;
								if (callbackFailed) throw workerCompletionCallbackFailure(callbackFailure);
								throw error;
							}
							try {
								reservationFence.assertAllSuccessfulPreflightsConsumed();
							} catch (error) {
								retainCallbackFailure(error);
							}
							signal.throwIfAborted();
							if (recordSupplementalProviderUsage(options.toolSurface, result.usage, accountedCompletionUsage)) {
								checkpointUsage(
									"Persisted supplemental provider result usage before rejecting unverified completion evidence.",
								);
							}
							reservationFence.close();
							if (callbackFailed) throw workerCompletionCallbackFailure(callbackFailure);
							if (!reservationFence.hasSuccessfulPreflight()) {
								throw new WorkerCompletionProtocolError(
									"Worker completion returned provider output without a successful authority preflight.",
								);
							}
							const evidenced = callbackEvidencedCompletion(result, historyLength, durableCallbackMessages);
							signal.throwIfAborted();
							const appended = options.conversation.commitTranscript(transcriptCursor, evidenced.suffix, {
								appendMissing: false,
							});
							if (appended !== 0) {
								throw new WorkerConversationOwnershipError(
									"Worker callback transcript verification unexpectedly appended missing messages.",
								);
							}
							committed = true;
							return evidenced.completion;
						} finally {
							signal.removeEventListener("abort", abortTranscriptCursor);
							reservationFence.close();
							if (activeReservationFence === reservationFence) activeReservationFence = undefined;
							if (!committed) options.conversation.abortTranscriptCommit(transcriptCursor);
						}
					};
					try {
						completion = await runProviderCompletionWithBackoff({
							attempt: attemptProviderCompletion,
							onAttemptFailure: closeActiveReservationFence,
							provider: options.model.provider,
							laneId: options.laneId,
							warn: options.warn,
							...(signal ? { signal } : {}),
						});
					} finally {
						closeActiveReservationFence();
					}
					const cumulativeUsage = checkpointUsage(
						"Verified the callback-persisted worker conversation terminal suffix.",
					);
					return {
						text: completion.text,
						costUsd: cumulativeUsage.costUsd,
						stopReason: String(completion.stopReason),
						changedFiles: [...changedFiles],
						blockers: [...toolIssues],
					};
				},
			});
			const usage = checkpointUsage("Persisted final cumulative worker usage before terminal result.");
			return { rawOutcome, usage, changedFiles: [...changedFiles] };
		},
	};
}
