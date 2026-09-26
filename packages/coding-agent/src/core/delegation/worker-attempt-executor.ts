import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { compact } from "@caupulican/pi-agent-core/compaction/compaction";
import { estimateProviderRequestTokens } from "@caupulican/pi-agent-core/provider-request-estimator";
import {
	classifyFailure,
	computeRetryDelayMs,
	type RetryPolicy,
	sleepAbortable,
} from "@caupulican/pi-agent-core/reliability";
import type { SessionRequestSnapshotInput } from "@caupulican/pi-agent-core/session";
import { sanitizeToolFailureContext } from "@caupulican/pi-agent-core/tool-failure-memory";
import type {
	AgentContextPlan,
	AgentContextPlanRequest,
	AgentMessage,
	ThinkingLevel,
} from "@caupulican/pi-agent-core/types";
import { addUsage, createEmptyUsage } from "@caupulican/pi-agent-core/usage";
import type { Api, AssistantMessage, Message, Model, Usage } from "@caupulican/pi-ai";
import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "../agent-session-contracts.ts";
import { BoundedCompletionFailureError } from "../autonomy/bounded-completion.ts";
import type { WorkerRequest } from "../autonomy/contracts.ts";
import type { LaneToolSurface } from "../autonomy/lane-tool-surface.ts";
import { safeRealpathSync } from "../autonomy/path-scope.ts";
import { type LastSentRequest, sessionLaneSummarizerRequest } from "../compaction-support.ts";
import { frozenPrefixLength } from "../context/prefix-stability.ts";
import { type ModelCapabilityProfile, resolveWorkerOutputTokenCeiling } from "../model-capability.ts";

import { attemptUsageFromGatewayUsage, EMPTY_ATTEMPT_USAGE } from "../orchestration/attempt-usage.ts";
import { CapabilityGatewayDeniedError, type ProviderBudgetReservation } from "../orchestration/capability-gateway.ts";
import type { ArtifactContract, AttemptUsageSnapshot, ExecutionGrant } from "../orchestration/contracts.ts";
import type { StartedDelegationAttempt } from "../orchestration/delegation-ledger.ts";
import type { WorkerProgressObservation } from "../supervision/worker-supervision-coordinator.ts";
import { WorkerActionJournal } from "./worker-action-journal.ts";
import type { AppliedActionsReport, WorkerAction } from "./worker-actions.ts";
import type { WorkerAgentControlCoordinator } from "./worker-agent-control-coordinator.ts";
import { WorkerConversationOwnershipError } from "./worker-conversation-revision.ts";
import type {
	WorkerConversation,
	WorkerConversationRetentionPolicy,
	WorkerTranscriptMessage,
} from "./worker-conversation-store.ts";
import type { WorkerExecutionPlan } from "./worker-execution-policy.ts";
import type { WorkerLifecycle } from "./worker-lifecycle.ts";
import { WorkerCompletionProtocolError, WorkerProviderTurnProtocol } from "./worker-provider-turn-protocol.ts";
import { runWorker, type WorkerRunOutcome } from "./worker-runner.ts";
import { buildWorkerSystemPrompt } from "./worker-system-prompt.ts";
import { captureWorkerTerminalOutputArtifact } from "./worker-terminal-output-artifact.ts";
import { WorkerTreeBudgetExceededError } from "./worker-tree-budget-coordinator.ts";
import { WorkerUsageAccounting } from "./worker-usage-accounting.ts";

export interface RecoveredWorkerTerminalCompletion {
	text: string;
	usage: Usage;
	stopReason: string;
}

