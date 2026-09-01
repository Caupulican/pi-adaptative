import { streamSimple } from "@caupulican/pi-ai/stream";
import type {
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	ThinkingBudgets,
	Transport,
} from "@caupulican/pi-ai/types";
import type { ToolArgumentValidationTelemetryEvent } from "@caupulican/pi-ai/validation";
import {
	type AgentLoopContinuationState,
	createAgentLoopContinuationState,
	runAgentLoop,
	runAgentLoopContinue,
} from "./agent-loop.ts";
import { convertToLlm } from "./messages.ts";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentContextPlan,
	AgentContextPlanRequest,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentState,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
	ProviderRequestAdmissionContext,
	ProviderRequestAdmissionResult,
	QueueMode,
	StreamFn,
	ToolCallStartHook,
	ToolExecutionMode,
} from "./types.ts";
import { createEmptyUsage } from "./usage.ts";

export type { QueueMode } from "./types.ts";

/**
 * Default `convertToLlm` for a caller that supplies none of its own. Delegates to the real
 * converter (`./messages.ts`) rather than duplicating a narrower filter: that function has an
 * explicit case for every `AgentMessage` role - "custom", "bashExecution", "branchSummary",
 * "compactionSummary" - converting each into a valid `Message` instead of silently dropping it. A
 * narrower, hand-rolled filter here (user/assistant/toolResult only, as this used to be) is a
 * latent trap for any content injected as one of those other roles: a default-converter caller
 * never sees it reach the provider at all, no error, nothing to notice - exactly what happened to
 * a MUST-protocol verification directive represented as a `role: "custom"` message (see the
 * turn-economics remediation doc's append-on-change section for the incident this fixes).
 *
 * Confirmed zero production behaviour change: `packages/coding-agent/src/core/sdk.ts` has always
 * wired its own `convertToLlm` explicitly (wrapping this same `messages.ts` function), so this
 * default only ever governed callers that never supply one - the test harness being the one that
 * mattered, which is why the harness silently dropped role:"custom" content while production never
 * did.
 */
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return convertToLlm(messages);
}

const DEFAULT_MODEL = {
	id: "unknown",
	name: "unknown",
	api: "unknown",
	provider: "unknown",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
} satisfies Model<any>;

type MutableAgentState = Omit<AgentState, "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"> & {
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: Set<string>;
	errorMessage?: string;
};

function createMutableAgentState(
	initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>,
): MutableAgentState {
	let tools = initialState?.tools?.slice() ?? [];
	let messages = initialState?.messages?.slice() ?? [];

	return {
		systemPrompt: initialState?.systemPrompt ?? "",
		model: initialState?.model ?? DEFAULT_MODEL,
		thinkingLevel: initialState?.thinkingLevel ?? "off",
		get tools() {
			return tools;
		},
		set tools(nextTools: AgentTool<any>[]) {
			tools = nextTools.slice();
		},
		get messages() {
			return messages;
		},
		set messages(nextMessages: AgentMessage[]) {
			messages = nextMessages.slice();
		},
		isStreaming: false,
		streamingMessage: undefined,
		pendingToolCalls: new Set<string>(),
		errorMessage: undefined,
	};
}

