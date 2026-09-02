import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import { PrefixFold } from "@caupulican/pi-agent-core";
import { estimateTokens } from "@caupulican/pi-agent-core/compaction/compaction";
import type { ToolResultMessage } from "@caupulican/pi-ai";
import { normalizePath } from "../utils/paths.ts";
import { quantizeRecentBoundary, resolveRecentBoundaryStride } from "./context/prefix-stability.ts";
import { boundedTextPreview } from "./text-preview.ts";
import { writeFileAtomicSync } from "./util/atomic-file.ts";

export interface SemanticMemoryGcSettings {
	enabled?: boolean;
	/** Number of newest Automata/Mind injected pages to preserve verbatim. */
	preserveRecentPages?: number;
	/** Minimum provider-visible text chars before a stale semantic memory page is packed. */
	minChars?: number;
	/** Markers that identify deterministic Automata/Mind context pages. */
	markers?: string[];
}

export interface ContextGcSettings {
	enabled?: boolean;
	/** Number of most recent AgentMessage rows to preserve verbatim. */
	preserveRecentMessages?: number;
	/**
	 * Grid the preserve-recent boundary advances on, in messages. Packing rewrites history in
	 * place, so a boundary that moves every turn re-prefills the conversation tail on every
	 * provider request; quantizing batches those rewrites onto a grid and leaves the prefix
	 * byte-identical in between (see context/prefix-stability.ts). Defaults to half the window;
	 * 1 restores continuous, pack-as-soon-as-it-ages behavior.
	 */
	packStrideMessages?: number;
	/** Minimum provider-visible text chars before a stale tool result is packed. */
	minToolResultChars?: number;
	/** Tool names eligible for stale result packing. */
	tools?: string[];
	/** Provider-context control for deterministic Automata/Mind semantic memory pages. */
	semanticMemory?: SemanticMemoryGcSettings;
}

export interface NormalizedContextGcSettings extends Omit<Required<ContextGcSettings>, "semanticMemory"> {
	semanticMemory: Required<SemanticMemoryGcSettings>;
}

/**
 * Brain-curation hooks (both optional; absent hooks are byte-for-byte today's behavior).
 * `resolveDigest` is a pure lookup keyed by the record's content hash — it must return the digest
 * already fenced in the untrusted-content boundary (e.g. BrainCurator.getDigest), with the fence's
 * nonce fixed once at store time, since GC re-renders the stub from raw messages on every request
 * and renders the returned string VERBATIM. `onPacked` lets the caller enqueue digest work with the
 * exact original text at the moment it is packed.
 */
export interface ContextGcCurationHooks {
	resolveDigest?: (digestKey: string) => string | undefined;
	onPacked?: (record: ContextGcPackedRecord, originalText: string) => void;
}

export interface ContextGcOptions extends NormalizedContextGcSettings {
	cwd: string;
	storageDir?: string;
	/** Acquire the leased store only when an eligible payload is actually written. */
	acquireStorageDir?: () => string;
	writePayloads?: boolean;
	curation?: ContextGcCurationHooks;
	/**
	 * Messages at this index and above are eligible for packing; every index strictly below it has
	 * already gone out on an accepted provider request and packing must never rewrite it (see
	 * `context/prefix-stability.ts`'s `frozenPrefixLength`, which derives this value from the
	 * request's `sentPrefixCount`). Always populated by `applyContextGc` below (clamped from its own
	 * optional `frozenBelow` input, defaulting to 0 — no freeze — for callers outside the live
	 * provider-request path); never constructed elsewhere, so this stays a definite number.
	 */
	frozenBelow: number;
}

export interface ContextGcPackedRecord {
	toolName: string;
	toolCallId: string;
	messageIndex: number;
	reason: "superseded-read" | "stale-tool-result" | "stale-semantic-memory";
	originalChars: number;
	originalTokens: number;
	packedTokens: number;
	storagePath?: string;
	path?: string;
	command?: string;
	key?: string;
	/** Brain-curator semantic digest of the packed content (model-generated; advisory only). Arrives
	 * already fenced in the untrusted-content boundary (see ContextGcCurationHooks.resolveDigest) —
	 * render verbatim, never re-wrap. */
	digest?: string;
}

