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
import { BoundedCompletionFailureError } from "../autonomy/bounded-completion.ts";
import type { WorkerRequest } from "../autonomy/contracts.ts";
import type { LaneToolSurface } from "../autonomy/lane-tool-surface.ts";
import { safeRealpathSync } from "../autonomy/path-scope.ts";
import type { ModelCapabilityProfile } from "../model-capability.ts";
import { attemptUsageFromGatewayUsage, EMPTY_ATTEMPT_USAGE } from "../orchestration/attempt-usage.ts";
import { CapabilityGatewayDeniedError, type ProviderBudgetReservation } from "../orchestration/capability-gateway.ts";
import type { ArtifactContract, AttemptUsageSnapshot, ExecutionGrant } from "../orchestration/contracts.ts";
import type { StartedDelegationAttempt } from "../orchestration/delegation-ledger.ts";
import { WorkerActionJournal } from "./worker-action-journal.ts";
import type { AppliedActionsReport, WorkerAction } from "./worker-actions.ts";
import type { WorkerAgentControlCoordinator } from "./worker-agent-control-coordinator.ts";
import { WorkerConversationOwnershipError } from "./worker-conversation-revision.ts";
import type { WorkerConversation, WorkerConversationRetentionPolicy } from "./worker-conversation-store.ts";
import type { WorkerExecutionPlan } from "./worker-execution-policy.ts";
import type { WorkerLifecycle } from "./worker-lifecycle.ts";
import { WorkerCompletionProtocolError, WorkerProviderTurnProtocol } from "./worker-provider-turn-protocol.ts";
import { runWorker, type WorkerRunOutcome } from "./worker-runner.ts";
import { buildWorkerSystemPrompt } from "./worker-system-prompt.ts";
import { captureWorkerTerminalOutputArtifact } from "./worker-terminal-output-artifact.ts";
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
	outputArtifact?: ArtifactContract;
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
			const completion = await args.attempt();
			if (completion.stopReason !== "error") return completion;
			throw new Error(
				completion.errorMessage?.trim() || "Provider completion stopped with an error without diagnostic detail.",
			);
		} catch (error) {
			args.onAttemptFailure();
			if (args.signal?.aborted) throw error;
			if (error instanceof WorkerCompletionProtocolError) {
				throw new BoundedCompletionFailureError("failed", "worker_protocol_error", error.message, error);
			}
			if (
				error instanceof WorkerConversationOwnershipError ||
				error instanceof CapabilityGatewayDeniedError ||
				error instanceof WorkerTreeBudgetExceededError ||
				error instanceof BoundedCompletionFailureError
			) {
				throw error;
			}
			const classified = classifyFailure({
				message: error instanceof Error ? error.message : String(error),
				provider: args.provider,
			});
			if (!classified.retryable || attempt >= WORKER_PROVIDER_RETRY_POLICY.maxAttempts) {
				const message = error instanceof Error ? error.message : String(error);
				throw new BoundedCompletionFailureError("failed", "completion_error", message, error);
			}
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
 * scheduling remain outside this boundary. This unit owns only the ordered worker conversation:
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

function isToolRequest(message: Message): boolean {
	return message.role === "assistant" && message.content.some((content) => content.type === "toolCall");
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
		!isDeepStrictEqual(result.usage, usage) ||
		result.errorMessage !== finalMessage.errorMessage
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
			...(finalMessage.errorMessage ? { errorMessage: finalMessage.errorMessage } : {}),
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
	let terminalOutput: string | undefined;

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
							const providerTurn = new WorkerProviderTurnProtocol({
								acquireReservation: () =>
									reserveProviderBudget(maxTokens, "worker_compaction_provider_completion", requestSignal),
								signal: requestSignal,
								onFailure: (error) => {
									if (preflightFailed) return;
									preflightFailed = true;
									preflightFailure = error;
								},
								...(options.toolSurface.gateway
									? { recordUsage: (delta) => options.toolSurface.gateway?.recordUsage(delta) }
									: {}),
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
										requestPreflight: () => providerTurn.requestPreflight(),
										signal: requestSignal,
										cacheRetention: "none",
										laneKind: "worker-compaction",
									});
								} catch (error) {
									providerTurn.close();
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
								if (providerTurn.hasOutstandingAssistantReservation()) {
									providerTurn.accountAssistantUsage(completion.usage);
								} else {
									providerTurn.accountUnverifiedResultUsageDelta(completion.usage);
								}
								checkpointUsage("Persisted worker compaction provider usage before verification.");
								if (providerTurn.hasSuccessfulPreflight()) {
									try {
										providerTurn.consumeTerminalAssistantAndHold();
									} catch (error) {
										if (!preflightFailed) {
											preflightFailed = true;
											preflightFailure = error;
										}
									}
								}
								providerTurn.close();
								requestSignal.throwIfAborted();
								if (preflightFailed) throw workerCompletionCallbackFailure(preflightFailure);
								providerTurn.assertProviderOutputPreflight("compaction");
								return response;
							} finally {
								providerTurn.close();
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
						terminalOutput = options.recoveredTerminal.text;
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
					let activeProviderTurn: WorkerProviderTurnProtocol | undefined;
					const closeActiveProviderTurn = (): void => {
						const active = activeProviderTurn;
						activeProviderTurn = undefined;
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
						let callbackFailed = false;
						let callbackFailure: unknown;
						const retainCallbackFailure = (error: unknown): void => {
							if (callbackFailed) return;
							callbackFailed = true;
							callbackFailure = error;
						};
						const providerTurn = new WorkerProviderTurnProtocol({
							acquireReservation: () =>
								reserveProviderBudget(
									options.laneCapability.laneMaxOutputTokens,
									"worker_provider_completion",
									signal,
								),
							signal,
							onFailure: retainCallbackFailure,
							...(options.toolSurface.gateway
								? { recordUsage: (delta) => options.toolSurface.gateway?.recordUsage(delta) }
								: {}),
						});
						activeProviderTurn = providerTurn;
						const persistToolRequest = (message: AssistantMessage): void => {
							signal.throwIfAborted();
							const toolCallIds = message.content.flatMap((content) =>
								content.type === "toolCall" ? [content.id] : [],
							);
							if (toolCallIds.length === 0 || toolCallIds.every((id) => persistedToolAssistantIds.has(id)))
								return;
							providerTurn.accountAssistantUsage(message.usage);
							options.conversation.appendMessage(message);
							for (const id of toolCallIds) {
								persistedToolAssistantIds.add(id);
								pendingToolAssistants.delete(id);
							}
							checkpointUsage("Persisted worker assistant tool request and its cumulative provider usage.");
							providerTurn.consumeToolAssistantAndRelease();
							durableCallbackMessages.push(message);
						};
						let committed = false;
						const abortTranscriptCursor = (): void => {
							providerTurn.close();
							options.conversation.abortTranscriptCommit(transcriptCursor);
						};
						signal.addEventListener("abort", abortTranscriptCursor, { once: true });
						try {
							signal.throwIfAborted();
							let result: IsolatedCompletionResult;
							try {
								result = await options.runIsolatedCompletion({
									systemPrompt: buildWorkerSystemPrompt({
										soul: options.soul,
										rolePrompt: systemPrompt,
										workerResourceSystemPrompt: options.workerResourceSystemPrompt,
										agentDir: options.agentDir,
										model: options.model,
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
									requestPreflight: () => providerTurn.requestPreflight(),
									beforeToolCall: async (context, toolSignal) => {
										try {
											signal.throwIfAborted();
											persistToolRequest(context.assistantMessage);
											const decision = await options.toolSurface.beforeToolCall(context, toolSignal);
											signal.throwIfAborted();
											if (!decision?.block) {
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
									afterToolCall: async ({ toolCall, args }) => {
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
											signal.throwIfAborted();
											return undefined;
										} catch (error) {
											retainCallbackFailure(error);
											throw error;
										}
									},
									onMessage: (message, origin) => {
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
											if (message.role === "assistant" && origin !== "local") {
												providerTurn.accountAssistantUsage(message.usage);
											}
											options.conversation.appendMessage(message);
											options.agentControl.acknowledgeMailboxMessage(options.agentId, message);
											if (message.role === "assistant" && origin !== "local") {
												checkpointUsage(
													"Persisted worker assistant response and its cumulative provider usage.",
												);
												providerTurn.consumeTerminalAssistantAndHold();
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
								providerTurn.close();
								if (signal.aborted) throw error;
								if (callbackFailed) throw workerCompletionCallbackFailure(callbackFailure);
								throw error;
							}
							try {
								providerTurn.assertEverySuccessfulPreflightConsumed();
							} catch (error) {
								retainCallbackFailure(error);
							}
							signal.throwIfAborted();
							if (providerTurn.accountUnverifiedResultUsageDelta(result.usage)) {
								checkpointUsage(
									"Persisted supplemental provider result usage before rejecting unverified completion evidence.",
								);
							}
							providerTurn.close();
							if (callbackFailed) throw workerCompletionCallbackFailure(callbackFailure);
							providerTurn.assertProviderOutputPreflight();
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
							providerTurn.close();
							if (activeProviderTurn === providerTurn) activeProviderTurn = undefined;
							if (!committed) options.conversation.abortTranscriptCommit(transcriptCursor);
						}
					};
					try {
						completion = await runProviderCompletionWithBackoff({
							attempt: attemptProviderCompletion,
							onAttemptFailure: closeActiveProviderTurn,
							provider: options.model.provider,
							laneId: options.laneId,
							warn: options.warn,
							...(signal ? { signal } : {}),
						});
					} finally {
						closeActiveProviderTurn();
					}
					const cumulativeUsage = checkpointUsage(
						"Verified the callback-persisted worker conversation terminal suffix.",
					);
					terminalOutput = completion.text;
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
			const outputArtifact = terminalOutput
				? captureWorkerTerminalOutputArtifact({
						agentDir: options.agentDir,
						parentSessionId: options.parentSessionId,
						attemptId: options.durableHandle.attemptId,
						text: terminalOutput,
						createdAt: new Date().toISOString(),
					})
				: undefined;
			return { rawOutcome, usage, changedFiles: [...changedFiles], ...(outputArtifact ? { outputArtifact } : {}) };
		},
	};
}
