import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { ToolResultMessage } from "@caupulican/pi-ai";
import { normalizePath } from "../utils/paths.ts";
import { estimateTokens } from "./compaction/compaction.ts";

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

export interface ContextGcOptions extends NormalizedContextGcSettings {
	cwd: string;
	storageDir?: string;
	writePayloads?: boolean;
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
	preserveRecentPages: 2,
	minChars: 1200,
	markers: [
		"<automata_context",
		"<automata_response",
		"<automata_query",
		"<automata_fetch",
		"<memory_lifecycle_audit",
		"<memory_lifecycle_purge",
		"<automata_doctor",
		"<automata_optimizer",
		"<automata_mesh",
	],
};

export const DEFAULT_CONTEXT_GC_SETTINGS: NormalizedContextGcSettings = {
	enabled: true,
	preserveRecentMessages: 12,
	minToolResultChars: 2500,
	tools: ["read", "bash", "rg", "grep", "context_headroom_retrieve", "headroom_retrieve"],
	semanticMemory: DEFAULT_SEMANTIC_MEMORY_GC_SETTINGS,
};

type ToolCallMeta = {
	id: string;
	name: string;
	args: Record<string, unknown>;
	messageIndex: number;
};

function cap(text: string, limit = 220): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > limit ? `${compact.slice(0, Math.max(0, limit - 1))}…` : compact;
}

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

function contentText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) return undefined;
		const typed = part as { type?: string; text?: string; mimeType?: string };
		if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
		else if (typed.type === "image") return undefined;
		else return undefined;
	}
	return parts.join("\n");
}

function toolResultText(message: ToolResultMessage): string {
	return message.content
		.map((part) => {
			if (part.type === "text") return part.text;
			if (part.type === "image") return `[image ${part.mimeType}]`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function isSemanticMemoryCustomMessage(message: AgentMessage): boolean {
	if (message.role !== "custom") return false;
	const customType = String((message as { customType?: unknown }).customType ?? "").toLowerCase();
	return customType.includes("automata") || customType.includes("memory") || customType.includes("mind");
}

function agentMessageText(message: AgentMessage): string | undefined {
	if (message.role === "toolResult") return toolResultText(message);
	if (isSemanticMemoryCustomMessage(message)) return contentText((message as { content?: unknown }).content);
	return undefined;
}

function isSemanticMemoryPage(text: string, settings: Required<SemanticMemoryGcSettings>): boolean {
	return settings.markers.some((marker) => text.includes(marker));
}

function collectSemanticMemoryIndexes(
	messages: AgentMessage[],
	settings: Required<SemanticMemoryGcSettings>,
): Set<number> {
	const indexes = new Set<number>();
	if (!settings.enabled) return indexes;
	for (let index = 0; index < messages.length; index++) {
		const text = agentMessageText(messages[index]);
		if (text && isSemanticMemoryPage(text, settings)) indexes.add(index);
	}
	return indexes;
}

function collectToolCalls(messages: AgentMessage[]): Map<string, ToolCallMeta> {
	const calls = new Map<string, ToolCallMeta>();
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const message = messages[messageIndex];
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			calls.set(part.id, {
				id: part.id,
				name: part.name,
				args: part.arguments ?? {},
				messageIndex,
			});
		}
	}
	return calls;
}

function normalizeToolPath(cwd: string, value: unknown): string | undefined {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const path = value.trim();
	return normalizePath(isAbsolute(path) ? path : resolve(cwd, path));
}

function collectLatestReadCallByPath(
	messages: AgentMessage[],
	calls: Map<string, ToolCallMeta>,
	cwd: string,
): Map<string, string> {
	const latest = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "toolResult" || message.toolName !== "read") continue;
		const call = calls.get(message.toolCallId);
		const path = normalizeToolPath(cwd, call?.args.path);
		if (path) latest.set(path, message.toolCallId);
	}
	return latest;
}

function storagePathFor(storageDir: string | undefined, key: string): string | undefined {
	if (!storageDir) return undefined;
	return resolve(storageDir, `${key}.txt`);
}

function maybeStoreOriginal(options: ContextGcOptions, key: string, original: string): string | undefined {
	const path = storagePathFor(options.storageDir, key);
	if (!path || !options.writePayloads) return path;
	try {
		mkdirSync(options.storageDir!, { recursive: true });
		if (!existsSync(path)) writeFileSync(path, original, "utf8");
	} catch {
		return undefined;
	}
	return path;
}

