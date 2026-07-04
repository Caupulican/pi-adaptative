import type { AgentMessage } from "@caupulican/pi-agent-core";
import { estimateTokens } from "@caupulican/pi-agent-core/node";
import type { CurationTelemetrySnapshot } from "./brain-curator.ts";

/**
 * Context composition dashboard (user-facing): decomposes EVERYTHING that rides along on every
 * request — system prompt, active tool schemas, extension contributions, injected blocks
 * (memory recall pages, evidence blocks), and the session messages themselves (raw vs. GC-packed
 * vs. policy-stubbed) — so a user integrating their own tools/extensions can see exactly what
 * each addition costs per request and where cleaning is (or is not) working.
 *
 * Honesty contract: everything here is an ESTIMATE (chars/4) EXCEPT `providerReportedTokens`,
 * which is what the provider actually billed. The dashboard always shows both and the delta —
 * the delta is the measure of how much the estimates can be trusted, never hidden.
 *
 * Known exclusions (named, not hidden): extension `context` handlers may rewrite messages at
 * send time in ways this view cannot see. The memory evidence block and enforcement stubbing
 * are ALSO send-time-only, but those are modeled explicitly via `adjustments`.
 */

export interface ToolCompositionRow {
	name: string;
	/** Estimated tokens for the tool's name+description+schema as sent to the provider. */
	schemaTokens: number;
	source: "built-in" | "extension";
}

export interface ExtensionCompositionRow {
	name: string;
	path: string;
	toolCount: number;
	commandCount: number;
	/** Estimated schema tokens of this extension's ACTIVE tools (its per-request cost). */
	activeToolSchemaTokens: number;
}

export interface MessageClassRow {
	label: string;
	count: number;
	tokens: number;
}

export interface ContextCompositionReport {
	/** Estimated tokens of the system prompt sent on every request. */
	systemPromptTokens: number;
	systemPromptChars: number;
	/** Estimated tokens of ALL active tool schemas sent on every request. */
	toolSchemaTokens: number;
	tools: ToolCompositionRow[];
	extensions: ExtensionCompositionRow[];
	/** Session message classes (raw/user/assistant/stubs/recall pages), heaviest first. */
	messageClasses: MessageClassRow[];
	messageTokens: number;
	messageCount: number;
	/** Estimated total sent per request: system prompt + tool schemas + messages. */
	estimatedRequestTokens: number;
	/** What the provider actually reported for the current context, when known. */
	providerReportedTokens: number | null;
	contextWindow: number | null;
	gc: { packedCount: number; savedTokens: number } | null;
	enforcement: { enforcedCount: number; advisoryEvictions: number } | null;
	curation: { enabled: boolean; telemetry: CurationTelemetrySnapshot; lastSkipReason?: string } | null;
	/** Background/side-channel spend that does NOT ride in this context but bills the account. */
	spawned: { cost: number; reports: number } | null;
	/** Send-time-only deltas folded into estimatedRequestTokens: +evidence block, -policy stubs. */
	adjustments: { memoryEvidenceTokens: number; enforcementSavedTokens: number };
	/** Actionable, bounded observations derived from the numbers above. */
	observations: string[];
}

export interface BuildContextCompositionInput {
	systemPrompt: string;
	tools: Array<{ name: string; description?: string; parameters?: unknown; source?: "built-in" | "extension" }>;
	extensions: Array<{
		name: string;
		path: string;
		toolNames: string[];
		commandCount: number;
	}>;
	messages: AgentMessage[];
	providerReportedTokens: number | null;
	contextWindow: number | null;
	gc?: { packedCount: number; savedTokens: number };
	enforcement?: { enforcedCount: number; advisoryEvictions: number };
	curation?: { enabled: boolean; telemetry: CurationTelemetrySnapshot; lastSkipReason?: string };
	spawned?: { cost: number; reports: number };
	adjustments?: { memoryEvidenceTokens: number; enforcementSavedTokens: number };
	/** Pre-formed warnings from other subsystems (e.g. profile-withheld context files). */
	extraObservations?: string[];
}

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function messageText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => (part as { type?: string }).type === "text")
		.map((part) => part.text)
		.join("\n");
}

