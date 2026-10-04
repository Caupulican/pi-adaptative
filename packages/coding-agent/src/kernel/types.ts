import type {
	AssistantMessage,
	AssistantMessageEvent,
	ImageContent,
	Message,
	Model,
	TextContent,
	Tool,
	ToolErrorKind,
	ToolResultMessage,
	Usage,
} from "@caupulican/pi-ai";
import type { Static, TSchema } from "typebox";
import type { ExecutionContext, ExecutionPathAuthority } from "./execution-context.ts";

export type { ExecutionPathAuthority } from "./execution-context.ts";

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
 * `tool_failure` — the tool could not establish an operation outcome: rejected arguments, denied
 * authority, interrupted execution, or a crash. Effects may already have occurred; this is not
 * rollback evidence. The harness replaces the result with a bounded failure record.
 *
 * `operation_outcome` — the tool established the bounded attempt's negative status: a process exit
 * code, a configured command deadline, a search that matched nothing, or a false predicate. This
 * does not imply the requested objective was achieved. The harness leaves the tool's output
 * intact and does not treat the outcome as a protocol mistake in failure memory.
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

/**
 * Recover a structured execution error without `instanceof`.
 * Runtime copies (jiti transforms, duplicate packages) can break class identity while keeping
 * `name`, `message`, `failureCode`, `errorKind`, and `outputSignature`.
 */
export function readAgentToolExecutionError(error: unknown): AgentToolExecutionError | undefined {
	if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined;
	try {
		const name = Reflect.get(error, "name");
		const message = Reflect.get(error, "message");
		const failureCode = Reflect.get(error, "failureCode");
		const outputSignature = Reflect.get(error, "outputSignature");
		const errorKind = Reflect.get(error, "errorKind");
		if (name !== "AgentToolExecutionError") return undefined;
		if (typeof message !== "string" || message.length === 0) return undefined;
		if (typeof failureCode !== "string" || failureCode.length === 0) return undefined;
		if (typeof outputSignature !== "string") return undefined;
		if (errorKind !== "tool_failure" && errorKind !== "operation_outcome") return undefined;
		return new AgentToolExecutionError(message, failureCode, outputSignature, errorKind);
	} catch {
		return undefined;
	}
}

function describeUnknownError(
	error: unknown,
	fallbackMessage: string,
): {
	message: string;
	errorClass: string;
} {
	try {
		if (typeof error === "string" && error.length > 0) return { message: error, errorClass: "string" };
		if (error !== null && (typeof error === "object" || typeof error === "function")) {
			let message = fallbackMessage;
			let errorClass: string = typeof error;
			const rawMessage = Reflect.get(error, "message");
			if (typeof rawMessage === "string" && rawMessage.length > 0) message = rawMessage;
			const rawName = Reflect.get(error, "name");
			if (typeof rawName === "string" && rawName.length > 0) errorClass = rawName;
			return { message, errorClass };
		}
	} catch {
		// Keep the fallback when getters or proxies throw.
	}
	return { message: fallbackMessage, errorClass: typeof error };
}

/** Read an error message without unguarded property or prototype inspection. Does not construct AgentToolExecutionError. */
export function safeErrorMessage(error: unknown, fallback = ""): string {
	return describeUnknownError(error, fallback).message;
}

/** Snapshot a thrown tool error without unguarded property or prototype inspection. */
export function describeThrownToolError(error: unknown): {
	structured: AgentToolExecutionError | undefined;
	message: string;
	errorClass: string;
} {
	const structured = readAgentToolExecutionError(error);
	if (structured) {
		return { structured, message: structured.message, errorClass: structured.name };
	}
	const fallback = describeUnknownError(error, "Tool execution failed.");
	return { structured: undefined, ...fallback };
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
/**
 * Progress observation only: listener failures never throw into the tool body. The core drains
 * admitted listener promises before finalization, records a bounded delivery failure separately
 * from the operation result, and ignores callbacks invoked after the operation settled.
 */
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
	/**
	 * Pure projection of the timeout actually applied by this executor, in milliseconds, including
	 * defaults and clamping. Undefined means no comparable bound; the host must not guess from args
	 * when this method is declared. The same resolver must supply the executor's own timeout.
	 */
	getTimeoutMs?: (params: Static<TParameters>) => number | undefined;
	/** Tool-owned corrective instruction, separate from raw diagnostics and execution admission. */
	getFailureCorrection?: (params: Static<TParameters>, failure: AgentToolFailureEvidenceContext) => string | undefined;
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

/** A host-owned executor and recovery contract admitted against one execution context. */
export interface AgentToolInvocation<TParameters extends TSchema = TSchema, TDetails = unknown> {
	readonly executionContext: ExecutionContext;
	readonly execute: AgentTool<TParameters, TDetails>["execute"];
	readonly failureRecovery?: AgentToolFailureRecoveryContract<TParameters>;
	/** Live backend filesystem capabilities for an executing backend; not serialized to journal data. */
	readonly pathAuthority?: ExecutionPathAuthority;
	/** Synchronous, infallible release. The core calls it once, after rejection or real finalization. */
	release(): void;
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
	 * Acquire the executor's immutable host context after argument validation, before policy checks.
	 * Must perform no operation effects. On rejection, the host cleans up resources it acquired.
	 * A returned invocation remains leased through background execution and after-tool policy.
	 */
	bindInvocation?: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
	) => Promise<AgentToolInvocation<TParameters, TDetails>>;
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
	/**
	 * Every call only reads: it changes no file, process or remote state. Harness policy that must tell
	 * reads from writes (a cheap turn's escalation, the work boundary, a side trip's surface) trusts this
	 * declaration; a tool that declares nothing is judged by its name and treated as mutating when unknown.
	 */
	readOnly?: boolean;
	executionMode?: ToolExecutionMode;
	/**
	 * The file this call will mutate, as the model spelled it, or undefined when it mutates nothing.
	 *
	 * Declaring it buys two things the loop cannot infer: a later sibling in the same assistant
	 * message whose arguments name this path is scheduled in a LATER group (`partitionToolCalls`),
	 * and the host can announce the call as a pending mutation so a sibling exclusive run waits for
	 * it instead of racing it. Called on RAW provider arguments before schema validation, so an
	 * implementation must be total and must never throw.
	 */
	mutationTarget?: (args: any) => string | undefined;
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
