/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import { EventStream } from "@caupulican/pi-ai/event-stream";
import {
	formatToolRepairStandingRule,
	REPEATED_SUCCESSFUL_TOOL_CALL_FAILURE,
	type ToolFailurePhase,
} from "@caupulican/pi-ai/tool-repair-registry";
import type { AssistantMessage, ToolResultMessage } from "@caupulican/pi-ai/types";
import {
	formatToolValidationEnrichment,
	type ToolArgumentExecutionOutcome,
	ToolArgumentValidationError,
	type ToolArgumentValidationTelemetryEvent,
	validateToolArguments,
} from "@caupulican/pi-ai/validation";
import {
	assistantMessageText,
	collapseDegenerateAssistantMessage,
	shouldAbortDegenerateStream,
} from "./degenerate-assistant-text.ts";
import {
	startPlannedAgentProviderRequest,
	startPlannedAgentProviderRequestWithId,
} from "./provider-request-planner.ts";
import {
	assessToolFailure,
	clearToolFailure,
	createRepeatedToolFailureResult,
	createToolFailureMemoryTracker,
	createToolFailureResult,
	describeOperationOutcome,
	getToolExecutionKey,
	getUnresolvedToolFailure,
	normalizeToolSignature,
	rememberToolFailure,
	type ToolFailureContextMemory,
	type ToolFailureMemoryTracker,
	toolFailureCorrection,
} from "./tool-failure-memory.ts";
import { ToolFailureRecoveryGate, type ToolFailureRecoveryGateEffect } from "./tool-failure-recovery-gate.ts";
import { rejectNativeToolProtocolResidue, rejectToolCallsFromToolFreeResponse } from "./tool-protocol-residue.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentRequestId,
	AgentTool,
	AgentToolCall,
	AgentToolErrorKind,
	AgentToolResult,
	ProviderRequestPrefixState,
	StreamFn,
	ToolCallRepairInfo,
	ToolCallStartContext,
} from "./types.ts";
import { AgentToolExecutionError, DEFAULT_MAX_PROVIDER_TURNS, DEFAULT_MAX_STALL_TURNS } from "./types.ts";
import { createEmptyUsage } from "./usage.ts";
import { sanitizeBinaryOutput } from "./utils/shell-output.ts";
import { retainedVerificationDetails, VerificationObligationTracker } from "./verification-obligations.ts";

export {
	composeRequestSystemPrompt,
	narrowRequestMaxTokens,
	resolveRequestPreflightMaxTokens,
} from "./provider-request-planner.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** Bound simultaneous tool starts without imposing a failure-count or operation-count stop. */
const DEFAULT_TOOL_CONCURRENCY = 4;
const MIN_TOOL_CONCURRENCY = 1;
const MAX_TOOL_CONCURRENCY = 16;

/** Bounded no-progress state retained across host-owned continuations of one logical prompt. */
export interface AgentLoopContinuationState {
	providerTurns: number;
	stallWindow: string[];
	/** Optional for compatibility with continuation snapshots created before result-aware cycle detection. */
	stagnantResultWindow?: string[];
	toolFailureRecoveryGate: ToolFailureRecoveryGate;
	/**
	 * Shared holder for the two provider-request prefix high-water marks (see
	 * {@link ProviderRequestPrefixState} and `provider-request-planner.ts` - do not collapse the two
	 * marks it carries into one). Optional for compatibility with continuation snapshots created
	 * before this field existed; `runLoop` creates one on first use and persists it back onto this
	 * object, so a legacy snapshot degrades to "nothing sent yet" instead of throwing, and every
	 * later turn on the SAME continuation state (including a host-driven `runAgentLoopContinue`
	 * reusing it) keeps sharing the one holder.
	 *
	 * A fresh `AgentLoopContinuationState` is exactly the run boundary `sentPrefixCount` (the
	 * pack-freeze mark) is scoped to - `createAgentLoopContinuationState` correctly zeroes it below.
	 * `sanitizerSentPrefixCount` (the sanitizer mark) is scoped to something LONGER-LIVED than one
	 * continuation state - see `initialSanitizerSentPrefixCount` below and `Agent.runPromptMessages`,
	 * which is the only correct place to seed it from a persistent value instead of zero.
	 */
	providerRequestPrefixState?: ProviderRequestPrefixState;
}

/**
 * @param initialSanitizerSentPrefixCount Starting value for the SESSION-scoped sanitizer mark (see
 * `ProviderRequestPrefixState` in types.ts). Defaults to 0, correct for any caller with no session
 * longer-lived than this one continuation state (direct `runAgentLoop`/`runAgentLoopContinue`
 * callers, tests). `Agent` is the one caller that owns a longer-lived session and must pass its own
 * persisted value here instead of accepting the default - see `Agent.runPromptMessages`.
 */
export function createAgentLoopContinuationState(
	initialSanitizerSentPrefixCount = 0,
	sanitizerMemory?: ToolFailureContextMemory,
): AgentLoopContinuationState {
	return {
		providerTurns: 0,
		stallWindow: [],
		stagnantResultWindow: [],
		toolFailureRecoveryGate: new ToolFailureRecoveryGate(),
		providerRequestPrefixState: {
			sentPrefixCount: 0,
			sanitizerSentPrefixCount: initialSanitizerSentPrefixCount,
			sanitizerMemory,
		},
	};
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	return streamAgentLoop(config, signal, (emit) => runAgentLoop(prompts, context, config, emit, signal, streamFn));
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	assertContinuableContext(context);

	return streamAgentLoop(config, signal, (emit) => runAgentLoopContinue(context, config, emit, signal, streamFn));
}

function streamAgentLoop(
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	run: (emit: AgentEventSink) => Promise<AgentMessage[]>,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();
	void run(async (event) => {
		stream.push(event);
	})
		.catch(async (error) => {
			const messages = [createLoopFailureMessage(error, config, signal?.aborted ?? false)];
			stream.push({ type: "agent_end", messages });
			return messages;
		})
		.then((messages) => {
			stream.end(messages);
		});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
	continuationState: AgentLoopContinuationState = createAgentLoopContinuationState(),
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	if (providerTurnLimitReached(config, continuationState)) {
		for (const prompt of prompts) {
			await emit({ type: "message_start", message: prompt });
			await emit({ type: "message_end", message: prompt });
		}
		await emitProviderTurnLimitStop(config, continuationState, newMessages, emit);
		return newMessages;
	}
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn, continuationState);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
	continuationState: AgentLoopContinuationState = createAgentLoopContinuationState(),
): Promise<AgentMessage[]> {
	assertContinuableContext(context);

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context, messages: [...context.messages] };

	await emit({ type: "agent_start" });
	if (providerTurnLimitReached(config, continuationState)) {
		await emitProviderTurnLimitStop(config, continuationState, newMessages, emit);
		return newMessages;
	}
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn, continuationState);
	return newMessages;
}

function assertContinuableContext(context: AgentContext): void {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}
}