export interface ContextGcReport {
	enabled: boolean;
	packedCount: number;
	originalTokens: number;
	packedTokens: number;
	savedTokens: number;
	records: ContextGcPackedRecord[];
}

export interface ContextGcResult {
	messages: AgentMessage[];
	report: ContextGcReport;
	/**
	 * Whether a pass over the same messages now would pack them identically. The only input that can
	 * change underneath a plan between preview and commit is the curator digest a packed record
	 * renders, so this re-resolves exactly the digests the pass looked up and nothing else.
	 */
	isCurrent(): boolean;
	/**
	 * Store each packed original. Already done when the pass ran with `writePayloads`; otherwise
	 * deferred to here so a plan can be previewed, checked and committed from ONE pass instead of
	 * being recomputed per stage. (`curation.onPacked` fires during the pass, as it always has; a
	 * caller that wants it deferred collects in the hook and drains at its own commit.)
	 */
	commit(): void;
}

const DEFAULT_SEMANTIC_MEMORY_GC_SETTINGS: Required<SemanticMemoryGcSettings> = {
	enabled: true,
	preserveRecentPages: 1,
	minChars: 900,
	markers: [
		// Generic memory-subsystem recall page marker (brand-free). Provider-specific markers are
		// merged in dynamically at runtime via MemoryManager.getContextMarkers().
		"<memory_context",
		// Pre-existing provider-specific markers (to be generalized to provider-declared markers).
		"<automata_context",
		"<automata_response",
		"<automata_query",
		"<automata_fetch",
		"<memory_lifecycle_audit",
		"<memory_lifecycle_purge",
		"<automata_doctor",
		"<automata_optimizer",
		"<automata_mesh",
		// Injected task_steps checklist page (tasks/task-state.ts formatTaskStepsContext), re-derived
		// fresh every turn from live TaskStepsState -- same GC treatment as a memory recall page (Bug
		// #7 lineage): pack stale turn-copies down to the most recent one instead of accumulating.
		"<task_steps_context",
		"<pipeline_context",
	],
};

export const DEFAULT_CONTEXT_GC_SETTINGS: NormalizedContextGcSettings = {
	enabled: true,
	preserveRecentMessages: 24,
	packStrideMessages: resolveRecentBoundaryStride(24),
	minToolResultChars: 1200,
	tools: [
		"read",
		"bash",
		"python",
		"powershell",
		"rg",
		"grep",
		"find",
		"run_toolkit_script",
		"ls",
		"skill_open",
		"automata_graph_status",
		"automata_graph_search",
		"automata_graph_query",
		"automata_graph_neighbors",
		"automata_graph_path",
		"automata_graph_pointer_pack",
		"learning_query_memory",
		"subagent",
		"delegate",
		"task_steps",
		"pipeline",
		"task_background",
		"task_goal",
		"run_ledger",
		"context_headroom_retrieve",
		"headroom_retrieve",
	],
	semanticMemory: DEFAULT_SEMANTIC_MEMORY_GC_SETTINGS,
};

type ToolCallMeta = {
	id: string;
	name: string;
	args: Record<string, unknown>;
	messageIndex: number;
	/** The call's `path` argument resolved against the working directory, once, at plan time. */
	path?: string;
};

function normalizeSemanticMemoryGcSettings(settings?: SemanticMemoryGcSettings): Required<SemanticMemoryGcSettings> {
	return {
		enabled: settings?.enabled ?? DEFAULT_SEMANTIC_MEMORY_GC_SETTINGS.enabled,
		preserveRecentPages: Math.max(
			0,
			Math.floor(settings?.preserveRecentPages ?? DEFAULT_SEMANTIC_MEMORY_GC_SETTINGS.preserveRecentPages),
		),
		minChars: Math.max(0, Math.floor(settings?.minChars ?? DEFAULT_SEMANTIC_MEMORY_GC_SETTINGS.minChars)),
		markers:
			settings?.markers && settings.markers.length > 0
				? settings.markers
				: DEFAULT_SEMANTIC_MEMORY_GC_SETTINGS.markers,
	};
}