function classifyMessage(message: AgentMessage): string {
	const details = (
		message as { details?: { contextGc?: { packed?: unknown }; promptPolicy?: { enforced?: unknown } } }
	).details;
	if (details?.contextGc?.packed === true) return "gc-packed stub";
	if (details?.promptPolicy?.enforced === true) return "policy stub";
	if (message.role === "custom") {
		const customType = (message as { customType?: string }).customType ?? "";
		if (customType === "memory_context" || messageText(message).includes("<memory_context")) {
			return "memory recall page";
		}
		return `custom (${customType || "unknown"})`;
	}
	if (message.role === "toolResult") return `toolResult (${(message as { toolName?: string }).toolName ?? "?"})`;
	return message.role;
}

export function buildContextCompositionReport(input: BuildContextCompositionInput): ContextCompositionReport {
	const systemPromptTokens = estimateTextTokens(input.systemPrompt);

	const tools: ToolCompositionRow[] = input.tools
		.map((tool) => ({
			name: tool.name,
			schemaTokens: estimateTextTokens(
				JSON.stringify({ name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? {} }),
			),
			source: tool.source ?? ("built-in" as const),
		}))
		.sort((a, b) => b.schemaTokens - a.schemaTokens);
	const toolSchemaTokens = tools.reduce((sum, tool) => sum + tool.schemaTokens, 0);
	const toolTokensByName = new Map(tools.map((tool) => [tool.name, tool.schemaTokens]));

	const extensions: ExtensionCompositionRow[] = input.extensions
		.map((extension) => ({
			name: extension.name,
			path: extension.path,
			toolCount: extension.toolNames.length,
			commandCount: extension.commandCount,
			activeToolSchemaTokens: extension.toolNames.reduce(
				(sum, toolName) => sum + (toolTokensByName.get(toolName) ?? 0),
				0,
			),
		}))
		.sort((a, b) => b.activeToolSchemaTokens - a.activeToolSchemaTokens);

	const classes = new Map<string, MessageClassRow>();
	let messageTokens = 0;
	for (const message of input.messages) {
		const label = classifyMessage(message);
		const tokens = estimateTokens(message);
		messageTokens += tokens;
		const row = classes.get(label) ?? { label, count: 0, tokens: 0 };
		row.count++;
		row.tokens += tokens;
		classes.set(label, row);
	}
	const messageClasses = [...classes.values()].sort((a, b) => b.tokens - a.tokens);

	const adjustments = input.adjustments ?? { memoryEvidenceTokens: 0, enforcementSavedTokens: 0 };
	const estimatedRequestTokens = Math.max(
		0,
		systemPromptTokens +
			toolSchemaTokens +
			messageTokens +
			adjustments.memoryEvidenceTokens -
			adjustments.enforcementSavedTokens,
	);

	const observations: string[] = [...(input.extraObservations ?? [])];
	const heaviestTool = tools[0];
	if (heaviestTool && toolSchemaTokens > 0 && heaviestTool.schemaTokens > Math.max(500, toolSchemaTokens * 0.3)) {
		observations.push(
			`tool "${heaviestTool.name}" alone is ~${heaviestTool.schemaTokens} tokens of schema on EVERY request — trim its description/schema if you own it`,
		);
	}
	const recall = messageClasses.find((row) => row.label === "memory recall page");
	if (recall && recall.tokens > 1500) {
		observations.push(
			`${recall.count} memory recall page(s) hold ~${recall.tokens} tokens — verify context GC is packing stale ones (gc packed: ${input.gc?.packedCount ?? 0})`,
		);
	}
	if (input.contextWindow && systemPromptTokens + toolSchemaTokens > input.contextWindow * 0.35) {
		observations.push(
			`fixed per-request overhead (system+tools) is ~${Math.round(((systemPromptTokens + toolSchemaTokens) / input.contextWindow) * 100)}% of the context window before any conversation`,
		);
	}
	if (input.providerReportedTokens !== null) {
		const delta = input.providerReportedTokens - estimatedRequestTokens;
		if (Math.abs(delta) > Math.max(2000, estimatedRequestTokens * 0.25)) {
			observations.push(
				`provider-reported context (${input.providerReportedTokens}) differs from the estimate by ${delta > 0 ? "+" : ""}${delta} tokens — treat estimates as directional`,
			);
		}
	}
	if (input.curation?.enabled && input.curation.lastSkipReason) {
		observations.push(`curation is enabled but idle: ${input.curation.lastSkipReason}`);
	}

	return {
		systemPromptTokens,
		systemPromptChars: input.systemPrompt.length,
		toolSchemaTokens,
		tools,
		extensions,
		messageClasses,
		messageTokens,
		messageCount: input.messages.length,
		estimatedRequestTokens,
		providerReportedTokens: input.providerReportedTokens,
		contextWindow: input.contextWindow,
		gc: input.gc ?? null,
		enforcement: input.enforcement ?? null,
		curation: input.curation ?? null,
		spawned: input.spawned ?? null,
		adjustments,
		observations,
	};
}