function createLoopFailureMessage(error: unknown, config: AgentLoopConfig, aborted: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: config.model.api,
		provider: config.model.provider,
		model: config.model.id,
		usage: createEmptyUsage(),
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

function providerTurnLimitReached(config: AgentLoopConfig, continuationState: AgentLoopContinuationState): boolean {
	const limit = config.maxProviderTurns ?? DEFAULT_MAX_PROVIDER_TURNS;
	return limit > 0 && continuationState.providerTurns >= limit;
}

async function emitProviderTurnLimitStop(
	config: AgentLoopConfig,
	continuationState: AgentLoopContinuationState,
	newMessages: AgentMessage[],
	emit: AgentEventSink,
): Promise<void> {
	config.onRunawayStop?.({
		reason: "provider_turn_limit",
		signature: "provider_turn_limit",
		repeats: continuationState.providerTurns,
	});
	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Maximum exact cycle width inspected by the runaway-loop backstop. Detection requires the complete
 * suffix pattern to repeat `stallLimit` times; recurring housekeeping calls among distinct productive
 * operations therefore never look like a loop merely because one signature is frequent.
 */
const STALL_WINDOW_PERIODS = 4;

/** Identical observable results make a repeated cycle conclusive well before the coarse call-only fuse. */
const STAGNANT_RESULT_REPEAT_LIMIT = 3;

function repeatsToolCallPattern(stallWindow: readonly string[], stallLimit: number): boolean {
	if (stallLimit <= 0) return false;
	const maxPeriod = Math.min(STALL_WINDOW_PERIODS, Math.floor(stallWindow.length / stallLimit));
	for (let period = 1; period <= maxPeriod; period++) {
		const requiredTurns = period * stallLimit;
		const start = stallWindow.length - requiredTurns;
		let matches = true;
		for (let offset = period; offset < requiredTurns; offset++) {
			if (stallWindow[start + offset] !== stallWindow[start + (offset % period)]) {
				matches = false;
				break;
			}
		}
		if (matches) return true;
	}
	return false;
}

function textProtocolOperationArguments(toolCall: AgentToolCall): unknown {
	const args: unknown = toolCall.arguments;
	if (!args || typeof args !== "object" || Array.isArray(args)) return args ?? null;
	const record = args as Record<string, unknown>;
	if ((toolCall.name === "write" || toolCall.name === "edit") && typeof record.path === "string") {
		return { path: record.path };
	}
	return args;
}

function textProtocolBatchSignature(toolCalls: readonly AgentToolCall[]): string {
	return normalizeToolSignature(
		toolCalls.map((toolCall) => [toolCall.name, textProtocolOperationArguments(toolCall)]),
	);
}

/** Hash only provider-visible result state; per-execution IDs/timestamps cannot hide a stagnant cycle. */
function toolResultBatchSignature(toolResults: readonly ToolResultMessage[]): string {
	return getToolExecutionKey(
		"tool_result_batch",
		toolResults.map((result) => ({
			toolName: result.toolName,
			content: result.content,
			isError: result.isError,
		})),
	);
}

function toolCallRecord(toolCall: AgentToolCall): Record<string, unknown> | undefined {
	const args: unknown = toolCall.arguments;
	return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : undefined;
}

function toolResultPhase(result: ToolResultMessage): string | undefined {
	if (!result.details || typeof result.details !== "object" || Array.isArray(result.details)) return undefined;
	const phase = (result.details as Record<string, unknown>).phase;
	return typeof phase === "string" ? phase : undefined;
}

function repeatsSuccessfulTextProtocolBatch(
	incomingSignature: string,
	toolCalls: readonly AgentToolCall[],
	previous: SuccessfulTextProtocolBatch | undefined,
): boolean {
	if (!previous) return false;
	if (incomingSignature === previous.signature) return true;
	if (toolCalls.length !== previous.calls.length || toolCalls.length !== previous.messages.length) return false;
	return toolCalls.every((toolCall, index) => {
		const previousCall = previous.calls[index];
		const previousResult = previous.messages[index];
		if (!previousCall || !previousResult) return false;
		const currentArgs = toolCallRecord(toolCall);
		const previousArgs = toolCallRecord(previousCall);
		if (currentArgs?.path !== previousArgs?.path) return false;
		const phase = toolResultPhase(previousResult);
		if (phase === "written") return toolCall.name === "write" && previousCall.name === "write";
		return phase === "edited" && toolCall.name === "edit" && previousCall.name === "edit";
	});
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
	continuationState: AgentLoopContinuationState = createAgentLoopContinuationState(),
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;
	// Runaway-loop backstop state: a sliding window of recent NORMALIZED tool-call signatures. A model
	// wedged repeating the same action makes no progress but keeps spending tokens; if one signature
	// recurs `stallLimit` times within the window we stop gracefully. Signatures are normalized so
	// volatile args (timestamps/UUIDs/nonces that change every call) can't disguise an otherwise-
	// identical call (bug #28). The window spans `stallLimit * STALL_WINDOW_PERIODS` turns so periodic
	// oscillation is caught too, not just back-to-back repeats: a cycle of period P repeats each
	// signature ~window/P times, so any P up to STALL_WINDOW_PERIODS reaches the threshold before the
	// window slides past it. Counts only turns that issued tool calls, so varied/long work never trips
	// it. `0` disables.
	const stallLimit = config.maxStallTurns ?? DEFAULT_MAX_STALL_TURNS;
	const providerTurnLimit = config.maxProviderTurns ?? DEFAULT_MAX_PROVIDER_TURNS;
	const stallWindow = continuationState.stallWindow;
	let stagnantResultWindow = continuationState.stagnantResultWindow;
	if (stagnantResultWindow === undefined) {
		stagnantResultWindow = [];
		continuationState.stagnantResultWindow = stagnantResultWindow;
	}
	let providerRequestPrefixState = continuationState.providerRequestPrefixState;
	if (providerRequestPrefixState === undefined) {
		providerRequestPrefixState = { sentPrefixCount: 0, sanitizerSentPrefixCount: 0 };
		continuationState.providerRequestPrefixState = providerRequestPrefixState;
	}
	// Announce a transient record `provider-request-planner.ts` just committed to durable history, on
	// THIS run's own `emit` - the same `message_start`/`message_end` pairing `pendingMessages` below
	// uses, so a host's existing message persistence (whatever already keeps its transcript in sync
	// with `message_end`) picks a committed record up without new host-side code. See
	// `onTransientRecordsCommitted`'s doc comment in types.ts for why this needs to exist at all: a
	// record folded only into `sourceContext.messages` survives THIS run but is invisible to a host
	// that rebuilds its own snapshot from its own persisted transcript between turns.
	//
	// Also pushes onto `newMessages` (this run's own "what did I add" record, returned from
	// `agentLoop`/`agentLoopContinue` and used to seed the next turn - see its declaration in the
	// caller) - not just `currentContext.messages`, which `provider-request-planner.ts`'s
	// `adoptReplannedMessages` already keeps in sync via `sourceContext`, so pushing there too would
	// duplicate the entry. Before this, `newMessages` silently disagreed with this run's OWN event
	// stream about what was added: anything committed only into `sourceContext.messages` (every
	// transient record) was invisible to `newMessages` while fully visible via `message_end`. Harmless
	// while nothing distinguished the two views; a real defect once something did - a consumer that
	// builds its own transcript by listening to `message_end` (as a worker's completion-callback
	// evidence check does) legitimately expects it to match what this same run officially returned as
	// new, and a mismatch there is this run's own inconsistency, not that consumer's to special-case
	// around.
	const emitCommittedTransientRecords = async (records: AgentMessage[]): Promise<void> => {
		for (const message of records) {
			await emit({ type: "message_start", message });
			await emit({ type: "message_end", message });
			newMessages.push(message);
		}
	};
	// Inject once, before the first request: every later `config = {...config, ...}` clone below
	// (the `prepareNextTurn` model/reasoning swap) copies both references forward unchanged, so the
	// "already sent" mark in provider-request-planner.ts survives a config clone instead of resetting
	// to 0 on every turn a host's `prepareNextTurn` touches (see `ProviderRequestPrefixState`), and the
	// commit-announcement hook stays bound to THIS run's `emit` rather than reverting to whatever (if
	// anything) `initialConfig` held.
	config = { ...config, providerRequestPrefixState, onTransientRecordsCommitted: emitCommittedTransientRecords };
	const validationFailureTracker: ToolValidationFailureTracker = new Map();
	const repairTeachTracker: ToolRepairTeachTracker = new Map();
	let toolFailureMemory = createToolFailureMemoryTracker(
		currentContext.messages,
		providerRequestPrefixState.sanitizerMemory,
		providerRequestPrefixState.sanitizerSentPrefixCount,
	);
	const verificationObligations = new VerificationObligationTracker(currentContext.messages);
	const toolFailureRecoveryGate = continuationState.toolFailureRecoveryGate;
	toolFailureRecoveryGate.restoreFromMessages(currentContext.messages);
	let lastSuccessfulTextProtocolBatch: SuccessfulTextProtocolBatch | undefined;
	let previousAssistantForDegenerateCollapse: AssistantMessage | undefined;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];
	const processPendingMessages = async (): Promise<void> => {
		if (pendingMessages.length === 0) return;
		lastSuccessfulTextProtocolBatch = undefined;
		// Only an owner/user turn can change authority or intent. Internal custom steering and
		// follow-up messages must not re-admit a known-bad unchanged operation. Count every owner
		// message so live admission stays byte-for-byte aligned with transcript restoration.
		for (const message of pendingMessages) {
			if (message.role === "user") toolFailureRecoveryGate.noteWorldAdvance();
			await emit({ type: "message_start", message });
			await emit({ type: "message_end", message });
			currentContext.messages.push(message);
			newMessages.push(message);
			verificationObligations.record([message]);
		}
		previousAssistantForDegenerateCollapse = undefined;
		pendingMessages = [];
	};

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (providerTurnLimit > 0 && continuationState.providerTurns >= providerTurnLimit) {
				// Preserve already-dequeued steering, but do not announce an assistant turn that will
				// never start. A turn is one provider response plus its tools/results.
				await processPendingMessages();
				await emitProviderTurnLimitStop(config, continuationState, newMessages, emit);
				return;
			}
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response).
			await processPendingMessages();
			continuationState.providerTurns++;
			// Obligation instructions ride the trailing region (see `AgentContext.trailingInstruction`
			// and `provider-request-planner.ts`), never `systemPrompt`: that set changes as obligations
			// appear and resolve, and systemPrompt sits at byte zero of the request, where a change
			// invalidates the provider's cached prefix for the whole conversation.
			const requestContext: AgentContext = {
				...currentContext,
				trailingInstruction: verificationObligations.requestInstruction(),
			};
			const response = await streamAssistantResponse(
				requestContext,
				config,
				signal,
				emit,
				streamFn,
				{
					verificationObligations,
					invalidVerificationTerminalStopReason:
						providerTurnLimit > 0 && continuationState.providerTurns >= providerTurnLimit ? "error" : "stop",
				},
				previousAssistantForDegenerateCollapse,
			);
			const message = response.message;
			previousAssistantForDegenerateCollapse = response.comparisonMessage;
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			let terminatingToolBatch = false;
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				const textProtocolBatch = toolCalls.every((toolCall) => toolCall.source === "text-protocol");
				const incomingBatchSignature = textProtocolBatchSignature(toolCalls);
				const previousSuccessfulTextProtocolResults =
					textProtocolBatch &&
					repeatsSuccessfulTextProtocolBatch(incomingBatchSignature, toolCalls, lastSuccessfulTextProtocolBatch)
						? lastSuccessfulTextProtocolBatch?.messages
						: undefined;
				const executedToolBatch = await executeToolCalls(
					currentContext,
					message,
					response.requestId,
					config,
					validationFailureTracker,
					repairTeachTracker,
					toolFailureMemory,
					toolFailureRecoveryGate,
					previousSuccessfulTextProtocolResults,
					signal,
					emit,
				);
				toolResults.push(...executedToolBatch.messages);
				terminatingToolBatch = executedToolBatch.terminate;
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
				verificationObligations.record(toolResults);
				if (!previousSuccessfulTextProtocolResults) {
					lastSuccessfulTextProtocolBatch =
						textProtocolBatch &&
						toolResults.length === toolCalls.length &&
						toolResults.every((result) => !result.isError)
							? {
									signature: textProtocolBatchSignature(toolCalls),
									messages: toolResults,
									calls: toolCalls,
								}
							: undefined;
				}
			} else {
				lastSuccessfulTextProtocolBatch = undefined;
			}
			const verificationBlocksCompletion =
				!verificationObligations.permitsTerminalMessage(message) ||
				(terminatingToolBatch && verificationObligations.getActiveIds().length > 0);
			if (verificationBlocksCompletion) hasMoreToolCalls = true;

			await emit({ type: "turn_end", message, toolResults });

			// Runaway-loop backstop (cost guard): detect only a repeated suffix cycle. Counting
			// signatures anywhere in the window falsely stopped progressing workflows whose status
			// checks recurred among distinct edits, reads, and verification operations.
			if (stallLimit > 0 && toolCalls.length > 0) {
				const signature = normalizeToolSignature(toolCalls.map((c) => [c.name, c.arguments ?? null]));
				const stagnantSignature = `${signature}:${toolResultBatchSignature(toolResults)}`;
				stagnantResultWindow.push(stagnantSignature);
				if (stagnantResultWindow.length > STAGNANT_RESULT_REPEAT_LIMIT * STALL_WINDOW_PERIODS) {
					stagnantResultWindow.shift();
				}
				if (repeatsToolCallPattern(stagnantResultWindow, STAGNANT_RESULT_REPEAT_LIMIT)) {
					config.onRunawayStop?.({
						reason: "stagnant_tool_cycle",
						signature,
						repeats: STAGNANT_RESULT_REPEAT_LIMIT,
					});
					await streamToollessClosingTurn(
						currentContext,
						newMessages,
						config,
						continuationState,
						providerTurnLimit,
						signal,
						emit,
						streamFn,
						previousAssistantForDegenerateCollapse,
						verificationObligations,
					);
					await emit({ type: "agent_end", messages: newMessages });
					return;
				}

				stallWindow.push(signature);
				if (stallWindow.length > stallLimit * STALL_WINDOW_PERIODS) stallWindow.shift();
				if (repeatsToolCallPattern(stallWindow, stallLimit)) {
					config.onRunawayStop?.({ reason: "repeated_tool_call", signature, repeats: stallLimit });
					await streamToollessClosingTurn(
						currentContext,
						newMessages,
						config,
						continuationState,
						providerTurnLimit,
						signal,
						emit,
						streamFn,
						previousAssistantForDegenerateCollapse,
						verificationObligations,
					);
					await emit({ type: "agent_end", messages: newMessages });
					return;
				}
			}

			const nextTurnContext = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};
			const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
			if (nextTurnSnapshot) {
				currentContext = nextTurnSnapshot.context ?? currentContext;
				if (nextTurnSnapshot.context) {
					toolFailureMemory = createToolFailureMemoryTracker(
						currentContext.messages,
						providerRequestPrefixState.sanitizerMemory,
						providerRequestPrefixState.sanitizerSentPrefixCount,
					);
					verificationObligations.restore(currentContext.messages);
				}
				config = {
					...config,
					model: nextTurnSnapshot.model ?? config.model,
					reasoning: nextTurnSnapshot.thinkingLevel ?? config.reasoning,
				};
			}

			if (
				!verificationBlocksCompletion &&
				(await config.shouldStopAfterTurn?.({
					message,
					toolResults,
					context: currentContext,
					newMessages,
				}))
			) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