/** The live mutable state that must be visible to session disposal before provider work yields. */
export interface WorkerAttemptExecutionLedger {
	changedFiles: Set<string>;
	sealChangedFiles(): readonly string[];
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
/**
 * Tool selection for one worker conversation, the same learning root runs: the evidence-gated hints
 * learned for the worker's model, and each tool call recorded into the shared evidence store.
 */
export interface WorkerToolSelection {
	hints(): string | undefined;
	begin(toolCallId: string, toolName: string, args: unknown): void;
	complete(toolCallId: string, succeeded: boolean, content: readonly unknown[]): void;
	discard(toolCallId: string): void;
}

/** One worker provider response, with what the cache survival estimator measures it against. */
export interface WorkerResponseObservation {
	readonly agentId: string;
	/** The request snapshot the response answers. */
	readonly snapshot: SessionRequestSnapshotInput | undefined;
	/** When that request opened. */
	readonly requestOpenedAt: number | undefined;
	/** The worker conversation's history the request carried. */
	readonly messages: readonly AgentMessage[];
}

export interface WorkerAttemptExecutorOptions {
	request: WorkerRequest;
	grant: ExecutionGrant;
	executionPlan: WorkerExecutionPlan;
	toolSurface: LaneToolSurface;
	conversation: WorkerConversation;
	lifecycle: Pick<WorkerLifecycle, "checkpoint" | "beginUsageAccounting">;
	laneId: string;
	agentId: string;
	durableHandle: StartedDelegationAttempt;
	parentSessionId: string;
	agentDir: string;
	cwd: string;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	laneCapability: Pick<ModelCapabilityProfile, "class" | "laneMaxOutputTokens" | "systemPromptMaxChars">;
	soul?: string;
	workerResourceSystemPrompt: string;
	workerContextFiles: ReadonlyArray<{ path: string; content?: string }>;
	initialUsage: AttemptUsageSnapshot;
	hasPersistedUsageCheckpoint: boolean;
	usageReportId: string;
	processCapable: boolean;
	/** Parent projectContextFiles mode. Omitted defaults to off. */
	projectContextFiles?: "off" | "on-demand";
	/** Applicable owner working preferences for this handoff; see buildWorkerSystemPrompt. */
	personaGuidance?: string;
	verificationSubjectTaskId?: string;
	recoveredTerminal?: RecoveredWorkerTerminalCompletion;
	retentionPolicy?: WorkerConversationRetentionPolicy;
	signal?: AbortSignal;
	runIsolatedCompletion(options: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
	agentControl: Pick<WorkerAgentControlCoordinator, "acknowledgeMailboxMessage" | "mailboxMessagesForConversation">;
	applyActions?(actions: readonly WorkerAction[], actionJournal?: WorkerActionJournal): AppliedActionsReport;
	warn(message: string): void;
	/**
	 * Live worker supervision. Called once per executed tool call with what actually happened on this
	 * attempt. Supervision is advisory: it never blocks the call it observes, and a failure inside it
	 * is swallowed by its own owner rather than failing the worker.
	 */
	observeWorkerProgress?(observation: WorkerProgressObservation): Promise<unknown> | unknown;
	/**
	 * Plan one request's context with root's own request-context controller, on this conversation's
	 * lane (context GC, path aliases, the authority context; the head-only steps absent).
	 * `sentPrefixCount` indexes `messages`.
	 */
	planRequest?(messages: AgentMessage[], sentPrefixCount: number, signal?: AbortSignal): Promise<AgentContextPlan>;
	/**
	 * The cache guard: each accepted provider request of this worker, as its recorded snapshot, with the
	 * tokens of its fixed prefix (system prompt and tool schemas) on the attempt's first request.
	 */
	observeWorkerRequest?(agentId: string, snapshot: SessionRequestSnapshotInput, prefixTokens?: number): void;
	/** A worker compaction's measured effect, recorded where root records its own. */
	recordCompactionOutcome?(outcome: { tokensBefore: number; tokensAfter: number; outputTokens: number }): void;
	/** Tool selection on the worker's model (see {@link WorkerToolSelection}). */
	toolSelection?: WorkerToolSelection;
	/** Each worker provider response, recorded as a cache observation on the worker's own history. */
	observeWorkerResponse?(message: AssistantMessage, observation: WorkerResponseObservation): void;
	/** Parent semantic duplicate review of code this worker's edit or write added; see the controller dep. */
	reviewNewCode?(input: { toolName: string; args: unknown; cwd: string }): Promise<string | undefined>;
	/** Parent objective ledger. Shell edits stay unattributed. Successful writes record a content digest. */
	recordObjectiveMutation?(event: {
		readonly kind: "owned_write" | "shell";
		readonly path?: string;
		readonly cwd: string;
	}): void;
}

/** Distinct arguments to the same tool are progress, especially during read-only review. */
export function isRepeatedWorkerToolInvocation(calls: readonly { name: string; args: unknown }[]): boolean {
	if (calls.length < 3) return false;
	const recent = calls.slice(-3);
	return recent.every((call) => call.name === recent[0]!.name && isDeepStrictEqual(call.args, recent[0]!.args));
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
	emittedMessages: readonly WorkerTranscriptMessage[],
): { completion: IsolatedCompletionResult; suffix: WorkerTranscriptMessage[] } {
	if (result.messages !== undefined && result.messages.length < historyLength) {
		throw new WorkerCompletionProtocolError(
			"Worker completion protocol returned fewer messages than its input history.",
		);
	}
	// `result.messages` is declared `Message[]` (IsolatedCompletionResult, agent-session-contracts.ts)
	// but a child loop that committed a transient record (packages/agent's step-3 host-gap hook) makes
	// it genuinely WorkerTranscriptMessage[] at runtime - widening here, not narrowing, so this
	// assignment needs no cast; only reflection-controller.ts's construction of `result.messages`
	// itself still does, where a wide value is forced into that narrower declared field. See this
	// module's and worker-conversation-store.ts's `WorkerTranscriptMessage` doc comments.
	let suffix: WorkerTranscriptMessage[];
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
	if (finalMessage?.role !== "assistant") {
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
	const attemptStartedAt = Date.now();
	/**
	 * Where this attempt's own messages begin, set when it runs: a reused specialist's earlier tasks are
	 * not this attempt's output.
	 */
	let attemptTranscriptStart = 0;
	const recentToolNames: string[] = [];
	const recentToolCalls: { name: string; args: unknown }[] = [];
	let executedToolCalls = 0;
	let changedFileCountAtChurnWindowStart = changedFiles.size;
	/**
	 * One live supervision observation per executed tool call. The deterministic churn check runs
	 * first, because repeated broad validation with no new implementation needs no semantic judgment.
	 */
	const observeToolCall = async (toolName: string, args: unknown): Promise<void> => {
		if (!options.observeWorkerProgress) return;
		executedToolCalls++;
		recentToolNames.push(toolName);
		if (recentToolNames.length > 8) recentToolNames.shift();
		recentToolCalls.push({ name: toolName, args });
		if (recentToolCalls.length > 3) recentToolCalls.shift();
		const isRepeating = isRepeatedWorkerToolInvocation(recentToolCalls);
		const isStalled = changedFiles.size === 0 && executedToolCalls >= 4 && (isRepeating || toolIssues.size > 0);
		let outputTail = "";
		try {
			// Only this attempt's own output: supervision judges the current task, never an earlier one's report.
			const messages = options.conversation.getRawTranscript().slice(attemptTranscriptStart);
			for (let index = messages.length - 1; index >= 0; index--) {
				const message = messages[index];
				if (message.role !== "assistant" || !("content" in message) || !Array.isArray(message.content)) continue;
				const text = message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("");
				if (text) {
					outputTail = text.slice(-2000);
					break;
				}
			}
		} catch {
			outputTail = "";
		}
		const observation: WorkerProgressObservation = {
			agentId: options.agentId,
			objectiveId: options.durableHandle.objectiveId,
			taskId: options.durableHandle.taskId,
			attemptId: options.durableHandle.attemptId,
			role: options.grant.role,
			mission: options.request.instructions,
			toolCalls: executedToolCalls,
			elapsedMs: Date.now() - attemptStartedAt,
			changedFiles: [...changedFiles],
			recentFailures: [...toolIssues],
			recentToolNames: [...recentToolNames],
			changedFileCountAtWindowStart: changedFileCountAtChurnWindowStart,
			changedFileCount: changedFiles.size,
			outputTail,
			isRepeating,
			isStalled,
		};
		if (changedFiles.size > changedFileCountAtChurnWindowStart) {
			changedFileCountAtChurnWindowStart = changedFiles.size;
		}
		try {
			await options.observeWorkerProgress(observation);
		} catch {
			// Supervision must not fail the worker it observes.
		}
	};
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
	const mutationTarget = (toolName: string, args: unknown): string | undefined => {
		if ((toolName !== "write" && toolName !== "edit") || !args || typeof args !== "object" || Array.isArray(args)) {
			return undefined;
		}
		const rawPath = (args as Record<string, unknown>).path;
		if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;
		const absolutePath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(options.cwd, rawPath);
		let canonicalPath = absolutePath;
		try {
			canonicalPath = safeRealpathSync(absolutePath);
		} catch {
			// A not-yet-created write target still needs a conservative lexical identity at cancellation.
		}
		return path.relative(options.cwd, canonicalPath).split(path.sep).join("/");
	};
	const recordMutationTarget = (filePath: string): void => {
		recordChangedFile(filePath);
		options.recordObjectiveMutation?.({
			kind: "owned_write",
			path: filePath,
			cwd: options.cwd,
		});
	};
	const admittedMutationTargets = new Map<string, string>();
	const admittedToolSelectionIds = new Set<string>();
	let callbackBoundarySealed = false;
	const sealChangedFiles = (): readonly string[] => {
		if (!callbackBoundarySealed) {
			callbackBoundarySealed = true;
			const unresolvedTargets = [...admittedMutationTargets.values()];
			admittedMutationTargets.clear();
			const unresolvedSelectionIds = [...admittedToolSelectionIds];
			admittedToolSelectionIds.clear();
			let failure: { error: unknown } | undefined;
			for (const filePath of unresolvedTargets) {
				try {
					recordMutationTarget(filePath);
				} catch (error) {
					failure ??= { error };
				}
			}
			for (const toolCallId of unresolvedSelectionIds) {
				try {
					options.toolSelection?.discard(toolCallId);
				} catch (error) {
					failure ??= { error };
				}
			}
			if (failure) throw failure.error;
		}
		return [...changedFiles];
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
	/** The latest accepted provider request of this attempt, for the response that answers it. */
	let lastRequest: { snapshot: SessionRequestSnapshotInput; openedAt: number } | undefined;
	/** The worker lane's last request exactly as sent, for its summarizer to extend on the warm cache. */
	let lastSent: LastSentRequest | undefined;
	/** Fixed per attempt, so the worker's system prompt stays byte-stable across its requests. */
	const toolSelectionHints = options.toolSelection?.hints();
	/** The durable history the request being planned carries (what the last sent request is checked against). */
	let planningMessages: readonly AgentMessage[] = [];
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
		options.toolSurface.gateway?.flushUsage();
		const usage = currentUsage();
		options.lifecycle.checkpoint(options.durableHandle, { summary, usage });
		return usage;
	};
	options.toolSurface.toolUsage.bindCheckpoint(() => {
		options.toolSurface.gateway?.flushUsage();
	});
	const usageSignals = new Set<AbortSignal>();
	const stopUsageClock = (): void => options.toolSurface.gateway?.stopUsageClock();
	const observeUsageSignal = (signal: AbortSignal): void => {
		if (signal.aborted) stopUsageClock();
		else if (!usageSignals.has(signal)) {
			usageSignals.add(signal);
			signal.addEventListener("abort", stopUsageClock, { once: true });
		}
	};
	const remainingAttemptTokens = (): number | undefined => options.toolSurface.gateway?.remainingAttemptTokenBudget();
	// A worker turn is capped by the model's own output limit, never by the lane summary cap: a
	// claim envelope with findings, or a write tool call carrying a file, does not fit 2048 tokens.
	const workerOutputTokenCeiling = resolveWorkerOutputTokenCeiling(options.model);
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
						// The summarizer extends the worker lane's own last request (its system prompt, tools and
						// messages exactly as sent) on the same cache, like root's summarizer on the session lane.
						...(() => {
							const structuredRequest = lastSent
								? sessionLaneSummarizerRequest({
										compactionModel: options.model,
										sessionModel: options.model,
										systemPrompt: lastSent.context.systemPrompt ?? "",
										tools: lastSent.context.tools,
										messagesToSummarize: preparation.messagesToSummarize,
										liveMessages: planningMessages,
										lastSent,
										textToolCallProtocol: undefined,
										sessionId: `${options.parentSessionId}/worker:${options.agentId}`,
									})
								: undefined;
							return structuredRequest ? { structuredRequest } : {};
						})(),
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
									// A structured request (cache retained) is the lane's own sent prefix plus one
									// instruction: sent as is, on the worker lane's affinity. Otherwise a standalone prompt.
									const structured =
										requestOptions.cacheRetention !== undefined && requestOptions.cacheRetention !== "none";
									completion = await options.runIsolatedCompletion({
										...(structured ? { requestContext: context } : {}),
										systemPrompt: context.systemPrompt ?? "",
										messages: context.messages,
										model: options.model,
										thinkingLevel: options.thinkingLevel,
										maxTokens,
										requestPreflight: () => providerTurn.requestPreflight(),
										signal: requestSignal,
										...(structured
											? {
													cacheRetention: requestOptions.cacheRetention ?? "short",
													laneKind: "worker",
													conversationId: `${options.parentSessionId}/worker:${options.agentId}`,
												}
											: { cacheRetention: "none", laneKind: "worker-compaction" }),
									});
								} catch (error) {
									providerTurn.close();
									requestSignal.throwIfAborted();
									if (preflightFailed) throw workerCompletionCallbackFailure(preflightFailure);
									throw error;
								}
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
								options.toolSurface.gateway?.flushUsage();
								requestSignal.throwIfAborted();
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
		sealChangedFiles,
		getUsage: currentUsage,
	};

