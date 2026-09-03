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
	ToolErrorKind,
	ToolResultMessage,
	Usage,
} from "@caupulican/pi-ai";
import type { Static, TSchema } from "typebox";
import type { ToolFailureContextMemory } from "./tool-failure-memory.ts";

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
 * D1 observability (turn-economics remediation): stream-timing fields agent-core stamps onto the
 * FINAL assistant message of one provider request (see `streamAssistantResponse` in
 * agent-loop.ts), never onto a host-synthesized message that never touched a provider stream.
 *
 * Declaration merging, not an edit to `@caupulican/pi-ai` (agent-core does not own that package):
 * these fields become part of `AssistantMessage` everywhere it is imported from - including
 * `packages/coding-agent`, which persists assistant messages verbatim into the session log - with
 * zero code changes required there. Mirrors, in the opposite direction, how `messages.ts` merges
 * new shapes into this package's own `CustomAgentMessages`.
 *
 * Both fields are optional so every existing construction of an AssistantMessage stays valid.
 */
declare module "@caupulican/pi-ai/types" {
	interface AssistantMessage {
		/**
		 * Epoch milliseconds when the first event carrying actual generated content arrived: a
		 * `text_delta`, `thinking_delta`, or `toolcall_delta` stream event specifically - never a
		 * `_start`/`_end` framing event, which can arrive with no new bytes yet. This is the metric's
		 * definition; picking a different event type changes what "first token" means.
		 *
		 * Absent, never `0` or a copy of `streamEndAt`, when the stream never produced one - an
		 * immediate error, or an abort before any content streamed.
		 */
		firstTokenAt?: number;
		/**
		 * Epoch milliseconds when the provider stream was exhausted - its `done` or `error` terminal
		 * event was observed - independent of when this message was later transformed or persisted.
		 */
		streamEndAt?: number;
	}
}

declare const AGENT_REQUEST_ID: unique symbol;

/** Opaque identity shared by one accepted provider request and its tool executions. */
export type AgentRequestId = string & { readonly [AGENT_REQUEST_ID]: true };

/**
 * Holder for TWO DELIBERATELY DIFFERENT "already sent to the provider" high-water marks (see
 * `provider-request-planner.ts`). A plain `WeakMap` keyed by config object identity loses either
 * the instant the agent loop clones `config` for a per-turn model/reasoning change - `agent-loop.ts`
 * replaces `config` with a new object whenever `prepareNextTurn` returns a snapshot, which a host
 * may do on every turn. Threading one shared holder object through every clone
 * (`{...config, providerRequestPrefixState}` copies the reference, never the value) keeps both
 * marks alive across those clones.
 *
 * DO NOT COLLAPSE THESE INTO ONE VALUE. Each protects a different consumer against a different
 * failure mode, and each consumer needs a different reset lifetime; unifying them recreates
 * whichever defect the unified value's reset behavior doesn't fit:
 *
 * - `sanitizerSentPrefixCount` is SESSION-scoped: it persists across every top-level prompt for the
 *   life of the owning `Agent` instance, and only ever grows (see `Agent.resetSanitizerPrefixHorizon`
 *   for the one case it must drop back to zero). It confines `sanitizeToolFailureContext`'s
 *   duplicate-erasure to history the provider has genuinely never seen. The provider's own prompt
 *   cache is keyed by SESSION id, not by top-level prompt (`prompt_cache_key`,
 *   `openai-codex-responses.ts`), so nothing about a new user prompt makes previously-sent bytes
 *   un-sent - rewriting bytes the provider has already been sent is never acceptable, at any point
 *   in a session. Making this run-scoped (resetting it every prompt, like `sentPrefixCount` below)
 *   re-arms the exact defect the "already sent" mark exists to prevent, once per user turn instead
 *   of once per process - measured live, this was silently happening on every prompt after the
 *   first in an ordinary multi-turn conversation.
 *
 * - `sentPrefixCount` is RUN-scoped: it resets every top-level prompt (unchanged from its original
 *   behavior). It is the pack-freeze horizon handed to a host through
 *   `AgentContextPlanRequest.sentPrefixCount`, which a context-GC packer uses to decide what it must
 *   not rewrite. A host's packing legitimately must rewrite old, already-sent content eventually -
 *   you cannot both pack a message and keep it provider-cached, so the correct policy is to
 *   invalidate rarely and in large strides, not never. Measured: within one long run this mark
 *   outgrows the packer's `recentStart` (which trails the transcript by a constant
 *   `preserveRecentMessages`), so packing goes to zero for the rest of that run - survivable only
 *   because this mark resets each prompt and packing resumes. Making this session-scoped (matching
 *   `sanitizerSentPrefixCount` above) would freeze packing PERMANENTLY within a session: context
 *   grows without bound and compaction fires more often, trading the cache defect above for a much
 *   more expensive unbounded-context defect.
 *
 * Whoever reads this next will be tempted to "simplify" it into one field. Resist that: it is
 * cheaper to keep two clearly-named numbers than to re-debug either defect this split prevents.
 */
