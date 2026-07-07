import type { Tool, ToolCall } from "../../types.ts";

export type TextToolProtocolParseFailure =
	| "overlap"
	| "mixed-prose"
	| "unrecognized"
	| "unknown-tool"
	| "validation-failed";

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

const DEFAULT_TEXT_TOOL_PROTOCOL_VARIANT: TextToolProtocolVariant = "tool-tag";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

function findJsonObjectEnd(text: string, start: number): number | undefined {
	let index = start;
	while (/\s/.test(text[index] ?? "")) index++;
	if (text[index] !== "{") return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") depth++;
		if (char === "}") {
			depth--;
			if (depth === 0) return index + 1;
		}
	}
	return undefined;
}

function isInsideMatch(index: number, matches: readonly EnvelopeMatch[]): boolean {
	return matches.some((match) => index >= match.start && index < match.end);
}

function findToolEnvelopes(text: string): EnvelopeMatch[] {
	const matches: EnvelopeMatch[] = [];
	const piCallEnvelope = /<pi:call\s+name=(["'])(.*?)\1\s*>([\s\S]*?)<\/pi:call\s*>/g;
	for (const match of text.matchAll(piCallEnvelope)) {
		matches.push({
			kind: "pi_call",
			start: match.index,
			end: match.index + match[0].length,
			name: unescapeAttribute(match[2] ?? ""),
			body: match[3] ?? "",
		});
	}

	const openPiCallEnvelope = /<pi:call\s+name=(["'])(.*?)\1\s*>/g;
	for (const match of text.matchAll(openPiCallEnvelope)) {
		if (isInsideMatch(match.index, matches)) continue;
		const bodyStart = match.index + match[0].length;
		const bodyEnd = findJsonObjectEnd(text, bodyStart);
		if (bodyEnd === undefined) continue;
		matches.push({
			kind: "pi_call",
			start: match.index,
			end: bodyEnd,
			name: unescapeAttribute(match[2] ?? ""),
			body: text.slice(bodyStart, bodyEnd),
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

	const fence = /```(?:tool|tool_call|json)\s*\n([\s\S]*?)\n?```/gi;
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

function normalizeSingleQuotedJson(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (!/^\{[\s\S]*\}$/.test(trimmed)) return undefined;
	if (!/'[^'\\]*(?:\\.[^'\\]*)*'/.test(trimmed)) return undefined;
	return trimmed.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, inner: string) => {
		return JSON.stringify(inner.replace(/\\'/g, "'"));
	});
}

function normalizeBareJsonObject(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (!/^\{[\s\S]*\}$/.test(trimmed)) return undefined;
	let changed = false;
	let normalized = trimmed.replace(
		/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g,
		(_match, prefix: string, key: string, suffix: string) => {
			changed = true;
			return `${prefix}${JSON.stringify(key)}${suffix}`;
		},
	);
	normalized = normalized.replace(/:\s*([A-Za-z_./-][A-Za-z0-9_./:-]*)(?=\s*[,}])/g, (_match, value: string) => {
		if (["true", "false", "null"].includes(value)) return `:${value}`;
		changed = true;
		return `:${JSON.stringify(value)}`;
	});
	return changed ? normalized : undefined;
}

function normalizedJsonCandidates(raw: string): string[] {
	const candidates: string[] = [];
	const objectEnd = findJsonObjectEnd(raw, 0);
	if (objectEnd !== undefined && raw.slice(objectEnd).trim()) candidates.push(raw.slice(0, objectEnd));
	const singleQuoted = normalizeSingleQuotedJson(raw);
	if (singleQuoted) candidates.push(singleQuoted);
	const bare = normalizeBareJsonObject(raw);
	if (bare) candidates.push(bare);
	const singleQuotedBare = singleQuoted ? normalizeBareJsonObject(singleQuoted) : undefined;
	if (singleQuotedBare) candidates.push(singleQuotedBare);
	return candidates;
}

function parseJsonValue(raw: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(raw) as unknown };
	} catch {
		for (const normalized of normalizedJsonCandidates(raw)) {
			try {
				return { ok: true, value: JSON.parse(normalized) as unknown };
			} catch {
				// Try the next bounded normalization candidate.
			}
		}
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

	const wrappedTool = isRecord(parsed.tool) ? parsed.tool : undefined;
	const nameValue = parsed.name ?? (typeof parsed.tool === "string" ? parsed.tool : undefined) ?? wrappedTool?.name;
	if (typeof nameValue !== "string") return undefined;
	const argsValue = parsed.arguments ?? parsed.args ?? wrappedTool?.arguments ?? wrappedTool?.args ?? {};
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

function schemaRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function firstString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function schemaType(schema: Record<string, unknown>): string | undefined {
	const type = schema.type;
	if (typeof type === "string") return type;
	if (!Array.isArray(type)) return undefined;
	return type.filter(firstString).find((entry) => entry !== "null");
}

function stringExampleForProperty(propertyName: string | undefined): string {
	if (propertyName === "path") return "src/index.ts";
	if (propertyName === "command") return "echo ok";
	if (propertyName === "oldText") return "foo";
	if (propertyName === "newText") return "bar";
	if (propertyName === "content") return "text";
	return "value";
}

function exampleValueForSchema(schemaValue: unknown, propertyName?: string): unknown {
	const schema = schemaRecord(schemaValue);
	if (!schema) return stringExampleForProperty(propertyName);
	const constValue = schema.const;
	if (constValue !== undefined) return constValue;
	const enumValues = Array.isArray(schema.enum) ? schema.enum : [];
	if (enumValues.length > 0) return enumValues[0];
	const defaultValue = schema.default;
	if (defaultValue !== undefined) return defaultValue;
	const type = schemaType(schema);
	if (type === "number" || type === "integer") return 1;
	if (type === "boolean") return true;
	if (type === "array") return [exampleValueForSchema(schema.items, propertyName)];
	if (type === "object") return exampleArgumentsForParameters(schema);
	return stringExampleForProperty(propertyName);
}

function requiredPropertyNames(parameters: Record<string, unknown> | undefined): string[] {
	return Array.isArray(parameters?.required) ? parameters.required.filter(firstString) : [];
}

function exampleArgumentsForParameters(parametersValue: unknown): Record<string, unknown> {
	const parameters = schemaRecord(parametersValue);
	const properties = schemaRecord(parameters?.properties);
	if (!properties) return {};
	const args: Record<string, unknown> = {};
	for (const name of requiredPropertyNames(parameters)) {
		args[name] = exampleValueForSchema(properties[name], name);
	}
	return args;
}

function typeLabel(schemaValue: unknown): string {
	const schema = schemaRecord(schemaValue);
	if (!schema) return "string";
	const enumValues = Array.isArray(schema.enum) ? schema.enum : [];
	if (enumValues.length > 0 && enumValues.every((entry) => ["string", "number", "boolean"].includes(typeof entry))) {
		return enumValues.map(String).join("|");
	}
	const type = schemaType(schema);
	if (type === "integer" || type === "number") return "number";
	if (type === "boolean") return "bool";
	if (type === "array") return `${typeLabel(schema.items)}[]`;
	if (type === "object") {
		const properties = schemaRecord(schema.properties);
		if (!properties) return "{}";
		const entries = Object.entries(properties)
			.slice(0, 4)
			.map(([name, value]) => `${name}:${typeLabel(value)}`);
		const suffix = Object.keys(properties).length > entries.length ? ",..." : "";
		return `{${entries.join(",")}${suffix}}`;
	}
	return "string";
}

function orderedPropertyNames(properties: Record<string, unknown>, required: readonly string[]): string[] {
	const requiredSet = new Set(required);
	return [
		...required.filter((name) => name in properties),
		...Object.keys(properties).filter((name) => !requiredSet.has(name)),
	];
}

function formatDefault(value: unknown): string {
	const json = JSON.stringify(value);
	return json ? `=${json}` : "";
}

function formatToolProjection(tool: Tool): string {
	const parameters = schemaRecord(tool.parameters);
	const properties = schemaRecord(parameters?.properties);
	const required = requiredPropertyNames(parameters);
	const requiredSet = new Set(required);
	const args = properties
		? orderedPropertyNames(properties, required)
				.map((name) => {
					const schema = schemaRecord(properties[name]);
					const optional = requiredSet.has(name) ? "" : "?";
					const defaultText = schema && "default" in schema ? formatDefault(schema.default) : "";
					return `${name}:${typeLabel(schema)}${optional}${defaultText}`;
				})
				.join(", ")
		: "";
	const description = tool.description.replace(/\s+/g, " ").trim();
	return `${tool.name}(${args}) - ${description}`;
}

function toolHasArrayParameter(tool: Tool): boolean {
	const parameters = schemaRecord(tool.parameters);
	const properties = schemaRecord(parameters?.properties);
	if (!properties) return false;
	return Object.values(properties).some((schemaValue) => schemaType(schemaRecord(schemaValue) ?? {}) === "array");
}

function exampleTools(tools: readonly Tool[]): Tool[] {
	const examples: Tool[] = [];
	const readTool = tools.find((tool) => tool.name === "read");
	if (readTool) examples.push(readTool);
	if (examples.length === 0) examples.push(tools[0]);
	const editTool = tools.find((tool) => tool.name === "edit" && !examples.includes(tool));
	const arrayTool = editTool ?? tools.find((tool) => !examples.includes(tool) && toolHasArrayParameter(tool));
	if (arrayTool) examples.push(arrayTool);
	return examples;
}

function protocolHeader(variant: TextToolProtocolVariant): string[] {
	return [
		"Text tool-call protocol is enabled.",
		"When calling tools, output only one or more envelopes and no prose:",
		formatVariantEnvelope(variant, "TOOL", '{"arg":"value"}'),
		"Arguments must be valid JSON objects. Use double quotes for JSON keys and string values. Arrays are JSON arrays [ ], never quoted strings. Omit optional args you do not need - do not send null.",
		"User requests about files, directories, searches, edits, writes, or shell commands require a tool envelope first; do not describe results yourself.",
		'If the user asks to read /tmp/example.txt, output exactly: <pi:call name="read">{"path":"/tmp/example.txt"}</pi:call>',
		'For any request to read a file path, call read with {"path":"THE_PATH"}; never output {"file_path":..., "content":...} or invented file contents.',
		"Never write raw shell commands such as read -t PATH, cat PATH, or ls PATH; use a tool-call envelope instead.",
		"Never output markdown code blocks, raw shell commands, file paths, or invented tool results instead of a tool call; use the envelope and wait for the real result.",
	];
}

export function generateTextToolProtocolPrimer(tools: readonly Tool[], options?: TextToolProtocolOptions): string {
	if (tools.length === 0) return "";
	const variant = options?.variant ?? DEFAULT_TEXT_TOOL_PROTOCOL_VARIANT;
	const lines = [...protocolHeader(variant), "Examples:"];
	for (const tool of exampleTools(tools)) {
		lines.push(
			formatVariantEnvelope(variant, tool.name, JSON.stringify(exampleArgumentsForParameters(tool.parameters))),
		);
	}
	lines.push("Available tools:");
	for (const tool of tools) {
		lines.push(formatToolProjection(tool));
	}
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
