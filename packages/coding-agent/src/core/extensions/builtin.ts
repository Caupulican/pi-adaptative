import { Type } from "typebox";
import { estimateStringTokens, estimateTokens } from "../../kernel/compaction/compaction.ts";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { sessionContextItems } from "../../kernel/session/session-manager.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { plainLabel } from "../../presentation/plain-text.ts";
import type { SelfCompactionView } from "../compaction/self-compaction-controller.ts";
import {
	formatKnowledgeCollectionLine,
	formatTranscriptMemoryLines,
	type MemoryPromptInclusionReport,
	type MemoryPromptInclusionStatus,
	type MemoryRetrievalDiagnostics,
	type TranscriptMemoryDiagnostics,
} from "../context/memory-diagnostics.ts";
import type { MemoryPolicyRejectionReason } from "../context/memory-provider-contract.ts";
import type { ContextGcReport } from "../context-gc.ts";
import {
	CONTINUOUS_CHAT_STATE_CUSTOM_TYPE,
	CONTINUOUS_CHAT_VIEW_CUSTOM_TYPE,
} from "../memory/continuous-chat-projection.ts";
import type { KnowledgeCollectionStatus } from "../memory/knowledge-collector.ts";
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

function addRow(rows: AuditRow[], entry: SessionEntry, message: AgentMessage) {
	const preview = messagePreview(message);
	rows.push({
		kind: entry.type,
		role: message.role,
		entryId: entry.id,
		timestamp: entry.timestamp,
		tokens: estimateTokens(message),
		chars: preview.length,
		label: messageLabel(message),
		preview: boundedTextPreview(preview),
	});
}

type ActiveContextAudit = {
	messages: AgentMessage[];
	rows: AuditRow[];
};

/**
 * What an ICM root's provider wire carries instead of the rebuilt session context: nothing while the chat is
 * unavailable (every request is blocked, for `blockedReason`), no turn between turns (the next turn's request is rebuilt
 * from the chat view), else the running turn's frame (chat view, live state) and the session entry its own messages
 * begin at, or why that entry is not known.
 */
export type ContinuousChatAudit =
	| { turn: undefined; blockedReason?: string }
	| { turn: { turnId: number; frame: AgentMessage[]; start: { entryId: string } | { unresolved: string } } };

function frameRow(message: AgentMessage): AuditRow {
	const preview = messagePreview(message);
	const label =
		message.role === "custom" && message.customType === CONTINUOUS_CHAT_VIEW_CUSTOM_TYPE
			? "ICM chat view (frame)"
			: message.role === "custom" && message.customType === CONTINUOUS_CHAT_STATE_CUSTOM_TYPE
				? "ICM turn state (frame)"
				: messageLabel(message);
	return {
		kind: "icm_frame",
		role: message.role,
		timestamp: new Date(message.timestamp).toISOString(),
		tokens: estimateTokens(message),
		chars: preview.length,
		label,
		preview: boundedTextPreview(preview),
	};
}

/**
 * The rows an ICM turn's requests carry: the frame, then the rebuilt context from the turn's start entry on (a
 * compaction summary there is one this turn applied). `messages` holds the turn's own messages, which context GC packs.
 */
function collectContinuousChatTurnAudit(
	context: ActiveContextAudit,
	turn: NonNullable<ContinuousChatAudit["turn"]>,
): ActiveContextAudit & { note: string | undefined } {
	const frameRows = turn.frame.map(frameRow);
	if ("unresolved" in turn.start) return { messages: [], rows: frameRows, note: turn.start.unresolved };
	const { entryId } = turn.start;
	const startIndex = context.rows.findIndex((row) => row.entryId === entryId);
	if (startIndex === -1) {
		return {
			messages: [],
			rows: frameRows,
			note: `the turn's start entry ${entryId} is not in the rebuilt session context`,
		};
	}
	const turnRows = context.rows
		.slice(startIndex)
		.map((row) =>
			row.role === "compactionSummary" ? { ...row, label: "compaction summary (applied by this turn)" } : row,
		);
	return { messages: context.messages.slice(startIndex), rows: [...frameRows, ...turnRows], note: undefined };
}

