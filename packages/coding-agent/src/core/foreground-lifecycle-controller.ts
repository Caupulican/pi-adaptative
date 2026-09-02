import { createHash } from "node:crypto";
import type { Agent, AgentMessage } from "@caupulican/pi-agent-core";
import type {
	RequestSnapshotEntry,
	SessionLifecycleInspection,
	SessionManager,
} from "@caupulican/pi-agent-core/session";
import { sessionLifecycleToolIdentityKey } from "@caupulican/pi-agent-core/session";
import type { ProviderRequestSnapshotContext, ToolCallStartContext } from "@caupulican/pi-agent-core/types";
import type { Api, AssistantMessage, Message, Model, ToolResultMessage } from "@caupulican/pi-ai";
import type { ModelRouterController } from "./model-router-controller.ts";
import { dumpProviderRequest } from "./request-dump.ts";

const MAX_MESSAGE_ENTRY_IDS = 256;
/**
 * Durable, per-request record of which transport actually carried a provider request and whether
 * the WebSocket `previous_response_id` delta continuation engaged or fell back to a full send —
 * the turn-economics transport-telemetry investigation. Diagnostic only, keyed by `requestId` so
 * it can be joined against the `request_snapshot` entry the same request already produced; never
 * read by any runtime decision.
 */
export const PROVIDER_TRANSPORT_TELEMETRY_CUSTOM_TYPE = "provider_transport_telemetry";
const MAX_WARNING_LENGTH = 500;
const MAX_EXACT_FINGERPRINT_CHARS = 32 * 1024;
const MAX_FINGERPRINT_DEPTH = 16;
const MAX_FINGERPRINT_ITEMS = 256;
const MAX_FINGERPRINT_STRING_CHARS = 16 * 1024;
const MAX_PROVIDER_HISTORY_MESSAGES = 256;
const MAX_LIFECYCLE_ANCESTRY_STEPS = 4096;

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

interface FingerprintBudget {
	remaining: number;
	seen: WeakSet<object>;
}

function boundedObjectKeys(record: Record<string, unknown>): { keys: string[]; truncated: boolean } {
	const keys: string[] = [];
	let truncated = false;
	for (const key in record) {
		if (!Object.hasOwn(record, key)) continue;
		if (keys.length >= MAX_FINGERPRINT_ITEMS) {
			truncated = true;
			break;
		}
		keys.push(key);
	}
	keys.sort();
	return { keys, truncated };
}

/**
 * Canonicalize only bounded provider metadata. The system/tool envelope is allowed to retain exact
 * values within the explicit cap; history is represented by descriptors below so a disk-backed or
 * very long context is never copied into a second full object graph just to fingerprint it.
 */
function canonicalizeBounded(value: unknown, budget: FingerprintBudget, depth = 0): unknown {
	if (budget.remaining <= 0) return "[truncated]";
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		const limit = Math.min(MAX_FINGERPRINT_STRING_CHARS, budget.remaining);
		budget.remaining -= Math.min(value.length, limit);
		return value.length <= limit ? value : `${value.slice(0, limit)}…<${value.length}>`;
	}
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "undefined") return "[undefined]";
	if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
	if (typeof value !== "object") return String(value);
	if (depth >= MAX_FINGERPRINT_DEPTH) return `[depth:${depth}]`;
	if (budget.seen.has(value)) return "[circular]";
	budget.seen.add(value);
	if (Array.isArray(value)) {
		const result: unknown[] = [];
		for (let index = 0; index < Math.min(value.length, MAX_FINGERPRINT_ITEMS); index += 1) {
			result.push(canonicalizeBounded(value[index], budget, depth + 1));
			if (budget.remaining <= 0) break;
		}
		if (value.length > result.length) result.push(`[items:${value.length}]`);
		return result;
	}
	const record = value as Record<string, unknown>;
	const { keys, truncated } = boundedObjectKeys(record);
	const result: Record<string, unknown> = {};
	for (const key of keys) {
		const keyLimit = Math.min(key.length, budget.remaining, MAX_FINGERPRINT_STRING_CHARS);
		const boundedKey = key.length <= keyLimit ? key : `${key.slice(0, keyLimit)}…<${key.length}>`;
		budget.remaining -= Math.min(key.length, keyLimit);
		result[boundedKey] = canonicalizeBounded(record[key], budget, depth + 1);
		if (budget.remaining <= 0) break;
	}
	if (truncated) result["[keys]"] = `>${MAX_FINGERPRINT_ITEMS}`;
	return result;
}

