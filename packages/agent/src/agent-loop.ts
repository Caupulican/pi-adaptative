/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import { EventStream } from "@caupulican/pi-ai/event-stream";
import { streamSimple } from "@caupulican/pi-ai/stream";
import {
	formatToolRepairStandingRule,
	REPEATED_SUCCESSFUL_TOOL_CALL_FAILURE,
	type ToolFailurePhase,
} from "@caupulican/pi-ai/tool-repair-registry";
import type { AssistantMessage, Context, ToolResultMessage } from "@caupulican/pi-ai/types";
import {
	type ToolArgumentExecutionOutcome,
	ToolArgumentValidationError,
	type ToolArgumentValidationTelemetryEvent,
	validateToolArguments,
} from "@caupulican/pi-ai/validation";
import {
	assessToolFailure,
	clearToolFailure,
	createToolFailureMemoryTracker,
	createToolFailureResult,
	normalizeToolSignature,
	rememberToolFailure,
	sanitizeToolFailureContext,
	type ToolFailureMemoryTracker,
	toolFailureCorrection,
} from "./tool-failure-memory.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	BackgroundToolCallCompletion,
	RequestPreflightContext,
	RequestPreflightResult,
	StreamFn,
	ToolCallRepairInfo,
} from "./types.ts";
import { DEFAULT_MAX_STALL_TURNS } from "./types.ts";
import { createEmptyUsage } from "./usage.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

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
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	assertContinuableContext(context);

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context, messages: [...context.messages] };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
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

/**
 * How many `stallLimit`-length periods the runaway-loop window spans. A window of `stallLimit * P`
 * turns lets the count-based detector catch oscillating cycles of period up to `P` (each signature in a
 * period-k cycle recurs ~window/k times), not just back-to-back repeats. Beyond this the cycle is loose
 * enough that it's indistinguishable from legitimate varied work, so we don't chase it.
 */
const STALL_WINDOW_PERIODS = 4;

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
 * Apply one request-local preflight without mutating persistent loop configuration.
 * Shared with isolated tool-free provider calls so every transport boundary has identical
 * validation and non-widening semantics.
 */
