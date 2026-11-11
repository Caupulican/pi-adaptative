/**
 * The request Command Code's generate route takes: pi's context as that route's messages, tools and system sections,
 * under the headers of the client release whose protocol this speaks.
 *
 * The route takes workspace facts beside the conversation. Pi's own system prompt already carries the ones the
 * model needs, so none of the user's project (its path, its files, its git state) is sent there.
 */

import type {
	CacheRetention,
	Context,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolResultMessage,
} from "../types.ts";
import { withNullableOptionals } from "../utils/nullable-optionals.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import type { ToolNameMap } from "../utils/tool-names.ts";
import { uuidv7 } from "../utils/uuid.ts";
import { joinTextContent, transformMessages } from "./transform-messages.ts";

export const COMMAND_CODE_BASE_URL = "https://api.commandcode.ai";
export const COMMAND_CODE_GENERATE_ROUTE = "/alpha/generate";
/** The Command Code client release whose wire protocol this adapter speaks. */
export const COMMAND_CODE_CLIENT_VERSION = "1.88.5";

type WireText = { type: "text"; text: string };
type WireImage = { type: "image"; image: string; mimeType: string };
type WireAssistantPart =
	| WireText
	| { type: "reasoning"; text: string }
	| { type: "tool-call"; toolCallId: string; toolName: string; input: Record<string, unknown> };
type WireToolResult = {
	type: "tool-result";
	toolCallId: string;
	toolName: string;
	output: { type: "text"; value: string };
};

export type CommandCodeWireMessage =
	| { role: "user"; content: (WireText | WireImage)[] }
	| { role: "assistant"; content: WireAssistantPart[] }
	| { role: "tool"; content: WireToolResult[] };

export interface CommandCodeRequestBody {
	config: {
		workingDir: string;
		date: string;
		environment: string;
		structure: string[];
		isGitRepo: boolean;
		currentBranch: string;
		mainBranch: string;
		gitStatus: string;
		recentCommits: string[];
	};
	memory: null;
	taste: null;
	skills: null;
	permissionMode: "standard";
	threadId?: string;
	promptCache?: "off";
	params: {
		model: string;
		messages: CommandCodeWireMessage[];
		tools: { name: string; description: string; input_schema: unknown }[];
		system?: (WireText & { cache_control?: { type: "ephemeral" } })[];
		max_tokens: number;
		stream: true;
		temperature?: number;
		reasoning_effort?: string;
	};
}

