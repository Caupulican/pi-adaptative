import { createHash } from "node:crypto";
import type {
	RequestSnapshotEntry,
	SessionManager,
	SessionRequestSnapshotInput,
} from "@caupulican/pi-agent-core/session";
import type { ProviderRequestSnapshotContext } from "@caupulican/pi-agent-core/types";
import type { Api, Model } from "@caupulican/pi-ai";

/**
 * Bounded fingerprints for `request_snapshot` entries, shared by the owner session's foreground
 * lifecycle boundary and by worker conversations. A snapshot summarizes what a provider request
 * carried (system prompt, tool surface, history shape, effective config) without persisting any
 * of its content, so two consecutive snapshots can be diffed to explain a cache miss and a census
 * can join a request's start time to the assistant message it produced. Every helper here is a
 * pure function of its inputs; the memo tables key on object identity and are safe to share.
 */

const MAX_MESSAGE_ENTRY_IDS = 256;
const MAX_EXACT_FINGERPRINT_CHARS = 32 * 1024;
const MAX_FINGERPRINT_DEPTH = 16;
const MAX_FINGERPRINT_ITEMS = 256;
const MAX_FINGERPRINT_STRING_CHARS = 16 * 1024;
const MAX_PROVIDER_HISTORY_MESSAGES = 256;
export const MAX_LIFECYCLE_ANCESTRY_STEPS = 4096;

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

export function fingerprint(value: unknown, maxChars = MAX_EXACT_FINGERPRINT_CHARS): string {
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
export function systemPromptFingerprint(prompt: unknown): string {
	if (lastSystemPromptFingerprint && lastSystemPromptFingerprint.prompt === prompt)
		return lastSystemPromptFingerprint.value;
	const value = fingerprint(prompt);
	lastSystemPromptFingerprint = { prompt, value };
	return value;
}

const toolFingerprints = new WeakMap<object, string>();
export function toolsFingerprint(tools: readonly unknown[]): string {
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
export function historyFingerprint(messages: readonly unknown[]): string {
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

export function messageEntryIds(sessionManager: SessionManager): string[] {
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

export function latestRequestSnapshot(sessionManager: SessionManager): RequestSnapshotEntry | undefined {
	let entry = sessionManager.getLeafEntry();
	let steps = 0;
	while (entry && steps < MAX_LIFECYCLE_ANCESTRY_STEPS) {
		if (entry.type === "request_snapshot") return entry;
		entry = entry.parentId === null ? undefined : sessionManager.getEntry(entry.parentId);
		steps += 1;
	}
	return undefined;
}

export function modelRef(model: Model<Api>): { api: string; provider: string; modelId: string } {
	return { api: model.api, provider: model.provider, modelId: model.id };
}

/**
 * Why this request is being recorded relative to the session's previous one: the first request of
 * the session, a resumption on the same model, or a change of model. Identical for an owner
 * session and a worker conversation, so both derive it here.
 */
export function requestSnapshotReason(
	sessionManager: SessionManager,
	model: Model<Api>,
): RequestSnapshotEntry["reason"] {
	const latest = latestRequestSnapshot(sessionManager);
	if (!latest) return "initial";
	return latest.api !== model.api || latest.provider !== model.provider || latest.modelId !== model.id
		? "change"
		: "resume";
}

/**
 * The complete `request_snapshot` input for one accepted provider request against the session that
 * will hold it. The owner lifecycle boundary and worker conversations call this with their own
 * session manager so the two record shapes can never drift apart.
 */
export function buildRequestSnapshotInput(
	context: ProviderRequestSnapshotContext,
	sessionManager: SessionManager,
): SessionRequestSnapshotInput {
	const model = context.model as Model<Api>;
	const ref = modelRef(model);
	return {
		requestId: context.requestId,
		reason: requestSnapshotReason(sessionManager, model),
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
		messageEntryIds: messageEntryIds(sessionManager),
		...(typeof context.reasoning === "string" ? { reasoning: context.reasoning } : {}),
	};
}