const RUNAWAY_STOP_CLOSING_SYSTEM_PROMPT = [
	"RUNAWAY STOP CLOSING TURN",
	"The host stopped a repeated tool-call loop. No tools are available in this final request.",
	"Write one concise factual closing message for the user: completed work, the unresolved operation or blocker, and the safest next action.",
	"Do not claim unperformed work. Do not emit a tool call or tool-call markup.",
].join("\n");

/**
 * Spend one final provider request, with no tools, so a stopped run closes in the model's own words.
 *
 * The harness never writes that message itself. Tools are removed from the request, so this request
 * cannot open another tool batch and cannot re-enter the loop; it runs through the same planned
 * provider boundary as every other request. If the run is aborted, or the configured provider-turn
 * limit leaves no budget, the run ends with no closing message rather than a fabricated one — and a
 * provider error keeps its own error message for the same reason.
 */
async function streamToollessClosingTurn(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	continuationState: AgentLoopContinuationState,
	providerTurnLimit: number,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
	previousAssistant?: AssistantMessage,
	verificationObligations?: VerificationObligationTracker,
): Promise<void> {
	if (signal?.aborted) return;
	if (providerTurnLimit > 0 && continuationState.providerTurns >= providerTurnLimit) return;
	continuationState.providerTurns++;
	await emit({ type: "turn_start" });
	// Same relocation as the main turn loop above: obligation text (if any) goes to
	// `trailingInstruction`, never appended into `systemPrompt`. RUNAWAY_STOP_CLOSING_SYSTEM_PROMPT
	// itself stays in the system prompt - it is host-authored, stable text, and this is always the
	// last request of the run, so there is no future turn whose cached prefix it could invalidate.
	const closingContext: AgentContext = {
		...currentContext,
		systemPrompt: currentContext.systemPrompt
			? `${currentContext.systemPrompt}\n\n${RUNAWAY_STOP_CLOSING_SYSTEM_PROMPT}`
			: RUNAWAY_STOP_CLOSING_SYSTEM_PROMPT,
		trailingInstruction: verificationObligations?.requestInstruction(),
		tools: [],
	};
	const response = await streamAssistantResponse(
		closingContext,
		config,
		signal,
		emit,
		streamFn,
		{
			rejectToolCalls: true,
			...(verificationObligations
				? {
						verificationObligations,
						invalidVerificationTerminalStopReason: "error" as const,
					}
				: {}),
		},
		previousAssistant,
		{ allowToolFreeComparison: true },
	);
	const message = response.message;
	newMessages.push(message);
	await emit({ type: "turn_end", message, toolResults: [] });
}

/**
 * Start one provider request through the canonical agent-loop boundary.
 *
 * All callers, including host-owned tool-free finalization, receive the same failure-context
 * sanitization, context transformation/conversion, dynamic authentication, request-local reasoning,
 * and request preflight immediately before transport.
 */
export async function startAgentProviderRequest(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn?: StreamFn,
): Promise<Awaited<ReturnType<StreamFn>>> {
	return startPlannedAgentProviderRequest(context, config, signal, streamFn);
}

type StartedAssistantResponse = {
	message: AssistantMessage;
	/** Provider output before degeneration collapse, retained for the next turn comparison. */
	comparisonMessage: AssistantMessage;
	requestId: AgentRequestId;
};