export interface CommandCodeRequestSettings {
	maxTokens?: number;
	temperature?: number;
	reasoningEffort?: string;
	cacheRetention: CacheRetention;
	sessionId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formatDeterministicUuid(bytes: Uint8Array): string {
	const copy = bytes.slice(0, 16);
	copy[6] = (copy[6]! & 0x0f) | 0x50;
	copy[8] = (copy[8]! & 0x3f) | 0x80;
	const hex = Array.from(copy, (byte) => byte.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

function fallbackSessionDigest(input: string): Uint8Array {
	const bytes = new Uint8Array(16);
	const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
	for (let lane = 0; lane < 4; lane++) {
		let hash = seeds[lane]!;
		for (let index = 0; index < input.length; index++) {
			hash ^= input.charCodeAt(index) + lane * 31;
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		bytes[lane * 4] = (hash >>> 24) & 0xff;
		bytes[lane * 4 + 1] = (hash >>> 16) & 0xff;
		bytes[lane * 4 + 2] = (hash >>> 8) & 0xff;
		bytes[lane * 4 + 3] = hash & 0xff;
	}
	return bytes;
}

/**
 * Resolves the one UUID shared by `body.threadId` and `x-session-id` for a conversation: an existing RFC UUID as-is,
 * a deterministic UUID derived from SHA-256 for non-UUID session ids (such as `auto-learn-*`), or a fresh `uuidv7()`.
 */
export async function resolveCommandCodeSessionId(sessionId?: string): Promise<string> {
	const trimmed = sessionId?.trim();
	if (!trimmed) return uuidv7();
	if (UUID.test(trimmed)) return trimmed;
	const subtle = globalThis.crypto?.subtle;
	const digest = subtle
		? new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(`command-code-session:${trimmed}`)))
		: fallbackSessionDigest(trimmed);
	return formatDeterministicUuid(digest);
}

/** Tool call ids of other providers can carry characters and lengths this route's upstream providers refuse. */
function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function imagePart(image: ImageContent): WireImage {
	return { type: "image", image: `data:${image.mimeType};base64,${image.data}`, mimeType: image.mimeType };
}

function userParts(content: string | (TextContent | ImageContent)[]): (WireText | WireImage)[] {
	if (typeof content === "string") return content ? [{ type: "text", text: sanitizeSurrogates(content) }] : [];
	const parts: (WireText | WireImage)[] = [];
	for (const block of content) {
		if (block.type === "image") parts.push(imagePart(block));
		else if (block.text) parts.push({ type: "text", text: sanitizeSurrogates(block.text) });
	}
	return parts;
}

/** The route's tool result is text with no failure flag, so a failed call says so in its text. */
function toolResultText(result: ToolResultMessage): string {
	const text = sanitizeSurrogates(joinTextContent(result.content)).trim();
	const images = result.content.some((block) => block.type === "image");
	const body = text || (images ? "(see attached image)" : "(no tool output)");
	return result.isError ? `[tool error] ${body}` : body;
}

function toWireMessages(messages: Message[], toolNameMap: ToolNameMap): CommandCodeWireMessage[] {
	const wire: CommandCodeWireMessage[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "user") {
			const content = userParts(message.content);
			if (content.length > 0) wire.push({ role: "user", content });
			continue;
		}
		if (message.role === "assistant") {
			const content: WireAssistantPart[] = [];
			for (const block of message.content) {
				if (block.type === "text") {
					if (block.text.trim()) content.push({ type: "text", text: sanitizeSurrogates(block.text) });
				} else if (block.type === "thinking") {
					// Redacted thinking is another provider's sealed payload: this route has no part that carries it.
					if (!block.redacted && block.thinking.trim()) {
						content.push({ type: "reasoning", text: sanitizeSurrogates(block.thinking) });
					}
				} else {
					content.push({
						type: "tool-call",
						toolCallId: block.id,
						toolName: toolNameMap.toProviderName(block.name),
						input: block.arguments ?? {},
					});
				}
			}
			if (content.length > 0) wire.push({ role: "assistant", content });
			continue;
		}
		// The results of one assistant turn travel as one tool message; the route's tool result holds no image, so
		// their images follow in a user message.
		const results: WireToolResult[] = [];
		const images: WireImage[] = [];
		for (; index < messages.length; index++) {
			const result = messages[index];
			if (result.role !== "toolResult") break;
			results.push({
				type: "tool-result",
				toolCallId: result.toolCallId,
				toolName: toolNameMap.toProviderName(result.toolName),
				output: { type: "text", value: toolResultText(result) },
			});
			for (const block of result.content) if (block.type === "image") images.push(imagePart(block));
		}
		index--;
		wire.push({ role: "tool", content: results });
		if (images.length > 0) wire.push({ role: "user", content: images });
	}
	return wire;
}

// The caller's cap narrows the model's own cap; nothing widens it.
function outputCap(model: Model<"command-code-generate">, settings: CommandCodeRequestSettings): number {
	return Math.min(settings.maxTokens ?? model.maxTokens, model.maxTokens);
}

/**
 * Whether the model's tools go out with nullable optional parameters. The service applies strict function schemas to
 * its OpenAI upstream, where every declared property is required, so "not set" must be a value the model can send.
 */
export function sendsNullForUnset(model: Model<"command-code-generate">): boolean {
	return model.upstream === "openai";
}

/** What the model is told where a strict upstream makes every parameter required. */
const UNSET_PARAMETER_NOTE = "Send null for a parameter you do not set.";

/** A strict upstream takes every property as required, so an optional one is sent as nullable. */
function toolsForUpstream(
	model: Model<"command-code-generate">,
	context: Context,
	toolNameMap: ToolNameMap,
): CommandCodeRequestBody["params"]["tools"] {
	const nullable = sendsNullForUnset(model);
	return (context.tools ?? []).map((tool) => ({
		name: toolNameMap.toProviderName(tool.name),
		description: nullable ? `${tool.description} ${UNSET_PARAMETER_NOTE}` : tool.description,
		input_schema: nullable ? withNullableOptionals(tool.parameters) : tool.parameters,
	}));
}

/** The body of one generate request. */
export function buildCommandCodeRequest(
	model: Model<"command-code-generate">,
	context: Context,
	toolNameMap: ToolNameMap,
	settings: CommandCodeRequestSettings,
): CommandCodeRequestBody {
	const caching = settings.cacheRetention !== "none";
	const params: CommandCodeRequestBody["params"] = {
		model: model.id,
		messages: toWireMessages(transformMessages(context.messages, model, normalizeToolCallId), toolNameMap),
		tools: toolsForUpstream(model, context, toolNameMap),
		max_tokens: outputCap(model, settings),
		stream: true,
	};
	if (context.systemPrompt) {
		const text = sanitizeSurrogates(context.systemPrompt);
		params.system = [caching ? { type: "text", text, cache_control: { type: "ephemeral" } } : { type: "text", text }];
	}
	if (settings.temperature !== undefined) params.temperature = settings.temperature;
	if (settings.reasoningEffort) params.reasoning_effort = settings.reasoningEffort;
	const body: CommandCodeRequestBody = {
		config: {
			workingDir: "",
			date: new Date().toISOString().slice(0, 10),
			environment: typeof process !== "undefined" && process.platform ? process.platform : "unknown",
			structure: [],
			isGitRepo: false,
			currentBranch: "",
			mainBranch: "",
			gitStatus: "",
			recentCommits: [],
		},
		memory: null,
		taste: null,
		skills: null,
		permissionMode: "standard",
		params,
	};
	// The route takes a conversation's thread only as a UUID.
	if (settings.sessionId && UUID.test(settings.sessionId)) body.threadId = settings.sessionId;
	if (!caching) body.promptCache = "off";
	return body;
}

/** The headers of one generate request; caller headers may add to them but never replace the key. */
export function commandCodeHeaders(apiKey: string, sessionId: string, extra?: Record<string, string>): Headers {
	const headers = new Headers(extra);
	headers.set("Content-Type", "application/json");
	headers.set("User-Agent", "cli");
	headers.set("Authorization", `Bearer ${apiKey}`);
	headers.set("x-command-code-version", COMMAND_CODE_CLIENT_VERSION);
	headers.set("x-cli-environment", "production");
	// The client sends the project folder's name here; pi sends its own name instead.
	headers.set("x-project-slug", "pi");
	headers.set("x-taste-learning", "false");
	headers.set("x-session-id", sessionId);
	return headers;
}
