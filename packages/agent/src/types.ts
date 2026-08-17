import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	streamSimple,
	TextContent,
	Tool,
	ToolArgumentValidationTelemetryEvent,
	ToolResultMessage,
	Usage,
} from "@caupulican/pi-ai";
import type { Static, TSchema } from "typebox";

/**
 * Stream function used by the agent loop.
 *
 * Contract:
 * - Must not throw or return a rejected promise for request/model/runtime failures.
 * - Must return an AssistantMessageEventStream.
 * - Failures must be encoded in the returned stream via protocol events and a
 *   final AssistantMessage with stopReason "error" or "aborted" and errorMessage.
 */
export type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;

/**
 * Configuration for how tool calls from a single assistant message are executed.
 *
 * - "sequential": each tool call is prepared, executed, and finalized before the next one starts.
 * - "parallel": tool calls are prepared and executed in bounded concurrent accounting waves.
 *   Each wave updates failure-recovery state before later calls launch. `tool_execution_end` is
 *   emitted in completion order within each wave, while tool-result artifacts remain in source order.
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * Controls how many queued user messages are injected when the agent loop reaches a queue drain point.
 *
 * - "all": drain and inject every queued message at that point.
 * - "one-at-a-time": drain and inject only the oldest queued message, leaving the rest queued for later drain points.
 */
export type QueueMode = "all" | "one-at-a-time";

/** A single tool call content block emitted by an assistant message. */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * Result returned from `beforeToolCall`.
 *
 * Returning `{ block: true }` prevents the tool from executing. The loop emits an error tool result instead.
 * `reason` becomes the text shown in that error result. If omitted, a default blocked message is used.
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

/**
 * Partial override returned from `afterToolCall`.
 *
 * Merge semantics are field-by-field:
 * - `content`: if provided, replaces the tool result content array in full
 * - `details`: if provided, replaces the tool result details value in full
 * - `usage`: if provided, replaces provider usage reported by the tool
 * - `isError`: if provided, replaces the tool result error flag
 * - `terminate`: if provided, replaces the early-termination hint
 *
 * Omitted fields keep the original executed tool result values.
 * There is no deep merge for `content` or `details`.
 */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	usage?: Usage;
	isError?: boolean;
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

/** Context passed to `beforeToolCall`. */
export interface BeforeToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments for the target tool schema. */
	args: unknown;
	/** Current agent context at the time the tool call is prepared. */
	context: AgentContext;
}

/** Context passed to `afterToolCall`. */
export interface AfterToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments for the target tool schema. */
	args: unknown;
	/** The executed tool result before any `afterToolCall` overrides are applied. */
	result: AgentToolResult<any>;
	/** Whether the executed tool result is currently treated as an error. */
	isError: boolean;
	/** Current agent context at the time the tool call is finalized. */
	context: AgentContext;
}

/** Policy-finalized result of a tool call that outlived its foreground turn. */
export interface BackgroundToolCallCompletion {
	/** Original tool call identity. */
	toolCall: AgentToolCall;
	/** Result after the normal `afterToolCall` policy boundary has run. */
	result: AgentToolResult<any>;
	/** Final error classification after policy overrides. */
	isError: boolean;
}

/** Context offered to a host when a prepared tool call crosses its foreground latency budget. */
export interface BackgroundToolCallContext extends BeforeToolCallContext {
	/** Configured foreground latency budget that elapsed. */
	elapsedMs: number;
	/** Event-driven terminal signal for the real, policy-finalized execution. */
	completion: Promise<BackgroundToolCallCompletion>;
	/** Abort only this detached execution. */
	cancel(): void;
}

/** Immediate foreground result returned when the host accepts ownership of a slow tool call. */
export interface BackgroundToolCallHandoff {
	/** Bounded result telling the model how to address the session-owned task. */
	result: AgentToolResult<any>;
	/** Optional foreground error classification. Defaults to `result.isError === true`. */
	isError?: boolean;
}