/** Bounded plain-text dashboard (interactive `/context` command and tests). */
export function formatContextCompositionDashboard(report: ContextCompositionReport, maxToolRows = 10): string {
	const pct = (tokens: number) =>
		report.contextWindow ? ` (${((tokens / report.contextWindow) * 100).toFixed(1)}% of window)` : "";
	const lines: string[] = [
		"Context composition — what rides on EVERY request",
		`estimated request total: ~${report.estimatedRequestTokens} tokens${pct(report.estimatedRequestTokens)}${
			report.providerReportedTokens !== null ? ` · provider-reported: ${report.providerReportedTokens}` : ""
		}`,
		"",
		`system prompt: ~${report.systemPromptTokens} tokens (${report.systemPromptChars} chars)`,
		`tool schemas:  ~${report.toolSchemaTokens} tokens across ${report.tools.length} active tool(s)`,
	];
	for (const tool of report.tools.slice(0, maxToolRows)) {
		lines.push(`  - ${tool.name}: ~${tool.schemaTokens} tok [${tool.source}]`);
	}
	if (report.tools.length > maxToolRows) {
		const rest = report.tools.slice(maxToolRows).reduce((sum, tool) => sum + tool.schemaTokens, 0);
		lines.push(`  - (+${report.tools.length - maxToolRows} more: ~${rest} tok)`);
	}
	if (report.extensions.length > 0) {
		lines.push("", "extensions:");
		for (const extension of report.extensions.slice(0, 8)) {
			lines.push(
				`  - ${extension.name}: ${extension.toolCount} tool(s), ${extension.commandCount} command(s), ~${extension.activeToolSchemaTokens} tok of active schemas`,
			);
		}
	}
	lines.push("", `session messages: ${report.messageCount} row(s), ~${report.messageTokens} tokens`);
	if (report.adjustments.memoryEvidenceTokens > 0 || report.adjustments.enforcementSavedTokens > 0) {
		lines.push(
			`send-time adjustments: +${report.adjustments.memoryEvidenceTokens} memory evidence, -${report.adjustments.enforcementSavedTokens} policy stubs (applied when the request is built)`,
		);
	}
	for (const row of report.messageClasses.slice(0, 10)) {
		lines.push(`  - ${row.label}: ${row.count} row(s), ~${row.tokens} tok`);
	}
	if (report.gc) {
		lines.push(
			"",
			`context GC: ${report.gc.packedCount} row(s) packed, ~${report.gc.savedTokens} tokens saved this pass`,
		);
	}
	if (report.enforcement) {
		lines.push(
			`prompt policy: ${report.enforcement.enforcedCount} stub(s) this turn (${report.enforcement.advisoryEvictions} via brain advisory)`,
		);
	}
	if (report.curation) {
		const t = report.curation.telemetry;
		lines.push(
			`brain curation: ${report.curation.enabled ? "enabled" : "disabled"} — ${t.jobsRun} job(s) run, ${t.parseFailures} parse failure(s), ${t.digestsServed} digest(s) served into stubs, ${t.queued} queued, ~${Math.ceil(t.localChars / 4)} tokens processed locally${
				report.curation.lastSkipReason ? ` · last skip: ${report.curation.lastSkipReason}` : ""
			}`,
		);
	}
	if (report.spawned && report.spawned.reports > 0) {
		lines.push(
			`spawned/background spend (NOT in this context): ${report.spawned.reports} report(s), $${report.spawned.cost.toFixed(4)}`,
		);
	}
	if (report.observations.length > 0) {
		lines.push("", "observations:");
		for (const observation of report.observations.slice(0, 5)) {
			lines.push(`  ! ${observation}`);
		}
	}
	return lines.join("\n");
}