/** Options for constructing an {@link Agent}. */
export interface AgentOptions {
	initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>;
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	planContext?: (request: AgentContextPlanRequest, signal?: AbortSignal) => Promise<AgentContextPlan>;
	admitProviderRequest?: (
		request: ProviderRequestAdmissionContext,
		signal?: AbortSignal,
	) => ProviderRequestAdmissionResult | Promise<ProviderRequestAdmissionResult>;
	onProviderRequestSnapshot?: AgentLoopConfig["onProviderRequestSnapshot"];
	resolveRequestReasoning?: AgentLoopConfig["resolveRequestReasoning"];
	/**
	 * Observability hook for a host-owned `planContext`/`transformContext` disturbing the
	 * already-sent prefix. See `AgentLoopConfig.onSentPrefixDisturbance` for the full contract. Not a
	 * new capability - `AgentLoopConfig` has carried this since it was added - but until this audit
	 * `Agent` exposed no path to it at all: no constructor option, no public instance field, nothing.
	 * Any host going through `Agent` (as opposed to calling `agentLoop` directly) could not have used
	 * it no matter how it tried. Same class of gap as `defaultConvertToLlm` silently dropping
	 * `role:"custom"` - a real `AgentLoopConfig` feature with no way to reach it through the class
	 * most hosts actually use.
	 */
	onSentPrefixDisturbance?: AgentLoopConfig["onSentPrefixDisturbance"];
	/**
	 * Request-local budget/authority check run immediately before every provider request. See
	 * `AgentLoopConfig.requestPreflight` for the full contract - same gap as
	 * `onSentPrefixDisturbance` above: previously unreachable through `Agent` at all, not merely
	 * unwired from the constructor.
	 */
	requestPreflight?: AgentLoopConfig["requestPreflight"];
	streamFn?: StreamFn;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	onPayload?: SimpleStreamOptions["onPayload"];
	onResponse?: SimpleStreamOptions["onResponse"];
	textToolCallProtocol?: SimpleStreamOptions["textToolCallProtocol"];
	onTextToolProtocolParse?: SimpleStreamOptions["onTextToolProtocolParse"];
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	onToolCallStart?: ToolCallStartHook;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	backgroundToolCallAfterMs?: AgentLoopConfig["backgroundToolCallAfterMs"];
	handoffToolCall?: AgentLoopConfig["handoffToolCall"];
	subscribeToolCallHandoffRequest?: AgentLoopConfig["subscribeToolCallHandoffRequest"];
	onToolArgumentValidation?: (event: ToolArgumentValidationTelemetryEvent) => void;
	toolArgumentTeachEnabled?: boolean;
	toolValidationEscalationThreshold?: number;
	onToolValidationEscalation?: AgentLoopConfig["onToolValidationEscalation"];
	prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	shouldStopAfterTurn?: (signal?: AbortSignal) => boolean | Promise<boolean>;
	beforeSteeringPoll?: (signal?: AbortSignal) => void | Promise<void>;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	sessionId?: string;
	thinkingBudgets?: ThinkingBudgets;
	transport?: Transport;
	maxRetryDelayMs?: number;
	maxStallTurns?: number;
	maxProviderTurns?: number;
	onRunawayStop?: AgentLoopConfig["onRunawayStop"];
	toolExecution?: ToolExecutionMode;
	toolConcurrency?: AgentLoopConfig["toolConcurrency"];
}

class PendingMessageQueue {
	private messages: AgentMessage[] = [];
	public mode: QueueMode;

	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	enqueue(message: AgentMessage): void {
		this.messages.push(message);
	}

	hasItems(): boolean {
		return this.messages.length > 0;
	}

	drain(): AgentMessage[] {
		if (this.mode === "all") {
			const drained = this.messages.slice();
			this.messages = [];
			return drained;
		}

		const first = this.messages[0];
		if (!first) {
			return [];
		}
		this.messages = this.messages.slice(1);
		return [first];
	}

	clear(): void {
		this.messages = [];
	}
}

type ActiveRun = {
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
};

/** A second foreground operation tried to acquire an Agent that still owns an active run. */
export class AgentBusyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentBusyError";
	}
}

/**
 * Stateful wrapper around the low-level agent loop.
 *
 * `Agent` owns the current transcript, emits lifecycle events, executes tools,
 * and exposes queueing APIs for steering and follow-up messages.
 */
export class Agent {
	private _state: MutableAgentState;
	private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
	private readonly steeringQueue: PendingMessageQueue;
	private readonly followUpQueue: PendingMessageQueue;