function normalizeContextGcSettings(settings?: ContextGcSettings): NormalizedContextGcSettings {
	const preserveRecentMessages = Math.max(
		0,
		Math.floor(settings?.preserveRecentMessages ?? DEFAULT_CONTEXT_GC_SETTINGS.preserveRecentMessages),
	);
	return {
		enabled: settings?.enabled ?? DEFAULT_CONTEXT_GC_SETTINGS.enabled,
		preserveRecentMessages,
		packStrideMessages: resolveRecentBoundaryStride(preserveRecentMessages, settings?.packStrideMessages),
		minToolResultChars: Math.max(
			0,
			Math.floor(settings?.minToolResultChars ?? DEFAULT_CONTEXT_GC_SETTINGS.minToolResultChars),
		),
		tools: settings?.tools && settings.tools.length > 0 ? settings.tools : DEFAULT_CONTEXT_GC_SETTINGS.tools,
		semanticMemory: normalizeSemanticMemoryGcSettings(settings?.semanticMemory),
	};
}

export function getContextGcSettings(settings?: ContextGcSettings): NormalizedContextGcSettings {
	return normalizeContextGcSettings(settings);
}

function textContentParts(content: unknown): string[] | undefined {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) return undefined;
		const typed = part as { type?: string; text?: string; mimeType?: string };
		if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
		else if (typed.type === "image") return undefined;
		else return undefined;
	}
	return parts;
}

function joinTextParts(parts: readonly string[]): string {
	if (parts.length === 0) return "";
	if (parts.length === 1) return parts[0];
	return parts.join("\n");
}

function contentText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	const parts = textContentParts(content);
	return parts ? joinTextParts(parts) : undefined;
}

function toolResultParts(message: ToolResultMessage): string[] {
	const parts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text" && part.text) parts.push(part.text);
		else if (part.type === "image") parts.push(`[image ${part.mimeType}]`);
	}
	return parts;
}

function toolResultText(message: ToolResultMessage): string {
	return joinTextParts(toolResultParts(message));
}

function smallStringSlice(value: string, start?: number, end?: number): string {
	const sliced = value.slice(start, end);
	return sliced ? ` ${sliced}`.slice(1) : "";
}

function joinedPartsContainMarker(parts: string[], marker: string): boolean {
	if (marker.length === 0) return true;
	const tailLength = marker.length - 1;
	let tail = "";
	let first = true;
	for (const part of parts) {
		if (part.includes(marker)) return true;
		if (!first && `${tail}\n${smallStringSlice(part, 0, tailLength)}`.includes(marker)) return true;
		if (tailLength === 0) tail = "";
		else if (part.length >= tailLength) tail = smallStringSlice(part, -tailLength);
		else tail = `${tail}${first ? "" : "\n"}${part}`.slice(-tailLength);
		first = false;
	}
	return false;
}

function joinedPartsContainAnyMarker(parts: string[], markers: readonly string[]): boolean {
	return markers.some((marker) => joinedPartsContainMarker(parts, marker));
}

// Gates which custom-message types are eligible for the semantic-memory packer below. Despite the
// name, this now also covers the injected task_steps checklist page (customType "task_steps_context",
// see agent-session.ts) -- it is a deterministic, re-derivable-from-live-state context page exactly
// like a memory recall page, so it gets the same GC treatment. A marker match alone
// is not enough: semanticMessageHasMarker/agentMessageText only inspect a custom message's text at all
// once it passes this gate, so a customType that doesn't match here never reaches the marker check.
function isSemanticMemoryCustomMessage(message: AgentMessage): boolean {
	if (message.role !== "custom") return false;
	const customType = String((message as { customType?: unknown }).customType ?? "").toLowerCase();
	return (
		customType.includes("automata") ||
		customType.includes("memory") ||
		customType.includes("mind") ||
		customType.includes("task_steps")
	);
}

function agentMessageText(message: AgentMessage): string | undefined {
	if (message.role === "toolResult") return toolResultText(message);
	if (isSemanticMemoryCustomMessage(message)) return contentText((message as { content?: unknown }).content);
	return undefined;
}