	return {
		ledger,
		checkpointUsage,
		async run(): Promise<WorkerAttemptExecutionResult> {
			attemptTranscriptStart = options.conversation.getRawTranscript().length;
			if (ran) throw new Error("A worker attempt executor may run only once.");
			ran = true;
			try {
				const gateway = options.toolSurface.gateway;
				if (!gateway) throw new Error("Worker execution requires a capability gateway with durable accounting.");
				gateway.bindUsageAccounting(
					new WorkerUsageAccounting({
						port: options.lifecycle.beginUsageAccounting(options.durableHandle, options.initialUsage),
						warn: options.warn,
						label: `Worker ${options.laneId}`,
						afterRecord: () => gateway.publishUsage(),
					}),
				);
				if (options.signal) observeUsageSignal(options.signal);
				options.signal?.throwIfAborted();
				const earlierSession = options.conversation.previousAttemptParentSession(options.durableHandle.attemptId);
				options.conversation.beginAttemptUsage(options.durableHandle.attemptId, options.parentSessionId);
				if (!options.hasPersistedUsageCheckpoint) {
					checkpointUsage("Persisted deterministic cumulative usage baseline for the durable worker transcript.");
				}
				const rawOutcome = await runWorker({
					request: options.request,
					earlierSession: earlierSession !== undefined && earlierSession !== options.parentSessionId,
					maxUsd: options.grant.budget.maxCostUsd,
					maxWallClockMs: options.grant.budget.maxWallClockMs ?? 0,
					usageReportId: options.usageReportId,
					sealChangedFiles,
					signal: options.signal,
					cwd: options.cwd,
					processCapable: options.processCapable,
					systemOneCapable: options.toolSurface.allowedTools.includes("typesafe_review"),
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
						observeUsageSignal(signal);
						if (options.recoveredTerminal) {
							terminalOutput = options.recoveredTerminal.text;
							checkpointUsage("Reused the persisted terminal worker assistant response after recovery.");
							return {
								text: options.recoveredTerminal.text,
								costUsd: currentUsage().costUsd,
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
							const durableCallbackMessages: WorkerTranscriptMessage[] = [];
							let callbackFailed = false;
							let callbackFailure: unknown;
							const retainCallbackFailure = (error: unknown): void => {
								if (callbackFailed) return;
								callbackFailed = true;
								callbackFailure = error;
							};
							const providerTurn = new WorkerProviderTurnProtocol({
								acquireReservation: () =>
									reserveProviderBudget(workerOutputTokenCeiling, "worker_provider_completion", signal),
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
								const observed = toolCallIds
									.map((id) => pendingToolAssistants.get(id))
									.find((item) => item !== undefined);
								if (observed) {
									if (!isDeepStrictEqual(observed.usage, message.usage)) {
										throw new WorkerCompletionProtocolError(
											"Worker tool request changed its already accounted provider usage.",
										);
									}
								} else providerTurn.accountAssistantUsage(message.usage);
								options.toolSurface.gateway?.flushUsage();
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
								// The conversation's sent-prefix marks, carried across its runs like root's.
								const requestPrefix = options.conversation.requestPrefix(history);
								try {
									result = await options.runIsolatedCompletion({
										prefixState: requestPrefix.state,
										systemPrompt: buildWorkerSystemPrompt({
											soul: options.soul,
											rolePrompt: systemPrompt,
											workerResourceSystemPrompt: options.workerResourceSystemPrompt,
											contextFiles: options.workerContextFiles,
											canReadContextFiles: options.toolSurface.allowedTools.includes("read"),
											modelCapability: options.laneCapability,
											agentDir: options.agentDir,
											model: options.model,
											projectContextFiles: options.projectContextFiles,
											...(options.personaGuidance ? { personaGuidance: options.personaGuidance } : {}),
											...(toolSelectionHints ? { toolSelectionHints } : {}),
										}),
										history,
										messages: [],
										model: options.model,
										thinkingLevel: options.thinkingLevel,
										maxTokens: Math.min(
											workerOutputTokenCeiling,
											availableTokens ?? Number.POSITIVE_INFINITY,
										),
										tools: options.toolSurface.tools,
										requestPreflight: () => providerTurn.requestPreflight(),
										// One durable request_snapshot per accepted provider request, so the worker's
										// request start and reasoning level survive in its own conversation.
										onProviderRequestSnapshot: (context) => {
											signal.throwIfAborted();
											const { snapshot } = options.conversation.appendRequestSnapshot(context);
											const firstRequest = lastRequest === undefined;
											lastRequest = { snapshot, openedAt: Date.now() };
											lastSent = {
												model: context.model as Model<Api>,
												context: context.context,
												sourceMessages: context.sourceContext.messages,
											};
											// The history the marks index: the next run re-anchors them against it.
											requestPrefix.source = context.sourceContext.messages;
											options.observeWorkerRequest?.(
												options.agentId,
												snapshot,
												firstRequest
													? estimateProviderRequestTokens({
															systemPrompt: context.context.systemPrompt,
															tools: context.context.tools,
															messages: [],
														})
													: undefined,
											);
										},
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
													options.toolSelection?.begin(
														context.toolCall.id,
														context.toolCall.name,
														context.args,
													);
													if (options.toolSelection) {
														admittedToolSelectionIds.add(context.toolCall.id);
														context.registerCleanup?.(() => {
															admittedToolSelectionIds.delete(context.toolCall.id);
															options.toolSelection?.discard(context.toolCall.id);
														});
													}
													const target = mutationTarget(context.toolCall.name, context.args);
													if (target) {
														admittedMutationTargets.set(context.toolCall.id, target);
														context.registerCleanup?.(() =>
															admittedMutationTargets.delete(context.toolCall.id),
														);
													}
												}
												return decision;
											} catch (error) {
												retainCallbackFailure(error);
												throw error;
											}
										},
										afterToolCall: async ({ toolCall, args, result, isError }) => {
											try {
												if (callbackBoundarySealed) {
													signal.throwIfAborted();
													throw new WorkerCompletionProtocolError(
														"Worker tool completion arrived after its changed-file boundary was sealed.",
													);
												}
												let duplicateNote: string | undefined;
												const admittedTarget = admittedMutationTargets.get(toolCall.id);
												if (admittedTarget) {
													admittedMutationTargets.delete(toolCall.id);
													const completedTarget = mutationTarget(toolCall.name, args) ?? admittedTarget;
													recordMutationTarget(completedTarget);
												}
												signal.throwIfAborted();
												options.toolSelection?.complete(toolCall.id, !isError, result.content);
												admittedToolSelectionIds.delete(toolCall.id);
												if (admittedTarget && !isError)
													duplicateNote = await options.reviewNewCode?.({
														toolName: toolCall.name,
														args,
														cwd: options.cwd,
													});
												signal.throwIfAborted();
												await observeToolCall(toolCall.name, args);
												return duplicateNote
													? {
															content: [
																...result.content,
																{ type: "text" as const, text: duplicateNote },
															],
														}
													: undefined;
											} catch (error) {
												retainCallbackFailure(error);
												throw error;
											}
										},
										onMessage: (message, origin) => {
											try {
												if (signal.aborted && message.role === "assistant" && origin !== "local") {
													providerTurn.close();
													providerTurn.accountLateAssistantUsage(message.usage);
													options.toolSurface.gateway?.flushUsage();
												}
												if (signal.aborted && message.role === "toolResult") {
													options.toolSurface.toolUsage.settle(message.toolCallId, message.usage);
												}
												signal.throwIfAborted();
												if (message.role === "assistant" && origin !== "local") {
													providerTurn.accountAssistantUsage(message.usage);
													options.toolSurface.gateway?.flushUsage();
													// Every provider response, tool use included, against the history its request carried
													// (this response is not persisted yet).
													options.observeWorkerResponse?.(message, {
														agentId: options.agentId,
														snapshot: lastRequest?.snapshot,
														requestOpenedAt: lastRequest?.openedAt,
														messages: options.conversation.getProviderContext().messages,
													});
												}
												// Failed/aborted streams can retain partial tool calls, but the loop never
												// executes them. Their terminal callback must account and persist the response now.
												if (
													message.role === "assistant" &&
													message.stopReason !== "error" &&
													message.stopReason !== "aborted" &&
													message.content.some((content) => content.type === "toolCall")
												) {
													// Known calls are normalized before beforeToolCall and persist from that hook.
													// Retain the request only so immediate unknown/malformed results can close the
													// transcript without freezing pre-repair arguments into durable history.
													for (const content of message.content) {
														if (content.type === "toolCall")
															pendingToolAssistants.set(content.id, message);
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
												if (message.role === "toolResult") {
													// Validate before persistence and retain billed usage if the append fails.
													// Tool service usage is separate from assistant reservation epochs.
													options.toolSurface.toolUsage.settle(message.toolCallId, message.usage);
												}
												options.conversation.appendMessage(message, origin);
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
										// The same per-request projection root gets: the conversation's own retention
										// compaction, then context GC packing what went stale, priced on this lane.
										...(retentionPolicy || options.planRequest
											? {
													planContext: async ({ messages, sentPrefixCount }: AgentContextPlanRequest) => {
														planningMessages = messages;
														const retain = async (
															policy: WorkerConversationRetentionPolicy,
														): Promise<AgentMessage[]> => {
															try {
																signal.throwIfAborted();
																const retained = await options.conversation.compactProviderContext(
																	policy,
																	signal,
																);
																signal.throwIfAborted();
																if (
																	retained.contextUsage.tokens > policy.maxContextTokens &&
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
																if (retained.compacted) {
																	options.recordCompactionOutcome?.({
																		tokensBefore: retained.compacted.tokensBefore,
																		tokensAfter: retained.contextUsage.tokens,
																		outputTokens: retained.compacted.usage?.output ?? 0,
																	});
																}
																return sanitizeToolFailureContext(retained.context.messages, "")
																	.messages;
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
														};
														const retained = retentionPolicy ? await retain(retentionPolicy) : messages;
														signal.throwIfAborted();
														// The sent mark indexes `messages`; re-anchor it by reference on what retention left.
														const frozenBelow = frozenPrefixLength(messages, sentPrefixCount, retained);
														return options.planRequest
															? options.planRequest(retained, frozenBelow, signal)
															: { messages: retained };
													},
												}
											: {}),
										signal,
										cacheRetention: "short",
										laneKind: "worker",
										conversationId: `${options.parentSessionId}/worker:${options.agentId}`,
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
								const supplementalUsage = providerTurn.accountUnverifiedResultUsageDelta(result.usage);
								options.toolSurface.gateway?.flushUsage();
								signal.throwIfAborted();
								if (supplementalUsage) {
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
				stopUsageClock();
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
				return {
					rawOutcome,
					usage,
					changedFiles: [...changedFiles],
					...(outputArtifact ? { outputArtifact } : {}),
				};
			} finally {
				stopUsageClock();
				for (const signal of usageSignals) signal.removeEventListener("abort", stopUsageClock);
				usageSignals.clear();
			}
		},
	};
}