/** The rows of the context a rebuild of `branch` (root to leaf) holds, read from the session's own rebuild. */
export function collectActiveContextAudit(branch: readonly SessionEntry[]): ActiveContextAudit {
	const audit: ActiveContextAudit = { messages: [], rows: [] };
	for (const { entry, message } of sessionContextItems(branch)) {
		audit.messages.push(message);
		addRow(audit.rows, entry, message);
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

/** Owner words for each memory policy rejection; the codes stay in the debug log. */
const REJECTION_WORDS: Readonly<Record<MemoryPolicyRejectionReason, string>> = {
	provider_disabled: "the provider is turned off",
	provider_not_searchable: "the provider cannot search",
	provider_not_fetchable: "the provider cannot fetch items",
	provider_not_writable: "the provider cannot write",
	provider_scope_unsupported: "the provider does not support this scope",
	policy_scope_blocked: "the policy blocks this scope",
	external_egress_blocked: "sending data outside is blocked",
	query_payload_disabled: "sending the query is turned off",
	query_too_large: "the query is too large",
	secret_like_query: "the query looks like it contains a secret",
	secret_write_rejected: "the write looks like it contains a secret",
	missing_evidence: "no evidence was given",
	durable_write_requires_approval: "a lasting write needs the owner's approval",
	external_write_requires_approval: "a write outside needs the owner's approval",
	missing_approval: "the owner's approval is missing",
};

/** Owner words for a failed provider's error class; any class not listed reads as an unexpected error. */
const FAILURE_WORDS: Readonly<Record<string, string | undefined>> = {
	pending: "still pending",
	unavailable: "unavailable",
	forbidden: "access refused",
	not_found: "not found",
	expired: "expired",
	uncaptured: "not captured",
	stale_snapshot: "out of date",
};

const INCLUSION_WORDS: Readonly<Record<MemoryPromptInclusionStatus, string>> = {
	disabled: "disabled",
	include_disabled: "not included in prompts",
	withheld: "withheld",
	no_results: "no results",
	empty_block: "nothing to include",
	included: "included",
	failed: "failed",
};

function formatMemoryProviderLines(retrieval: MemoryRetrievalDiagnostics): string[] {
	return retrieval.providerReports.map((providerReport) => {
		harnessLog.debug("ui", "a memory provider line was shown in words", () => ({
			providerId: providerReport.providerId,
			rejectionReasons: providerReport.rejectionReasons,
			failure: providerReport.failure,
		}));
		const rejection =
			providerReport.rejectionReasons.length > 0
				? `; rejected: ${providerReport.rejectionReasons.map((reason) => REJECTION_WORDS[reason]).join(", ")}`
				: "";
		const failure =
			providerReport.failure !== undefined
				? `; failure: ${FAILURE_WORDS[providerReport.failure] ?? "an unexpected error"}`
				: "";
		return `  ${plainLabel(providerReport.providerId)}: ${providerReport.status} (${providerReport.resultCount} result(s)${rejection}${failure})`;
	});
}

function formatMemoryPromptInclusionLine(promptInclusion: MemoryPromptInclusionReport): string {
	harnessLog.debug("ui", "the prompt inclusion status was shown in words", () => ({ status: promptInclusion.status }));
	return `Prompt inclusion: ${INCLUSION_WORDS[promptInclusion.status]} (${promptInclusion.includedCount} included, ${promptInclusion.omittedCount} omitted, ${promptInclusion.blockChars} chars)`;
}

function formatSelfCompactionLine(view: SelfCompactionView): string {
	if (view.settingsError) {
		harnessLog.debug("ui", "self-compaction settings were rejected", () => ({ settingsError: view.settingsError }));
		return "self-compaction: disabled because one of its settings is invalid; check the compaction settings in settings.json";
	}
	if (!view.thresholds) return `self-compaction: ${view.enabled ? "unavailable (no compaction trigger)" : "disabled"}`;
	const t = view.thresholds;
	const handoff =
		view.handoff.status === "none" ? "" : `, handoff ${view.handoff.status} (attempts ${view.handoff.attempts})`;
	return `self-compaction: level ${view.level}; notice ${t.noticeTokens}, warning ${t.warningTokens}, forced ${t.forcedTokens}, host early ${t.earlyTokens ?? "off"}, hard ${t.hardTokens}; tools ${view.toolsLocked ? "locked to self-compaction" : "open"}${handoff}`;
}

export function createCoreDiagnosticsToolDefinitions(
	getActiveTools: () => string[],
	getAllTools: () => ToolInfo[],
	getContextGcReport?: (messages: AgentMessage[]) => ContextGcReport,
	getMemoryDiagnostics?: () => {
		retrieval: MemoryRetrievalDiagnostics;
		promptInclusion: MemoryPromptInclusionReport;
		transcript: TranscriptMemoryDiagnostics;
		knowledge: KnowledgeCollectionStatus;
	},
	getSelfCompactionView?: () => SelfCompactionView | undefined,
	getContinuousChatAudit?: () => ContinuousChatAudit | undefined,
): ToolDefinition[] {
	return [
		{
			name: "context_audit",
			label: "Context Audit",
			description:
				"Audit the current provider-visible context composition: model window usage, system prompt estimate, active tool schema estimate, active session message rows (under ICM: the chat view and turn-state frame plus the running turn's own rows), and heaviest context contributors.",
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
				const sessionContext = collectActiveContextAudit(branch);
				// Under ICM no request carries the rebuilt session context: a turn's requests carry its frame and its own
				// messages, and between turns nothing is sent until the next turn rebuilds from the chat view.
				const continuousChat = getContinuousChatAudit?.();
				const turnAudit =
					continuousChat?.turn === undefined
						? undefined
						: collectContinuousChatTurnAudit(sessionContext, continuousChat.turn);
				const { rows, messages: activeMessages } =
					continuousChat === undefined ? sessionContext : (turnAudit ?? { rows: [], messages: [] });
				const contextGcReport =
					continuousChat !== undefined && turnAudit === undefined
						? undefined
						: getContextGcReport?.(activeMessages);
				const rowScopeLine =
					continuousChat === undefined
						? undefined
						: continuousChat.turn === undefined
							? continuousChat.blockedReason !== undefined
								? `ICM: the project chat is unavailable (${continuousChat.blockedReason}); every provider request is blocked until it recovers, and none carries session history`
								: "ICM: no chat turn is running; the next turn's requests carry the chat view, its live state and that turn's own messages, never earlier session history"
							: `ICM chat turn ${continuousChat.turn.turnId}: rows are the request frame (${continuousChat.turn.frame.length}) and the turn's own messages (${rows.length - continuousChat.turn.frame.length})${turnAudit?.note ? `; no turn rows: ${turnAudit.note}` : ""}`;
				const memoryDiagnostics = getMemoryDiagnostics?.();
				const selfCompaction = getSelfCompactionView?.();
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
					rowScopeLine,
					continuousChat === undefined
						? `active branch rows: ${rows.length}; session row estimate: ${rowTokenSum} tokens`
						: `ICM request rows: ${rows.length}; row estimate: ${rowTokenSum} tokens`,
					contextGcReport
						? `Context GC estimate: ${contextGcReport.savedTokens} tokens saved by packing ${contextGcReport.packedCount} stale row(s); effective session row estimate: ${effectiveRowTokenSum} tokens`
						: undefined,
					`system prompt estimate: ${systemTokens} tokens (${systemPrompt.length} chars)`,
					`active tool schema estimate: ${toolSchemaTokens} tokens across ${activeToolInfos.length} active tool(s)`,
					unattributed === null
						? undefined
						: `provider-reported remainder not mapped by chars/4 rows: ${unattributed} tokens`,
					selfCompaction ? formatSelfCompactionLine(selfCompaction) : undefined,
					...(memoryDiagnostics
						? [
								formatMemoryRetrievalLine(memoryDiagnostics.retrieval),
								...formatMemoryProviderLines(memoryDiagnostics.retrieval),
								formatMemoryPromptInclusionLine(memoryDiagnostics.promptInclusion),
								...formatTranscriptMemoryLines(memoryDiagnostics.transcript),
								formatKnowledgeCollectionLine(memoryDiagnostics.knowledge),
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
						continuousChat:
							continuousChat === undefined
								? undefined
								: continuousChat.turn === undefined
									? { running: false }
									: {
											running: true,
											turnId: continuousChat.turn.turnId,
											start: continuousChat.turn.start,
											frameRows: continuousChat.turn.frame.length,
										},
						rows,
						memory: memoryDiagnostics,
						selfCompaction,
					},
				};
			},
		},
	];
}