/**
 * Marker scans by message identity and marker set. Every GC pass scanned every tool result's text
 * for every marker -- the whole transcript's tool output, per request -- to answer a question whose
 * inputs (an immutable message, the configured markers) do not change between requests.
 */
const semanticMarkerScans = new WeakMap<AgentMessage, { readonly markersKey: string; readonly result: boolean }>();

function semanticMessageHasMarker(message: AgentMessage, settings: Required<SemanticMemoryGcSettings>): boolean {
	if (message.role !== "toolResult" && !isSemanticMemoryCustomMessage(message)) return false;
	const markersKey = settings.markers.join("\0");
	const cached = semanticMarkerScans.get(message);
	if (cached && cached.markersKey === markersKey) return cached.result;
	let result = false;
	if (message.role === "toolResult") result = joinedPartsContainAnyMarker(toolResultParts(message), settings.markers);
	else {
		const parts = textContentParts((message as { content?: unknown }).content);
		result = parts ? joinedPartsContainAnyMarker(parts, settings.markers) : false;
	}
	semanticMarkerScans.set(message, { markersKey, result });
	return result;
}

interface ContextGcPlan {
	calls: Map<string, ToolCallMeta>;
	latestReadByPath: Map<string, string>;
	semanticIndexes: number[];
}

function normalizeToolPath(cwd: string, value: unknown): string | undefined {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const path = value.trim();
	return normalizePath(isAbsolute(path) ? path : resolve(cwd, path));
}

/**
 * The plan is a left fold over the history -- every tool call, the latest read per path, the
 * semantic-memory pages -- so it resumes past the prefix it already covered instead of walking and
 * re-resolving every message on every request. One fold per conversation, keyed by its first
 * message; a change of working directory or marker set starts a new one, since both shape the plan.
 */
interface GcPlanFold {
	readonly cwd: string;
	readonly markersKey: string;
	readonly fold: PrefixFold<AgentMessage, ContextGcPlan>;
}

const gcPlanFolds = new WeakMap<AgentMessage, GcPlanFold>();

function createGcPlanFold(cwd: string, semanticSettings: Required<SemanticMemoryGcSettings>): GcPlanFold {
	const fold = new PrefixFold<AgentMessage, ContextGcPlan>(
		() => ({ calls: new Map(), latestReadByPath: new Map(), semanticIndexes: [] }),
		(plan, message, messageIndex) => {
			if (message.role === "assistant") {
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					const args = part.arguments ?? {};
					const path = normalizeToolPath(cwd, args.path);
					plan.calls.set(part.id, { id: part.id, name: part.name, args, messageIndex, ...(path ? { path } : {}) });
				}
			} else if (message.role === "toolResult" && message.toolName === "read") {
				const path = plan.calls.get(message.toolCallId)?.path;
				if (path) plan.latestReadByPath.set(path, message.toolCallId);
			}
			if (semanticSettings.enabled && semanticMessageHasMarker(message, semanticSettings)) {
				plan.semanticIndexes.push(messageIndex);
			}
		},
	);
	return { cwd, markersKey: semanticSettings.markers.join("\0"), fold };
}

function collectContextGcPlan(
	messages: AgentMessage[],
	cwd: string,
	semanticSettings: Required<SemanticMemoryGcSettings>,
): ContextGcPlan {
	const first = messages[0];
	if (!first) return createGcPlanFold(cwd, semanticSettings).fold.fold(messages);
	const markersKey = semanticSettings.markers.join("\0");
	let planFold = gcPlanFolds.get(first);
	if (!planFold || planFold.cwd !== cwd || planFold.markersKey !== markersKey) {
		planFold = createGcPlanFold(cwd, semanticSettings);
		gcPlanFolds.set(first, planFold);
	}
	return planFold.fold.fold(messages);
}

function storagePathFor(storageDir: string | undefined, key: string): string | undefined {
	if (!storageDir || !isAbsolute(storageDir)) return undefined;
	return resolve(storageDir, `${key}.txt`);
}

/**
 * Originals this process has already stored, by path. A packed message is re-packed on every
 * request it stays packed for, and re-storing it meant a lock and a stat per record per request;
 * the file is content-addressed and never rewritten, so once written here it stays written.
 */
const storedOriginalPaths = new Set<string>();