/** Context passed to `shouldStopAfterTurn`. */
export interface ShouldStopAfterTurnContext {
	/** The assistant message that completed the turn. */
	message: AssistantMessage;
	/** Tool result messages passed to the preceding `turn_end` event. */
	toolResults: ToolResultMessage[];
	/** Current agent context after the turn's assistant message and tool results have been appended. */
	context: AgentContext;
	/** Messages that this loop invocation will return if it exits at this point. Prompt runs include the initial prompt messages; continuation runs do not include pre-existing context messages. */
	newMessages: AgentMessage[];
}

/** Replacement runtime state used by the agent loop before starting another provider request. */
export interface AgentLoopTurnUpdate {
	/** Context for the next provider request. */
	context?: AgentContext;
	/** Model for the next provider request. */
	model?: Model<any>;
	/** Thinking level for the next provider request. */
	thinkingLevel?: ThinkingLevel;
}

export type AgentRunawayStopReason = "repeated_tool_call" | "provider_turn_limit";

/** Semantic cause and evidence for a host-enforced runaway/cost stop. */
export interface AgentRunawayStopInfo {
	reason: AgentRunawayStopReason;
	signature: string;
	repeats: number;
}

export interface ToolValidationEscalationEvent {
	tool: string;
	signature: string;
	repeats: number;
	model: string;
	provider: string;
}

export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}

/** Input for one replay-safe context-planning attempt. */
export interface AgentContextPlanRequest {
	/** Sanitized durable history used as the compactable portion of this request. */
	messages: AgentMessage[];
	/** Zero-based admission generation; freshness-only retries repeat the same value. */
	attempt: number;
}

/**
 * Replay-safe context plan. `messages` is compactable history. `transientMessages` and
 * `transientSystemPrompt` are mandatory request-local context that compaction must never summarize
 * or drop.
 */
export interface AgentContextPlan {
	messages: AgentMessage[];
	transientMessages?: AgentMessage[];
	/** Host-owned instructions appended to the system channel for this request only. */
	transientSystemPrompt?: string;
	/** Cheap freshness check immediately before admission/commit. */
	isCurrent?: () => boolean;
	/**
	 * Pure final validation for expensive projections. Return false to discard and replan; do not
	 * mutate durable state here.
	 */
	prepareCommit?: () => boolean;
	/**
	 * Apply lifecycle side effects after every composed validator passed. Synchronous, infallible by
	 * contract, and must not change the planned payload.
	 */
	commit?: () => void;
	/** Release request-local planning resources when a plan is not accepted. */
	discard?: () => void;
}

/** Provider-ready request inspected after full materialization and immediately before transport. */
export interface RequestPreflightContext {
	model: Model<Api>;
	context: Context;
	/** Current owner-selected output cap before request-local narrowing. */
	maxTokens?: number;
}

/** Request-local limits. A returned output cap can only narrow the current owner/model limit. */
export interface RequestPreflightResult {
	maxTokens?: number;
}

/** Exact materialization offered to the host-owned compaction/admission gate. */
export interface ProviderRequestAdmissionContext extends RequestPreflightContext {
	/** Agent-level request snapshot from which this materialization was planned. */
	sourceContext: AgentContext;
	/** Provider context containing only the non-compactable system/tool/transient envelope. */
	nonCompactableContext: Context;
	/** Zero-based admission generation; increments only after an accepted history replan. */
	attempt: number;
}

export type ProviderRequestAdmissionResult =
	| { action: "send"; maxTokens?: number }
	| { action: "replan"; context: AgentContext };

/**
 * Default runaway-loop backstop: a single identical tool-call signature recurring this many times
 * within a sliding window (4×) stops the loop. Generous enough that legitimate long/varied work never
 * trips it, but bounds the cost of a model wedged repeating one failing call forever.
 */
export const DEFAULT_MAX_STALL_TURNS = 12;
/** Provider-turn fuse is opt-in; varied productive work has no implicit request-count ceiling. */
export const DEFAULT_MAX_PROVIDER_TURNS = 0;