type AssistantResponsePolicy = {
	rejectToolCalls?: boolean;
	verificationObligations?: VerificationObligationTracker;
	invalidVerificationTerminalStopReason?: "stop" | "error";
};

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
	policy?: AssistantResponsePolicy,
	previousAssistant?: AssistantMessage,
	collapseOptions?: { allowToolFreeComparison?: boolean },
): Promise<StartedAssistantResponse> {
	const degenerationAbort = new AbortController();
	const onOuterAbort = (): void => degenerationAbort.abort();
	if (signal?.aborted) degenerationAbort.abort();
	else signal?.addEventListener("abort", onOuterAbort, { once: true });
	const response = await startPlannedAgentProviderRequestWithId(context, config, degenerationAbort.signal, streamFn);

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;
	let abortedForDegeneration = false;
	/**
	 * D1 observability (see AssistantMessage.firstTokenAt in types.ts): stamped on the first event
	 * that carries actual generated content - a `_delta` event specifically, never a `_start`/`_end`
	 * framing event - and left `undefined` if the stream errors or aborts before one ever arrives.
	 */
	let firstTokenAt: number | undefined;

	responseEvents: for await (const event of response.stream) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (
					firstTokenAt === undefined &&
					(event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta")
				) {
					firstTokenAt = Date.now();
				}
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
					if (
						!abortedForDegeneration &&
						!signal?.aborted &&
						!partialMessage.content.some((block) => block.type === "toolCall") &&
						shouldAbortDegenerateStream(assistantMessageText(partialMessage))
					) {
						abortedForDegeneration = true;
						degenerationAbort.abort();
					}
				}
				break;

			case "done":
			case "error":
				break responseEvents;
		}
	}
	// D1 observability (see AssistantMessage.streamEndAt in types.ts): the stream is exhausted the
	// instant its terminal `done`/`error` event was observed above, not when the message is later
	// transformed or persisted. Unconditional: every path that reaches here saw a real terminal
	// event, so this is never fabricated the way a value would be if set before the loop.
	const streamEndAt = Date.now();

	signal?.removeEventListener("abort", onOuterAbort);
	const providerMessage = await response.stream.result();
	let finalMessage = policy?.rejectToolCalls
		? rejectToolCallsFromToolFreeResponse(providerMessage)
		: rejectNativeToolProtocolResidue(providerMessage, context.tools ?? [], Boolean(config.textToolCallProtocol));
	if (abortedForDegeneration && !signal?.aborted && finalMessage.stopReason === "aborted") {
		finalMessage = { ...finalMessage, stopReason: "stop" };
		delete finalMessage.errorMessage;
	}
	if (policy?.verificationObligations) {
		finalMessage = policy.verificationObligations.enforceTerminalMessage(
			finalMessage,
			policy.invalidVerificationTerminalStopReason ?? "error",
		);
	}
	const comparisonMessage = finalMessage;
	finalMessage = collapseDegenerateAssistantMessage(finalMessage, previousAssistant, collapseOptions);
	// Attached last, after every transform above, so these are never silently dropped by a transform
	// that constructs a new object without spreading its input (see AssistantMessage.firstTokenAt /
	// streamEndAt in types.ts).
	finalMessage = {
		...finalMessage,
		...(firstTokenAt !== undefined ? { firstTokenAt } : {}),
		streamEndAt,
	};
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return { message: finalMessage, comparisonMessage, requestId: response.requestId };
}

interface ToolExecutionContext {
	context: AgentContext;
	assistantMessage: AssistantMessage;
	requestId: AgentRequestId;
	config: AgentLoopConfig;
	validationFailureTracker: ToolValidationFailureTracker;
	repairTeachTracker: ToolRepairTeachTracker;
	toolFailureMemory: ToolFailureMemoryTracker;
	toolFailureRecoveryGate: ToolFailureRecoveryGate;
	/** Set while preparing a batch; only an entirely clean tool turn closes validation episodes. */
	validationBounced: boolean;
	previousSuccessfulResults?: readonly ToolResultMessage[];
	signal?: AbortSignal;
	emit: AgentEventSink;
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	requestId: AgentRequestId,
	config: AgentLoopConfig,
	validationFailureTracker: ToolValidationFailureTracker,
	repairTeachTracker: ToolRepairTeachTracker,
	toolFailureMemory: ToolFailureMemoryTracker,
	toolFailureRecoveryGate: ToolFailureRecoveryGate,
	previousSuccessfulTextProtocolResults: readonly ToolResultMessage[] | undefined,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const execCtx: ToolExecutionContext = {
		context: currentContext,
		assistantMessage,
		requestId,
		config,
		validationFailureTracker,
		repairTeachTracker,
		toolFailureMemory,
		toolFailureRecoveryGate,
		validationBounced: false,
		previousSuccessfulResults: previousSuccessfulTextProtocolResults,
		signal,
		emit,
	};
	const batch =
		config.toolExecution === "sequential" || isToolParallelismDisabled()
			? await executeToolCallsSequential(execCtx, toolCalls)
			: await executeToolCallsPartitioned(execCtx, toolCalls);
	if (!execCtx.validationBounced) resetValidationFailureTracker(validationFailureTracker);
	return batch;
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

type SuccessfulTextProtocolBatch = {
	signature: string;
	messages: readonly ToolResultMessage[];
	calls: readonly AgentToolCall[];
};

type StartedToolCall =
	| { kind: "finalized"; finalized: FinalizedToolCallOutcome }
	| { kind: "prepared"; preparation: PreparedToolCall };

async function prepareAndStartToolCall(
	execCtx: ToolExecutionContext,
	toolCall: AgentToolCall,
	index: number,
): Promise<StartedToolCall> {
	const preparation = execCtx.previousSuccessfulResults
		? createRepeatedSuccessfulToolCallOutcome(execCtx.previousSuccessfulResults[index])
		: await prepareToolCall(
				execCtx.context,
				execCtx.assistantMessage,
				toolCall,
				execCtx.config,
				execCtx.validationFailureTracker,
				execCtx.toolFailureMemory,
				execCtx.toolFailureRecoveryGate,
				execCtx.signal,
				execCtx.requestId,
			);
	if (preparation.kind === "immediate") {
		if (preparation.validationEvent?.outcome === "bounced") execCtx.validationBounced = true;
		await emitToolExecutionStart(toolCall, execCtx.emit);
		emitToolArgumentValidationTelemetry(execCtx.config, preparation.validationEvent, "not_run", "none");
		return {
			kind: "finalized",
			finalized: finalizeRejectedToolCall(
				toolCall,
				execCtx.context.tools?.find((tool) => tool.name === toolCall.name),
				preparation,
				execCtx.toolFailureMemory,
			),
		};
	}
	return { kind: "prepared", preparation };
}

async function finalizeStartedToolCall(
	execCtx: ToolExecutionContext,
	started: StartedToolCall,
): Promise<FinalizedToolCallOutcome> {
	if (started.kind === "finalized") return started.finalized;
	return executeAndFinalizePreparedToolCall(
		execCtx.context,
		execCtx.assistantMessage,
		started.preparation,
		execCtx.requestId,
		execCtx.config,
		execCtx.repairTeachTracker,
		execCtx.toolFailureMemory,
		execCtx.toolFailureRecoveryGate,
		execCtx.signal,
		execCtx.emit,
	);
}

async function reservePreparedToolCalls(
	execCtx: ToolExecutionContext,
	preparedCalls: readonly PreparedToolCall[],
): Promise<void> {
	if (preparedCalls.length === 0) return;
	execCtx.signal?.throwIfAborted();
	if (execCtx.config.onToolCallStart) {
		const calls: ToolCallStartContext[] = preparedCalls.map((prepared) => ({
			requestId: execCtx.requestId,
			callId: prepared.toolCall.id,
			toolName: prepared.toolCall.name,
			assistantMessage: execCtx.assistantMessage,
			toolCall: prepared.toolCall,
			args: prepared.args,
			context: execCtx.context,
		}));
		await execCtx.config.onToolCallStart(calls, execCtx.signal);
	}
	execCtx.signal?.throwIfAborted();
	for (const prepared of preparedCalls) {
		await emitToolExecutionStart(prepared.toolCall, execCtx.emit);
	}
}

/**
 * Run exactly one call the way the legacy sequential branch runs each of its calls: prepare,
 * reserve as a singleton array, execute, finalize, apply the recovery-gate effect, emit
 * `tool_execution_end`, then the result-message artifact. Shared by the legacy sequential branch
 * (`executeToolCallsSequential`) and by S2's partition scheduling, where a lone
 * `executionMode: "sequential"` call becomes its own barrier group and runs through this exact
 * same path - this is a structural extraction, not a behavior change: every await happens at the
 * same point in the timeline it did when this was inlined in the sequential loop.
 */
async function executeBarrierToolCall(
	execCtx: ToolExecutionContext,
	toolCall: AgentToolCall,
	index: number,
): Promise<{ finalized: FinalizedToolCallOutcome; toolResultMessage: ToolResultMessage }> {
	const started = await prepareAndStartToolCall(execCtx, toolCall, index);
	if (started.kind === "prepared") {
		await reservePreparedToolCalls(execCtx, [started.preparation]);
	}
	const finalized = await finalizeStartedToolCall(execCtx, started);
	execCtx.toolFailureRecoveryGate.apply(finalized.executionGateEffect);

	await emitToolExecutionEnd(finalized, execCtx.emit);
	const toolResultMessage = createToolResultMessage(finalized);
	await emitToolResultMessage(toolResultMessage, execCtx.emit);
	// A handoff may publish a foreground placeholder, but a barrier call still owns the execution
	// ordering contract. Do not let the caller continue until the detached execution has reached
	// its normal policy-finalized terminal state.
	if (finalized.backgroundCompletion) await finalized.backgroundCompletion.catch(() => undefined);
	return { finalized, toolResultMessage };
}

async function executeToolCallsSequential(
	execCtx: ToolExecutionContext,
	toolCalls: AgentToolCall[],
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const [index, toolCall] of toolCalls.entries()) {
		const { finalized, toolResultMessage } = await executeBarrierToolCall(execCtx, toolCall, index);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (execCtx.signal?.aborted) {
			break;
		}
	}