function reasonText(record: ContextGcPackedRecord): string {
	if (record.reason === "superseded-read") return "older read snapshot superseded by a later read of the same file";
	if (record.reason === "stale-semantic-memory") {
		return "older Automata/Mind semantic context page outside the semantic-memory freshness window";
	}
	return "stale bulky tool output outside the recent context window";
}

function buildSummary(record: ContextGcPackedRecord): string {
	const semantic = record.reason === "stale-semantic-memory";
	const lines = [
		semantic ? "[Semantic GC packed stale Automata/Mind context page]" : "[Context GC packed stale tool result]",
		semantic ? undefined : `tool: ${record.toolName}`,
		record.path ? `path: ${record.path}` : undefined,
		record.command ? `command: ${cap(record.command)}` : undefined,
		`reason: ${reasonText(record)}`,
		`original: ${record.originalChars} chars (~${record.originalTokens} tokens)`,
		record.storagePath
			? `exact old provider-visible text stored at: ${record.storagePath}`
			: "exact old provider-visible text retained in the session log, not inline in provider context",
		semantic
			? "If this memory context matters, query Automata/Mind again with the same topic/filter or fetch the drawer pointers from the stored page."
			: record.path
				? "For current file contents, use the read tool on the path above. For the exact old output, read the stored payload path if present."
				: "If this exact old output matters, retrieve/read the stored payload path if present or rerun the tool command.",
		"Do not rely on this summary as the original content.",
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

export function applyContextGc(
	messages: AgentMessage[],
	rawSettings: ContextGcSettings & { cwd?: string; storageDir?: string; writePayloads?: boolean },
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
		writePayloads: rawSettings.writePayloads ?? true,
	};
	const eligibleTools = new Set(options.tools);
	const calls = collectToolCalls(messages);
	const latestReadByPath = collectLatestReadCallByPath(messages, calls, options.cwd);
	const recentStart = Math.max(0, messages.length - options.preserveRecentMessages);
	const semanticIndexSet = collectSemanticMemoryIndexes(messages, options.semanticMemory);
	const semanticIndexes = Array.from(semanticIndexSet);
	const preservedSemanticIndexes = new Set(semanticIndexes.slice(-options.semanticMemory.preserveRecentPages));
	const nextMessages = messages.slice();
	let changed = false;

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (semanticIndexSet.has(index) && !preservedSemanticIndexes.has(index) && index < recentStart) {
			const originalText = agentMessageText(message);
			if (originalText && originalText.length >= options.semanticMemory.minChars) {
				const originalTokens = estimateTokens(message);
				const key = createHash("sha256")
					.update(`semantic-memory\0${index}\0${originalText}`)
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
				const packed = makePackedSemanticMemoryMessage(message, record);
				record.packedTokens = estimateTokens(packed);
				nextMessages[index] = packed;
				baseReport.records.push(record);
				baseReport.originalTokens += record.originalTokens;
				baseReport.packedTokens += record.packedTokens;
				changed = true;
				continue;
			}
		}

		if (message.role !== "toolResult") continue;
		if (!eligibleTools.has(message.toolName)) continue;
		if (index >= recentStart) continue;

		const originalText = toolResultText(message);
		if (originalText.length < options.minToolResultChars) continue;

		const call = calls.get(message.toolCallId);
		const path = normalizeToolPath(options.cwd, call?.args.path);
		let reason: ContextGcPackedRecord["reason"] = "stale-tool-result";
		if (message.toolName === "read" && path) {
			if (latestReadByPath.get(path) === message.toolCallId) continue;
			reason = "superseded-read";
		}

		const originalTokens = estimateTokens(message);
		const key = createHash("sha256")
			.update(`${message.toolName}\0${message.toolCallId}\0${originalText}`)
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
			command: typeof call?.args.command === "string" ? call.args.command : undefined,
			key,
		};
		const packed = makePackedToolResult(message, record);
		record.packedTokens = estimateTokens(packed);
		nextMessages[index] = packed as AgentMessage;
		baseReport.records.push(record);
		baseReport.originalTokens += record.originalTokens;
		baseReport.packedTokens += record.packedTokens;
		changed = true;
	}

	baseReport.packedCount = baseReport.records.length;
	baseReport.savedTokens = Math.max(0, baseReport.originalTokens - baseReport.packedTokens);
	return { messages: changed ? nextMessages : messages, report: baseReport };
}
