import type { Tool, ToolCall } from "../../types.ts";

export type TextToolProtocolParseFailure = "overlap" | "mixed-prose" | "unrecognized";

export interface ParsedTextToolCalls {
	calls: ToolCall[];
	text: string;
	attempted: boolean;
	failure?: TextToolProtocolParseFailure;
}

export type TextToolProtocolVariant = "tool-tag" | "tool-call" | "fenced-json";

export interface TextToolProtocolOptions {
	variant?: TextToolProtocolVariant;
}

type EnvelopeKind = "pi_call" | "tool_call" | "fenced_json";

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
	const piCallEnvelope = /<pi:call\s+name="([^"]+)"\s*>([\s\S]*?)<\/pi:call>/g;
	for (const match of text.matchAll(piCallEnvelope)) {
		matches.push({
			kind: "pi_call",
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

	const fence = /```(?:tool|tool_call)\s*\n([\s\S]*?)\n?```/gi;
	for (const match of text.matchAll(fence)) {
		matches.push({
			kind: "fenced_json",
			start: match.index,
			end: match.index + match[0].length,
			body: match[1] ?? "",
		});
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

function remainingText(text: string, matches: readonly EnvelopeMatch[]): string {
	let cursor = 0;
	const pieces: string[] = [];
	for (const match of matches) {
		pieces.push(text.slice(cursor, match.start));
		cursor = match.end;
	}
	pieces.push(text.slice(cursor));
	return pieces.join("");
}

function coerceArguments(value: unknown): {
	arguments: Record<string, unknown>;
	rawArguments?: Record<string, unknown>;
} {
	if (isRecord(value)) return { arguments: value };
	return { arguments: value as Record<string, unknown>, rawArguments: { value } };
}

function parseJsonValue(raw: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(raw) as unknown };
	} catch {
		return { ok: false };
	}
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
	const parsed = parseJsonValue(raw);
	return parsed.ok && isRecord(parsed.value) ? parsed.value : undefined;
}

function textToolErrorMessage(name: string, names: readonly string[]): string | undefined {
	if (names.includes(name)) return undefined;
	return `Unknown tool "${name}". Valid tools: ${names.join(", ")}.`;
}

function extractNameFromMalformedJson(raw: string): string | undefined {
	const match = /"(?:name|tool)"\s*:\s*"([^"]+)"/.exec(raw);
	return match?.[1];
}

function parsePiCallEnvelope(match: EnvelopeMatch, names: readonly string[], index: number): ToolCall | undefined {
	if (!match.name) return undefined;
	const parsed = parseJsonValue(match.body);
	const args = parsed.ok ? coerceArguments(parsed.value) : coerceArguments(match.body.trim());
	return {
		type: "toolCall",
		id: `text-tool-${index}`,
		name: match.name,
		arguments: args.arguments,
		rawArguments: parsed.ok ? args.rawArguments : { text: match.body.trim() },
		source: "text-protocol",
		errorMessage: textToolErrorMessage(match.name, names),
	};
}

function parseEnvelope(match: EnvelopeMatch, names: readonly string[], index: number): ToolCall | undefined {
	if (match.kind === "pi_call") return parsePiCallEnvelope(match, names, index);

	const parsed = parseJsonObject(match.body);
	if (!parsed) {
		const name = extractNameFromMalformedJson(match.body);
		if (!name) return undefined;
		return {
			type: "toolCall",
			id: `text-tool-${index}`,
			name,
			arguments: match.body.trim() as unknown as Record<string, unknown>,
			rawArguments: { text: match.body.trim() },
			source: "text-protocol",
			errorMessage: textToolErrorMessage(name, names),
		};
	}

	const nameValue = parsed.name ?? parsed.tool;
	if (typeof nameValue !== "string") return undefined;
	const argsValue = parsed.arguments ?? parsed.args ?? {};
	const args = coerceArguments(argsValue);
	return {
		type: "toolCall",
		id: `text-tool-${index}`,
		name: nameValue,
		arguments: args.arguments,
		rawArguments: args.rawArguments,
		source: "text-protocol",
		errorMessage: textToolErrorMessage(nameValue, names),
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
	return `<pi:call name="${escapeAttribute(toolName)}">${argsJson}</pi:call>`;
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
	if (knownTools.length === 0) return { calls: [], text, attempted: false };
	const matches = findToolEnvelopes(text);
	if (matches.length === 0) return { calls: [], text, attempted: false };
	if (hasOverlap(matches)) return { calls: [], text, attempted: true, failure: "overlap" };
	const remainder = remainingText(text, matches);
	const names = [...knownToolNames(knownTools)];
	const calls = matches
		.map((match, index) => parseEnvelope(match, names, index + 1))
		.filter((call): call is ToolCall => call !== undefined);
	return calls.length > 0
		? { calls, text: remainder.trim(), attempted: true }
		: { calls: [], text, attempted: true, failure: "unrecognized" };
}