export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;

	/**
	 * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
	 *
	 * Each AgentMessage must be converted to a UserMessage, AssistantMessage, or ToolResultMessage
	 * that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
	 * status messages) should be filtered out.
	 *
	 * Contract: must not throw or reject. Return a safe fallback value instead.
	 * Throwing interrupts the low-level agent loop without producing a normal event sequence.
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // Convert custom message to user message
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // Filter out UI-only messages
	 *     return [];
	 *   }
	 *   // Pass through standard LLM messages
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * Optional transform applied to the context before `convertToLlm`.
	 *
	 * Use this for operations that work at the AgentMessage level:
	 * - Context window management (pruning old messages)
	 * - Injecting context from external sources
	 *
	 * Contract: must not throw or reject. Return the original messages or another
	 * safe fallback value instead.
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * Preferred two-phase replacement for `transformContext`. Planning is replay-safe and may run
	 * again after compaction or invalidation; only the accepted plan's `commit` is invoked.
	 */
	planContext?: (request: AgentContextPlanRequest, signal?: AbortSignal) => Promise<AgentContextPlan>;

	/**
	 * Host-owned admission gate over the complete provider-visible materialization. It may accept the
	 * request or compact durable history and return a replacement source context for replanning.
	 */
	admitProviderRequest?: (
		request: ProviderRequestAdmissionContext,
		signal?: AbortSignal,
	) => ProviderRequestAdmissionResult | Promise<ProviderRequestAdmissionResult>;

	/**
	 * Runs after admission against the exact transport-ready context, immediately before every provider request.
	 *
	 * Use this for request-local budget/authority checks whose state can change between tool turns.
	 * Throwing prevents transport. A returned `maxTokens` must be a positive safe integer and can
	 * only narrow the current owner/model output limit; it never mutates the persistent loop config.
	 */
	requestPreflight?: (
		context: RequestPreflightContext,
		signal?: AbortSignal,
	) => RequestPreflightResult | undefined | Promise<RequestPreflightResult | undefined>;

	/**
	 * Resolve the reasoning effort after context transformation and immediately before the provider
	 * request. This supports request-local policy decisions that must not mutate persisted agent state.
	 */
	resolveRequestReasoning?: (
		reasoning: SimpleStreamOptions["reasoning"],
		request: { model: Model<Api>; context: Context; maxTokens?: number },
	) => SimpleStreamOptions["reasoning"];

	/**
	 * Resolves an API key dynamically for each LLM call.
	 *
	 * Useful for short-lived OAuth tokens (e.g., GitHub Copilot) that may expire
	 * during long-running tool execution phases.
	 *
	 * Contract: must not throw or reject. Return undefined when no key is available.
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * Called after each turn fully completes and `turn_end` has been emitted.
	 *
	 * If it returns true, the loop emits `agent_end` and exits before polling steering or follow-up queues,
	 * without starting another LLM call. The current assistant response and any tool executions finish normally.
	 *
	 * Use this to request a graceful stop after the current turn, e.g. before context gets too full.
	 *
	 * Contract: must not throw or reject. Throwing interrupts the low-level agent loop without producing a normal event sequence.
	 */
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;

	/**
	 * Runaway-loop backstop. A model stuck repeating the SAME tool call (identical name + arguments) —
	 * because a tool keeps erroring, or it is confused/oscillating — makes no progress yet keeps
	 * consuming tokens indefinitely (history grows every turn). This bounds that cost: if one tool-call
	 * signature recurs at least this many times within a sliding window (4×), the loop stops gracefully
	 * (emits `agent_end`). It counts ONLY turns that issued tool calls and keys on exact name+arguments,
	 * so legitimate long or varied agentic work never trips it. `0` disables the backstop.
	 * Default: {@link DEFAULT_MAX_STALL_TURNS}.
	 */
	maxStallTurns?: number;

	/**
	 * Optional provider-request fuse for one logical prompt, including host continuations.
	 * Unlike {@link maxStallTurns}, this also catches varied tool churn that never repeats an exact
	 * signature. The loop emits a local terminal diagnostic before another provider request. Positive
	 * values explicitly enable the fuse; `0` disables it. Default: {@link DEFAULT_MAX_PROVIDER_TURNS}.
	 */
	maxProviderTurns?: number;

	/**
	 * Observability hook fired once if either the repeated-call backstop or explicit provider-turn fuse trips,
	 * just before the loop stops. Lets the host surface/log the exact cause. Must not throw.
	 */
	onRunawayStop?: (info: AgentRunawayStopInfo) => void;

	/**
	 * Called after `turn_end` and before the loop decides whether another provider request should start.
	 * Return replacement context/model/thinking state to affect the next turn in this run.
	 * Return undefined to keep using the current context/config.
	 */
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

	/**
	 * Returns steering messages to inject into the conversation mid-run.
	 *
	 * Called after the current assistant turn finishes executing its tool calls, unless `shouldStopAfterTurn` exits first.
	 * If messages are returned, they are added to the context before the next LLM call.
	 * Tool calls from the current assistant message are not skipped.
	 *
	 * Use this for "steering" the agent while it's working.
	 *
	 * Contract: must not throw or reject. Return [] when no steering messages are available.
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Returns follow-up messages to process after the agent would otherwise stop.
	 *
	 * Called when the agent has no more tool calls and no steering messages.
	 * If messages are returned, they're added to the context and the agent
	 * continues with another turn.
	 *
	 * Use this for follow-up messages that should wait until the agent finishes.
	 *
	 * Contract: must not throw or reject. Return [] when no follow-up messages are available.
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Tool execution mode.
	 * - "sequential": execute tool calls one by one
	 * - "parallel": preflight and execute tool calls in bounded concurrent accounting waves;
	 *   update recovery state between waves, emit `tool_execution_end` in completion order within
	 *   each wave, then emit tool-result message artifacts in assistant source order
	 *
	 * Default: "parallel"
	 */
	toolExecution?: ToolExecutionMode;

	/** Disable in-band tool repair teaching notes. Default: enabled. */
	toolArgumentTeachEnabled?: boolean;

	/**
	 * Observe tool argument validation outcomes. Events contain only shape metadata
	 * (outcome, model/provider/tool, failure modes, repairs) and never argument values.
	 */
	onToolArgumentValidation?: (event: ToolArgumentValidationTelemetryEvent) => void;

	/**
	 * Number of consecutive identical validation bounces before adding full schema/example feedback
	 * and notifying the host. Set to 0 to disable. Default: 3.
	 */
	toolValidationEscalationThreshold?: number;

	/**
	 * Fired when a repeated identical tool validation failure reaches the escalation threshold.
	 * Hosts with model routers can use this signal to move the next turn off a cheap route.
	 */
	onToolValidationEscalation?: (event: ToolValidationEscalationEvent) => void;

	/**
	 * Called before a tool is executed, after arguments have been validated.
	 *
	 * Return `{ block: true }` to prevent execution. The loop emits an error tool result instead.
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * Called after a tool finishes executing, before `tool_execution_end` and tool-result message events are emitted.
	 *
	 * Return an `AfterToolCallResult` to override parts of the executed tool result:
	 * - `content` replaces the full content array
	 * - `details` replaces the full details payload
	 * - `isError` replaces the error flag
	 * - `terminate` replaces the early-termination hint
	 *
	 * Any omitted fields keep their original values. No deep merge is performed.
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;

	/**
	 * Foreground latency budget for prepared tool calls. When it elapses, `handoffToolCall` may
	 * transfer the still-running execution to a host-owned task. Disabled unless both fields exist.
	 */
	backgroundToolCallAfterMs?: number;

	/**
	 * Synchronously accept ownership of a slow call. Returning a handoff lets the provider loop
	 * continue with its bounded placeholder while `completion` still crosses `afterToolCall` once.
	 * Returning `undefined` keeps waiting in the foreground.
	 */
	handoffToolCall?: (context: BackgroundToolCallContext) => BackgroundToolCallHandoff | undefined;

	/**
	 * Register a one-shot host request that asks an in-flight foreground call to cross the same
	 * `handoffToolCall` boundary before its automatic latency budget elapses.
	 */
	subscribeToolCallHandoffRequest?: (toolCallId: string, request: () => void) => () => void;
}