	return { messages, terminate: shouldTerminateToolBatch(finalizedCalls) };
}

type ToolExecutionGroup =
	| { kind: "barrier"; call: AgentToolCall; index: number }
	| { kind: "parallel"; entries: { call: AgentToolCall; index: number }[] };

/**
 * S2 - order-preserving partition (replaces whole-batch `hasSequentialToolCall` poisoning). Walk
 * `toolCalls` in emission order; a tool whose `executionMode === "sequential"` closes the
 * currently open parallel group (if any) and becomes its own barrier group; every other call
 * (including an unknown tool - preflight still rejects it during preparation) accumulates into
 * the open parallel group, opening a fresh one if none is open. Every call appears in exactly one
 * group, in original relative order; concatenating the groups' outputs back together (as
 * `executeToolCallsPartitioned` does) reproduces the original emission order.
 */
function partitionToolCalls(
	toolCalls: readonly AgentToolCall[],
	tools: readonly AgentTool<any>[] | undefined,
): ToolExecutionGroup[] {
	const groups: ToolExecutionGroup[] = [];
	let openGroup: { kind: "parallel"; entries: { call: AgentToolCall; index: number }[] } | undefined;
	for (const [index, call] of toolCalls.entries()) {
		const mode = tools?.find((tool) => tool.name === call.name)?.executionMode;
		if (mode === "sequential") {
			openGroup = undefined;
			groups.push({ kind: "barrier", call, index });
			continue;
		}
		if (!openGroup) {
			openGroup = { kind: "parallel", entries: [] };
			groups.push(openGroup);
		}
		openGroup.entries.push({ call, index });
	}
	return groups;
}

/**
 * S3 - refill-batch pool (replaces the fixed-size wave barrier). Slots are refilled in batches:
 * whenever k slots are free, prepare those k calls serially (preflight stays serial - never
 * parallelized), reserve them as ONE array through the unchanged `reservePreparedToolCalls` (a
 * host can still atomically persist the whole refill's reservation before any of its bodies
 * start), then dispatch them. A slot frees and is immediately eligible for refill as soon as ITS
 * call finishes, instead of waiting for the rest of a fixed-size wave to settle - that removes the
 * wave barrier while keeping preparation incremental, so `beforeToolCall` policy and
 * `toolFailureRecoveryGate.admit()` keep observing in-turn state that earlier completions changed.
 * `tool_execution_end` fires at each call's actual completion (S4), not replayed once a whole wave
 * settles - that reordering is audited safe (agent-loop.test.ts:3108) because nothing downstream
 * is order-sensitive. The recovery gate is a DIFFERENT story: `apply()` stamps a failure with the
 * gate's shared world-cursor, and a sibling's success bumps that same cursor, so which one lands
 * first changes whether a later retry is admitted. The old code applied one whole wave's effects
 * together, synchronously, in emission order after `Promise.all`; gate effects here therefore
 * still apply in strict emission order via `nextToApply`, catching up as soon as the next slot in
 * line is ready, decoupled from actual completion order (which only governs telemetry and pool
 * width accounting).
 */
async function pooledExecuteToolCalls(
	execCtx: ToolExecutionContext,
	entries: readonly { call: AgentToolCall; index: number }[],
	width: number,
): Promise<FinalizedToolCallOutcome[]> {
	const results: (FinalizedToolCallOutcome | undefined)[] = new Array(entries.length);
	const inFlight = new Map<number, Promise<void>>();
	let nextToApply = 0;
	const drainGateApply = (): void => {
		while (nextToApply < results.length) {
			const finalized = results[nextToApply];
			if (!finalized) break;
			execCtx.toolFailureRecoveryGate.apply(finalized.executionGateEffect);
			nextToApply++;
		}
	};
	const settle = async (slot: number, finalized: FinalizedToolCallOutcome): Promise<void> => {
		results[slot] = finalized;
		drainGateApply();
		await emitToolExecutionEnd(finalized, execCtx.emit);
	};

	let next = 0;
	while (next < entries.length && !execCtx.signal?.aborted) {
		const free = width - inFlight.size;
		if (free <= 0) {
			await Promise.race(inFlight.values());
			continue;
		}
		const refillWave: PreparedToolCall[] = [];
		const refillSlots: { slot: number; started: StartedToolCall }[] = [];
		while (refillWave.length < free && next < entries.length && !execCtx.signal?.aborted) {
			const entry = entries[next];
			const slot = next;
			next++;
			const started = await prepareAndStartToolCall(execCtx, entry.call, entry.index);
			if (started.kind === "finalized") {
				// Immediate validation/policy/replay outcomes are never reserved (test :3622).
				await settle(slot, started.finalized);
				continue;
			}
			refillWave.push(started.preparation);
			refillSlots.push({ slot, started });
		}
		if (refillSlots.length === 0) continue;
		await reservePreparedToolCalls(execCtx, refillWave);
		for (const { slot, started } of refillSlots) {
			const running = finalizeStartedToolCall(execCtx, started).then((finalized) => {
				inFlight.delete(slot);
				return settle(slot, finalized);
			});
			inFlight.set(slot, running);
		}
	}
	// In-flight work is always awaited, including on the abort path - an already-dispatched call
	// keeps its real result.
	await Promise.allSettled(inFlight.values());
	// A call that never reached preparation (the abort path stopped refill-batch formation before
	// reaching it) is simply absent from the result, not a placeholder.
	return results.filter((entry): entry is FinalizedToolCallOutcome => entry !== undefined);
}

async function executeToolCallsPartitioned(
	execCtx: ToolExecutionContext,
	toolCalls: AgentToolCall[],
): Promise<ExecutedToolCallBatch> {
	const groups = partitionToolCalls(toolCalls, execCtx.context.tools);
	const width = resolveToolConcurrency(execCtx.config);
	const orderedFinalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const group of groups) {
		if (execCtx.signal?.aborted) break;
		if (group.kind === "barrier") {
			const { finalized, toolResultMessage } = await executeBarrierToolCall(execCtx, group.call, group.index);
			orderedFinalizedCalls.push(finalized);
			messages.push(toolResultMessage);
			continue;
		}
		// Result-message artifacts for this group are only emitted once the whole group settles, in
		// original emission order - matching the pinned "ends in completion order, results persist
		// in source order" contract (agent-loop.test.ts:3108). Groups themselves already run
		// strictly in order (never overlapping), so deferring per-group instead of to the very end
		// of the whole batch produces an identical observable event stream.
		const finalizedEntries = await pooledExecuteToolCalls(execCtx, group.entries, width);
		for (const finalized of finalizedEntries) {
			const toolResultMessage = createToolResultMessage(finalized);
			await emitToolResultMessage(toolResultMessage, execCtx.emit);
			orderedFinalizedCalls.push(finalized);
			messages.push(toolResultMessage);
		}
	}

	return { messages, terminate: shouldTerminateToolBatch(orderedFinalizedCalls) };
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
	validationEvent?: ToolArgumentValidationTelemetryEvent;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
	phase: ToolFailurePhase;
	failureCode: string;
	correction: string;
	diagnostic?: string;
	/** Bounded current-turn instruction that supplements, but never replaces, the durable failure ledger. */
	providerFeedback?: string;
	repeatedSuccessfulCall?: { previousToolCallId: string };
	repeatedToolFailure?: boolean;
	validationEvent?: ToolArgumentValidationTelemetryEvent;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
	errorClass?: string;
	failureMessage?: string;
	failureCode?: string;
	outputSignature?: string;
	errorKind?: AgentToolErrorKind;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
	executionGateEffect?: ToolFailureRecoveryGateEffect;
	/** Present only for an accepted handoff; sequential batches await it before their next body. */
	backgroundCompletion?: Promise<FinalizedToolCallOutcome>;
};

type ToolValidationFailureEpisode = {
	repeats: number;
	escalated: boolean;
};

/** Bounded LRU episodes keyed by tool + deterministic validator/provider failure signature. */
type ToolValidationFailureTracker = Map<string, ToolValidationFailureEpisode>;

type ValidationFailureHandling = {
	message: string;
	providerFeedback?: string;
};

type ToolRepairTeachTracker = Map<string, number>;

const DEFAULT_TOOL_VALIDATION_ESCALATION_THRESHOLD = 3;
const TOOL_REPAIR_TEACH_EVERY = 5;
const REPEATED_SUCCESS_RESULT_MAX_CHARS = 2_048;
const MAX_PROVIDER_PARSE_DIAGNOSTIC_CHARS = 480;
const MAX_TRACKED_VALIDATION_FAILURE_EPISODES = 8;

