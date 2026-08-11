import { estimateStringTokens, estimateTokens } from "@caupulican/pi-agent-core/compaction/compaction";
import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "@caupulican/pi-agent-core/messages";
import type { CompactionEntry, SessionEntry } from "@caupulican/pi-agent-core/session";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import { Type } from "typebox";
import type { MemoryPromptInclusionReport, MemoryRetrievalDiagnostics } from "../context/memory-diagnostics.ts";
import type { ContextGcReport } from "../context-gc.ts";
import { boundedTextPreview } from "../text-preview.ts";
import type { ToolDefinition, ToolInfo } from "./types.ts";

type ContextAuditParams = {
	maxItems?: number;
	minTokens?: number;
	query?: string;
	includePreviews?: boolean;
};

type AuditRow = {
	kind: string;
	role?: string;
	entryId?: string;
	timestamp?: string;
	tokens: number;
	chars: number;
	label: string;
	preview: string;
};

const DEFAULT_MAX_ITEMS = 40;
const MAX_MAX_ITEMS = 200;
const MAX_PREVIEW_CHARS = 600;

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const typed = part as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
			if (typed.type === "text") return typed.text || "";
			if (typed.type === "thinking") return `[thinking ${typed.thinking?.length ?? 0} chars]`;
			if (typed.type === "toolCall")
				return `[toolCall ${typed.name || "unknown"} ${JSON.stringify(typed.arguments ?? {})}]`;
			if (typed.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function messagePreview(message: AgentMessage): string {
	switch (message.role) {
		case "assistant":
		case "user":
		case "toolResult":
		case "custom":
			return contentText((message as { content?: unknown }).content);
		case "bashExecution":
			return `Ran ${message.command}\n${message.output}`;
		case "branchSummary":
		case "compactionSummary":
			return message.summary;
		default:
			return "";
	}
}

function messageLabel(message: AgentMessage): string {
	if (message.role === "assistant") {
		const toolCalls = message.content.filter((part) => part.type === "toolCall").length;
		return toolCalls > 0 ? `assistant (${toolCalls} tool call${toolCalls === 1 ? "" : "s"})` : "assistant";
	}
	if (message.role === "toolResult") return `tool result: ${message.toolName}`;
	if (message.role === "custom") return `custom: ${message.customType}`;
	if (message.role === "bashExecution") return "bash execution";
	if (message.role === "branchSummary") return "branch summary";
	if (message.role === "compactionSummary") return "compaction summary";
	return message.role;
}

function addRow(rows: AuditRow[], entry: SessionEntry, message: AgentMessage, kindOverride?: string) {
	const preview = messagePreview(message);
	rows.push({
		kind: kindOverride || entry.type,
		role: message.role,
		entryId: entry.id,
		timestamp: entry.timestamp,
		tokens: estimateTokens(message),
		chars: preview.length,
		label: messageLabel(message),
		preview: boundedTextPreview(preview),
	});
}

function messageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "custom_message") {
		return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	return undefined;
}

function latestCompaction(entries: SessionEntry[]): CompactionEntry | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "compaction") return entry;
	}
	return undefined;
}

type ActiveContextAudit = {
	messages: AgentMessage[];
	rows: AuditRow[];
};

function addActiveContextEntry(
	audit: ActiveContextAudit,
	entry: SessionEntry,
	message: AgentMessage,
	kindOverride?: string,
): void {
	audit.messages.push(message);
	addRow(audit.rows, entry, message, kindOverride);
}

export function collectActiveContextAudit(entries: SessionEntry[]): ActiveContextAudit {
	const audit: ActiveContextAudit = { messages: [], rows: [] };
	const compaction = latestCompaction(entries);
	if (!compaction) {
		for (const entry of entries) {
			const message = messageFromEntry(entry);
			if (message) addActiveContextEntry(audit, entry, message);
		}
		return audit;
	}

	const compactionMessage = createCompactionSummaryMessage(
		compaction.summary,
		compaction.tokensBefore,
		compaction.timestamp,
	);
	addActiveContextEntry(audit, compaction, compactionMessage, "compaction");

	const compactionIndex = entries.findIndex((entry) => entry.id === compaction.id);
	let foundFirstKept = false;
	for (let index = 0; index < compactionIndex; index++) {
		const entry = entries[index];
		if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
		if (!foundFirstKept) continue;
		const message = messageFromEntry(entry);
		if (message) addActiveContextEntry(audit, entry, message);
	}
	for (let index = compactionIndex + 1; index < entries.length; index++) {
		const entry = entries[index];
		const message = messageFromEntry(entry);
		if (message) addActiveContextEntry(audit, entry, message);
	}
	return audit;
}