	public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	public transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	public planContext?: (request: AgentContextPlanRequest, signal?: AbortSignal) => Promise<AgentContextPlan>;
	public admitProviderRequest?: (
		request: ProviderRequestAdmissionContext,
		signal?: AbortSignal,
	) => ProviderRequestAdmissionResult | Promise<ProviderRequestAdmissionResult>;
	public onProviderRequestSnapshot?: AgentLoopConfig["onProviderRequestSnapshot"];
	public resolveRequestReasoning?: AgentLoopConfig["resolveRequestReasoning"];
	public onSentPrefixDisturbance?: AgentLoopConfig["onSentPrefixDisturbance"];
	public requestPreflight?: AgentLoopConfig["requestPreflight"];
	public streamFn: StreamFn;
	public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	public onPayload?: SimpleStreamOptions["onPayload"];
	public onResponse?: SimpleStreamOptions["onResponse"];
	public textToolCallProtocol?: SimpleStreamOptions["textToolCallProtocol"];
	public onTextToolProtocolParse?: SimpleStreamOptions["onTextToolProtocolParse"];
	public beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;
	public onToolCallStart?: ToolCallStartHook;
	public afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;
	public backgroundToolCallAfterMs?: AgentLoopConfig["backgroundToolCallAfterMs"];
	public handoffToolCall?: AgentLoopConfig["handoffToolCall"];
	public subscribeToolCallHandoffRequest?: AgentLoopConfig["subscribeToolCallHandoffRequest"];
	public onToolArgumentValidation?: (event: ToolArgumentValidationTelemetryEvent) => void;
	public toolArgumentTeachEnabled?: boolean;
	public toolValidationEscalationThreshold?: number;
	public onToolValidationEscalation?: AgentLoopConfig["onToolValidationEscalation"];
	public prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	public shouldStopAfterTurn?: (signal?: AbortSignal) => boolean | Promise<boolean>;
	/** Host-owned inbox refresh run immediately before each steering-queue drain. */
	public beforeSteeringPoll?: (signal?: AbortSignal) => void | Promise<void>;
	private activeRun?: ActiveRun;
	/** No-progress gates shared only by host continuations of the current logical prompt. */
	private loopContinuationState: AgentLoopContinuationState | undefined;
	/**
	 * SESSION-scoped "already sent" mark for `sanitizeToolFailureContext` (see
	 * `ProviderRequestPrefixState` in types.ts - do not merge this back with the RUN-scoped
	 * `sentPrefixCount` that `loopContinuationState` resets every prompt; that recreates the exact
	 * defect this field exists to prevent). Persists across every `prompt()`/`continue()` call for
	 * the life of this `Agent` instance, seeding each new `AgentLoopContinuationState` instead of
	 * letting it reset to zero, and is written back from the loop's own copy after each run. Reset
	 * only by `reset()` and `resetSanitizerPrefixHorizon()` - see the latter's doc comment for when
	 * a host must call it.
	 */
	private sanitizerSentPrefixCount = 0;
	/** Session identifier forwarded to providers for cache-aware backends. */
	public sessionId?: string;
	/** Optional per-level thinking token budgets forwarded to the stream function. */
	public thinkingBudgets?: ThinkingBudgets;
	/** Preferred transport forwarded to the stream function. */
	public transport: Transport;
	/** Optional cap for provider-requested retry delays. */
	public maxRetryDelayMs?: number;
	/** Runaway-loop backstop for repeated identical tool-call turns. */
	public maxStallTurns?: number;
	/** Optional provider-request fuse for one logical prompt; disabled when omitted or zero. */
	public maxProviderTurns?: number;
	/** Observability hook fired once if a repeated-call or provider-turn guard trips. */
	public onRunawayStop?: AgentLoopConfig["onRunawayStop"];
	/** Tool execution strategy for assistant messages that contain multiple tool calls. */
	public toolExecution: ToolExecutionMode;
	/** Pool width for "parallel" mode's parallel groups. Validated/defaulted in the agent loop. */
	public toolConcurrency?: AgentLoopConfig["toolConcurrency"];

	constructor(options: AgentOptions = {}) {
		this._state = createMutableAgentState(options.initialState);
		this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm;
		this.transformContext = options.transformContext;
		this.planContext = options.planContext;
		this.admitProviderRequest = options.admitProviderRequest;
		this.onProviderRequestSnapshot = options.onProviderRequestSnapshot;
		this.resolveRequestReasoning = options.resolveRequestReasoning;
		this.onSentPrefixDisturbance = options.onSentPrefixDisturbance;
		this.requestPreflight = options.requestPreflight;
		this.streamFn = options.streamFn ?? streamSimple;
		this.getApiKey = options.getApiKey;
		this.onPayload = options.onPayload;
		this.onResponse = options.onResponse;
		this.textToolCallProtocol = options.textToolCallProtocol;
		this.onTextToolProtocolParse = options.onTextToolProtocolParse;
		this.beforeToolCall = options.beforeToolCall;
		this.onToolCallStart = options.onToolCallStart;
		this.afterToolCall = options.afterToolCall;
		this.backgroundToolCallAfterMs = options.backgroundToolCallAfterMs;
		this.handoffToolCall = options.handoffToolCall;
		this.subscribeToolCallHandoffRequest = options.subscribeToolCallHandoffRequest;
		this.onToolArgumentValidation = options.onToolArgumentValidation;
		this.toolArgumentTeachEnabled = options.toolArgumentTeachEnabled;
		this.toolValidationEscalationThreshold = options.toolValidationEscalationThreshold;
		this.onToolValidationEscalation = options.onToolValidationEscalation;
		this.prepareNextTurn = options.prepareNextTurn;
		this.shouldStopAfterTurn = options.shouldStopAfterTurn;
		this.beforeSteeringPoll = options.beforeSteeringPoll;
		this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
		this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
		this.sessionId = options.sessionId;
		this.thinkingBudgets = options.thinkingBudgets;
		this.transport = options.transport ?? "auto";
		this.maxRetryDelayMs = options.maxRetryDelayMs;
		this.maxStallTurns = options.maxStallTurns;
		this.maxProviderTurns = options.maxProviderTurns;
		this.onRunawayStop = options.onRunawayStop;
		this.toolExecution = options.toolExecution ?? "parallel";
		this.toolConcurrency = options.toolConcurrency;
	}