export async function resolveRequestPreflightMaxTokens(options: {
	requestPreflight?: (
		context: RequestPreflightContext,
		signal?: AbortSignal,
	) => RequestPreflightResult | undefined | Promise<RequestPreflightResult | undefined>;
	model: RequestPreflightContext["model"];
	context: RequestPreflightContext["context"];
	maxTokens?: number;
	signal?: AbortSignal;
}): Promise<number | undefined> {
	if (!options.requestPreflight) return options.maxTokens;
	if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) {
		throw new TypeError("request maxTokens must be a positive safe integer");
	}
	const preflight = await options.requestPreflight(
		{ model: options.model, context: options.context, maxTokens: options.maxTokens },
		options.signal,
	);
	if (preflight?.maxTokens === undefined) return options.maxTokens;
	if (!Number.isSafeInteger(preflight.maxTokens) || preflight.maxTokens <= 0) {
		throw new TypeError("requestPreflight.maxTokens must be a positive safe integer");
	}
	const ceilings = [preflight.maxTokens];
	if (options.maxTokens !== undefined) ceilings.push(options.maxTokens);
	if (Number.isSafeInteger(options.model.maxTokens) && options.model.maxTokens > 0) {
		ceilings.push(options.model.maxTokens);
	}
	return Math.min(...ceilings);
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
	const stallWindow: string[] = [];
	const validationFailureTracker: ToolValidationFailureTracker = { repeats: 0 };
	const repairTeachTracker: ToolRepairTeachTracker = new Map();
	let toolFailureMemory = createToolFailureMemoryTracker(currentContext.messages);
	let lastSuccessfulTextProtocolBatch: SuccessfulTextProtocolBatch | undefined;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				lastSuccessfulTextProtocolBatch = undefined;
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
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
					config,
					validationFailureTracker,
					repairTeachTracker,
					toolFailureMemory,
					previousSuccessfulTextProtocolResults,
					signal,
					emit,
				);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
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

			await emit({ type: "turn_end", message, toolResults });

			// Runaway-loop backstop (cost guard): detect a model stuck repeating one action.
			if (stallLimit > 0 && toolCalls.length > 0) {
				const signature = normalizeToolSignature(toolCalls.map((c) => [c.name, c.arguments ?? null]));
				stallWindow.push(signature);
				if (stallWindow.length > stallLimit * STALL_WINDOW_PERIODS) stallWindow.shift();
				const repeats = stallWindow.reduce((n, s) => (s === signature ? n + 1 : n), 0);
				if (repeats >= stallLimit) {
					config.onRunawayStop?.({ signature, repeats });
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
					toolFailureMemory = createToolFailureMemoryTracker(currentContext.messages);
				}
				config = {
					...config,
					model: nextTurnSnapshot.model ?? config.model,
					reasoning: nextTurnSnapshot.thinkingLevel ?? config.reasoning,
				};
			}

			if (
				await config.shouldStopAfterTurn?.({
					message,
					toolResults,
					context: currentContext,
					newMessages,
				})
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
	// Failed protocol turns never reach host transforms or provider conversion. Their bounded,
	// unresolved state is carried separately in the system prompt until the same operation succeeds.
	const sanitized = sanitizeToolFailureContext(context.messages, context.systemPrompt);
	let messages = sanitized.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}
	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: sanitized.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	const requestMaxTokens = await resolveRequestPreflightMaxTokens({
		requestPreflight: config.requestPreflight,
		model: config.model,
		context: llmContext,
		maxTokens: config.maxTokens,
		signal,
	});
	// Resolve credentials only after the request-local authority/budget gate accepts the request.
	// This prevents an already-exhausted background lane from refreshing OAuth/SSO credentials.
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;
	const requestReasoning = config.resolveRequestReasoning
		? config.resolveRequestReasoning(config.reasoning, {
				model: config.model,
				context: llmContext,
				maxTokens: requestMaxTokens,
			})
		: config.reasoning;

	return await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		maxTokens: requestMaxTokens,
		reasoning: requestReasoning,
		signal,
	});
}

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
): Promise<AssistantMessage> {
	const response = await startAgentProviderRequest(context, config, signal, streamFn);

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
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
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	validationFailureTracker: ToolValidationFailureTracker,
	repairTeachTracker: ToolRepairTeachTracker,
	toolFailureMemory: ToolFailureMemoryTracker,
	previousSuccessfulTextProtocolResults: readonly ToolResultMessage[] | undefined,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(
			currentContext,
			assistantMessage,
			toolCalls,
			config,
			validationFailureTracker,
			repairTeachTracker,
			toolFailureMemory,
			previousSuccessfulTextProtocolResults,
			signal,
			emit,
		);
	}
	return executeToolCallsParallel(
		currentContext,
		assistantMessage,
		toolCalls,
		config,
		validationFailureTracker,
		repairTeachTracker,
		toolFailureMemory,
		previousSuccessfulTextProtocolResults,
		signal,
		emit,
	);
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
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	index: number,
	config: AgentLoopConfig,
	validationFailureTracker: ToolValidationFailureTracker,
	toolFailureMemory: ToolFailureMemoryTracker,
	previousSuccessfulTextProtocolResults: readonly ToolResultMessage[] | undefined,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<StartedToolCall> {
	const preparation = previousSuccessfulTextProtocolResults
		? createRepeatedSuccessfulToolCallOutcome(previousSuccessfulTextProtocolResults[index])
		: await prepareToolCall(currentContext, assistantMessage, toolCall, config, validationFailureTracker, signal);
	await emitToolExecutionStart(toolCall, emit);
	if (preparation.kind === "immediate") {
		emitToolArgumentValidationTelemetry(config, preparation.validationEvent, "not_run", "none");
		return { kind: "finalized", finalized: finalizeRejectedToolCall(toolCall, preparation, toolFailureMemory) };
	}
	return { kind: "prepared", preparation };
}

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	validationFailureTracker: ToolValidationFailureTracker,
	repairTeachTracker: ToolRepairTeachTracker,
	toolFailureMemory: ToolFailureMemoryTracker,
	previousSuccessfulTextProtocolResults: readonly ToolResultMessage[] | undefined,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const [index, toolCall] of toolCalls.entries()) {
		const started = await prepareAndStartToolCall(
			currentContext,
			assistantMessage,
			toolCall,
			index,
			config,
			validationFailureTracker,
			toolFailureMemory,
			previousSuccessfulTextProtocolResults,
			signal,
			emit,
		);
		let finalized: FinalizedToolCallOutcome;
		if (started.kind === "finalized") {
			finalized = started.finalized;
		} else {
			finalized = await executeAndFinalizePreparedToolCall(
				currentContext,
				assistantMessage,
				started.preparation,
				config,
				repairTeachTracker,
				toolFailureMemory,
				signal,
				emit,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	validationFailureTracker: ToolValidationFailureTracker,
	repairTeachTracker: ToolRepairTeachTracker,
	toolFailureMemory: ToolFailureMemoryTracker,
	previousSuccessfulTextProtocolResults: readonly ToolResultMessage[] | undefined,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const [index, toolCall] of toolCalls.entries()) {
		const started = await prepareAndStartToolCall(
			currentContext,
			assistantMessage,
			toolCall,
			index,
			config,
			validationFailureTracker,
			toolFailureMemory,
			previousSuccessfulTextProtocolResults,
			signal,
			emit,
		);
		if (started.kind === "finalized") {
			await emitToolExecutionEnd(started.finalized, emit);
			finalizedCalls.push(started.finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			const finalized = await executeAndFinalizePreparedToolCall(
				currentContext,
				assistantMessage,
				started.preparation,
				config,
				repairTeachTracker,
				toolFailureMemory,
				signal,
				emit,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
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
	repeatedSuccessfulCall?: { previousToolCallId: string };
	validationEvent?: ToolArgumentValidationTelemetryEvent;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
	errorClass?: string;
	failureMessage?: string;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

type ToolValidationFailureTracker = {
	signature?: string;
	repeats: number;
	escalatedSignature?: string;
};

type ToolRepairTeachTracker = Map<string, number>;

const DEFAULT_TOOL_VALIDATION_ESCALATION_THRESHOLD = 3;
const TOOL_REPAIR_TEACH_EVERY = 5;
const REPEATED_SUCCESS_RESULT_MAX_CHARS = 2_048;

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
	tracker.signature = undefined;
	tracker.repeats = 0;
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

function handleValidationFailure(
	error: ToolArgumentValidationError,
	config: AgentLoopConfig,
	tracker: ToolValidationFailureTracker,
): string {
	if (tracker.signature === error.signature) {
		tracker.repeats++;
	} else {
		tracker.signature = error.signature;
		tracker.repeats = 1;
		tracker.escalatedSignature = undefined;
	}

	const threshold = toolValidationEscalationThreshold(config);
	if (threshold <= 0 || tracker.repeats < threshold || tracker.escalatedSignature === error.signature) {
		return error.message;
	}

	tracker.escalatedSignature = error.signature;
	config.onToolValidationEscalation?.({
		tool: error.toolName,
		signature: error.signature,
		repeats: tracker.repeats,
		model: config.model.id,
		provider: config.model.provider,
	});
	return `${error.message}\n\nRepeated validation failure (${tracker.repeats} identical attempts). Use this full schema and example before retrying:\n${error.enrichment}`;
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	validationFailureTracker: ToolValidationFailureTracker,
	signal: AbortSignal | undefined,
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
		return {
			kind: "immediate",
			result: createErrorToolResult(toolCall.errorMessage),
			isError: true,
			phase: "validation",
			failureCode: "malformed_call",
			correction: "Resend one complete JSON argument object matching the current tool schema.",
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
		resetValidationFailureTracker(validationFailureTracker);
		if (preparedToolCall.repairNotes) {
			toolCall.repairNotes = preparedToolCall.repairNotes;
		}
		if (validatedArgs !== toolCall.arguments) {
			toolCall.rawArguments ??= toolCall.arguments;
			toolCall.arguments = validatedArgs;
		}
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
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
			if (beforeResult?.block) {
				const reason = beforeResult.reason || "Tool execution was blocked";
				return {
					kind: "immediate",
					result: createErrorToolResult(reason),
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
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
			validationEvent,
		};
	} catch (error) {
		const message = isToolArgumentValidationError(error)
			? handleValidationFailure(error, config, validationFailureTracker)
			: error instanceof Error
				? error.message
				: String(error);
		return {
			kind: "immediate",
			result: createErrorToolResult(message),
			isError: true,
			phase: isToolArgumentValidationError(error) ? "validation" : "preflight",
			failureCode: isToolArgumentValidationError(error) ? "invalid_arguments" : "preflight_error",
			correction: isToolArgumentValidationError(error)
				? validationFailureCorrection(validationEvent, toolCall.name)
				: toolFailureCorrection(message, "rejected", "preflight"),
			diagnostic: isToolArgumentValidationError(error) ? undefined : message,
			validationEvent,
		};
	}
}

function finalizeRejectedToolCall(
	toolCall: AgentToolCall,
	outcome: ImmediateToolCallOutcome,
	tracker: ToolFailureMemoryTracker,
): FinalizedToolCallOutcome {
	const record = rememberToolFailure(
		tracker,
		toolCall.name,
		toolCall.arguments,
		"rejected",
		outcome.failureCode,
		outcome.correction,
		outcome.diagnostic,
		outcome.phase,
	);
	const failureResult = createToolFailureResult(record, outcome.result.terminate);
	return {
		toolCall,
		result: outcome.repeatedSuccessfulCall
			? {
					...failureResult,
					details: {
						...failureResult.details,
						piRepeatedSuccessfulCall: outcome.repeatedSuccessfulCall,
					},
				}
			: failureResult,
		isError: true,
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
	config: AgentLoopConfig,
	repairTeachTracker: ToolRepairTeachTracker,
	toolFailureMemory: ToolFailureMemoryTracker,
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
			executed,
			config,
			repairTeachTracker,
			toolFailureMemory,
			foregroundSignal,
		);
	}

	const executionAbort = createLinkedToolAbort(foregroundSignal);
	const startedAt = Date.now();
	let emitForegroundUpdates = true;
	const completion: Promise<BackgroundToolCallCompletion> = (async () => {
		const executed = await executePreparedToolCall(prepared, executionAbort.signal, (event) => {
			if (emitForegroundUpdates) return emit(event);
		});
		return finalizeExecutedToolCall(
			currentContext,
			assistantMessage,
			prepared,
			executed,
			config,
			repairTeachTracker,
			toolFailureMemory,
			executionAbort.signal,
		);
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
	let outcome: { kind: "completed"; value: BackgroundToolCallCompletion } | { kind: "deadline" | "manual" };
	try {
		outcome = await Promise.race([completion.then((value) => ({ kind: "completed" as const, value })), ...triggers]);
	} finally {
		if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
		unsubscribeHandoffRequest?.();
	}
	if (outcome.kind === "completed") return outcome.value;
	if (executionAbort.signal.aborted) return completion;

	let handoff: ReturnType<NonNullable<AgentLoopConfig["handoffToolCall"]>>;
	try {
		handoff = config.handoffToolCall({
			assistantMessage,
			toolCall: prepared.toolCall,
			args: prepared.args,
			context: currentContext,
			elapsedMs: Math.max(0, Date.now() - startedAt),
			completion,
			cancel: executionAbort.cancel,
		});
	} catch {
		return completion;
	}
	if (!handoff) return completion;

	emitForegroundUpdates = false;
	executionAbort.detachForeground();
	return {
		toolCall: prepared.toolCall,
		result: handoff.result,
		isError: handoff.isError ?? handoff.result.isError === true,
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
			...(result.isError === true ? { errorClass: "tool_result_error" } : {}),
		};
	} catch (error) {
		await Promise.all(updateEvents);
		const message = error instanceof Error ? error.message : String(error);
		return {
			result: createErrorToolResult(message),
			isError: true,
			errorClass: error instanceof Error ? error.name : typeof error,
			failureMessage: message,
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
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	repairTeachTracker: ToolRepairTeachTracker,
	toolFailureMemory: ToolFailureMemoryTracker,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;
	let failureMessage = executed.failureMessage ?? "";
	let errorClass = executed.errorClass;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
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
			failureMessage = error instanceof Error ? error.message : String(error);
			errorClass = error instanceof Error ? error.name : typeof error;
			result = { ...createErrorToolResult(failureMessage), usage: result.usage };
			isError = true;
		}
	}

	if (isError) {
		const usage = result.usage;
		const effectiveFailureMessage =
			failureMessage || result.content.find((block) => block.type === "text")?.text || "Tool execution failed";
		const assessment = assessToolFailure(effectiveFailureMessage, "failed", errorClass);
		const record = rememberToolFailure(
			toolFailureMemory,
			prepared.toolCall.name,
			prepared.args,
			"failed",
			assessment.failureCode,
			assessment.guidance,
			assessment.diagnostic,
			assessment.phase,
		);
		result = { ...createToolFailureResult(record, result.terminate), usage };
	} else {
		clearToolFailure(toolFailureMemory, prepared.toolCall.name, prepared.args);
	}

	const repaired = isError
		? { result, taught: false }
		: appendRepairTeachNotes(result, prepared.toolCall, repairTeachTracker, config);
	emitToolArgumentValidationTelemetry(
		config,
		prepared.validationEvent,
		isError ? "failed" : "succeeded",
		repaired.taught ? "note" : "none",
	);

	return {
		toolCall: prepared.toolCall,
		result: repaired.result,
		isError,
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
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
