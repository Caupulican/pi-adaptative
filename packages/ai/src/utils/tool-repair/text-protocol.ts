import type { Tool, ToolCall } from "../../types.ts";

export interface ParsedTextToolCalls {
	calls: ToolCall[];
	text: string;
}

export type TextToolProtocolVariant = "tool-tag" | "tool-call" | "fenced-json";

export interface TextToolProtocolOptions {
	variant?: TextToolProtocolVariant;
}

type EnvelopeKind = "tool" | "tool_call" | "fenced_json";

interface EnvelopeMatch {
	kind: EnvelopeKind;
	start: number;
	end: number;
	name?: string;
	body: string;
}

const MAX_SCHEMA_CHARS = 600;
const DEFAULT_TEXT_TOOL_PROTOCOL_VARIANT: TextToolProtocolVariant = "tool-tag";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactJson(value: unknown, maxChars = MAX_SCHEMA_CHARS): string {
	const json = JSON.stringify(value);
	if (json.length <= maxChars) return json;
	return `${json.slice(0, maxChars - 1)}…`;
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeAttribute(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function knownToolNames(tools: readonly Tool[]): Set<string> {
	return new Set(tools.map((tool) => tool.name));
}

function findToolEnvelopes(text: string): EnvelopeMatch[] {
	const matches: EnvelopeMatch[] = [];
	const toolEnvelope = /<tool\s+name="([^"]+)">([\s\S]*?)<\/tool>/g;
	for (const match of text.matchAll(toolEnvelope)) {
		matches.push({
			kind: "tool",
			start: match.index,
			end: match.index + match[0].length,
			name: unescapeAttribute(match[1] ?? ""),
			body: match[2] ?? "",
		});
	}

	const toolCallEnvelope = /<tool_call>([\s\S]*?)<\/tool_call>/g;
	for (const match of text.matchAll(toolCallEnvelope)) {
		matches.push({
			kind: "tool_call",
			start: match.index,
			end: match.index + match[0].length,
			body: match[1] ?? "",
		});
	}

	const trimmed = text.trim();
	const fence = /^```(?:json|tool|tool_call)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
	if (fence?.[1]) {
		const start = text.indexOf(trimmed);
		matches.push({ kind: "fenced_json", start, end: start + trimmed.length, body: fence[1] });
	}

	return matches.sort((a, b) => a.start - b.start);
}

function hasOverlap(matches: readonly EnvelopeMatch[]): boolean {
	let previousEnd = -1;
	for (const match of matches) {
		if (match.start < previousEnd) return true;
		previousEnd = match.end;
	}
	return false;
}

function remainingText(text: string, matches: readonly EnvelopeMatch[]): string | undefined {
	let cursor = 0;
	const pieces: string[] = [];
	for (const match of matches) {
		pieces.push(text.slice(cursor, match.start));
		cursor = match.end;
	}
	pieces.push(text.slice(cursor));
	const remainder = pieces.join("");
	return remainder.trim().length === 0 ? remainder : undefined;
}

function coerceArguments(value: unknown): {
	arguments: Record<string, unknown>;
	rawArguments?: Record<string, unknown>;
} {
	if (isRecord(value)) return { arguments: value };
	return { arguments: {}, rawArguments: { value } };
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(raw);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function extractNameFromMalformedJson(raw: string, names: ReadonlySet<string>): string | undefined {
	for (const name of names) {
		if (raw.includes(`"${name}"`)) return name;
	}
	return undefined;
}

function parseEnvelope(match: EnvelopeMatch, names: ReadonlySet<string>, index: number): ToolCall | undefined {
	if (match.kind === "tool") {
		if (!match.name || !names.has(match.name)) return undefined;
		const parsed = parseJsonObject(match.body);
		const args = parsed ? { arguments: parsed } : { arguments: {}, rawArguments: { text: match.body.trim() } };
		return {
			type: "toolCall",
			id: `text-tool-${index}`,
			name: match.name,
			arguments: args.arguments,
			rawArguments: args.rawArguments,
			source: "text-protocol",
		};
	}

	const parsed = parseJsonObject(match.body);
	if (!parsed) {
		const name = extractNameFromMalformedJson(match.body, names);
		if (!name) return undefined;
		return {
			type: "toolCall",
			id: `text-tool-${index}`,
			name,
			arguments: {},
			rawArguments: { text: match.body.trim() },
			source: "text-protocol",
		};
	}

	const nameValue = parsed.name ?? parsed.tool;
	if (typeof nameValue !== "string" || !names.has(nameValue)) return undefined;
	const argsValue = parsed.arguments ?? parsed.args ?? {};
	const args = coerceArguments(argsValue);
	return {
		type: "toolCall",
		id: `text-tool-${index}`,
		name: nameValue,
		arguments: args.arguments,
		rawArguments: args.rawArguments,
		source: "text-protocol",
	};
}

export function normalizeTextToolProtocolOptions(
	option: boolean | TextToolProtocolOptions | undefined,
): TextToolProtocolOptions | undefined {
	if (!option) return undefined;
	if (option === true) return { variant: DEFAULT_TEXT_TOOL_PROTOCOL_VARIANT };
	return { variant: option.variant ?? DEFAULT_TEXT_TOOL_PROTOCOL_VARIANT };
}

function formatVariantEnvelope(variant: TextToolProtocolVariant, toolName: string, argsJson: string): string {
	if (variant === "tool-call") return `<tool_call>{"name":"${toolName}","arguments":${argsJson}}</tool_call>`;
	if (variant === "fenced-json") return `\`\`\`tool_call\n{"name":"${toolName}","arguments":${argsJson}}\n\`\`\``;
	return `<tool name="${escapeAttribute(toolName)}">${argsJson}</tool>`;
}

export function generateTextToolProtocolPrimer(tools: readonly Tool[], options?: TextToolProtocolOptions): string {
	if (tools.length === 0) return "";
	const variant = options?.variant ?? DEFAULT_TEXT_TOOL_PROTOCOL_VARIANT;
	const lines = [
		"Text tool-call protocol is enabled.",
		"When calling tools, output only one or more envelopes and no prose:",
		formatVariantEnvelope(variant, "TOOL_NAME", '{"argument":"value"}'),
		"Available tools:",
	];
	for (const tool of tools) {
		lines.push(`- ${escapeAttribute(tool.name)}: ${tool.description}; args schema ${compactJson(tool.parameters)}`);
	}
	const exampleTool = tools[0];
	lines.push("Examples:", formatVariantEnvelope(variant, exampleTool.name, "{}"));
	return lines.join("\n");
}

export function parseTextToolCalls(text: string, knownTools: readonly Tool[]): ParsedTextToolCalls {
	if (knownTools.length === 0) return { calls: [], text };
	const matches = findToolEnvelopes(text);
	if (matches.length === 0 || hasOverlap(matches)) return { calls: [], text };
	const remainder = remainingText(text, matches);
	if (remainder === undefined) return { calls: [], text };
	const names = knownToolNames(knownTools);
	const calls = matches
		.map((match, index) => parseEnvelope(match, names, index + 1))
		.filter((call): call is ToolCall => call !== undefined);
	return calls.length > 0 ? { calls, text: remainder.trim() } : { calls: [], text };
}