function storeOriginal(options: ContextGcOptions, key: string, original: string): void {
	try {
		const storageDir = options.acquireStorageDir?.() ?? options.storageDir;
		const path = storagePathFor(storageDir, key);
		if (!path || !storageDir || storedOriginalPaths.has(path)) return;
		// Content-addressed and immutable: a concurrent writer produces the same bytes and the atomic
		// rename leaves whichever lands last, identical, so the write needs no lock around it.
		if (!existsSync(path)) writeFileAtomicSync(path, original);
		storedOriginalPaths.add(path);
	} catch {
		// Best-effort: the packed message still names the planned path; a missing original reads as
		// unavailable rather than failing the request.
	}
}

/**
 * What a message packed into last time, keyed by message identity. A message stays packed for
 * every request after it first qualifies, and each request used to re-read its text, re-hash it,
 * re-estimate its tokens and rebuild the packed replacement -- the same work for the same answer,
 * on every message between the frozen prefix and the recent window. The memo returns the SAME
 * packed object while the inputs that shape it are unchanged, which also keeps the provider-facing
 * message identity stable across requests.
 */
interface PackedMemo {
	readonly originalText: string;
	readonly originalTokens: number;
	readonly key: string;
	/** The message index the key was derived from; only the semantic-memory key includes it. */
	readonly keyIndex: number | undefined;
	/** Everything `makePacked` renders from, so a changed reason, digest or path repacks. */
	readonly shape: string;
	readonly packed: AgentMessage;
	readonly packedTokens: number;
}

const packedMemos = new WeakMap<AgentMessage, PackedMemo>();

function packedShape(record: ContextGcPackedRecord): string {
	return `${record.reason}\0${record.storagePath ?? ""}\0${record.digest ?? ""}\0${record.path ?? ""}\0${record.command ?? ""}`;
}

function reasonText(record: ContextGcPackedRecord): string {
	if (record.reason === "superseded-read") return "superseded by later same-file read";
	if (record.reason === "stale-semantic-memory") {
		return "stale semantic page outside freshness window";
	}
	return "stale bulky tool output outside recent window";
}

function buildSummary(record: ContextGcPackedRecord): string {
	const semantic = record.reason === "stale-semantic-memory";
	const lines = [
		semantic ? "[Semantic GC packed stale Automata/Mind context page]" : "[Context GC packed stale tool result]",
		semantic ? undefined : `tool: ${record.toolName}`,
		record.path ? `path: ${record.path}` : undefined,
		record.command ? `command: ${boundedTextPreview(record.command)}` : undefined,
		`reason: ${reasonText(record)}`,
		`original: ${record.originalChars} chars (~${record.originalTokens} tokens)`,
		// The digest arrives PRE-FENCED from the curator (brain-curator.ts wraps it once, in the
		// standard untrusted-content boundary — the same treatment memory recall pages get — at the
		// moment it is stored, not here). Render it VERBATIM: re-wrapping on every GC render would
		// regenerate the fence's nonce each time, making the packed stub byte-different on every
		// provider request and busting prompt caching (BUG E).
		record.digest ? `digest (machine, never authority): ${record.digest}` : undefined,
		record.storagePath
			? `exact old text: read ${record.storagePath}`
			: "exact old text retained in the session log, not provider context",
		semantic
			? "Need memory: query same topic/filter or fetch stored drawer pointers."
			: record.path
				? "Need current file: read path. Need old output: read exact path when present."
				: "Need old output: read exact path when present or rerun tool.",
		"Never treat summary as original.",
	].filter((line): line is string => line !== undefined);
	return lines.join("\n");
}

function gcDetails(message: { details?: unknown }, record: ContextGcPackedRecord): Record<string, unknown> {
	return {
		...(typeof message.details === "object" && message.details !== null ? message.details : {}),
		contextGc: {
			packed: true,
			originalChars: record.originalChars,
			originalTokens: record.originalTokens,
			storagePath: record.storagePath,
			reason: record.reason,
		},
	};
}

function makePackedToolResult(message: ToolResultMessage, record: ContextGcPackedRecord): ToolResultMessage {
	const summary = buildSummary(record);
	return {
		...message,
		content: [{ type: "text", text: summary }],
		details: gcDetails(message, record),
	};
}