	/**
	 * Subscribe to agent lifecycle events.
	 *
	 * Listener promises are awaited in subscription order and are included in
	 * the current run's settlement. Listeners also receive the active abort
	 * signal for the current run.
	 *
	 * `agent_end` is the final emitted event for a run, but the agent does not
	 * become idle until all awaited listeners for that event have settled.
	 */
	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Current agent state.
	 *
	 * Assigning `state.tools` or `state.messages` copies the provided top-level array.
	 */
	get state(): AgentState {
		return this._state;
	}

	/** Controls how queued steering messages are drained. */
	set steeringMode(mode: QueueMode) {
		this.steeringQueue.mode = mode;
	}

	get steeringMode(): QueueMode {
		return this.steeringQueue.mode;
	}

	/** Controls how queued follow-up messages are drained. */
	set followUpMode(mode: QueueMode) {
		this.followUpQueue.mode = mode;
	}

	get followUpMode(): QueueMode {
		return this.followUpQueue.mode;
	}

	/** Queue a message to be injected after the current assistant turn finishes. */
	steer(message: AgentMessage): void {
		this.steeringQueue.enqueue(message);
	}

	/** Queue a message to run only after the agent would otherwise stop. */
	followUp(message: AgentMessage): void {
		this.followUpQueue.enqueue(message);
	}

	/** Remove all queued steering messages. */
	clearSteeringQueue(): void {
		this.steeringQueue.clear();
	}

	/** Remove all queued follow-up messages. */
	clearFollowUpQueue(): void {
		this.followUpQueue.clear();
	}

	/** Remove all queued steering and follow-up messages. */
	clearAllQueues(): void {
		this.clearSteeringQueue();
		this.clearFollowUpQueue();
	}

	/** Returns true when either queue still contains pending messages. */
	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	/** Active abort signal for the current run, if any. */
	get signal(): AbortSignal | undefined {
		return this.activeRun?.abortController.signal;
	}

	/** Abort the current run, if one is active. */
	abort(): void {
		this.activeRun?.abortController.abort();
	}

	/**
	 * Resolve when the current run and all awaited event listeners have finished.
	 *
	 * This resolves after `agent_end` listeners settle.
	 */
	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	/** Clear transcript state, runtime state, and queued messages. */
	reset(): void {
		if (this.activeRun) {
			throw new AgentBusyError("Agent cannot reset while a run is active. Abort and await waitForIdle() first.");
		}
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this._state.errorMessage = undefined;
		this.loopContinuationState = undefined;
		this.resetSanitizerPrefixHorizon();
		this.clearFollowUpQueue();
		this.clearSteeringQueue();
	}

	/**
	 * Drop the SESSION-scoped sanitizer mark back to zero (see `ProviderRequestPrefixState` in
	 * types.ts and the field doc comment on `sanitizerSentPrefixCount`). `reset()` calls this
	 * automatically, since it already clears `state.messages` to `[]` - after that, index 0 is
	 * correctly "nothing sent yet" for the new, empty transcript.
	 *
	 * A host MUST also call this whenever it replaces `state.messages` with a DIFFERENT lineage
	 * than the one the mark was tracking - a session reload, a fork, or a branch switch - since the
	 * mark otherwise indexes into a message array that no longer exists. This package does not
	 * expose a signal for those specific transitions beyond a full `reset()`; a host performing one
	 * of them without calling this (or `reset()`) leaves the mark pointing at stale history, which
	 * would incorrectly protect - or incorrectly permit erasing - positions in the new array that
	 * have no relationship to what was actually sent for it. See the repo-root AGENTS.md entry under
	 * "Compaction and Long Sessions" for the exact coding-agent call sites this needs wiring into
	 * (session-tree-navigator.ts, agent-session.ts, sdk.ts) - none of them call this yet.
	 */
	resetSanitizerPrefixHorizon(): void {
		this.sanitizerSentPrefixCount = 0;
	}