/**
 * Thinking/reasoning level for models that support it.
 * Note: "xhigh", "max", and "ultra" are only supported by selected model families. "ultra" maps
 * to the model's maximum provider effort. Delegation policy is provider- and reasoning-independent.
 * Use model thinking-level metadata from @caupulican/pi-ai to detect support for a concrete model.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// Empty by default - apps extend via declaration merging
}

/**
 * AgentMessage: Union of LLM messages + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * Public agent state.
 *
 * `tools` and `messages` use accessor properties so implementations can copy
 * assigned arrays before storing them.
 */
export interface AgentState {
	/** System prompt sent with each model request. */
	systemPrompt: string;
	/** Active model used for future turns. */
	model: Model<any>;
	/** Requested reasoning level for future turns. */
	thinkingLevel: ThinkingLevel;
	/** Available tools. Assigning a new array copies the top-level array. */
	set tools(tools: AgentTool<any>[]);
	get tools(): AgentTool<any>[];
	/** Conversation transcript. Assigning a new array copies the top-level array. */
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	/**
	 * True while the agent is processing a prompt or continuation.
	 *
	 * This remains true until awaited `agent_end` listeners settle.
	 */
	readonly isStreaming: boolean;
	/** Partial assistant message for the current streamed response, if any. */
	readonly streamingMessage?: AgentMessage;
	/** Tool call ids currently executing. */
	readonly pendingToolCalls: ReadonlySet<string>;
	/** Error message from the most recent failed or aborted assistant turn, if any. */
	readonly errorMessage?: string;
}

