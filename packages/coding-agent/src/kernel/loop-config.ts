import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	ToolArgumentValidationTelemetryEvent,
	ToolResultMessage,
	Usage,
} from "@caupulican/pi-ai";
import type { ExecutionContext, ExecutionPathAuthority } from "./execution-context.ts";
import type { ToolFailureContextMemory } from "./tool-failure-memory.ts";
import type {
	AgentMessage,
	AgentRequestId,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	ThinkingLevel,
	ToolExecutionMode,
} from "./types.ts";

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
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

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
 * - `sentPrefixCount` is SESSION-scoped as well (since 2026-09-03; it used to reset every top-level
 *   prompt). It is the pack-freeze horizon handed to a host through
 *   `AgentContextPlanRequest.sentPrefixCount`, which a context-GC packer uses to decide what it must
 *   not rewrite. A host's packing legitimately must rewrite old, already-sent content eventually -
 *   you cannot both pack a message and keep it provider-cached, so the correct policy is to
 *   invalidate rarely and in large strides, not never. Measured: within one long run this mark
 *   outgrows the packer's `recentStart` (which trails the transcript by a constant
 *   `preserveRecentMessages`), so a packer that treats the mark as absolute packs nothing for the
 *   rest of that run; while the mark reset per prompt, every run start then repacked the whole
 *   previous run at once - measured live as the prompt halving and the head cache miss on every
 *   user, reflection and continuation turn. The stride is therefore the host's: the coding-agent
 *   packer offers below-mark rewrites only at the grid crossings of its quantized recent boundary
 *   (`context/prefix-stability.ts`), whatever the run boundaries, as one batch it packs only when
 *   the saving pays for the cache break, and keeps a message it already packed in its packed form
 *   while frozen. A host that treats this mark as an absolute freeze
 *   would grow context without bound; a host that ignores it rewrites history every turn.
 *
 * Whoever reads this next will be tempted to "simplify" it into one field. Resist that: it is
 * cheaper to keep two clearly-named numbers than to re-debug either defect this split prevents.
 */
export interface ProviderRequestPrefixState {
	/**
	 * SESSION-scoped pack-freeze horizon (carried across top-level prompts like the sanitizer mark).
	 * Feeds `AgentContextPlanRequest.sentPrefixCount` and the disturbance detector in
	 * `provider-request-planner.ts`; the host's packer decides where below it a batched rewrite may
	 * land (priced batches at grid crossings only). See the interface doc comment above before
	 * changing this field's lifetime.
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
 * Executor-owned `details.piVerification` is retained independently: hooks cannot create, replace,
 * mutate, or erase the verification witness, even when the hook throws.
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
	/**
	 * Transfer synchronous cleanup to this invocation's preparation owner. It runs on rejection or
	 * abandonment, or after real finalization (including detached work), even if the hook later throws.
	 * Registration after release runs cleanup immediately. Cleanup must be synchronous, infallible
	 * and idempotent; it never represents an execution outcome.
	 */
	registerCleanup?(cleanup: () => void): void;
	/** Immutable host binding captured before policy admission; absent for context-free tools. */
	executionContext?: ExecutionContext;
	/** Live backend filesystem capabilities for an executing backend; not serialized to journal data. */
	pathAuthority?: ExecutionPathAuthority;
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
	/** The same binding used at admission, retained through detached completion. */
	executionContext?: ExecutionContext;
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
export type BackgroundToolCallTrigger = "requested" | "clock" | "manual";

export interface BackgroundToolCallContext extends BeforeToolCallContext {
	/**
	 * What moved the call: the model asked for a background task up front (`requested`), the
	 * operator's latency clock elapsed (`clock`), or the host asked by hand (`manual`).
	 */
	trigger: BackgroundToolCallTrigger;
	/** Foreground time spent before the handoff (about zero for a requested one). */
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
	/** 0-based position of this call in its assistant message's tool calls. */
	index: number;
	/**
	 * True when this call's tool declared a `mutationTarget` for these arguments. A host that
	 * sequences file mutations against exclusive runs needs the flag at reservation time, before any
	 * body in the wave starts, and gets it here rather than looking the tool up in its own registry.
	 */
	mutation: boolean;
}

/**
 * Live resources held by a successful tool-start reservation, independent of durable result evidence.
 * The host owns cleanup until its start hook returns; if it throws, it must release acquired resources.
 */
export interface ToolCallStartReservation {
	/** Synchronous, infallible and idempotent. Release only this wave's resource for the named call. */
	release(callId: string): void;
}

/**
 * Reserve one or more prepared tool calls before their side effects begin.
 *
 * Sequential execution invokes this once with one prepared call. Parallel execution invokes it
 * once with the complete prepared wave, so a host can atomically persist the wave reservation before
 * any body starts. Immediate validation, policy, and replay outcomes are never offered here.
 * A returned reservation transfers live resource cleanup to the core. Each call releases after
 * real finalization (including background completion), or immediately when preparation is abandoned.
 * This cleanup is not a durable tool result or evidence that execution succeeded.
 */
export type ToolCallStartHook = (
	calls: readonly ToolCallStartContext[],
	signal?: AbortSignal,
	// biome-ignore lint/suspicious/noConfusingVoidType: Hooks returning Promise<void> must compose with reservation-returning branches; undefined would reject that valid union.
) => void | ToolCallStartReservation | Promise<void | ToolCallStartReservation>;

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

/** A host's request that the loop stop and have the model report, see {@link AgentLoopConfig.getHaltRequest}. */
export interface AgentHaltRequest {
	/** Injected into the transcript before the closing request, so the model sees why it stopped. */
	userMessage: string;
	/** Host-authored system text for the tool-free closing request. */
	closingPrompt: string;
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
	/** Non-secret account scope frozen with the API key that this request will transport. */
	providerAccountKey?: string;
	/** Request-local reasoning value that will be sent to transport. */
	reasoning: SimpleStreamOptions["reasoning"];
	/** Zero-based admission generation for the accepted plan. */
	attempt: number;
}

/** Ephemeral request auth resolved once before lifecycle snapshot and transport dispatch. */
export interface ResolvedProviderRequestAuth {
	apiKey?: string;
	headers?: Record<string, string>;
	credentialHeaders?: Record<string, string>;
	/** Non-secret account scope derived from `apiKey`; never sent to a provider. */
	providerAccountKey?: string;
}

export type ProviderRequestAdmissionResult =
	| { action: "send"; maxTokens?: number }
	| { action: "replan"; context: AgentContext };

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
	 *
	 * `context` is the MATERIALIZED WIRE context: `convertToLlm` has already turned every non-wire
	 * AgentMessage kind into a plain `user` message, so a `role: "custom"` message and its
	 * `customType` are no longer visible there. `sourceMessages` is this request's durable
	 * agent-message plan, unconverted - the only place a policy can recognize which host-initiated
	 * message the request is answering.
	 */
	resolveRequestReasoning?: (
		reasoning: SimpleStreamOptions["reasoning"],
		request: {
			model: Model<Api>;
			context: Context;
			maxTokens?: number;
			sourceMessages: readonly AgentMessage[];
			/**
			 * The conversation the request belongs to (`AgentLoopConfig.sessionId`). One resolver can serve
			 * several conversations (a host's isolated lanes reuse its policy), so per-conversation state is
			 * keyed by it.
			 */
			sessionId?: string;
		},
	) => SimpleStreamOptions["reasoning"];