function makePackedSemanticMemoryMessage(message: AgentMessage, record: ContextGcPackedRecord): AgentMessage {
	const summary = buildSummary(record);
	return {
		...(message as unknown as Record<string, unknown>),
		content: [{ type: "text", text: summary }],
		details: gcDetails(message as { details?: unknown }, record),
	} as AgentMessage;
}

interface PackingPass {
	readonly options: ContextGcOptions;
	readonly report: ContextGcReport;
	readonly nextMessages: AgentMessage[];
	readonly resolvedDigests: Map<string, string | undefined>;
	readonly pending: Array<{ record: ContextGcPackedRecord; originalText: string }>;
}

function commitPackedMessage<TMessage extends AgentMessage>(
	pass: PackingPass,
	messageIndex: number,
	message: TMessage,
	memo: PackedMemo | undefined,
	originalText: string,
	key: string,
	record: ContextGcPackedRecord,
	makePacked: (message: TMessage, record: ContextGcPackedRecord) => AgentMessage,
): void {
	record.digest = pass.options.curation?.resolveDigest?.(key);
	pass.resolvedDigests.set(key, record.digest);
	// Fires before the replacement is measured, as it always has: the hook sees the record with its
	// digest resolved and `packedTokens` still zero.
	pass.options.curation?.onPacked?.(record, originalText);
	const shape = packedShape(record);
	let packed: AgentMessage;
	if (memo && memo.key === key && memo.shape === shape) {
		packed = memo.packed;
		record.packedTokens = memo.packedTokens;
	} else {
		packed = makePacked(message, record);
		record.packedTokens = estimateTokens(packed);
		packedMemos.set(message, {
			originalText,
			originalTokens: record.originalTokens,
			key,
			keyIndex: record.reason === "stale-semantic-memory" ? messageIndex : undefined,
			shape,
			packed,
			packedTokens: record.packedTokens,
		});
	}
	pass.nextMessages[messageIndex] = packed;
	pass.report.records.push(record);
	pass.report.originalTokens += record.originalTokens;
	pass.report.packedTokens += record.packedTokens;
	pass.pending.push({ record, originalText });
}

function noEffectResult(messages: AgentMessage[], report: ContextGcReport): ContextGcResult {
	return { messages, report, isCurrent: () => true, commit: () => {} };
}