function groupRows(rows: AuditRow[]): Array<[string, { count: number; tokens: number; chars: number }]> {
	const groups = new Map<string, { count: number; tokens: number; chars: number }>();
	for (const row of rows) {
		const key = row.label;
		const current = groups.get(key) ?? { count: 0, tokens: 0, chars: 0 };
		current.count += 1;
		current.tokens += row.tokens;
		current.chars += row.chars;
		groups.set(key, current);
	}
	return [...groups.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
}

/** Bounded, deterministic summary lines for the memory-retrieval/prompt-inclusion diagnostic (safe metadata only, no content). */
function formatMemoryRetrievalLine(retrieval: MemoryRetrievalDiagnostics): string {
	return `Memory retrieval: ${retrieval.enabled ? `enabled (max ${retrieval.maxResults} results)` : "disabled"}`;
}

function formatMemoryProviderLines(retrieval: MemoryRetrievalDiagnostics): string[] {
	return retrieval.providerReports.map((providerReport) => {
		const rejection =
			providerReport.rejectionReasons.length > 0 ? `; rejected: ${providerReport.rejectionReasons.join(", ")}` : "";
		return `  provider ${providerReport.providerId}: ${providerReport.status} (${providerReport.resultCount} result(s)${rejection})`;
	});
}

function formatMemoryPromptInclusionLine(promptInclusion: MemoryPromptInclusionReport): string {
	return `Prompt inclusion: ${promptInclusion.status} (${promptInclusion.includedCount} included, ${promptInclusion.omittedCount} omitted, ${promptInclusion.blockChars} chars)`;
}

export function createCoreDiagnosticsToolDefinitions(
	getActiveTools: () => string[],
	getAllTools: () => ToolInfo[],
	getContextGcReport?: (messages: AgentMessage[]) => ContextGcReport,
	getMemoryDiagnostics?: () => {
		retrieval: MemoryRetrievalDiagnostics;
		promptInclusion: MemoryPromptInclusionReport;
	},
): ToolDefinition[] {
	return [
		{
			name: "context_audit",
			label: "Context Audit",
			description:
				"Audit the current provider-visible context composition: model window usage, system prompt estimate, active tool schema estimate, active session message rows, and heaviest context contributors.",
			promptSnippet: "Audit provider-visible context before context optimization.",
			promptGuidelines: [
				"Use context_audit for context consumers, high footer percentage, loaded messages/tools/system text.",
				"Bound output with query/minTokens/maxItems; never dump full context.",
				"Token counts are estimates; provider usage remains model/provider dependent.",
			],
			parameters: Type.Object(
				{
					maxItems: Type.Optional(
						Type.Number({ description: "Maximum heaviest session-context rows to show. Default 40, max 200." }),
					),
					minTokens: Type.Optional(
						Type.Number({
							description: "Only show session-context rows with at least this many estimated tokens.",
						}),
					),
					query: Type.Optional(
						Type.String({ description: "Case-insensitive filter over row label and preview." }),
					),
					includePreviews: Type.Optional(
						Type.Boolean({ description: "Include bounded row previews. Defaults true." }),
					),
				},
				{ additionalProperties: false },
			),
			async execute(_toolCallId, params: ContextAuditParams, _signal, _onUpdate, ctx) {
				const maxItems = Math.max(1, Math.min(MAX_MAX_ITEMS, Math.floor(params.maxItems ?? DEFAULT_MAX_ITEMS)));
				const minTokens = Math.max(0, Math.floor(params.minTokens ?? 0));
				const includePreviews = params.includePreviews !== false;
				const query = params.query?.trim().toLowerCase();

				const branch = ctx.sessionManager.getBranch();
				const { rows, messages: activeMessages } = collectActiveContextAudit(branch);
				const contextGcReport = getContextGcReport?.(activeMessages);
				const memoryDiagnostics = getMemoryDiagnostics?.();
				const contextUsage = ctx.getContextUsage();
				const systemPrompt = ctx.getSystemPrompt?.() || "";
				const activeTools = new Set(getActiveTools());
				const allTools = getAllTools();
				const activeToolInfos = allTools.filter((tool) => activeTools.has(tool.name));
				const systemTokens = estimateStringTokens(systemPrompt);
				const toolSchemaChars = JSON.stringify(
					activeToolInfos.map((tool) => ({
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
						promptGuidelines: tool.promptGuidelines,
					})),
				).length;
				const toolSchemaTokens = Math.ceil(toolSchemaChars / 4);
				const rowTokenSum = rows.reduce((sum, row) => sum + row.tokens, 0);
				const effectiveRowTokenSum = Math.max(0, rowTokenSum - (contextGcReport?.savedTokens ?? 0));
				const usageText = contextUsage
					? contextUsage.tokens === null || contextUsage.percent === null
						? `provider usage: unknown/${contextUsage.contextWindow} tokens (usually right after compaction)`
						: `provider usage: ${contextUsage.tokens}/${contextUsage.contextWindow} tokens (${contextUsage.percent.toFixed(1)}%)`
					: "provider usage: unavailable (no active model/context window)";
				const providerTokens = contextUsage?.tokens ?? null;
				const unattributed =
					providerTokens === null
						? null
						: Math.max(0, providerTokens - systemTokens - toolSchemaTokens - rowTokenSum);

				let filtered = rows.filter((row) => row.tokens >= minTokens);
				if (query) {
					filtered = filtered.filter((row) => `${row.label}\n${row.preview}`.toLowerCase().includes(query));
				}
				const heaviest = [...filtered].sort((a, b) => b.tokens - a.tokens).slice(0, maxItems);
				const groupLines = groupRows(rows)
					.slice(0, 12)
					.map(([label, group]) => `- ${label}: ${group.tokens} est tok across ${group.count} row(s)`);
				const rowLines = heaviest.map((row, index) => {
					const base = `${index + 1}. ${row.tokens} est tok · ${row.label} · ${row.entryId ?? "no-entry"}`;
					return includePreviews
						? `${base}\n   ${boundedTextPreview(row.preview, MAX_PREVIEW_CHARS) || "(no text preview)"}`
						: base;
				});

				const lines = [
					"Context audit",
					usageText,
					`active branch rows: ${rows.length}; session row estimate: ${rowTokenSum} tokens`,
					contextGcReport
						? `Context GC estimate: ${contextGcReport.savedTokens} tokens saved by packing ${contextGcReport.packedCount} stale row(s); effective session row estimate: ${effectiveRowTokenSum} tokens`
						: undefined,
					`system prompt estimate: ${systemTokens} tokens (${systemPrompt.length} chars)`,
					`active tool schema estimate: ${toolSchemaTokens} tokens across ${activeToolInfos.length} active tool(s)`,
					unattributed === null
						? undefined
						: `provider-reported remainder not mapped by chars/4 rows: ${unattributed} tokens`,
					...(memoryDiagnostics
						? [
								formatMemoryRetrievalLine(memoryDiagnostics.retrieval),
								...formatMemoryProviderLines(memoryDiagnostics.retrieval),
								formatMemoryPromptInclusionLine(memoryDiagnostics.promptInclusion),
							]
						: []),
					"",
					"Largest groups:",
					...(groupLines.length ? groupLines : ["- none"]),
					"",
					`Heaviest rows${query ? ` matching ${JSON.stringify(params.query)}` : ""}:`,
					...(rowLines.length ? rowLines : ["- none"]),
				].filter((line): line is string => line !== undefined);

				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: {
						contextUsage,
						systemPrompt: {
							chars: systemPrompt.length,
							estimatedTokens: systemTokens,
							preview: boundedTextPreview(systemPrompt, MAX_PREVIEW_CHARS),
						},
						activeTools: activeToolInfos.map((tool) => tool.name),
						toolSchemaEstimate: { chars: toolSchemaChars, estimatedTokens: toolSchemaTokens },
						rowTokenSum,
						effectiveRowTokenSum,
						contextGc: contextGcReport,
						rows,
						memory: memoryDiagnostics,
					},
				};
			},
		},
	];
}