export interface ProviderRequestPrefixState {
	/**
	 * RUN-scoped pack-freeze horizon (resets every top-level prompt). Feeds
	 * `AgentContextPlanRequest.sentPrefixCount` and the disturbance detector in
	 * `provider-request-planner.ts` - both validate a host's context-GC packing against exactly this
	 * value, so it must keep resetting per prompt for packing to ever resume. See the interface
	 * doc comment above before changing this field's lifetime.
	 */
	sentPrefixCount: number;
	/**
	 * SESSION-scoped sanitizer horizon (persists across prompts; see the interface doc comment
	 * above). Feeds `sanitizeToolFailureContext`'s duplicate-erasure clamp only - never the host-
	 * facing `AgentContextPlanRequest.sentPrefixCount`.
	 */
	sanitizerSentPrefixCount: number;
	/**
	 * SESSION-scoped like `sanitizerSentPrefixCount`, and reset with it: the sanitizer's record of
	 * every call it has erased plus its resumable fold state (see `ToolFailureContextMemory`).
	 * Threaded here so it survives the per-turn config clones the same way the marks do.
	 */
	sanitizerMemory?: ToolFailureContextMemory;
}

/**
 * Configuration for how tool calls from a single assistant message are executed.
 *
 * - "sequential": each tool call is prepared, executed, and finalized before the next one starts.
 * - "parallel": calls are partitioned in source order into parallel groups separated by
 *   sequential barriers. Each parallel group runs through a width-bounded pool, where new calls
 *   start as slots free up; `tool_execution_end` follows actual completion order while persisted
 *   tool-result artifacts remain in source order.
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
	terminate?: boolean;
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
	/** Opaque identity of the accepted provider request that produced this call. */
	requestId?: AgentRequestId;
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
	/** Opaque identity of the accepted provider request that produced this call. */
	requestId?: AgentRequestId;
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

/** Context passed to the durable tool-start reservation boundary. */
export interface ToolCallStartContext extends BeforeToolCallContext {
	/** Accepted provider request identity is mandatory at the durable reservation boundary. */
	requestId: AgentRequestId;
	/** Stable tool-call identity within the assistant message. */
	callId: string;
	/** Tool registry name used for this call. */
	toolName: string;
}

/**
 * Reserve one or more prepared tool calls before their side effects begin.
 *
 * Sequential execution invokes this once with one prepared call. Parallel execution invokes it
 * once with the complete prepared wave, so a host can atomically persist the wave reservation before
 * any body starts. Immediate validation, policy, and replay outcomes are never offered here.
 */
export type ToolCallStartHook = (calls: readonly ToolCallStartContext[], signal?: AbortSignal) => void | Promise<void>;

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

export type AgentRunawayStopReason = "stagnant_tool_cycle" | "repeated_tool_call" | "provider_turn_limit";