/** Provenance marker for messages synthesized by the host instead of a provider transport. */
export type AgentMessageOrigin = "local";

/** Final or partial result produced by a tool. */
export interface AgentToolResult<T> {
	/** Text or image content returned to the model. */
	content: (TextContent | ImageContent)[];
	/** Arbitrary structured details for logs or UI rendering. */
	details: T;
	/**
	 * Marks a completed execution as a failure without throwing.
	 *
	 * The agent loop preserves the result long enough for `afterToolCall` to
	 * inspect it, then converts the bounded diagnostic into its durable failure
	 * record. Throwing remains valid for exceptional execution failures.
	 */
	isError?: boolean;
	/** Provider usage spent inside this tool, for durable budget and cost accounting. */
	usage?: Usage;
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

/** Callback used by tools to stream partial execution updates. */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

const AGENT_TOOL_FAILURE_RECOVERY_AUTHORITY = Symbol("AgentToolFailureRecoveryAuthority");

/** Opaque identity shared only by tool instances that act on the same authoritative backend. */
export interface AgentToolFailureRecoveryAuthority {
	readonly [AGENT_TOOL_FAILURE_RECOVERY_AUTHORITY]: true;
}

/** Create an unforgeable, process-local recovery authority for intentionally cooperating tools. */
export function createAgentToolFailureRecoveryAuthority(): AgentToolFailureRecoveryAuthority {
	return Object.freeze({ [AGENT_TOOL_FAILURE_RECOVERY_AUTHORITY]: true as const });
}

/** Validate recovery authority values supplied by tool-owned contracts. */
export function isAgentToolFailureRecoveryAuthority(value: unknown): value is AgentToolFailureRecoveryAuthority {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(value as { [AGENT_TOOL_FAILURE_RECOVERY_AUTHORITY]?: unknown })[AGENT_TOOL_FAILURE_RECOVERY_AUTHORITY] === true
	);
}

/** Exact, opaque state requirement shared only by tools that intentionally cooperate on recovery. */
export interface AgentToolFailureRecoveryTarget {
	/** Backend identity; equality is object identity and the harness never serializes it. */
	authority: AgentToolFailureRecoveryAuthority;
	/** Stable semantic namespace owned by the declaring tools. The harness never interprets it. */
	kind: string;
	/** Exact resource/state identity within `kind`. The harness compares it byte-for-byte. */
	scope: string;
}

/** Bounded failure identity supplied to a failed tool's recovery contract. */
export interface AgentToolFailureRecoveryContext {
	failureCode: string;
}

/** Ephemeral live failure context available only while tool-owned evidence is projected. */
export interface AgentToolFailureEvidenceContext extends AgentToolFailureRecoveryContext {
	message: string;
}