function fingerprint(value: unknown, maxChars = MAX_EXACT_FINGERPRINT_CHARS): string {
	const serialized = JSON.stringify(canonicalizeBounded(value, { remaining: maxChars, seen: new WeakSet() }));
	return createHash("sha256").update(serialized.slice(0, maxChars)).digest("hex");
}

/**
 * The system prompt is the same string on nearly every request and the tool surface the same
 * projected objects (see provider-tool-projection), yet both were canonicalized and hashed in full
 * per request: with the history metadata memoized, they were the whole of the fingerprint cost.
 * The prompt is remembered by value (one comparison of the last string seen); each tool by identity.
 * The tools fingerprint covers every tool through its own bounded fingerprint, where the single
 * bounded pass over the whole array stopped at the character budget.
 */
let lastSystemPromptFingerprint: { readonly prompt: unknown; readonly value: string } | undefined;
function systemPromptFingerprint(prompt: unknown): string {
	if (lastSystemPromptFingerprint && lastSystemPromptFingerprint.prompt === prompt)
		return lastSystemPromptFingerprint.value;
	const value = fingerprint(prompt);
	lastSystemPromptFingerprint = { prompt, value };
	return value;
}

const toolFingerprints = new WeakMap<object, string>();
function toolsFingerprint(tools: readonly unknown[]): string {
	const perTool = tools.map((tool) => {
		if (!tool || typeof tool !== "object") return fingerprint(tool);
		const cached = toolFingerprints.get(tool);
		if (cached) return cached;
		const value = fingerprint(tool);
		toolFingerprints.set(tool, value);
		return value;
	});
	return fingerprint(perTool);
}

function contentDescriptor(content: unknown): unknown {
	if (typeof content === "string") {
		return { kind: "text", length: content.length, fingerprint: fingerprint(content) };
	}
	if (!Array.isArray(content)) return { kind: typeof content };
	return content.slice(0, MAX_FINGERPRINT_ITEMS).map((block) => {
		if (!block || typeof block !== "object") return { kind: typeof block };
		const candidate = block as Record<string, unknown>;
		const descriptor: Record<string, unknown> = { type: candidate.type ?? "unknown" };
		for (const key of ["id", "name", "toolCallId", "toolName"] as const) {
			if (typeof candidate[key] === "string") descriptor[key] = candidate[key];
		}
		for (const key of ["text", "thinking", "arguments", "data"] as const) {
			const field = candidate[key];
			if (typeof field === "string") {
				descriptor[`${key}Length`] = field.length;
				descriptor[`${key}Fingerprint`] = fingerprint(field);
			} else if (field !== undefined) {
				descriptor[`${key}Type`] = typeof field;
				descriptor[`${key}Fingerprint`] = fingerprint(field);
			}
		}
		return descriptor;
	});
}

/**
 * Per-message metadata by message identity. The history fingerprint samples a bounded window of
 * messages, but each sampled message is canonicalized and hashed field by field, and the window's
 * head is the same objects request after request; memoizing the descriptor makes that cost
 * proportional to messages not seen before. Messages are immutable once built.
 */
const providerMessageMetadata = new WeakMap<object, unknown>();

function providerMessageDescriptor(message: object): unknown {
	const cached = providerMessageMetadata.get(message);
	if (cached !== undefined) return cached;
	const candidate = message as Record<string, unknown>;
	const entry: Record<string, unknown> = {
		role: candidate.role,
		content: contentDescriptor(candidate.content),
	};
	for (const key of ["id", "callId", "toolCallId", "toolName", "provider", "model"] as const) {
		if (typeof candidate[key] === "string") entry[key] = candidate[key];
	}
	providerMessageMetadata.set(message, entry);
	return entry;
}

const messageFingerprints = new WeakMap<object, string>();

function messageFingerprint(message: unknown): string {
	if (!message || typeof message !== "object") return fingerprint({ type: typeof message });
	const cached = messageFingerprints.get(message);
	if (cached) return cached;
	const value = fingerprint(providerMessageDescriptor(message));
	messageFingerprints.set(message, value);
	return value;
}