/** Semantic cause and evidence for a host-enforced runaway/cost stop. */
export interface AgentRunawayStopInfo {
	reason: AgentRunawayStopReason;
	signature: string;
	repeats: number;
	/** The failing call's diagnostic when the stop came from one call failing identically. */
	detail?: string;
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
	/**
	 * How many leading messages of `sourceContext.messages` - the durable history for this admission
	 * attempt, indexed BEFORE `sanitizeToolFailureContext` ran and before this plan's `messages`
	 * above - have already gone out on a previous accepted provider request in this run.
	 *
	 * Contract a host-supplied `planContext` must honor: messages below this index have already been
	 * sent to the provider and must never be rewritten, reordered, or removed - a compaction/GC pass
	 * may only ever append after this index, or leave the prefix below it untouched. Rewriting
	 * anything below it invalidates the provider's cached prefix for the whole conversation from that
	 * point on.
	 *
	 * Always a valid index into `sourceContext.messages` for the CURRENT admission attempt (clamped
	 * to its length, so it can never exceed the message count it indexes into) and monotonically
	 * non-decreasing across a run. It is also a valid index into this request's `messages` above for
	 * the prefix the two arrays share: the sanitizer that produces `messages` from
	 * `sourceContext.messages` never erases anything below this same mark, so their first
	 * `sentPrefixCount` entries are identical. `0` means nothing has been sent yet.
	 */
	sentPrefixCount: number;
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

/**
 * Evidence that a host-owned `planContext`/`transformContext` result rewrote, reordered, or removed
 * a message the planner had already marked as sent to the provider (see
 * `AgentContextPlanRequest.sentPrefixCount`). See `AgentLoopConfig.onSentPrefixDisturbance`.
 */
export interface SentPrefixDisturbanceInfo {
	/** How many messages at or above index 0 and below `sentPrefixCount` were disturbed. */
	disturbedCount: number;
	/** Zero-based index, into the plan's own input `messages`, of the first disturbed message. */
	firstDisturbedIndex: number;
	/** The `sentPrefixCount` this admission attempt was computed against. */
	sentPrefixCount: number;
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

/** Exact accepted provider request offered to the host-owned durable lifecycle boundary. */
export interface ProviderRequestSnapshotContext extends ProviderRequestAdmissionContext {
	/** Opaque identity generated only after final plan validation and adoption. */
	requestId: AgentRequestId;
	/** Request-local reasoning value that will be sent to transport. */
	reasoning: SimpleStreamOptions["reasoning"];
	/** Zero-based admission generation for the accepted plan. */
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
/**
 * One tool call failing with the same failure key this many times ends the run, whatever else the
 * model mixes into the same turns. The batch-level stall fuse above never fired on the measured
 * case (28 identical failing calls in 22 minutes, each riding a batch whose other calls varied,
 * each result text carrying a new occurrence count) while the failure ledger counted every one.
 */
export const DEFAULT_MAX_REPEATED_FAILURES = 6;
/** Provider-turn fuse is opt-in; varied productive work has no implicit request-count ceiling. */
export const DEFAULT_MAX_PROVIDER_TURNS = 0;

export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;

	/**
	 * Run-scoped storage for the provider-request prefix high-water mark; see
	 * {@link ProviderRequestPrefixState}. The agent loop creates and injects this once per run and
	 * carries it forward across every internal config clone. Direct one-shot callers (e.g.
	 * `startAgentProviderRequest`, or a test that never goes through `agentLoop`) normally omit it -
	 * a single request has no prior sent prefix, and a fallback keyed by config identity supplies
	 * the correct default of "nothing sent yet". Hosts driving the loop should leave this unset and
	 * let the loop manage it.
	 */
	providerRequestPrefixState?: ProviderRequestPrefixState;

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
	 * Observability hook fired when the `messages` returned by `planContext` OR `transformContext`
	 * rewrites, reorders, or removes a message at or below `sentPrefixCount` (see
	 * `AgentContextPlanRequest.sentPrefixCount`) - i.e. the host's own transform violated the
	 * contract it was handed. Detection only: never blocks, replans, or otherwise changes the
	 * request: the planner sends whatever the host returned either way. Fires on every admission
	 * attempt that disturbs the prefix, including ones later discarded as stale, so a host sees the
	 * full extent of what its own transform did.
	 *
	 * This host's own compaction never fires it - but NOT because compaction respects the boundary
	 * this hook scans. Compaction summarizes the OLDEST messages, which sit at or below
	 * `sentPrefixCount` (everything already sent starts from the beginning of the conversation); a
	 * compaction pass running INSIDE `planContext`/`transformContext` would trip this on essentially
	 * every pass. It stays silent only because compaction does not run there at all: it runs through
	 * `admitProviderRequest` returning `{action: "replan"}`, entirely outside the two functions this
	 * hook observes. The loop then re-enters with the new, shorter `sourceContext`, and
	 * `sentPrefixCount` is re-clamped against that shorter array before this comparison ever runs
	 * again - compaction sits on the OTHER SIDE of the boundary this hook scans, not inside it,
	 * obeying it. If compaction is ever moved inside the plan path, this hook WILL fire on it; the
	 * fix then is to re-clamp the mark before scanning, not to weaken this hook. Must not throw.
	 */
	onSentPrefixDisturbance?: (info: SentPrefixDisturbanceInfo) => void;

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
	 * Persist or otherwise reserve the accepted provider request before transport begins.
	 *
	 * This runs after final plan validation, plan commit, and source-context adoption. It is awaited;
	 * throwing prevents the provider stream from being created and leaves the accepted plan committed.
	 */
	onProviderRequestSnapshot?: (context: ProviderRequestSnapshotContext, signal?: AbortSignal) => void | Promise<void>;