/**
 * One action a tool can actually perform for a declared failure target.
 *
 * A `correct` action teaches a materially changed operation and never unlocks an unchanged retry.
 * A `repair` action must emit exact evidence after success; only that evidence may unlock one probe.
 */
export type AgentToolFailureRecoveryAction<TParameters extends TSchema, TDetails> =
	| {
			kind: "correct";
			authority: AgentToolFailureRecoveryAuthority;
			targetKind: string;
			instruction: string;
	  }
	| {
			kind: "repair";
			authority: AgentToolFailureRecoveryAuthority;
			targetKind: string;
			instruction: string;
			getEvidence: (params: Static<TParameters>, result: AgentToolResult<TDetails>) => readonly string[];
	  };

/** Tool-owned failure targets and recovery actions. Undeclared behavior has no recovery authority. */
export interface AgentToolFailureRecoveryContract<TParameters extends TSchema, TDetails> {
	/** Keep exhaustion local to this operation when another operation can still correct it. Defaults to run. */
	exhaustionScope?: "operation" | "run";
	/** Derive exact recovery requirements from validated arguments and a classified failure. */
	getFailureTargets?: (
		params: Static<TParameters>,
		failure: AgentToolFailureRecoveryContext,
	) => readonly AgentToolFailureRecoveryTarget[];
	/**
	 * Return tool-owned evidence needed to construct a changed operation. The harness sanitizes and
	 * caps this text before exposing it beside the normalized failure record.
	 */
	getFailureEvidence?: (params: Static<TParameters>, failure: AgentToolFailureEvidenceContext) => string | undefined;
	/** Actions this tool can perform when it is present in the active tool surface. */
	actions?: readonly AgentToolFailureRecoveryAction<TParameters, TDetails>[];
}

/** Tool definition used by the agent runtime. */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	/** Human-readable label for UI display. */
	label: string;
	/** Compact provider-facing capability description. Execution keeps the full `description`. */
	providerDescription?: string;
	/**
	 * Optional compatibility shim for raw tool-call arguments before schema validation.
	 * Must return an object that matches `TParameters`.
	 */
	prepareArguments?: (args: unknown) => Static<TParameters>;
	/** Explicit failure-recovery authority; the agent loop never infers recovery from argument text. */
	failureRecovery?: AgentToolFailureRecoveryContract<TParameters, TDetails>;
	/**
	 * Execute the tool call. Throw for exceptional execution failures, or return
	 * `{ isError: true }` with bounded diagnostic content for an expected
	 * operation failure such as a non-zero subprocess exit.
	 */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	/**
	 * Per-tool execution mode override.
	 * - "sequential": this tool must execute one at a time with other tool calls.
	 * - "parallel": this tool can execute concurrently with other tool calls.
	 *
	 * If omitted, the default execution mode applies.
	 */
	executionMode?: ToolExecutionMode;
}

/** Context snapshot passed into the low-level agent loop. */
export interface AgentContext {
	/** System prompt included with the request. */
	systemPrompt: string;
	/** Transcript visible to the model. */
	messages: AgentMessage[];
	/** Tools available for this run. */
	tools?: AgentTool<any>[];
}

/**
 * Events emitted by the Agent for UI updates.
 *
 * `agent_end` is the last event emitted for a run, but awaited `Agent.subscribe()`
 * listeners for that event are still part of run settlement. The agent becomes
 * idle only after those listeners finish.
 */
export interface ToolCallRepairInfo {
	repaired: true;
	rawArguments?: Record<string, unknown>;
	notes?: string[];
}

export type AgentEvent =
	// Agent lifecycle
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// Message lifecycle - emitted for user, assistant, and toolResult messages
	| { type: "message_start"; message: AgentMessage; origin?: AgentMessageOrigin }
	// Only emitted for assistant messages during streaming
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage; origin?: AgentMessageOrigin }
	// Tool execution lifecycle
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any; repair?: ToolCallRepairInfo }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: any;
			partialResult: any;
			repair?: ToolCallRepairInfo;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: any;
			isError: boolean;
			repair?: ToolCallRepairInfo;
	  };