	/** Start a new prompt from text, a single message, or a batch of messages. */
	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	async prompt(input: string, images?: ImageContent[]): Promise<void>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		if (this.activeRun) {
			throw new AgentBusyError(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}
		const messages = this.normalizePromptInput(input, images);
		await this.runPromptMessages(messages);
	}

	/** Continue from the current transcript. The last message must be a user or tool-result message. */
	async continue(): Promise<void> {
		if (this.activeRun) {
			throw new AgentBusyError("Agent is already processing. Wait for completion before continuing.");
		}

		const lastMessage = this._state.messages[this._state.messages.length - 1];
		if (!lastMessage) {
			throw new Error("No messages to continue from");
		}

		if (lastMessage.role === "assistant") {
			const queuedSteering = this.steeringQueue.drain();
			if (queuedSteering.length > 0) {
				await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
				return;
			}

			const queuedFollowUps = this.followUpQueue.drain();
			if (queuedFollowUps.length > 0) {
				await this.runPromptMessages(queuedFollowUps);
				return;
			}

			throw new Error("Cannot continue from message role: assistant");
		}

		await this.runContinuation();
	}

	private normalizePromptInput(
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
	): AgentMessage[] {
		if (Array.isArray(input)) {
			return input;
		}

		if (typeof input !== "string") {
			return [input];
		}

		const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
		if (images && images.length > 0) {
			content.push(...images);
		}
		return [{ role: "user", content, timestamp: Date.now() }];
	}

