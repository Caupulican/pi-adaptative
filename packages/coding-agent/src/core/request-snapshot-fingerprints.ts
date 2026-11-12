import { createHash } from "node:crypto";
import type { Api, Model } from "@caupulican/pi-ai";
import type { ProviderRequestSnapshotContext } from "../kernel/index.ts";
import { messageContentRevision } from "../kernel/message-revision.ts";
import type { RequestSnapshotEntry } from "../kernel/session/session-entries.ts";
import type { SessionManager, SessionRequestSnapshotInput } from "../kernel/session/session-manager.ts";
import { cacheLaneKey } from "./context/cache-observation-recorder.ts";

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
const MAX_EXACT_PROOF_DEPTH = 64;
const MAX_EXACT_PROOF_NODES = 100_000;
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

/** A message's provider-visible content identity (role, content, ids), memoized by object. */
export function messageFingerprint(message: unknown): string {
	if (!message || typeof message !== "object") return fingerprint({ type: typeof message });
	const cached = messageFingerprints.get(message);
	if (cached) return cached;
	const value = fingerprint(providerMessageDescriptor(message));
	messageFingerprints.set(message, value);
	return value;
}

interface ExactProofBudget {
	remainingNodes: number;
	stack: WeakSet<object>;
}

/**
 * Hash provider JSON bytes without retaining them. This intentionally preserves enumerable key order:
 * argument-object key order is visible in serialized tool-call arguments. Unsupported values and
 * pathological structures fail closed instead of receiving a partial digest.
 */
function updateExactProviderJson(
	hash: ReturnType<typeof createHash>,
	value: unknown,
	budget: ExactProofBudget,
	depth = 0,
	arrayElement = false,
): boolean {
	budget.remainingNodes -= 1;
	if (budget.remainingNodes < 0 || depth > MAX_EXACT_PROOF_DEPTH) return false;
	if (value === null) {
		hash.update("null");
		return true;
	}
	if (typeof value === "string" || typeof value === "boolean") {
		hash.update(JSON.stringify(value));
		return true;
	}
	if (typeof value === "number") {
		hash.update(JSON.stringify(Number.isFinite(value) ? value : null));
		return true;
	}
	if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
		if (!arrayElement) return false;
		hash.update("null");
		return true;
	}
	if (typeof value !== "object") return false;
	if (budget.stack.has(value)) return false;
	if ("toJSON" in value) return false;
	if (Array.isArray(value)) {
		if (Object.getPrototypeOf(value) !== Array.prototype) return false;
		budget.stack.add(value);
		hash.update("[");
		for (let index = 0; index < value.length; index += 1) {
			if (index > 0) hash.update(",");
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
			if (!descriptor || !("value" in descriptor)) return false;
			if (!updateExactProviderJson(hash, descriptor.value, budget, depth + 1, true)) return false;
		}
		hash.update("]");
		budget.stack.delete(value);
		return true;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	budget.stack.add(value);
	hash.update("{");
	let emitted = false;
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		budget.remainingNodes -= 1;
		if (budget.remainingNodes < 0) return false;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable) continue;
		if (!("value" in descriptor)) return false;
		const field = descriptor.value;
		if (field === undefined || typeof field === "function" || typeof field === "symbol") continue;
		if (emitted) hash.update(",");
		emitted = true;
		hash.update(JSON.stringify(key)).update(":");
		if (!updateExactProviderJson(hash, field, budget, depth + 1)) return false;
	}
	hash.update("}");
	budget.stack.delete(value);
	return true;
}

export function exactProviderFingerprint(value: unknown): string | undefined {
	const hash = createHash("sha256");
	try {
		return updateExactProviderJson(hash, value, { remainingNodes: MAX_EXACT_PROOF_NODES, stack: new WeakSet() })
			? hash.digest("hex")
			: undefined;
	} catch {
		return undefined;
	}
}

let lastExactSystemPromptFingerprint: { readonly prompt: unknown; readonly value: string | undefined } | undefined;

function exactSystemPromptFingerprint(prompt: unknown): string | undefined {
	if (lastExactSystemPromptFingerprint && lastExactSystemPromptFingerprint.prompt === prompt)
		return lastExactSystemPromptFingerprint.value;
	const value = exactProviderFingerprint(prompt);
	lastExactSystemPromptFingerprint = { prompt, value };
	return value;
}