export function applyContextGc(
	messages: AgentMessage[],
	rawSettings: ContextGcSettings & {
		cwd?: string;
		storageDir?: string;
		acquireStorageDir?: () => string;
		writePayloads?: boolean;
		curation?: ContextGcCurationHooks;
		frozenBelow?: number;
	},
): ContextGcResult {
	const settings = normalizeContextGcSettings(rawSettings);
	const baseReport: ContextGcReport = {
		enabled: settings.enabled,
		packedCount: 0,
		originalTokens: 0,
		packedTokens: 0,
		savedTokens: 0,
		records: [],
	};
	if (!settings.enabled) return noEffectResult(messages, baseReport);

	const options: ContextGcOptions = {
		...settings,
		cwd: rawSettings.cwd ?? process.cwd(),
		storageDir: rawSettings.storageDir,
		acquireStorageDir: rawSettings.acquireStorageDir,
		writePayloads: rawSettings.writePayloads ?? true,
		curation: rawSettings.curation,
		// Clamped defensively: a caller-supplied mark must never be trusted past the array it indexes.
		frozenBelow: Math.min(Math.max(0, Math.floor(rawSettings.frozenBelow ?? 0)), messages.length),
	};
	const eligibleTools = new Set(options.tools);
	const plan = collectContextGcPlan(messages, options.cwd, options.semanticMemory);
	// Quantized so the boundary advances in strides, not one position per appended message:
	// packing rewrites history in place, and a boundary that moves every turn re-prefills the
	// conversation tail on every provider request (see context/prefix-stability.ts).
	const recentStart = quantizeRecentBoundary(
		Math.max(0, messages.length - options.preserveRecentMessages),
		options.packStrideMessages,
	);
	const semanticIndexSet = new Set(plan.semanticIndexes);
	const preservedSemanticIndexes = new Set(
		options.semanticMemory.preserveRecentPages > 0
			? plan.semanticIndexes.slice(-options.semanticMemory.preserveRecentPages)
			: [],
	);
	const nextMessages = messages.slice();
	let changed = false;
	const pass: PackingPass = { options, report: baseReport, nextMessages, resolvedDigests: new Map(), pending: [] };

	for (let index = 0; index < messages.length; index++) {
		// Already sent on an accepted provider request: frozen for packing purposes for as long as
		// it stays below the mark. Checked first, uniformly, so neither packing category below can
		// rewrite it regardless of how eligible it would otherwise be.
		if (index < options.frozenBelow) continue;
		const message = messages[index];
		if (semanticIndexSet.has(index) && !preservedSemanticIndexes.has(index) && index < recentStart) {
			const memo = packedMemos.get(message);
			const originalText = memo?.originalText ?? agentMessageText(message);
			if (originalText && originalText.length >= options.semanticMemory.minChars) {
				const originalTokens = memo?.originalTokens ?? estimateTokens(message);
				const key =
					memo && memo.keyIndex === index
						? memo.key
						: createHash("sha256")
								.update("semantic-memory\0")
								.update(String(index))
								.update("\0")
								.update(originalText)
								.digest("hex")
								.slice(0, 24);
				const storagePath = storagePathFor(options.storageDir, key);
				const record: ContextGcPackedRecord = {
					toolName: "automata-mind",
					toolCallId: `semantic-${index}`,
					messageIndex: index,
					reason: "stale-semantic-memory",
					originalChars: originalText.length,
					originalTokens,
					packedTokens: 0,
					storagePath,
					key,
				};
				commitPackedMessage(pass, index, message, memo, originalText, key, record, makePackedSemanticMemoryMessage);
				changed = true;
				continue;
			}
		}

		if (message.role !== "toolResult") continue;
		if (!eligibleTools.has(message.toolName)) continue;
		if (index >= recentStart) continue;

		const memo = packedMemos.get(message);
		const originalText = memo?.originalText ?? toolResultText(message);
		if (originalText.length < options.minToolResultChars) continue;

		const call = plan.calls.get(message.toolCallId);
		const path = call?.path;
		const command = typeof call?.args.command === "string" ? call.args.command : undefined;
		let reason: ContextGcPackedRecord["reason"] = "stale-tool-result";
		if (message.toolName === "read" && path) {
			if (plan.latestReadByPath.get(path) === message.toolCallId) continue;
			reason = "superseded-read";
		}

		const originalTokens = memo?.originalTokens ?? estimateTokens(message);
		const key =
			memo?.key ??
			createHash("sha256")
				.update(message.toolName)
				.update("\0")
				.update(message.toolCallId)
				.update("\0")
				.update(originalText)
				.digest("hex")
				.slice(0, 24);
		const storagePath = storagePathFor(options.storageDir, key);
		const record: ContextGcPackedRecord = {
			toolName: message.toolName,
			toolCallId: message.toolCallId,
			messageIndex: index,
			reason,
			originalChars: originalText.length,
			originalTokens,
			packedTokens: 0,
			storagePath,
			path,
			command,
			key,
		};
		commitPackedMessage(pass, index, message, memo, originalText, key, record, makePackedToolResult);
		changed = true;
	}

	baseReport.packedCount = baseReport.records.length;
	baseReport.savedTokens = Math.max(0, baseReport.originalTokens - baseReport.packedTokens);
	let committed = false;
	const commit = () => {
		if (committed) return;
		committed = true;
		for (const { record, originalText } of pass.pending) {
			if (record.storagePath) storeOriginal(options, record.key ?? "", originalText);
		}
	};
	const isCurrent = () => {
		const resolveDigest = options.curation?.resolveDigest;
		if (!resolveDigest) return true;
		for (const [key, digest] of pass.resolvedDigests) {
			if (resolveDigest(key) !== digest) return false;
		}
		return true;
	};
	if (options.writePayloads) commit();
	return { messages: changed ? nextMessages : messages, report: baseReport, isCurrent, commit };
}