	/**
	 * Internal wiring seam, not a host extension point: the agent loop creates and injects this once
	 * per run, the same way it injects {@link providerRequestPrefixState}, and a host driving the loop
	 * should leave it unset. `provider-request-planner.ts` calls it with exactly the transient records
	 * (see `transient-records.ts`) it just folded into durable history for this request - the loop's
	 * own implementation turns each into a `message_start`/`message_end` pair on its `emit` sink, the
	 * same pairing `pendingMessages`/steering messages use, so a host's existing message persistence
	 * (whatever already keeps its own transcript in sync with `message_end`) picks them up without new
	 * host-side code.
	 *
	 * Why this exists: `provider-request-planner.ts` folding a record into `sourceContext.messages`
	 * (and, via `adoptReplannedMessages`, into the caller's own array) keeps it alive for the rest of
	 * THIS `agentLoop` run, but a host that rebuilds its own context snapshot between turns (see
	 * `PrepareNextTurnContext`) reconstructs from ITS OWN persisted transcript, not from this package's
	 * internal array - a record this package committed but never emitted is invisible to that
	 * rebuild and silently vanishes at the next turn boundary. Emitting it is what makes the commit
	 * reach the host's transcript at all.
	 *
	 * A direct one-shot caller that never goes through `agentLoop` (e.g.
	 * `startPlannedAgentProviderRequest` called on its own) leaves this unset; the planner's call is
	 * optional-chained, so a committed record simply isn't announced anywhere outside its own return
	 * value - correct for a caller with no ongoing event stream for a host to listen to in the first
	 * place.
	 */
	onTransientRecordsCommitted?: (records: AgentMessage[]) => void | Promise<void>;

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
	 * Per-call repeated-failure guard: a failure key whose ledger occurrence reaches this count
	 * stops the run with `repeated_tool_call`. Defaults to {@link DEFAULT_MAX_REPEATED_FAILURES};
	 * hosts follow the model's capability tier. Zero disables it.
	 */
	maxRepeatedFailures?: number;

	/**
	 * Optional provider-request fuse for one logical prompt, including host continuations.
	 * Unlike {@link maxStallTurns}, this also catches varied tool churn that never repeats an exact
	 * signature. The loop stops before another provider request without fabricating an assistant
	 * message. Positive values explicitly enable the fuse; `0` disables it. Default:
	 * {@link DEFAULT_MAX_PROVIDER_TURNS}.
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
	 * - "parallel": partition an assistant message's tool calls into an order-preserving sequence
	 *   of groups - a lone `executionMode: "sequential"` call closes the current group and becomes
	 *   its own barrier group (reserved and run alone, exactly like the sequential mode above);
	 *   every other call accumulates into a parallel group run through a width-bounded pool (see
	 *   `toolConcurrency`). Groups run in original emission order, so a sequential call no longer
	 *   poisons unrelated calls into serial execution. Within a pooled group, `tool_execution_end`
	 *   fires at each call's actual completion (not replayed at a wave boundary); the recovery gate
	 *   still applies effects in original emission order (a fast sibling's success and a slow
	 *   sibling's failure must not race), catching up as soon as the next call in line is ready.
	 *   Tool-result message artifacts are likewise emitted in assistant source order once their
	 *   group settles.
	 *
	 * Default: "parallel"
	 */
	toolExecution?: ToolExecutionMode;

	/**
	 * Pool width for "parallel" mode's parallel groups (see `toolExecution`): the maximum number
	 * of prepared calls dispatched at once within one group. Slots are refilled as they free, so a
	 * new call can start as soon as any one finishes rather than waiting for a fixed-size wave to
	 * fully settle. Overridden by the `PI_TOOL_CONCURRENCY` env var only when its complete trimmed
	 * value is a decimal safe integer in 1-16; `PI_TOOL_PARALLELISM_DISABLED` bypasses partitioning
	 * and pooling entirely (every batch runs through the legacy sequential branch) and takes
	 * precedence over both. This field is
	 * validated to an integer in 1-16; an out-of-range or non-integer value is ignored.
	 *
	 * Default: 4
	 */
	toolConcurrency?: number;

