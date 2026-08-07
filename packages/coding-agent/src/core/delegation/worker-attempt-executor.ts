import path from "node:path";
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
import type { ProviderBudgetReservation } from "../orchestration/capability-gateway.ts";
import type { AttemptUsageSnapshot, ExecutionGrant } from "../orchestration/contracts.ts";
import type { StartedDelegationAttempt } from "../orchestration/delegation-ledger.ts";
import { WorkerActionJournal } from "./worker-action-journal.ts";
import type { AppliedActionsReport, WorkerAction } from "./worker-actions.ts";
import type { WorkerAgentControlCoordinator } from "./worker-agent-control-coordinator.ts";
import type { WorkerConversation, WorkerConversationRetentionPolicy } from "./worker-conversation-store.ts";
import type { WorkerExecutionPlan } from "./worker-execution-policy.ts";
import type { WorkerLifecycle } from "./worker-lifecycle.ts";
import { runWorker, type WorkerRunOutcome } from "./worker-runner.ts";

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

function isToolRequest(message: Message): boolean {
	return message.role === "assistant" && message.content.some((content) => content.type === "toolCall");
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
	let providerContextCompacted = options.conversation.hasProviderCompaction();
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
	let failedCompactionUsage: Usage | undefined;
	const retentionPolicy = options.retentionPolicy && {
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
				options.signal,
				options.thinkingLevel,
				undefined,
				undefined,
				{
					completion: async (model, context, requestOptions): Promise<AssistantMessage> => {
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
						let reservation: ProviderBudgetReservation | undefined;
						try {
							const completion = await options.runIsolatedCompletion({
								systemPrompt: context.systemPrompt ?? "",
								messages: context.messages,
								model: options.model,
								thinkingLevel: options.thinkingLevel,
								maxTokens,
								requestPreflight: async () => {
									reservation?.release();
									reservation = await reserveProviderBudget(
										maxTokens,
										"worker_compaction_provider_completion",
										requestOptions.signal ?? options.signal,
									);
									return { maxTokens: reservation.maxTokens };
								},
								signal: requestOptions.signal ?? options.signal,
								cacheRetention: "none",
								laneKind: "worker-compaction",
							});
							addUsage(compactionUsage, completion.usage);
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
							recordAssistantUsage(options.toolSurface, response);
							checkpointUsage("Persisted worker compaction provider usage before verification.");
							return response;
						} finally {
							reservation?.release();
						}
					},
				},
			);
		},
		getFailedCompactionUsage: () => failedCompactionUsage,
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
					const persistedToolAssistantIds = new Set<string>();
					const pendingToolAssistants = new Map<string, AssistantMessage>();
					let providerReservation: ProviderBudgetReservation | undefined;
					const releaseProviderReservation = (): void => {
						providerReservation?.release();
						providerReservation = undefined;
					};
					const persistToolRequest = (message: AssistantMessage): void => {
						const toolCallIds = message.content.flatMap((content) =>
							content.type === "toolCall" ? [content.id] : [],
						);
						if (toolCallIds.length === 0 || toolCallIds.every((id) => persistedToolAssistantIds.has(id))) return;
						recordAssistantUsage(options.toolSurface, message);
						options.conversation.appendMessage(message);
						for (const id of toolCallIds) {
							persistedToolAssistantIds.add(id);
							pendingToolAssistants.delete(id);
						}
						checkpointUsage("Persisted worker assistant tool request and its cumulative provider usage.");
						releaseProviderReservation();
					};
					options.toolSurface.gateway?.assertBudgetAvailable("worker_provider_completion");
					const availableTokens = remainingAttemptTokens();
					if (availableTokens !== undefined && availableTokens <= 0) {
						throw new Error("Worker token budget exhausted before provider completion.");
					}
					options.conversation.ensureAttemptUserPrompt(options.durableHandle.attemptId, userPrompt);
					let history = options.conversation.getProviderMessages();
					let completion: IsolatedCompletionResult;
					const attemptProviderCompletion = (): Promise<IsolatedCompletionResult> => {
						// Later attempts resume from the durably persisted transcript, not a stale snapshot.
						history = options.conversation.getProviderMessages();
						return options.runIsolatedCompletion({
							systemPrompt: composeSubagentSystemPrompt({
								soul: options.soul,
								rolePrompt: [systemPrompt, options.workerResourceSystemPrompt].filter(Boolean).join("\n\n"),
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
							requestPreflight: async () => {
								releaseProviderReservation();
								providerReservation = await reserveProviderBudget(
									options.laneCapability.laneMaxOutputTokens,
									"worker_provider_completion",
									signal,
								);
								return { maxTokens: providerReservation.maxTokens };
							},
							beforeToolCall: async (context, toolSignal) => {
								persistToolRequest(context.assistantMessage);
								const decision = await options.toolSurface.beforeToolCall(context, toolSignal);
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
							},
							afterToolCall: async ({ toolCall, args, isError }) => {
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
										recordChangedFile(path.relative(options.cwd, canonicalPath).split(path.sep).join("/"));
									}
								}
								if (isError) toolIssues.add(`${toolCall.name} failed during isolated execution`);
								return undefined;
							},
							onMessage: (message) => {
								if (message.role === "assistant" && isToolRequest(message)) {
									// Known calls are normalized before beforeToolCall and persist from that hook.
									// Retain the request only so immediate unknown/malformed results can close the
									// transcript without freezing pre-repair arguments into durable history.
									for (const content of message.content) {
										if (content.type === "toolCall") pendingToolAssistants.set(content.id, message);
									}
									return;
								}
								if (message.role === "toolResult" && !persistedToolAssistantIds.has(message.toolCallId)) {
									const pending = pendingToolAssistants.get(message.toolCallId);
									if (pending) persistToolRequest(pending);
								}
								if (message.role === "assistant") recordAssistantUsage(options.toolSurface, message);
								options.conversation.appendMessage(message);
								options.agentControl.acknowledgeMailboxMessage(options.agentId, message);
								if (message.role === "assistant") {
									checkpointUsage("Persisted worker assistant response and its cumulative provider usage.");
									releaseProviderReservation();
								}
								if (message.role === "toolResult")
									checkpointUsage(`Persisted worker tool result '${message.toolCallId}'.`);
							},
							getSteeringMessages: async (): Promise<AgentMessage[]> => {
								const includeFollowUp = firstMailboxPoll;
								firstMailboxPoll = false;
								return options.agentControl.mailboxMessagesForConversation(
									options.agentId,
									options.conversation,
									includeFollowUp,
								);
							},
							getFollowUpMessages: async (): Promise<AgentMessage[]> =>
								options.agentControl.mailboxMessagesForConversation(
									options.agentId,
									options.conversation,
									true,
								),
							...(retentionPolicy
								? {
										transformContext: async (messages: AgentMessage[]) => {
											try {
												const retained = await options.conversation.compactProviderContext(
													retentionPolicy,
													options.signal,
												);
												if (
													retained.status === "compacted_verified" ||
													retained.status === "compacted_deterministic"
												) {
													providerContextCompacted = true;
												}
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
					};
					try {
						completion = await runProviderCompletionWithBackoff({
							attempt: attemptProviderCompletion,
							onAttemptFailure: releaseProviderReservation,
							provider: options.model.provider,
							laneId: options.laneId,
							warn: options.warn,
							...(signal ? { signal } : {}),
						});
					} finally {
						releaseProviderReservation();
					}
					if (!providerContextCompacted) {
						options.conversation.commitTranscript(
							completion.messages ?? options.conversation.getProviderMessages(),
						);
					}
					checkpointUsage(
						`Persisted worker conversation through ${options.conversation.getProviderContext().messages.length} messages.`,
					);
					return {
						text: completion.text,
						costUsd: completion.usage.cost.total,
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
