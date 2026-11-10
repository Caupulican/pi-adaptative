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
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import type { ToolNameMap } from "../utils/tool-names.ts";
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
		tools: (context.tools ?? []).map((tool) => ({
			name: toolNameMap.toProviderName(tool.name),
			description: tool.description,
			input_schema: tool.parameters,
		})),
		max_tokens: settings.maxTokens ?? model.maxTokens,
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
