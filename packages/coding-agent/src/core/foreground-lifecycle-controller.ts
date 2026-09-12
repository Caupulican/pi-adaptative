import type { Agent, AgentMessage } from "@caupulican/pi-agent-core";
import type { SessionLifecycleInspection, SessionManager } from "@caupulican/pi-agent-core/session";
import { sessionLifecycleToolIdentityKey } from "@caupulican/pi-agent-core/session";
import type { ProviderRequestSnapshotContext, ToolCallStartContext } from "@caupulican/pi-agent-core/types";
import type { AssistantMessage, Message, ToolResultMessage } from "@caupulican/pi-ai";
import type { ModelRouterController } from "./model-router-controller.ts";
import { dumpProviderRequest } from "./request-dump.ts";
import { buildRequestSnapshotInput } from "./request-snapshot-fingerprints.ts";
import { announceToolCall, retireToolCall } from "./tools/file-mutation-queue.ts";

/**
 * Durable, per-request record of which transport actually carried a provider request and whether
 * the WebSocket `previous_response_id` delta continuation engaged or fell back to a full send —
 * the turn-economics transport-telemetry investigation. Diagnostic only, keyed by `requestId` so
 * it can be joined against the `request_snapshot` entry the same request already produced; never
 * read by any runtime decision.
 */
export const PROVIDER_TRANSPORT_TELEMETRY_CUSTOM_TYPE = "provider_transport_telemetry";
/**
 * Durable record of one automatic provider retry (start: the failure and the backoff chosen; end:
 * whether the retried request eventually succeeded). Before this record existed the retry
 * controller's events reached only the live UI, so a rate limit or overload the harness retried
 * and recovered from left no trace in the session and could not be counted by a later census.
 * Joined to the request it retries through `requestId` (the latest `request_snapshot`); never
 * read by any runtime decision.
 */
export const PROVIDER_RETRY_CUSTOM_TYPE = "provider_retry";

/** The retry controller's two lifecycle events, as the recovery controller emits them. */
export type ProviderRetryLifecycleEvent =
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };
const MAX_WARNING_LENGTH = 500;
const MAX_RETRY_ERROR_MESSAGE_LENGTH = 2_000;

type AppendMessage = (message: Message) => string;

/**
 * The subset of `Agent` this controller actually touches: setting the provider-request/tool-call
 * hooks, replacing `state.messages` during crash-recovery repair, and resetting the session-scoped
 * sanitizer horizon immediately after doing so. Narrowed instead of depending on the full `Agent`
 * class so a test stub missing one of these members fails `tsc` instead of crashing at runtime the
 * first time `repair()` reaches it -- a real `Agent` always structurally satisfies this regardless,
 * so production callers (ForegroundLifecycleAdapter) need no change. Field types are indexed off
 * `Agent` itself, not redeclared, so they can never drift out of sync with the real class.
 */
export interface ForegroundLifecycleAgentDependency {
	onProviderRequestSnapshot?: Agent["onProviderRequestSnapshot"];
	onToolCallStart?: Agent["onToolCallStart"];
	state: { messages: Agent["state"]["messages"] };
	resetSanitizerPrefixHorizon: Agent["resetSanitizerPrefixHorizon"];
}

interface ForegroundLifecycleControllerDeps {
	agent: ForegroundLifecycleAgentDependency;
	sessionManager: SessionManager;
	modelRouter: ModelRouterController;
	emitWarning(message: string): void;
	/**
	 * Session identity of the group lock these announcements order (see file-mutation-queue.ts).
	 * Omitted announces into the process-wide default scope, which is what a single-session host had.
	 */
	getMutationScope?(): string;
	/** The session announcing its calls; emission order is compared only among one announcer's calls. */
	getAnnouncer?(): string;
}

interface StartedToolIdentity {
	requestId: string;
	assistantMessageEntryId: string;
	callId: string;
	toolName: string;
}