function createRepeatedSuccessfulToolCallOutcome(
	previousResult: ToolResultMessage | undefined,
): ImmediateToolCallOutcome {
	const previousText = previousResult?.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.slice(0, REPEATED_SUCCESS_RESULT_MAX_CHARS);
	const diagnostic = previousText
		? `${REPEATED_SUCCESSFUL_TOOL_CALL_FAILURE.diagnostic} Previous successful result: ${previousText}`
		: REPEATED_SUCCESSFUL_TOOL_CALL_FAILURE.diagnostic;
	return {
		kind: "immediate",
		result: createErrorToolResult(diagnostic),
		isError: true,
		phase: "execution",
		failureCode: REPEATED_SUCCESSFUL_TOOL_CALL_FAILURE.failureCode,
		correction: REPEATED_SUCCESSFUL_TOOL_CALL_FAILURE.guidance,
		diagnostic,
		...(previousResult ? { repeatedSuccessfulCall: { previousToolCallId: previousResult.toolCallId } } : {}),
	};
}

function createAbortedToolCallOutcome(
	validationEvent: ToolArgumentValidationTelemetryEvent | undefined,
): ImmediateToolCallOutcome {
	return {
		kind: "immediate",
		result: createErrorToolResult("Operation aborted"),
		isError: true,
		phase: "cancelled",
		failureCode: "aborted",
		correction: "Retry only if the operation is still required.",
		validationEvent,
	};
}

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

function createValidationBounceTelemetry(
	config: AgentLoopConfig,
	toolCall: AgentToolCall,
	errorKeyword: string,
): ToolArgumentValidationTelemetryEvent {
	return {
		outcome: "bounced",
		provider: config.model.provider,
		model: config.model.id,
		tool: toolCall.name,
		source: toolCall.source,
		failureModes: ["other"],
		repairsApplied: [],
		errorKeywords: [errorKeyword],
		taught: "none",
		executionOutcome: "not_run",
	};
}

function validationFailureCorrection(
	event: ToolArgumentValidationTelemetryEvent | undefined,
	toolName: string,
): string {
	const shape = event?.failureShape
		?.slice(0, 3)
		.map((entry) => `${entry.path}: expected ${entry.expectedType}, received ${entry.receivedType}`)
		.join("; ");
	const rules = [
		...new Set(
			(event?.failureModes ?? [])
				.filter((mode) => mode !== "other")
				.map((mode) => formatToolRepairStandingRule(mode)),
		),
	];
	return [`Match ${toolName} arguments to its current schema.`, shape ? `Fix ${shape}.` : undefined, ...rules]
		.filter((part): part is string => part !== undefined)
		.join(" ");
}

function resetValidationFailureTracker(tracker: ToolValidationFailureTracker): void {
	tracker.clear();
}

function emitToolArgumentValidationTelemetry(
	config: AgentLoopConfig,
	event: ToolArgumentValidationTelemetryEvent | undefined,
	executionOutcome: ToolArgumentExecutionOutcome,
	taught: ToolArgumentValidationTelemetryEvent["taught"],
): void {
	if (!event) return;
	config.onToolArgumentValidation?.({ ...event, executionOutcome, taught });
}

function toolValidationEscalationThreshold(config: AgentLoopConfig): number {
	return config.toolValidationEscalationThreshold ?? DEFAULT_TOOL_VALIDATION_ESCALATION_THRESHOLD;
}

function isToolArgumentRepairEmergencyDisabled(): boolean {
	const env = typeof process === "object" && process ? process.env : undefined;
	const value = env?.PI_TOOL_REPAIR_DISABLED;
	if (!value) return false;
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * S1 emergency switch. Bypasses partition scheduling and the pool entirely: every batch runs
 * through the legacy `executeToolCallsSequential` branch, same as `config.toolExecution ===
 * "sequential"`. Parsed exactly like `isToolArgumentRepairEmergencyDisabled` above (house pattern).
 * Takes precedence over `PI_TOOL_CONCURRENCY` and `AgentOptions.toolConcurrency`.
 */
function isToolParallelismDisabled(): boolean {
	const env = typeof process === "object" && process ? process.env : undefined;
	const value = env?.PI_TOOL_PARALLELISM_DISABLED;
	if (!value) return false;
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isValidToolConcurrency(value: number): boolean {
	return Number.isInteger(value) && value >= MIN_TOOL_CONCURRENCY && value <= MAX_TOOL_CONCURRENCY;
}

/** Complete trimmed decimal integer in the supported range 1-16; anything else is ignored. */
function parseToolConcurrencyEnv(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) return undefined;
	const parsed = Number(trimmed);
	return Number.isSafeInteger(parsed) && isValidToolConcurrency(parsed) ? parsed : undefined;
}

/**
 * S1 pool-width resolution. Precedence: `PI_TOOL_CONCURRENCY` env > `config.toolConcurrency` >
 * `DEFAULT_TOOL_CONCURRENCY`. Callers must check `isToolParallelismDisabled()` first - that switch
 * bypasses this function entirely, it is not folded in here.
 */
function resolveToolConcurrency(config: AgentLoopConfig): number {
	const env = typeof process === "object" && process ? process.env : undefined;
	const envConcurrency = parseToolConcurrencyEnv(env?.PI_TOOL_CONCURRENCY);
	if (envConcurrency !== undefined) return envConcurrency;
	if (config.toolConcurrency !== undefined && isValidToolConcurrency(config.toolConcurrency)) {
		return config.toolConcurrency;
	}
	return DEFAULT_TOOL_CONCURRENCY;
}

function isToolArgumentValidationError(error: unknown): error is ToolArgumentValidationError {
	return (
		error instanceof ToolArgumentValidationError ||
		(error instanceof Error &&
			error.name === "ToolArgumentValidationError" &&
			typeof (error as { toolName?: unknown }).toolName === "string" &&
			typeof (error as { signature?: unknown }).signature === "string" &&
			typeof (error as { enrichment?: unknown }).enrichment === "string")
	);
}

function recordValidationBounce(
	signature: string,
	toolName: string,
	enrichment: string,
	config: AgentLoopConfig,
	tracker: ToolValidationFailureTracker,
): ValidationFailureHandling {
	const episodeKey = `${toolName}\0${signature}`;
	const previous = tracker.get(episodeKey);
	const episode: ToolValidationFailureEpisode = {
		repeats: (previous?.repeats ?? 0) + 1,
		escalated: previous?.escalated ?? false,
	};
	tracker.delete(episodeKey);
	tracker.set(episodeKey, episode);
	while (tracker.size > MAX_TRACKED_VALIDATION_FAILURE_EPISODES) {
		const oldest = tracker.keys().next().value;
		if (oldest === undefined) break;
		tracker.delete(oldest);
	}

	const threshold = toolValidationEscalationThreshold(config);
	if (threshold <= 0 || episode.repeats < threshold || episode.escalated) {
		return { message: "" };
	}

	episode.escalated = true;
	config.onToolValidationEscalation?.({
		tool: toolName,
		signature,
		repeats: episode.repeats,
		model: config.model.id,
		provider: config.model.provider,
	});
	return {
		message: `Repeated validation failure (${episode.repeats} identical attempts).`,
		providerFeedback: enrichment,
	};
}

function handleValidationFailure(
	error: ToolArgumentValidationError,
	config: AgentLoopConfig,
	tracker: ToolValidationFailureTracker,
	parserDiagnostic?: string,
): ValidationFailureHandling {
	const enrichment = parserDiagnostic ? `${parserDiagnostic}\n\n${error.enrichment}` : error.enrichment;
	const handling = recordValidationBounce(error.signature, error.toolName, enrichment, config, tracker);
	return {
		message: handling.providerFeedback
			? `${error.message}\n\n${handling.message} Use this full schema and example before retrying:\n${handling.providerFeedback}`
			: error.message,
		...(handling.providerFeedback ? { providerFeedback: handling.providerFeedback } : {}),
	};
}

function truncateProviderValidationFeedback(value: string, maxChars: number): string {
	const sanitized = sanitizeBinaryOutput(value).trim();
	if (sanitized.length <= maxChars) return sanitized;
	let end = maxChars - 1;
	const code = sanitized.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end--;
	return `${sanitized.slice(0, end)}…`;
}

function parserDiagnosticFromRawArguments(toolCall: AgentToolCall): string | undefined {
	const rawArguments = toolCall.rawArguments;
	if (!rawArguments || typeof rawArguments !== "object" || Array.isArray(rawArguments)) return undefined;
	const candidate = rawArguments.parseDiagnostic;
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
	const detail = candidate as Record<string, unknown>;
	const kind = typeof detail.kind === "string" ? detail.kind : "malformed call";
	const offset =
		typeof detail.offset === "number" && Number.isFinite(detail.offset) ? ` at offset ${detail.offset}` : "";
	const context = typeof detail.context === "string" ? `: ${detail.context}` : "";
	return truncateProviderValidationFeedback(
		`Provider parse diagnostic (${kind}${offset})${context}`,
		MAX_PROVIDER_PARSE_DIAGNOSTIC_CHARS,
	);
}

function providerMalformedCallEnrichment(tool: AgentTool, parserDetail: string): string {
	return `${parserDetail}\n\n${formatToolValidationEnrichment(tool)}`;
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	validationFailureTracker: ToolValidationFailureTracker,
	toolFailureMemory: ToolFailureMemoryTracker,
	toolFailureRecoveryGate: ToolFailureRecoveryGate,
	signal: AbortSignal | undefined,
	requestId: AgentRequestId,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((candidate) => candidate.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
			phase: "validation",
			failureCode: "unknown_tool",
			correction: "Choose a tool from the currently available tool list.",
			validationEvent: createValidationBounceTelemetry(config, toolCall, "unknown_tool"),
		};
	}

	if (toolCall.errorMessage) {
		const parserDetail = truncateProviderValidationFeedback(
			toolCall.errorMessage,
			MAX_PROVIDER_PARSE_DIAGNOSTIC_CHARS,
		);
		const handling = recordValidationBounce(
			`malformed_call:${tool.name}:${parserDetail}`,
			tool.name,
			providerMalformedCallEnrichment(tool, parserDetail),
			config,
			validationFailureTracker,
		);
		return {
			kind: "immediate",
			result: createErrorToolResult(parserDetail),
			isError: true,
			phase: "validation",
			failureCode: "malformed_call",
			correction: "Resend one complete JSON argument object matching the current tool schema.",
			diagnostic: parserDetail,
			...(handling.providerFeedback ? { providerFeedback: handling.providerFeedback } : {}),
			validationEvent: createValidationBounceTelemetry(config, toolCall, "malformed_call"),
		};
	}

	let validationEvent: ToolArgumentValidationTelemetryEvent | undefined;
	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall, {
			model: config.model.id,
			provider: config.model.provider,
			repairEnabled: !isToolArgumentRepairEmergencyDisabled(),
			telemetry: (event) => {
				validationEvent = event;
			},
		});
		if (preparedToolCall.repairNotes) {
			toolCall.repairNotes = preparedToolCall.repairNotes;
		}
		if (validatedArgs !== toolCall.arguments) {
			toolCall.rawArguments ??= toolCall.arguments;
			toolCall.arguments = validatedArgs;
		}
		const unresolvedRecord = getUnresolvedToolFailure(toolFailureMemory, toolCall.name, validatedArgs);
		const admission = toolFailureRecoveryGate.admit(tool, validatedArgs, unresolvedRecord, currentContext.messages);
		if (admission.kind === "blocked") {
			const result = createRepeatedToolFailureResult(admission.record, admission.envelopeOnlyChange);
			const memoryRecord = result.details.piToolFailureMemory;
			toolFailureMemory.set(admission.record.failureKey, memoryRecord);
			return {
				kind: "immediate",
				result,
				isError: true,
				phase: admission.record.phase,
				failureCode: "repeated_failed_operation",
				correction: memoryRecord.correction,
				diagnostic: memoryRecord.diagnostic,
				repeatedToolFailure: true,
				validationEvent: createValidationBounceTelemetry(config, toolCall, "repeated_failed_operation"),
			};
		}
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					requestId,
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return createAbortedToolCallOutcome(validationEvent);
			}
			if (beforeResult?.block) {
				const reason = beforeResult.reason || "Tool execution was blocked";
				return {
					kind: "immediate",
					result: {
						...createErrorToolResult(reason),
						...(beforeResult.terminate !== undefined ? { terminate: beforeResult.terminate } : {}),
					},
					isError: true,
					phase: "policy",
					failureCode: "blocked",
					correction: "Choose an allowed approach or request the required authority before retrying.",
					diagnostic: reason,
					validationEvent,
				};
			}
		}
		if (signal?.aborted) {
			return createAbortedToolCallOutcome(validationEvent);
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
			validationEvent,
		};
	} catch (error) {
		const parserDiagnostic = parserDiagnosticFromRawArguments(toolCall);
		const validationFailure = isToolArgumentValidationError(error)
			? handleValidationFailure(error, config, validationFailureTracker, parserDiagnostic)
			: undefined;
		const message = validationFailure?.message ?? (error instanceof Error ? error.message : String(error));
		return {
			kind: "immediate",
			result: createErrorToolResult(message),
			isError: true,
			phase: isToolArgumentValidationError(error) ? "validation" : "preflight",
			failureCode: isToolArgumentValidationError(error) ? "invalid_arguments" : "preflight_error",
			correction: isToolArgumentValidationError(error)
				? [validationFailureCorrection(validationEvent, toolCall.name), parserDiagnostic]
						.filter((part): part is string => part !== undefined)
						.join(" ")
				: toolFailureCorrection(message, "rejected", "preflight"),
			diagnostic: isToolArgumentValidationError(error) ? undefined : message,
			...(validationFailure?.providerFeedback ? { providerFeedback: validationFailure.providerFeedback } : {}),
			validationEvent,
		};
	}
}

