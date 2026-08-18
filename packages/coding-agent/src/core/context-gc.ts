import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import { estimateTokens } from "@caupulican/pi-agent-core/compaction/compaction";
import type { ToolResultMessage } from "@caupulican/pi-ai";
import { normalizePath } from "../utils/paths.ts";
import { boundedTextPreview } from "./text-preview.ts";
import { withFileLockSync, writeFileAtomicSync } from "./util/atomic-file.ts";

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
	return {
		enabled: settings?.enabled ?? DEFAULT_CONTEXT_GC_SETTINGS.enabled,
		preserveRecentMessages: Math.max(
			0,
			Math.floor(settings?.preserveRecentMessages ?? DEFAULT_CONTEXT_GC_SETTINGS.preserveRecentMessages),
		),
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

function semanticMessageHasMarker(message: AgentMessage, settings: Required<SemanticMemoryGcSettings>): boolean {
	if (message.role === "toolResult") return joinedPartsContainAnyMarker(toolResultParts(message), settings.markers);
	if (isSemanticMemoryCustomMessage(message)) {
		const parts = textContentParts((message as { content?: unknown }).content);
		return parts ? joinedPartsContainAnyMarker(parts, settings.markers) : false;
	}
	return false;
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

function collectContextGcPlan(
	messages: AgentMessage[],
	cwd: string,
	semanticSettings: Required<SemanticMemoryGcSettings>,
): ContextGcPlan {
	const calls = new Map<string, ToolCallMeta>();
	const readResultCallIds: string[] = [];
	const semanticIndexes: number[] = [];

	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const message = messages[messageIndex];
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				calls.set(part.id, {
					id: part.id,
					name: part.name,
					args: part.arguments ?? {},
					messageIndex,
				});
			}
		} else if (message.role === "toolResult" && message.toolName === "read") {
			readResultCallIds.push(message.toolCallId);
		}

		if (semanticSettings.enabled && semanticMessageHasMarker(message, semanticSettings)) {
			semanticIndexes.push(messageIndex);
		}
	}

	const latestReadByPath = new Map<string, string>();
	for (const toolCallId of readResultCallIds) {
		const call = calls.get(toolCallId);
		const path = normalizeToolPath(cwd, call?.args.path);
		if (path) latestReadByPath.set(path, toolCallId);
	}

	return { calls, latestReadByPath, semanticIndexes };
}

const REFERENCE_PROTECTION_ASSISTANT_MESSAGES = 8;
const REFERENCE_FRAGMENT_MAX_COUNT = 8;
const REFERENCE_FRAGMENT_MAX_CHARS = 200;
const REFERENCE_COMMAND_MAX_SEGMENTS = 4;

function assistantMessageText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	const parts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text" && part.text) parts.push(part.text);
		else if (part.type === "thinking" && part.thinking) parts.push(part.thinking);
	}
	return joinTextParts(parts);
}

function collectRecentAssistantText(messages: AgentMessage[]): string {
	const collected: string[] = [];
	for (let index = messages.length - 1; index >= 0; index--) {
		if (collected.length >= REFERENCE_PROTECTION_ASSISTANT_MESSAGES) break;
		const message = messages[index];
		if (message.role !== "assistant") continue;
		collected.push(assistantMessageText(message));
	}
	return joinTextParts(collected);
}

function lastPathSegment(value: string): string {
	return value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1);
}