/**
 * Fingerprint of a bounded window of the history: the first quarter of the window budget and the
 * newest messages up to it, plus the counts. Each sampled message contributes its own memoized
 * fingerprint and the window digests those, so a request hashes a few kilobytes of digests and
 * canonicalizes nothing it has seen before; canonicalizing the window's descriptors afresh on every
 * request was the single largest per-request cost left in the host at 1,500 turns.
 */
function historyFingerprint(messages: readonly unknown[]): string {
	const firstCount = Math.min(messages.length, Math.floor(MAX_PROVIDER_HISTORY_MESSAGES / 4));
	const indexes =
		messages.length <= MAX_PROVIDER_HISTORY_MESSAGES
			? Array.from({ length: messages.length }, (_, index) => index)
			: [
					...Array.from({ length: firstCount }, (_, index) => index),
					...Array.from(
						{ length: MAX_PROVIDER_HISTORY_MESSAGES - firstCount },
						(_, index) => messages.length - (MAX_PROVIDER_HISTORY_MESSAGES - firstCount) + index,
					),
				];
	const digest = createHash("sha256").update(`${messages.length}\0${Math.max(0, messages.length - indexes.length)}\0`);
	for (const index of indexes) digest.update(messageFingerprint(messages[index])).update("\0");
	return digest.digest("hex");
}

function messageEntryIds(sessionManager: SessionManager): string[] {
	const ids: string[] = [];
	let entry = sessionManager.getLeafEntry();
	let steps = 0;
	while (entry && ids.length < MAX_MESSAGE_ENTRY_IDS && steps < MAX_LIFECYCLE_ANCESTRY_STEPS) {
		if (entry.type === "message") ids.push(entry.id);
		entry = entry.parentId === null ? undefined : sessionManager.getEntry(entry.parentId);
		steps += 1;
	}
	return ids.reverse();
}

function latestRequestSnapshot(sessionManager: SessionManager): RequestSnapshotEntry | undefined {
	let entry = sessionManager.getLeafEntry();
	let steps = 0;
	while (entry && steps < MAX_LIFECYCLE_ANCESTRY_STEPS) {
		if (entry.type === "request_snapshot") return entry;
		entry = entry.parentId === null ? undefined : sessionManager.getEntry(entry.parentId);
		steps += 1;
	}
	return undefined;
}

function modelRef(model: Model<Api>): { api: string; provider: string; modelId: string } {
	return { api: model.api, provider: model.provider, modelId: model.id };
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
		this.startedTools.clear();
		this.pendingToolsByCall.clear();
	}

	private findPersistedMessageEntryId(message: AgentMessage): string | undefined {
		return this.persistedMessages.get(message);
	}

	private requestReason(model: Model<Api>): "initial" | "resume" | "change" {
		const latest = latestRequestSnapshot(this.deps.sessionManager);
		if (!latest) return "initial";
		return latest.api !== model.api || latest.provider !== model.provider || latest.modelId !== model.id
			? "change"
			: "resume";
	}

	private async onProviderRequestSnapshot(
		context: ProviderRequestSnapshotContext,
		signal?: AbortSignal,
	): Promise<void> {
		signal?.throwIfAborted();
		const flushed = this.deps.modelRouter.commitSessionBufferPrefix();
		for (const [message, entryId] of flushed) this.notePersistedMessage(message, entryId);
		const model = context.model as Model<Api>;
		const ref = modelRef(model);
		const requestId = context.requestId;
		this.lastRequestId = requestId;
		this.deps.sessionManager.appendRequestSnapshot({
			requestId,
			reason: this.requestReason(model),
			api: ref.api,
			provider: ref.provider,
			modelId: ref.modelId,
			effectiveConfigFingerprint: fingerprint({
				model: ref,
				reasoning: context.reasoning,
				maxTokens: context.maxTokens,
				attempt: context.attempt,
			}),
			systemFingerprint: systemPromptFingerprint(context.context.systemPrompt),
			toolsFingerprint: toolsFingerprint(context.context.tools ?? []),
			historyFingerprint: historyFingerprint(context.context.messages),
			messageEntryIds: messageEntryIds(this.deps.sessionManager),
		});
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
		const pending = this.pendingToolsByCall.get(this.callKey(result.toolCallId, result.toolName));
		if (!pending || pending.size !== 1) return;
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