	/**
	 * Resolves an API key dynamically for each LLM call.
	 *
	 * Useful for short-lived OAuth tokens (e.g., GitHub Copilot) that may expire
	 * during long-running tool execution phases.
	 *
	 * Contract: must not throw or reject. Return undefined when no key is available.
	 */
	getApiKey?: (provider: string, model?: Model<Api>) => Promise<string | undefined> | string | undefined;

	/**
	 * Resolve the complete auth projection for one routed model exactly once. When present, this is
	 * authoritative over `getApiKey`; the planner freezes its key, ordinary auth headers,
	 * credential-routing headers, and account scope into the accepted request before any lifecycle
	 * callback runs. Throwing prevents request acceptance and transport.
	 */
	resolveProviderRequestAuth?: (
		model: Model<Api>,
	) => ResolvedProviderRequestAuth | Promise<ResolvedProviderRequestAuth>;

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
	 * Host halt request, polled before every provider request. When it returns a request the loop
	 * injects `userMessage` into the transcript, spends one final tool-free provider request so the
	 * model authors its own report (the same closing turn a runaway stop uses, with `closingPrompt`
	 * in place of the runaway text), and ends the run. A tool batch already executing finishes first.
	 * The host owns what the report means; the loop never writes the report itself.
	 *
	 * Contract: must not throw or reject. The loop acts on the first request it receives and ends the
	 * run, so it never polls again within one run; whether a host's later re-attempt of the same run
	 * receives the request again is the host's decision.
	 */
	getHaltRequest?: () => AgentHaltRequest | undefined;

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

	/**
	 * True when the model asked for this call to run as a background task from the start (a tool
	 * argument such as `background: true`). The call crosses `handoffToolCall` at once instead of
	 * waiting for a latency budget; the host decides whether a handoff is possible at all.
	 */
	isBackgroundRequested?: (toolName: string, args: unknown) => boolean;
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
	/**
	 * Why this request's system prompt or tools deliberately differ from the run's (a safety removal,
	 * such as the runaway-stop closing request withholding every tool). Never sent to the provider; a
	 * host's cache guard reads it from `ProviderRequestSnapshotContext.sourceContext` to tell a break the
	 * loop made on purpose from one nobody sanctioned.
	 */
	surfaceChange?: string;
	/**
	 * The request's literal tail is a host-authored instruction the model must act on (a halt message
	 * asking for its own report). The planner then appends no trailing MUST-protocol record (the
	 * failure ledger, verification obligations) after it, so the instruction stays the last thing the
	 * model reads. Records already in the transcript are untouched.
	 */
	instructionTail?: boolean;
}