function finalizeRejectedToolCall(
	toolCall: AgentToolCall,
	tool: AgentTool<any> | undefined,
	outcome: ImmediateToolCallOutcome,
	tracker: ToolFailureMemoryTracker,
): FinalizedToolCallOutcome {
	if (outcome.repeatedToolFailure) {
		return {
			toolCall,
			result: outcome.result,
			isError: true,
		};
	}
	const record = rememberToolFailure(
		tracker,
		toolCall.name,
		toolCall.arguments,
		"rejected",
		outcome.failureCode,
		outcome.correction,
		outcome.diagnostic,
		outcome.phase,
		undefined,
		{
			output: outcome.result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n"),
		},
	);
	const failureResult = createToolFailureResult(record, outcome.result.terminate);
	const result = outcome.providerFeedback
		? {
				...failureResult,
				content: [...failureResult.content, { type: "text" as const, text: outcome.providerFeedback }],
			}
		: failureResult;
	return {
		toolCall,
		result: outcome.repeatedSuccessfulCall
			? {
					...result,
					details: {
						...result.details,
						piRepeatedSuccessfulCall: outcome.repeatedSuccessfulCall,
					},
				}
			: result,
		isError: true,
		executionGateEffect: {
			kind: "unproductive",
			...(tool ? { tool } : {}),
			record,
			args: toolCall.arguments,
		},
	};
}

type LinkedToolAbort = {
	signal: AbortSignal;
	detachForeground(): void;
	cancel(): void;
};

function createLinkedToolAbort(foregroundSignal: AbortSignal | undefined): LinkedToolAbort {
	const controller = new AbortController();
	const abortFromForeground = (): void => controller.abort(foregroundSignal?.reason);
	let linked = false;
	if (foregroundSignal?.aborted) {
		abortFromForeground();
	} else if (foregroundSignal) {
		foregroundSignal.addEventListener("abort", abortFromForeground, { once: true });
		linked = true;
	}
	return {
		signal: controller.signal,
		detachForeground: () => {
			if (!linked || !foregroundSignal) return;
			foregroundSignal.removeEventListener("abort", abortFromForeground);
			linked = false;
		},
		cancel: () => controller.abort(),
	};
}

function getBackgroundToolCallDelay(config: AgentLoopConfig): number | undefined {
	const delay = config.backgroundToolCallAfterMs;
	if (delay === undefined || !Number.isFinite(delay) || delay <= 0) return undefined;
	return delay;
}