	private async runPromptMessages(
		messages: AgentMessage[],
		options: { skipInitialSteeringPoll?: boolean } = {},
	): Promise<void> {
		// Seeded from the persistent, SESSION-scoped mark - NOT the zero-arg default, which would
		// re-arm the sanitizer's dedup-erasure across the whole prior session on every new prompt.
		// See ProviderRequestPrefixState in types.ts.
		const continuationState = createAgentLoopContinuationState(this.sanitizerSentPrefixCount);
		this.loopContinuationState = continuationState;
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoop(
				messages,
				this.createContextSnapshot(),
				this.createLoopConfig(options),
				(event) => this.processEvents(event),
				signal,
				this.streamFn,
				continuationState,
			);
		});
		this.syncSanitizerPrefixHorizon(continuationState);
	}

	private async runContinuation(): Promise<void> {
		const continuationState =
			this.loopContinuationState ?? createAgentLoopContinuationState(this.sanitizerSentPrefixCount);
		this.loopContinuationState = continuationState;
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoopContinue(
				this.createContextSnapshot(),
				this.createLoopConfig(),
				(event) => this.processEvents(event),
				signal,
				this.streamFn,
				continuationState,
			);
		});
		this.syncSanitizerPrefixHorizon(continuationState);
	}

	/**
	 * Copies the loop's own (possibly just-grown) sanitizer mark back onto this persistent field
	 * after a run, whether that run finished normally, failed, or was aborted -
	 * `runWithLifecycle` swallows run failures internally and never rethrows, so this always runs.
	 * `continuationState.providerRequestPrefixState` is the SAME object the loop wrote through
	 * during the run (see `createAgentLoopContinuationState`), so this only ever reads a value
	 * already updated in place - it does not recompute anything.
	 */
	private syncSanitizerPrefixHorizon(continuationState: AgentLoopContinuationState): void {
		const updated = continuationState.providerRequestPrefixState?.sanitizerSentPrefixCount;
		if (updated !== undefined) this.sanitizerSentPrefixCount = updated;
	}

	private createContextSnapshot(): AgentContext {
		return {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools.slice(),
		};
	}

	private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
		let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
		return {
			model: this._state.model,
			reasoning: this._state.thinkingLevel,
			temperature: this.textToolCallProtocol ? 0 : undefined,
			sessionId: this.sessionId,
			onPayload: this.onPayload,
			onResponse: this.onResponse,
			textToolCallProtocol: this.textToolCallProtocol,
			onTextToolProtocolParse: this.onTextToolProtocolParse,
			transport: this.transport,
			thinkingBudgets: this.thinkingBudgets,
			maxRetryDelayMs: this.maxRetryDelayMs,
			maxStallTurns: this.maxStallTurns,
			maxProviderTurns: this.maxProviderTurns,
			onRunawayStop: this.onRunawayStop,
			toolExecution: this.toolExecution,
			toolConcurrency: this.toolConcurrency,
			toolArgumentTeachEnabled: this.toolArgumentTeachEnabled,
			onToolArgumentValidation: this.onToolArgumentValidation,
			toolValidationEscalationThreshold: this.toolValidationEscalationThreshold,
			onToolValidationEscalation: this.onToolValidationEscalation,
			beforeToolCall: this.beforeToolCall,
			onToolCallStart: this.onToolCallStart,
			afterToolCall: this.afterToolCall,
			backgroundToolCallAfterMs: this.backgroundToolCallAfterMs,
			handoffToolCall: this.handoffToolCall,
			subscribeToolCallHandoffRequest: this.subscribeToolCallHandoffRequest,
			prepareNextTurn: this.prepareNextTurn ? async () => await this.prepareNextTurn?.(this.signal) : undefined,
			shouldStopAfterTurn: this.shouldStopAfterTurn
				? async () => (await this.shouldStopAfterTurn?.(this.signal)) ?? false
				: undefined,
			convertToLlm: this.convertToLlm,
			transformContext: this.transformContext,
			planContext: this.planContext,
			admitProviderRequest: this.admitProviderRequest,
			onProviderRequestSnapshot: this.onProviderRequestSnapshot,
			resolveRequestReasoning: this.resolveRequestReasoning,
			onSentPrefixDisturbance: this.onSentPrefixDisturbance,
			requestPreflight: this.requestPreflight,
			getApiKey: this.getApiKey,
			getSteeringMessages: async () => {
				await this.beforeSteeringPoll?.(this.signal);
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.steeringQueue.drain();
			},
			getFollowUpMessages: async () => this.followUpQueue.drain(),
		};
	}

	private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.activeRun) {
			throw new AgentBusyError("Agent is already processing.");
		}

		const abortController = new AbortController();
		let resolvePromise = () => {};
		const promise = new Promise<void>((resolve) => {
			resolvePromise = resolve;
		});
		this.activeRun = { promise, resolve: resolvePromise, abortController };

		this._state.isStreaming = true;
		this._state.streamingMessage = undefined;
		this._state.errorMessage = undefined;

		try {
			await executor(abortController.signal);
		} catch (error) {
			await this.handleRunFailure(error, abortController.signal.aborted);
		} finally {
			this.finishRun();
		}
	}

	private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
		const failureMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: this._state.model.api,
			provider: this._state.model.provider,
			model: this._state.model.id,
			usage: createEmptyUsage(),
			stopReason: aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		} satisfies AgentMessage;
		await this.processEvents({ type: "message_start", message: failureMessage, origin: "local" });
		await this.processEvents({ type: "message_end", message: failureMessage, origin: "local" });
		await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
		await this.processEvents({ type: "agent_end", messages: [failureMessage] });
	}

	private finishRun(): void {
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this.activeRun?.resolve();
		this.activeRun = undefined;
	}

	/**
	 * Reduce internal state for a loop event, then await listeners.
	 *
	 * `agent_end` only means no further loop events will be emitted. The run is
	 * considered idle later, after all awaited listeners for `agent_end` finish
	 * and `finishRun()` clears runtime-owned state.
	 */
	private async processEvents(event: AgentEvent): Promise<void> {
		switch (event.type) {
			case "message_start":
				this._state.streamingMessage = event.message;
				break;

			case "message_update":
				this._state.streamingMessage = event.message;
				break;

			case "message_end":
				this._state.streamingMessage = undefined;
				this._state.messages.push(event.message);
				break;

			case "tool_execution_start": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.add(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "tool_execution_end": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.delete(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "turn_end":
				if (event.message.role === "assistant" && event.message.errorMessage) {
					this._state.errorMessage = event.message.errorMessage;
				}
				break;

			case "agent_end":
				this._state.streamingMessage = undefined;
				break;
		}

		const signal = this.activeRun?.abortController.signal;
		if (!signal) {
			throw new Error("Agent listener invoked outside active run");
		}
		for (const listener of this.listeners) {
			await listener(event, signal);
		}
	}
}