function stripTokenWrappers(token: string): string {
	return token.replace(/^["'`(]+/, "").replace(/["'`),;:]+$/, "");
}

function pushReferenceFragment(fragments: string[], fragment: string): void {
	if (fragments.length >= REFERENCE_FRAGMENT_MAX_COUNT) return;
	if (fragment.length === 0 || fragment.length > REFERENCE_FRAGMENT_MAX_CHARS) return;
	if (!fragments.includes(fragment)) fragments.push(fragment);
}

function isDistinctiveCommandWord(word: string): boolean {
	if (word.startsWith("-")) return false;
	if (word.length >= 5) return true;
	return word.length >= 4 && (word.includes("/") || word.includes("\\") || word.includes("."));
}

function collectCommandReferenceFragments(fragments: string[], command: string): void {
	for (const segment of command.split(/&&|\|\||[;|\n]/).slice(0, REFERENCE_COMMAND_MAX_SEGMENTS)) {
		const words = segment
			.split(/\s+/)
			.map(stripTokenWrappers)
			.filter((word) => word.length > 0 && !word.startsWith("-"));
		if (words.length >= 2 && `${words[0]} ${words[1]}`.length >= 6) {
			pushReferenceFragment(fragments, `${words[0]} ${words[1]}`);
		}
	}
	for (const token of command.split(/\s+/)) {
		if (fragments.length >= REFERENCE_FRAGMENT_MAX_COUNT) break;
		const word = stripTokenWrappers(token);
		if (isDistinctiveCommandWord(word)) pushReferenceFragment(fragments, word);
		const base = lastPathSegment(word);
		if (base !== word && !base.startsWith("-") && base.length >= 4) pushReferenceFragment(fragments, base);
	}
}

/**
 * Review finding (ledger #144 follow-up): `args.path`/`args.command` are not the only citable
 * evidence carriers -- python results carry `scriptPath` (path-shaped) or inline `code`, and
 * run_process results carry `executable` + `args` argv (joined with spaces). Widen ONLY the
 * reference check's inputs through the existing path/command-fragment rules and bounds; the
 * packed record's own `path`/`command` fields stay exactly what the tool args named.
 */
function referenceEvidenceInputs(
	cwd: string,
	call: ToolCallMeta | undefined,
	path: string | undefined,
	command: string | undefined,
): { path: string | undefined; command: string | undefined } {
	const scriptPath = normalizeToolPath(cwd, call?.args.scriptPath ?? call?.args.script_path);
	const code = typeof call?.args.code === "string" ? call.args.code : undefined;
	const executable = typeof call?.args.executable === "string" ? call.args.executable : undefined;
	const argv =
		executable !== undefined && Array.isArray(call?.args.args)
			? [executable, ...call.args.args.filter((entry): entry is string => typeof entry === "string")].join(" ")
			: undefined;
	const commandText = [command, code, argv]
		.filter((entry): entry is string => entry !== undefined && entry.length > 0)
		.join("\n");
	return { path: path ?? scriptPath, command: commandText.length > 0 ? commandText : undefined };
}

function referenceFragmentsFor(path: string | undefined, command: string | undefined): string[] {
	const fragments: string[] = [];
	if (path) {
		const base = lastPathSegment(path);
		const fileLike = base.includes(".") && base.length >= 3;
		pushReferenceFragment(fragments, fileLike || base.length >= 5 ? base : path);
	}
	if (command) collectCommandReferenceFragments(fragments, command);
	return fragments;
}

/**
 * Reference protection (ledger #144): a stale tool result the model is still citing is not
 * packable — packing mid-investigation evidence forces re-derivation of already-paid-for work
 * (field trace: 64 gc stores / 10.1 MB persisted, zero retrievals). "Still citing" is a bounded
 * pure check: the result's `path` (its file-like final segment) or a distinctive fragment of its
 * shell `command` (leading non-flag bigram per segment, non-flag words of >= 5 chars or
 * path-shaped words of >= 4, plus their final segments) appears in the text/thinking of the last
 * REFERENCE_PROTECTION_ASSISTANT_MESSAGES assistant messages. Fragment count and length are
 * capped, so the check stays O(recent assistant text) per candidate. The `superseded-read`
 * reason is exempt at the call site: a newer read of the same file supersedes regardless of
 * references.
 */
function isReferencedByRecentAssistantText(recentAssistantText: string, path?: string, command?: string): boolean {
	if (recentAssistantText.length === 0) return false;
	return referenceFragmentsFor(path, command).some((fragment) => recentAssistantText.includes(fragment));
}

function storagePathFor(storageDir: string | undefined, key: string): string | undefined {
	if (!storageDir || !isAbsolute(storageDir)) return undefined;
	return resolve(storageDir, `${key}.txt`);
}

function maybeStoreOriginal(options: ContextGcOptions, key: string, original: string): string | undefined {
	const plannedPath = storagePathFor(options.storageDir, key);
	if (!plannedPath || !options.writePayloads) return plannedPath;
	try {
		const storageDir = options.acquireStorageDir?.() ?? options.storageDir;
		const path = storagePathFor(storageDir, key);
		if (!path || !storageDir) return undefined;
		withFileLockSync(path, () => {
			if (!existsSync(path)) writeFileAtomicSync(path, original);
		});
		return path;
	} catch {
		return undefined;
	}
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

function commitPackedMessage<TMessage extends AgentMessage>(
	options: ContextGcOptions,
	report: ContextGcReport,
	nextMessages: AgentMessage[],
	messageIndex: number,
	message: TMessage,
	originalText: string,
	key: string,
	record: ContextGcPackedRecord,
	makePacked: (message: TMessage, record: ContextGcPackedRecord) => AgentMessage,
): void {
	record.digest = options.curation?.resolveDigest?.(key);
	options.curation?.onPacked?.(record, originalText);
	const packed = makePacked(message, record);
	record.packedTokens = estimateTokens(packed);
	nextMessages[messageIndex] = packed;
	report.records.push(record);
	report.originalTokens += record.originalTokens;
	report.packedTokens += record.packedTokens;
}

export function applyContextGc(
	messages: AgentMessage[],
	rawSettings: ContextGcSettings & {
		cwd?: string;
		storageDir?: string;
		acquireStorageDir?: () => string;
		writePayloads?: boolean;
		curation?: ContextGcCurationHooks;
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
	if (!settings.enabled) return { messages, report: baseReport };

	const options: ContextGcOptions = {
		...settings,
		cwd: rawSettings.cwd ?? process.cwd(),
		storageDir: rawSettings.storageDir,
		acquireStorageDir: rawSettings.acquireStorageDir,
		writePayloads: rawSettings.writePayloads ?? true,
		curation: rawSettings.curation,
	};
	const eligibleTools = new Set(options.tools);
	const plan = collectContextGcPlan(messages, options.cwd, options.semanticMemory);
	const recentStart = Math.max(0, messages.length - options.preserveRecentMessages);
	const semanticIndexSet = new Set(plan.semanticIndexes);
	const preservedSemanticIndexes = new Set(
		options.semanticMemory.preserveRecentPages > 0
			? plan.semanticIndexes.slice(-options.semanticMemory.preserveRecentPages)
			: [],
	);
	const nextMessages = messages.slice();
	let changed = false;
	let recentAssistantText: string | undefined;

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (semanticIndexSet.has(index) && !preservedSemanticIndexes.has(index) && index < recentStart) {
			const originalText = agentMessageText(message);
			if (originalText && originalText.length >= options.semanticMemory.minChars) {
				const originalTokens = estimateTokens(message);
				const key = createHash("sha256")
					.update("semantic-memory\0")
					.update(String(index))
					.update("\0")
					.update(originalText)
					.digest("hex")
					.slice(0, 24);
				const storagePath = maybeStoreOriginal(options, key, originalText);
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
				commitPackedMessage(
					options,
					baseReport,
					nextMessages,
					index,
					message,
					originalText,
					key,
					record,
					makePackedSemanticMemoryMessage,
				);
				changed = true;
				continue;
			}
		}

		if (message.role !== "toolResult") continue;
		if (!eligibleTools.has(message.toolName)) continue;
		if (index >= recentStart) continue;

		const originalText = toolResultText(message);
		if (originalText.length < options.minToolResultChars) continue;

		const call = plan.calls.get(message.toolCallId);
		const path = normalizeToolPath(options.cwd, call?.args.path);
		const command = typeof call?.args.command === "string" ? call.args.command : undefined;
		let reason: ContextGcPackedRecord["reason"] = "stale-tool-result";
		if (message.toolName === "read" && path) {
			if (plan.latestReadByPath.get(path) === message.toolCallId) continue;
			reason = "superseded-read";
		}
		if (reason === "stale-tool-result") {
			recentAssistantText ??= collectRecentAssistantText(messages);
			const reference = referenceEvidenceInputs(options.cwd, call, path, command);
			if (isReferencedByRecentAssistantText(recentAssistantText, reference.path, reference.command)) continue;
		}

		const originalTokens = estimateTokens(message);
		const key = createHash("sha256")
			.update(message.toolName)
			.update("\0")
			.update(message.toolCallId)
			.update("\0")
			.update(originalText)
			.digest("hex")
			.slice(0, 24);
		const storagePath = maybeStoreOriginal(options, key, originalText);
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
		commitPackedMessage(
			options,
			baseReport,
			nextMessages,
			index,
			message,
			originalText,
			key,
			record,
			makePackedToolResult,
		);
		changed = true;
	}

	baseReport.packedCount = baseReport.records.length;
	baseReport.savedTokens = Math.max(0, baseReport.originalTokens - baseReport.packedTokens);
	return { messages: changed ? nextMessages : messages, report: baseReport };
}