async function executeAndFinalizePreparedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	requestId: AgentRequestId,
	config: AgentLoopConfig,
	repairTeachTracker: ToolRepairTeachTracker,
	toolFailureMemory: ToolFailureMemoryTracker,
	toolFailureRecoveryGate: ToolFailureRecoveryGate,
	foregroundSignal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<FinalizedToolCallOutcome> {
	const backgroundDelay = getBackgroundToolCallDelay(config);
	if (
		!config.handoffToolCall ||
		(backgroundDelay === undefined && config.subscribeToolCallHandoffRequest === undefined)
	) {
		const executed = await executePreparedToolCall(prepared, foregroundSignal, emit);
		return finalizeExecutedToolCall(
			currentContext,
			assistantMessage,
			prepared,
			requestId,
			executed,
			config,
			repairTeachTracker,
			toolFailureMemory,
			toolFailureRecoveryGate,
			foregroundSignal,
		);
	}

	const executionAbort = createLinkedToolAbort(foregroundSignal);
	const startedAt = Date.now();
	let emitForegroundUpdates = true;
	const completion = (async (): Promise<FinalizedToolCallOutcome> => {
		const executed = await executePreparedToolCall(prepared, executionAbort.signal, (event) => {
			if (emitForegroundUpdates) return emit(event);
		});
		const finalized = await finalizeExecutedToolCall(
			currentContext,
			assistantMessage,
			prepared,
			requestId,
			executed,
			config,
			repairTeachTracker,
			toolFailureMemory,
			toolFailureRecoveryGate,
			executionAbort.signal,
		);
		return finalized;
	})();
	completion.then(executionAbort.detachForeground, executionAbort.detachForeground);

	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const triggers: Array<Promise<{ kind: "deadline" | "manual" }>> = [];
	if (backgroundDelay !== undefined) {
		triggers.push(
			new Promise<{ kind: "deadline" }>((resolve) => {
				deadlineTimer = setTimeout(() => resolve({ kind: "deadline" }), backgroundDelay);
				(deadlineTimer as { unref?: () => void }).unref?.();
			}),
		);
	}
	let unsubscribeHandoffRequest: (() => void) | undefined;
	if (config.subscribeToolCallHandoffRequest) {
		const manual = new Promise<{ kind: "manual" }>((resolve) => {
			try {
				unsubscribeHandoffRequest = config.subscribeToolCallHandoffRequest?.(prepared.toolCall.id, () =>
					resolve({ kind: "manual" }),
				);
			} catch {
				unsubscribeHandoffRequest = undefined;
			}
		});
		triggers.push(manual);
	}
	let outcome: { kind: "completed"; value: FinalizedToolCallOutcome } | { kind: "deadline" | "manual" };
	try {
		outcome = await Promise.race([completion.then((value) => ({ kind: "completed" as const, value })), ...triggers]);
	} finally {
		if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
		unsubscribeHandoffRequest?.();
	}
	if (outcome.kind === "completed") return outcome.value;
	if (executionAbort.signal.aborted) return completion;

	let handoffAccepted = false;
	// A handed-off call leaves the batch, so the batch never applies its effect: the background
	// completion is the only place left that can tell the governor what this operation did.
	const handedOffCompletion = completion.then((finalized) => {
		if (handoffAccepted) toolFailureRecoveryGate.apply(finalized.executionGateEffect);
		return finalized;
	});
	void handedOffCompletion.catch(() => undefined);
	let handoff: ReturnType<NonNullable<AgentLoopConfig["handoffToolCall"]>>;
	try {
		handoff = config.handoffToolCall({
			requestId,
			assistantMessage,
			toolCall: prepared.toolCall,
			args: prepared.args,
			context: currentContext,
			elapsedMs: Math.max(0, Date.now() - startedAt),
			completion: handedOffCompletion,
			cancel: executionAbort.cancel,
		});
	} catch {
		return completion;
	}
	handoffAccepted = handoff !== undefined;
	if (!handoff) return completion;

	emitForegroundUpdates = false;
	executionAbort.detachForeground();
	return {
		toolCall: prepared.toolCall,
		result: handoff.result,
		isError: handoff.isError ?? handoff.result.isError === true,
		backgroundCompletion: handedOffCompletion,
	};
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		await Promise.all(updateEvents);
		return {
			result,
			// Tool definitions can report an expected operation failure without
			// throwing. Keep the returned result intact through afterToolCall so
			// policy hooks can inspect its bounded diagnostics and metadata.
			isError: result.isError === true,
			...(result.isError === true
				? { errorClass: "tool_result_error", errorKind: result.errorKind ?? "tool_failure" }
				: {}),
		};
	} catch (error) {
		await Promise.all(updateEvents);
		const message = error instanceof Error ? error.message : String(error);
		const toolFailure = error instanceof AgentToolExecutionError ? error : undefined;
		return {
			result: createErrorToolResult(message),
			isError: true,
			errorClass: error instanceof Error ? error.name : typeof error,
			failureMessage: message,
			errorKind: toolFailure?.errorKind ?? "tool_failure",
			...(toolFailure ? { failureCode: toolFailure.failureCode, outputSignature: toolFailure.outputSignature } : {}),
		};
	}
}

function repairTeachKey(toolName: string, note: string): string {
	const repairName = /^\[harness\] ([^:]+):/.exec(note)?.[1] ?? note;
	return `${toolName}\0${repairName}`;
}

function shouldEmitRepairTeachNote(toolName: string, note: string, tracker: ToolRepairTeachTracker): boolean {
	const key = repairTeachKey(toolName, note);
	const count = (tracker.get(key) ?? 0) + 1;
	tracker.set(key, count);
	return count === 1 || count % TOOL_REPAIR_TEACH_EVERY === 0;
}

function appendRepairTeachNotes(
	result: AgentToolResult<any>,
	toolCall: AgentToolCall,
	tracker: ToolRepairTeachTracker,
	config: AgentLoopConfig,
): { result: AgentToolResult<any>; taught: boolean } {
	if (config.toolArgumentTeachEnabled === false) return { result, taught: false };
	const notes = (toolCall.repairNotes ?? []).filter((note) => shouldEmitRepairTeachNote(toolCall.name, note, tracker));
	if (notes.length === 0) return { result, taught: false };
	return {
		result: {
			...result,
			content: [...result.content, { type: "text", text: notes.join("\n") }],
		},
		taught: true,
	};
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	requestId: AgentRequestId,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	repairTeachTracker: ToolRepairTeachTracker,
	toolFailureMemory: ToolFailureMemoryTracker,
	toolFailureRecoveryGate: ToolFailureRecoveryGate,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;
	let failureMessage = executed.failureMessage ?? "";
	let errorClass = executed.errorClass;
	let failureCode = executed.failureCode;
	let outputSignature = executed.outputSignature;
	let errorKind = executed.errorKind;
	let executionGateEffect: ToolFailureRecoveryGateEffect | undefined;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					requestId,
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				result = {
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			// The hook itself failed, so nothing about the tool's own completed operation survives.
			failureMessage = error instanceof Error ? error.message : String(error);
			errorClass = error instanceof Error ? error.name : typeof error;
			failureCode = undefined;
			outputSignature = undefined;
			errorKind = "tool_failure";
			result = { ...createErrorToolResult(failureMessage), usage: result.usage };
			isError = true;
		}
	}

	const verificationDetails = retainedVerificationDetails(result.details);
	if (isError) {
		const usage = result.usage;
		const failureOutput =
			failureMessage ||
			result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n") ||
			"Tool execution failed";
		const effectiveFailureMessage =
			failureMessage || result.content.find((block) => block.type === "text")?.text || "Tool execution failed";
		const assessment = assessToolFailure(effectiveFailureMessage, "failed", errorClass);
		const effectiveFailureCode = failureCode ?? assessment.failureCode;
		if (errorKind === "operation_outcome") {
			// The tool ran the operation to completion; the non-zero status is the observation the
			// agent asked for. Nothing here is a mistake, so no failure record is remembered and the
			// tool's own output stands exactly as written. The governor still notes that repeating
			// this identical operation cannot say anything new until something else changes.
			clearToolFailure(toolFailureMemory, prepared.toolCall.name, prepared.args);
			result = { ...result, errorKind: "operation_outcome", usage };
			executionGateEffect = {
				kind: "unproductive",
				tool: prepared.tool,
				record: describeOperationOutcome(
					prepared.toolCall.name,
					prepared.args,
					effectiveFailureCode,
					assessment.diagnostic,
				),
				args: prepared.args,
			};
		} else {
			const recoveryPlan = toolFailureRecoveryGate.planFailure(
				prepared.tool,
				prepared.args,
				{ failureCode: effectiveFailureCode, message: effectiveFailureMessage },
				currentContext.tools ?? [],
			);
			const correction = assessment.policyGuidance
				? `${assessment.policyGuidance} ${recoveryPlan.guidance}`
				: recoveryPlan.guidance;
			const record = rememberToolFailure(
				toolFailureMemory,
				prepared.toolCall.name,
				prepared.args,
				"failed",
				effectiveFailureCode,
				correction,
				assessment.diagnostic,
				assessment.phase,
				recoveryPlan.evidence ?? assessment.evidence,
				{ output: failureOutput, outputSignature },
			);
			executionGateEffect = {
				kind: "unproductive",
				tool: prepared.tool,
				record,
				args: prepared.args,
			};
			result = { ...createToolFailureResult(record, result.terminate), usage };
		}
	} else {
		clearToolFailure(toolFailureMemory, prepared.toolCall.name, prepared.args);
		if (!executed.isError) {
			executionGateEffect = {
				kind: "success",
				tool: prepared.tool,
				args: prepared.args,
			};
		}
	}

	const repaired = appendRepairTeachNotes(result, prepared.toolCall, repairTeachTracker, config);
	const resultWithVerification = {
		...repaired.result,
		details: verificationDetails ? { ...repaired.result.details, ...verificationDetails } : repaired.result.details,
	};
	emitToolArgumentValidationTelemetry(
		config,
		prepared.validationEvent,
		isError ? "failed" : "succeeded",
		repaired.taught ? "note" : "none",
	);

	return {
		toolCall: prepared.toolCall,
		result: resultWithVerification,
		isError,
		executionGateEffect,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionStart(toolCall: AgentToolCall, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
		repair: getToolCallRepairInfo(toolCall),
	});
}

export function getToolCallRepairInfo(toolCall: AgentToolCall): ToolCallRepairInfo | undefined {
	if (!toolCall.rawArguments && !toolCall.repairNotes?.length) return undefined;
	return {
		repaired: true,
		...(toolCall.rawArguments ? { rawArguments: toolCall.rawArguments } : {}),
		...(toolCall.repairNotes?.length ? { notes: toolCall.repairNotes } : {}),
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
		repair: getToolCallRepairInfo(finalized.toolCall),
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: finalized.result.content,
		details: finalized.result.details,
		usage: finalized.result.usage,
		isError: finalized.isError,
		// Persisted so a reloaded transcript still separates a completed operation's own status from a
		// tool that could not run at all.
		...(finalized.isError && finalized.result.errorKind ? { errorKind: finalized.result.errorKind } : {}),
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