	/** Disable in-band tool repair teaching notes. Default: enabled. */
	toolArgumentTeachEnabled?: boolean;
	/**
	 * How much of the tool-failure protocol rides each request's ledger record. "full" (default)
	 * repeats the protocol text in every active ledger; "pointer" sends one line that points at the
	 * protocol block a host placed once in the stable system prompt. The readmission gate and the
	 * ledger resolution enforce the protocol either way; the prose only tells the model where to
	 * read it. Measured live, the full text cost about 600 characters per active record per request.
	 */
	toolFailureProtocolProse?: "full" | "pointer";
	/**
	 * Whether argument repair is on for this run. The loop resolves it once at run start from the
	 * `PI_TOOL_REPAIR_DISABLED` emergency switch and hosts never set it: reading the environment on
	 * every validated call was a visible row of the per-turn profile for a two-microsecond answer.
	 */
	toolArgumentRepairEnabled?: boolean;

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

	/** Reserve prepared tool calls before execution. See {@link ToolCallStartHook}. */
	onToolCallStart?: ToolCallStartHook;

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

/**
 * Why an errored tool result is an error. These are different events and the harness treats them differently.
 *
 * `tool_failure` — the tool could not perform the operation at all: rejected arguments, denied
 * authority, a timeout, a crash. The operation never happened, the harness owns the diagnostic it
 * shows the model, and it replaces the result with a bounded failure record.
 *
 * `operation_outcome` — the tool performed the operation completely and is reporting the
 * operation's own negative status: a process exit code, a search that matched nothing, a predicate
 * that answered false. Nothing failed; this is the observation the agent asked for. The harness
 * leaves the tool's own output exactly as returned and never rewrites it into a failure record.
 *
 * Both are unproductive to repeat while nothing else has changed, so both are observed by the
 * repetition governor in {@link "./tool-failure-recovery-gate.ts"}. Neither may ever end a run.
 */
export type AgentToolErrorKind = ToolErrorKind;

/**
 * Structured execution failure emitted by a tool when recovery identity must not depend on rendered diagnostics.
 *
 * `failureCode` identifies the tool-owned terminal outcome. `outputSignature` identifies the complete raw
 * operation output, including bytes omitted from bounded model-facing previews. `errorKind` says whether the
 * tool failed or completed and reported a negative operation status; it defaults to `tool_failure` so a tool
 * that has not classified itself is never mistaken for a completed operation.
 */
export class AgentToolExecutionError extends Error {
	readonly failureCode: string;
	readonly outputSignature: string;
	readonly errorKind: AgentToolErrorKind;

	constructor(
		message: string,
		failureCode: string,
		outputSignature: string,
		errorKind: AgentToolErrorKind = "tool_failure",
	) {
		super(message);
		this.name = "AgentToolExecutionError";
		this.failureCode = failureCode;
		this.outputSignature = outputSignature;
		this.errorKind = errorKind;
	}
}

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
	/**
	 * Classifies an errored result. Defaults to `tool_failure`; set `operation_outcome` when the tool
	 * ran the operation to completion and `isError` only reports the operation's own negative status.
	 */
	errorKind?: AgentToolErrorKind;
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
 * Actions are teaching only: they name the corrective work that makes a retry worth attempting. They
 * do not grant execution budget — admission is governed solely by whether anything has succeeded
 * since the operation last ran (see `ToolFailureRecoveryGate`).
 *
 * A `correct` action teaches a materially changed operation. A `repair` action teaches corrective
 * work on the state the failed operation depends on, after which the same operation is worth rerunning.
 */
export type AgentToolFailureRecoveryAction = {
	kind: "correct" | "repair";
	authority: AgentToolFailureRecoveryAuthority;
	targetKind: string;
	instruction: string;
};

/** Tool-owned failure targets and recovery actions. Undeclared behavior has no recovery authority. */
export interface AgentToolFailureRecoveryContract<TParameters extends TSchema> {
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
	actions?: readonly AgentToolFailureRecoveryAction[];
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
	failureRecovery?: AgentToolFailureRecoveryContract<TParameters>;
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
	/**
	 * Request-local instruction delivered at the same trailing transient position the failure
	 * ledger uses (see `provider-request-planner.ts`), never composed into `systemPrompt`. Content
	 * placed here can change turn to turn - e.g. verification obligations appearing and resolving -
	 * without invalidating the provider's cached prefix, because it never sits at byte zero of the
	 * request.
	 */
	trailingInstruction?: string;
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