function boundedWarning(message: string): string {
	const normalized = message
		.replace(/[\u0000-\u001F\u007F]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return normalized.length > MAX_WARNING_LENGTH ? `${normalized.slice(0, MAX_WARNING_LENGTH)}…` : normalized;
}

function outcomeForToolResult(result: ToolResultMessage): "success" | "error" {
	return result.isError ? "error" : "success";
}

function isAmbiguousInspection(inspection: SessionLifecycleInspection): boolean {
	return inspection.refusalReasons.length > 0;
}

/**
 * Foreground persistence boundary for provider requests and tool execution.
 *
 * Agent-core deliberately owns provider/tool ordering while coding-agent owns the session log. This
 * controller is the adapter between those lifecycles: request snapshots are written before transport,
 * cheap routed messages are committed before a prepared tool body starts, and canonical result message
 * ids are linked to one bounded terminal record. It never persists request content, tool arguments, or
 * tool results in lifecycle metadata.
 */
export class ForegroundLifecycleController {
	private readonly deps: ForegroundLifecycleControllerDeps;
	private readonly persistedMessages = new WeakMap<object, string>();
	private readonly startedTools = new Map<string, StartedToolIdentity>();
	private readonly pendingToolsByCall = new Map<string, Set<string>>();
	private readonly completedResultMessages = new WeakSet<object>();
	/**
	 * The requestId of the most recently snapshotted provider request, captured in
	 * `onProviderRequestSnapshot` (which always runs before the resulting assistant message can
	 * complete) so `recordTransportTelemetry` can correlate the two without agent-core needing to
	 * carry a requestId on `AssistantMessage` itself.
	 */
	private lastRequestId: string | undefined;

	constructor(deps: ForegroundLifecycleControllerDeps) {
		this.deps = deps;
	}

	/** Install the two agent-core callbacks at the host-owned durability boundary. */
	install(): void {
		this.deps.agent.onProviderRequestSnapshot = (context, signal) => this.onProviderRequestSnapshot(context, signal);
		this.deps.agent.onToolCallStart = (calls, signal) => this.onToolCallStart(calls, signal);
	}

	notePersistedMessage(message: AgentMessage, entryId: string): void {
		this.persistedMessages.set(message, entryId);
	}

	/** Drop in-flight associations when the host swaps/reloads the active session branch. */
	resetForSessionReload(): void {
		const scope = this.deps.getMutationScope?.();
		for (const identity of this.startedTools.values()) retireToolCall(identity.callId, scope);
		this.startedTools.clear();
		this.pendingToolsByCall.clear();
	}

	private findPersistedMessageEntryId(message: AgentMessage): string | undefined {
		return this.persistedMessages.get(message);
	}

	private async onProviderRequestSnapshot(
		context: ProviderRequestSnapshotContext,
		signal?: AbortSignal,
	): Promise<void> {
		signal?.throwIfAborted();
		const flushed = this.deps.modelRouter.commitSessionBufferPrefix();
		for (const [message, entryId] of flushed) this.notePersistedMessage(message, entryId);
		const requestId = context.requestId;
		this.lastRequestId = requestId;
		this.deps.sessionManager.appendRequestSnapshot(buildRequestSnapshotInput(context, this.deps.sessionManager));
		dumpProviderRequest(requestId, context.context);
		signal?.throwIfAborted();
	}

	private appendMessage: AppendMessage = (message) => {
		const entryId = this.deps.sessionManager.appendMessage(message);
		this.notePersistedMessage(message, entryId);
		return entryId;
	};

	/**
	 * Durably record this completed assistant message's `provider_transport` diagnostics (see
	 * `openai-codex-responses.ts`), correlated to the request that produced it via
	 * `lastRequestId`. A no-op for a message with none (every provider besides the Codex
	 * WebSocket/SSE one, or a diagnostic-free success). Never throws: a failed diagnostic write
	 * must never fail the request it observes, exactly like `dumpProviderRequest`.
	 */
	recordTransportTelemetry(message: AssistantMessage): void {
		const diagnostics = message.diagnostics;
		if (!diagnostics || diagnostics.length === 0) return;
		for (const diagnostic of diagnostics) {
			if (diagnostic.type !== "provider_transport") continue;
			try {
				this.deps.sessionManager.appendCustomEntry(PROVIDER_TRANSPORT_TELEMETRY_CUSTOM_TYPE, {
					requestId: this.lastRequestId,
					...diagnostic.details,
				});
			} catch {
				// A failed diagnostic write must never fail the request it observes.
			}
		}
	}

	/**
	 * Durably record one automatic retry lifecycle event, correlated to the request that failed via
	 * `lastRequestId` and stamped with the model the session was on. Never throws: a failed
	 * diagnostic write must never fail the recovery it observes (see `recordTransportTelemetry`).
	 */
	recordRetryEvent(event: ProviderRetryLifecycleEvent, model?: { provider: string; id: string }): void {
		const data =
			event.type === "auto_retry_start"
				? {
						phase: "start" as const,
						attempt: event.attempt,
						maxAttempts: event.maxAttempts,
						delayMs: event.delayMs,
						errorMessage: event.errorMessage.slice(0, MAX_RETRY_ERROR_MESSAGE_LENGTH),
					}
				: {
						phase: "end" as const,
						attempt: event.attempt,
						success: event.success,
						...(event.finalError === undefined
							? {}
							: { finalError: event.finalError.slice(0, MAX_RETRY_ERROR_MESSAGE_LENGTH) }),
					};
		try {
			this.deps.sessionManager.appendCustomEntry(PROVIDER_RETRY_CUSTOM_TYPE, {
				requestId: this.lastRequestId,
				...(model ? { provider: model.provider, modelId: model.id } : {}),
				...data,
			});
		} catch {
			// A failed diagnostic write must never fail the recovery it observes.
		}
	}

	private async onToolCallStart(calls: readonly ToolCallStartContext[], signal?: AbortSignal): Promise<void> {
		if (calls.length === 0) return;
		signal?.throwIfAborted();
		const requestId = calls[0]!.requestId;
		if (calls.some((call) => call.requestId !== requestId)) {
			throw new Error("Tool reservation wave contains multiple provider request identities");
		}

		const flushed = this.deps.modelRouter.commitSessionBuffer();
		for (const [message, entryId] of flushed) this.notePersistedMessage(message, entryId);
		const assistantMessage = calls[0]!.assistantMessage;
		const assistantMessageEntryId = this.findPersistedMessageEntryId(assistantMessage);
		if (!assistantMessageEntryId) {
			throw new Error("Foreground tool reservation rejected: assistant message is not canonically persisted.");
		}
		const identities: StartedToolIdentity[] = [];
		for (const call of calls) {
			const identity: StartedToolIdentity = {
				requestId,
				assistantMessageEntryId,
				callId: call.callId,
				toolName: call.toolName,
			};
			const key = this.toolKey(identity);
			if (this.startedTools.has(key)) throw new Error(`Duplicate foreground tool reservation: ${call.callId}.`);
			identities.push(identity);
		}
		this.deps.sessionManager.appendForegroundToolStarts(
			identities.map(
				({ requestId: identityRequestId, assistantMessageEntryId: messageEntryId, callId, toolName }) => ({
					requestId: identityRequestId,
					assistantMessageEntryId: messageEntryId,
					callId,
					toolName,
				}),
			),
		);
		// Emission-order announcement for the whole wave, before any body starts. A mutation tool only
		// reaches the mutation queue deep inside its own execute, so without this a sibling exclusive
		// run (bash, python) dispatched in the same batch takes the writer lock first and runs against
		// the pre-mutation workspace. Announcing every call -- not only the mutations -- is what lets
		// an exclusive run find its own emission index.
		const batchId = `${requestId}\u0000${assistantMessageEntryId}`;
		const mutationScope = this.deps.getMutationScope?.();
		const announcer = this.deps.getAnnouncer?.();
		for (const call of calls) {
			announceToolCall(call.callId, call.index, call.mutation, batchId, mutationScope, announcer);
		}
		for (const identity of identities) this.startedTools.set(this.toolKey(identity), identity);
		for (const identity of identities) {
			const callKey = this.callKey(identity.callId, identity.toolName);
			const pending = this.pendingToolsByCall.get(callKey) ?? new Set<string>();
			pending.add(this.toolKey(identity));
			this.pendingToolsByCall.set(callKey, pending);
		}
		signal?.throwIfAborted();
	}

	private toolKey(
		identity: Pick<StartedToolIdentity, "requestId" | "assistantMessageEntryId" | "callId" | "toolName">,
	): string {
		return [identity.requestId, identity.assistantMessageEntryId, identity.callId, identity.toolName].join("\u0000");
	}

	private callKey(callId: string, toolName: string): string {
		return `${callId}\u0000${toolName}`;
	}

	/** Called after the canonical message entry has been appended by AgentSession. */
	onMessagePersisted(message: AgentMessage, entryId: string): void {
		this.notePersistedMessage(message, entryId);
		if (message.role !== "toolResult") return;
		if (this.completedResultMessages.has(message)) return;
		const result = message as ToolResultMessage;
		// Durable terminal for the emission-order announcement. ToolGateController already retires it
		// at the execution terminal; this covers a reserved call that never reached execution at all.
		retireToolCall(result.toolCallId, this.deps.getMutationScope?.());
		const pending = this.pendingToolsByCall.get(this.callKey(result.toolCallId, result.toolName));
		if (pending?.size !== 1) return;
		const key = pending.values().next().value as string;
		const identity = this.startedTools.get(key);
		if (!identity) return;
		const metadata = result.isError
			? { resultMessageEntryId: entryId, errorKind: result.errorKind ?? "tool_failure" }
			: { resultMessageEntryId: entryId };
		this.deps.sessionManager.appendForegroundToolTerminal(
			identity.requestId,
			identity.assistantMessageEntryId,
			identity.callId,
			identity.toolName,
			outcomeForToolResult(result),
			metadata,
		);
		this.completedResultMessages.add(message);
		this.startedTools.delete(key);
		this.pendingToolsByCall.delete(this.callKey(result.toolCallId, result.toolName));
	}

	/**
	 * Repair incomplete lifecycle records on construction/reload. The active branch is inspected first;
	 * duplicate, mismatched, or out-of-order records are left untouched and reported rather than guessed.
	 */
	repair(): string[] {
		const inspection = this.deps.sessionManager.inspectSessionLifecycle();
		if (isAmbiguousInspection(inspection)) {
			const warning = boundedWarning(
				"Session lifecycle repair refused: duplicate, mismatched, or out-of-order records require manual review.",
			);
			this.deps.emitWarning(warning);
			return [warning];
		}
		const plan = this.deps.sessionManager.planSessionLifecycleRepair();
		const index = this.deps.sessionManager.getSessionLifecycleIndex();
		const warnings: string[] = [];
		for (const closer of plan.toolClosers) {
			const record = index.toolsByIdentity.get(
				sessionLifecycleToolIdentityKey(closer.requestId, closer.assistantMessageEntryId, closer.callId),
			);
			const call = record?.assistantCalls[0];
			if (!call) continue;
			const synthetic = this.appendRepairResult(closer.toolName, closer.callId, closer.code);
			if (closer.sourceEntryId && closer.requestId !== undefined) {
				this.deps.sessionManager.appendForegroundToolTerminal(
					closer.requestId,
					closer.assistantMessageEntryId,
					closer.callId,
					closer.toolName,
					"error",
					{ resultMessageEntryId: synthetic, errorKind: "tool_failure" },
				);
			}
		}
		for (const promotion of plan.terminalPromotions) {
			const record = index.toolsByIdentity.get(
				sessionLifecycleToolIdentityKey(promotion.requestId, promotion.assistantMessageEntryId, promotion.callId),
			);
			// A canonical immediate result has no foreground start and must remain terminal-free.
			if (!record?.start) continue;
			if (promotion.requestId === undefined) continue;
			this.deps.sessionManager.appendForegroundToolTerminal(
				promotion.requestId,
				promotion.assistantMessageEntryId,
				promotion.callId,
				promotion.toolName,
				promotion.outcome,
				{
					resultMessageEntryId: promotion.resultMessageEntryId,
					...(promotion.errorKind === undefined ? {} : { errorKind: promotion.errorKind }),
				},
			);
		}
		for (const closer of plan.compactionClosers) {
			this.deps.sessionManager.appendCompactionEnd(closer.compactionId, "interrupted", {
				error: "Compaction was interrupted before its terminal outcome was recorded.",
			});
		}
		if (plan.toolClosers.length > 0 || plan.terminalPromotions.length > 0 || plan.compactionClosers.length > 0) {
			this.deps.agent.state.messages = this.deps.sessionManager.buildSessionContext().messages;
			// Crash-recovery repair rebuilds in-memory state from durable storage at startup, the same
			// "session load" case Agent.resetSanitizerPrefixHorizon's doc comment calls out.
			this.deps.agent.resetSanitizerPrefixHorizon();
		}
		for (const warning of warnings) this.deps.emitWarning(warning);
		return warnings;
	}

	private appendRepairResult(toolName: string, callId: string, code: string): string {
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: callId,
			toolName,
			content: [
				{
					type: "text",
					text:
						code === "TOOL_NOT_STARTED"
							? "The harness recorded that this tool call was never started. Treat it as not run and decide whether to retry."
							: "The harness recorded that the tool outcome is unknown after interruption. Inspect the workspace before retrying or claiming completion.",
				},
			],
			isError: true,
			errorKind: "tool_failure",
			timestamp: Date.now(),
		};
		return this.appendMessage(message);
	}
}