const exactToolFingerprints = new WeakMap<object, string | undefined>();

function exactToolsFingerprint(tools: readonly unknown[]): string | undefined {
	const hash = createHash("sha256").update(`${tools.length}\0`);
	for (const tool of tools) {
		if (!tool || typeof tool !== "object") return undefined;
		let exact = exactToolFingerprints.get(tool);
		if (exact === undefined && !exactToolFingerprints.has(tool)) {
			exact = exactProviderFingerprint(tool);
			exactToolFingerprints.set(tool, exact);
		}
		if (exact === undefined) return undefined;
		hash.update(`${exact.length}:`).update(exact);
	}
	return hash.digest("hex");
}

const exactMessageFingerprints = new WeakMap<
	object,
	{ readonly revision: number; readonly value: string | undefined }
>();

export function exactMessageFingerprint(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return exactProviderFingerprint(message);
	const revision = messageContentRevision(message);
	const cached = exactMessageFingerprints.get(message);
	if (cached?.revision === revision) return cached.value;
	const value = exactProviderFingerprint(message);
	exactMessageFingerprints.set(message, { revision, value });
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

/** What one lane's previous request sent, kept in memory to compare the next request against. */
export interface LaneRequestPrefix {
	readonly system: string;
	readonly exactSystem?: string;
	readonly tools: string;
	readonly exactTools?: string;
	readonly reasoning: string;
	readonly messages: readonly string[];
	readonly exactMessages: readonly (string | undefined)[];
	readonly requestOnlyMessageRange?: { readonly start: number; readonly count: number };
}

/** Per session log and lane (api, provider, model): the last request's prefix. Process-local by design. */
const lanePrefixes = new WeakMap<SessionManager, Map<string, LaneRequestPrefix>>();

export interface RequestPrefixDivergence {
	readonly prefixIntact: boolean | "unknown";
	readonly firstDivergentIndex?: number;
	readonly firstDivergentKind?: string;
	readonly requestOnlyProjectionReplacement?: true;
}

function messageKind(message: unknown): string {
	if (!message || typeof message !== "object") return "unknown";
	const candidate = message as { role?: unknown; customType?: unknown };
	if (candidate.role === "custom" && typeof candidate.customType === "string") return `custom:${candidate.customType}`;
	return typeof candidate.role === "string" ? candidate.role : "unknown";
}

/**
 * Compare a request's provider-visible prefix with the previous request's on the same lane: intact when
 * the system prompt, the tools and every message the previous request sent are unchanged and in place.
 * The first difference names what broke the cache: the system prompt, the tools, a removed message, or
 * the role (or record kind) of the first rewritten message.
 */
function compareRequestPrefixStrict(
	previous: LaneRequestPrefix | undefined,
	current: LaneRequestPrefix,
	messages: readonly unknown[],
): RequestPrefixDivergence {
	if (!previous) return { prefixIntact: "unknown" };
	if (
		previous.exactSystem !== undefined && current.exactSystem !== undefined
			? previous.exactSystem !== current.exactSystem
			: previous.system !== current.system
	)
		return { prefixIntact: false, firstDivergentIndex: -1, firstDivergentKind: "system" };
	if (
		previous.exactTools !== undefined && current.exactTools !== undefined
			? previous.exactTools !== current.exactTools
			: previous.tools !== current.tools
	)
		return { prefixIntact: false, firstDivergentIndex: -1, firstDivergentKind: "tools" };
	for (let index = 0; index < previous.messages.length; index++) {
		if (index >= current.messages.length)
			return { prefixIntact: false, firstDivergentIndex: index, firstDivergentKind: "removed" };
		const previousExact = previous.exactMessages[index];
		const currentExact = current.exactMessages[index];
		const differs =
			previousExact !== undefined && currentExact !== undefined
				? previousExact !== currentExact
				: previous.messages[index] !== current.messages[index];
		if (differs) {
			return { prefixIntact: false, firstDivergentIndex: index, firstDivergentKind: messageKind(messages[index]) };
		}
	}
	return { prefixIntact: true };
}

function rangeIsValid(
	range: LaneRequestPrefix["requestOnlyMessageRange"],
	messageCount: number,
): range is { readonly start: number; readonly count: number } {
	if (!range) return false;
	const end = range.start + range.count;
	return (
		Number.isSafeInteger(range.start) &&
		range.start >= 0 &&
		Number.isSafeInteger(range.count) &&
		range.count >= 0 &&
		Number.isSafeInteger(end) &&
		end <= messageCount
	);
}

function requestOnlyProjectionIsOnlyChange(previous: LaneRequestPrefix, current: LaneRequestPrefix): boolean {
	const previousRange = previous.requestOnlyMessageRange;
	const currentRange = current.requestOnlyMessageRange;
	if (
		previous.exactSystem === undefined ||
		current.exactSystem === undefined ||
		previous.exactSystem !== current.exactSystem ||
		previous.exactTools === undefined ||
		current.exactTools === undefined ||
		previous.exactTools !== current.exactTools ||
		previous.reasoning !== current.reasoning ||
		!rangeIsValid(previousRange, previous.exactMessages.length) ||
		!rangeIsValid(currentRange, current.exactMessages.length) ||
		previousRange.start !== currentRange.start
	) {
		return false;
	}
	const previousProjection = previous.exactMessages.slice(
		previousRange.start,
		previousRange.start + previousRange.count,
	);
	const currentProjection = current.exactMessages.slice(currentRange.start, currentRange.start + currentRange.count);
	if (
		previousProjection.length === currentProjection.length &&
		previousProjection.every((value, index) => value === currentProjection[index])
	)
		return false;
	const previousHistory = [
		...previous.exactMessages.slice(0, previousRange.start),
		...previous.exactMessages.slice(previousRange.start + previousRange.count),
	];
	const currentHistory = [
		...current.exactMessages.slice(0, currentRange.start),
		...current.exactMessages.slice(currentRange.start + currentRange.count),
	];
	return previousHistory.every((value, index) => value !== undefined && currentHistory[index] === value);
}

export function compareRequestPrefix(
	previous: LaneRequestPrefix | undefined,
	current: LaneRequestPrefix,
	messages: readonly unknown[],
): RequestPrefixDivergence {
	const divergence = compareRequestPrefixStrict(previous, current, messages);
	return divergence.prefixIntact === false &&
		previous !== undefined &&
		requestOnlyProjectionIsOnlyChange(previous, current)
		? { ...divergence, requestOnlyProjectionReplacement: true }
		: divergence;
}

function requestPrefixDivergence(
	sessionManager: SessionManager,
	lane: string,
	current: LaneRequestPrefix,
	messages: readonly unknown[],
): RequestPrefixDivergence {
	let lanes = lanePrefixes.get(sessionManager);
	if (!lanes) {
		lanes = new Map();
		lanePrefixes.set(sessionManager, lanes);
	}
	const divergence = compareRequestPrefix(lanes.get(lane), current, messages);
	lanes.set(lane, current);
	return divergence;
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
	const systemFingerprint = systemPromptFingerprint(context.context.systemPrompt);
	const tools = toolsFingerprint(context.context.tools ?? []);
	const exactSystem = exactSystemPromptFingerprint(context.context.systemPrompt);
	const exactTools = exactToolsFingerprint(context.context.tools ?? []);
	const requestOnlyMessageRange = context.requestOnlyMessageRange;
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
		systemFingerprint,
		toolsFingerprint: tools,
		historyFingerprint: historyFingerprint(context.context.messages),
		messageEntryIds: messageEntryIds(sessionManager),
		...(typeof context.reasoning === "string" ? { reasoning: context.reasoning } : {}),
		...requestPrefixDivergence(
			sessionManager,
			cacheLaneKey(ref.api, ref.provider, ref.modelId),
			{
				system: systemFingerprint,
				...(exactSystem !== undefined ? { exactSystem } : {}),
				tools,
				...(exactTools !== undefined ? { exactTools } : {}),
				reasoning: fingerprint(context.reasoning),
				messages: context.context.messages.map(messageFingerprint),
				exactMessages: context.context.messages.map(exactMessageFingerprint),
				...(requestOnlyMessageRange ? { requestOnlyMessageRange } : {}),
			},
			context.context.messages,
		),
		messageCount: context.context.messages.length,
	};
}
