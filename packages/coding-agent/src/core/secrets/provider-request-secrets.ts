import type { Api, Context, Model } from "@caupulican/pi-ai";
import {
	type ContentPath,
	CredentialContentProjectionError,
	type CredentialKeyPreserver,
	type CredentialStringProjector,
	redactCredentialContent,
} from "./credential-model-content.ts";

const RESPONSES_APIS = new Set(["openai-responses", "openai-codex-responses", "azure-openai-responses"]);
const GOOGLE_APIS = new Set(["google-generative-ai", "google-vertex", "google-antigravity"]);
const RESPONSES_ITEM_KEYS = new Set(["type", "id", "summary", "content", "encrypted_content", "status"]);
const COMPLETIONS_ITEM_KEYS = new Set(["type", "id", "data", "format", "index"]);
const ANTHROPIC_ITEM_KEYS = new Set(["type", "thinking", "signature", "data"]);
const GOOGLE_PART_KEYS = new Set(["thoughtSignature", "thought", "text", "functionCall", "inlineData"]);
const CONTEXT_THINKING_KEYS = new Set(["type", "thinking", "thinkingSignature", "redacted"]);
const CONTEXT_TEXT_KEYS = new Set(["type", "text", "textSignature"]);
const CONTEXT_IMAGE_KEYS = new Set(["type", "data", "mimeType"]);
const CONTEXT_TOOL_KEYS = new Set([
	"type",
	"id",
	"name",
	"arguments",
	"rawArguments",
	"thoughtSignature",
	"source",
	"errorMessage",
	"repairNotes",
]);

function isReasoningStatus(text: string): boolean {
	return text === "in_progress" || text === "completed" || text === "incomplete";
}

function reasoningSummaryType(path: ContentPath, parent: unknown): string | undefined {
	if (path.length !== 2 || typeof path[1] !== "number") return undefined;
	const type = path[0] === "summary" ? "summary_text" : path[0] === "content" ? "reasoning_text" : undefined;
	return type && field(parent, "type") === type ? type : undefined;
}

/** Read data properties only: a payload hook cannot gain trust by running getters. */
function field(value: unknown, key: string | number): unknown {
	if (!value || typeof value !== "object") return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function at(value: unknown, path: ContentPath): unknown {
	for (const key of path) value = field(value, key);
	return value;
}

/** Request-scoped provenance, frozen before a payload hook can introduce new strings. */
export function createProviderRequestSecretPolicy(
	context: Context,
	model: Model<Api>,
	redact: (text: string) => string,
) {
	// Hooks receive the same model object. Protocol selection must not follow later mutations.
	const api = model.api;
	const provider = model.provider;
	const modelId = model.id;
	const contextStrings = new Map<string, { original: string; projected: string }>();
	const opaque = new Set<string>();
	const messages = field(context, "messages");
	if (!Array.isArray(messages)) throw new CredentialContentProjectionError("accessor");
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const message = field(messages, messageIndex);
		const role = field(message, "role");
		const content = field(message, "content");
		const stop = field(message, "stopReason");
		if (
			role === "assistant" &&
			(stop === "stop" || stop === "length" || stop === "toolUse" || stop === "error" || stop === "aborted")
		)
			contextStrings.set(JSON.stringify(["messages", messageIndex, "stopReason"]), {
				original: stop,
				projected: stop,
			});
		if (role === "user" || role === "toolResult" || role === "assistant") {
			contextStrings.set(JSON.stringify(["messages", messageIndex, "role"]), { original: role, projected: role });
		}
		if (!Array.isArray(content)) continue;
		if (role === "user" || role === "toolResult") {
			for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
				const block = field(content, blockIndex);
				const data = field(block, "data");
				const type = field(block, "type");
				if (type === "text" || type === "image")
					contextStrings.set(JSON.stringify(["messages", messageIndex, "content", blockIndex, "type"]), {
						original: type,
						projected: type,
					});
				if (field(block, "type") === "image" && typeof data === "string") {
					contextStrings.set(JSON.stringify(["messages", messageIndex, "content", blockIndex, "data"]), {
						original: data,
						projected: data,
					});
				}
			}
			continue;
		}
		if (
			role !== "assistant" ||
			field(message, "api") !== api ||
			field(message, "provider") !== provider ||
			field(message, "model") !== modelId ||
			field(message, "stopReason") === "error" ||
			field(message, "stopReason") === "aborted"
		)
			continue;
		for (const [key, value] of [
			["api", api],
			["provider", provider],
			["model", modelId],
		] as const)
			contextStrings.set(JSON.stringify(["messages", messageIndex, key]), { original: value, projected: value });
		for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
			const block = field(content, blockIndex);
			const type = field(block, "type");
			if (type !== "thinking" && type !== "text" && type !== "toolCall") continue;
			contextStrings.set(JSON.stringify(["messages", messageIndex, "content", blockIndex, "type"]), {
				original: type,
				projected: type,
			});
			const key = type === "thinking" ? "thinkingSignature" : type === "text" ? "textSignature" : "thoughtSignature";
			const signature = field(block, key);
			if (typeof signature !== "string" || !signature) continue;
			let projected: string;
			const serialized =
				RESPONSES_APIS.has(api) && type === "thinking"
					? { type: "reasoning", field: "encrypted_content" }
					: api === "openai-completions" && type === "toolCall"
						? { type: "reasoning.encrypted", field: "data" }
						: undefined;
			if (serialized) {
				let item: unknown;
				try {
					item = JSON.parse(signature);
				} catch (error) {
					// Completions ignores malformed reasoning-details JSON; Responses rejects it.
					if (api === "openai-completions") continue;
					throw error;
				}
				if (field(item, "type") !== serialized.type) continue;
				const encrypted = field(item, serialized.field);
				if (typeof encrypted === "string") opaque.add(encrypted);
				const keys = serialized.type === "reasoning" ? RESPONSES_ITEM_KEYS : COMPLETIONS_ITEM_KEYS;
				const safe = redactCredentialContent(
					item,
					redact,
					(path, key, parent) =>
						(path.length === 0 && keys.has(key)) ||
						(serialized.type === "reasoning" &&
							reasoningSummaryType(path, parent) !== undefined &&
							(key === "type" || key === "text")),
					undefined,
					(path, text, parent) => {
						if (path.length === 1 && (path[0] === serialized.field || path[0] === "type")) return text;
						if (
							serialized.type === "reasoning" &&
							path.length === 1 &&
							path[0] === "status" &&
							isReasoningStatus(text)
						)
							return text;
						if (
							serialized.type === "reasoning" &&
							path.at(-1) === "type" &&
							text === reasoningSummaryType(path.slice(0, -1), parent)
						)
							return text;
						return redact(text);
					},
				);
				projected = safe === item ? signature : JSON.stringify(safe);
			} else if (GOOGLE_APIS.has(api) || (api === "anthropic-messages" && type === "thinking")) {
				opaque.add(signature);
				projected = signature;
			} else continue;
			contextStrings.set(JSON.stringify(["messages", messageIndex, "content", blockIndex, key]), {
				original: signature,
				projected,
			});
		}
	}
	const contextString: CredentialStringProjector = (path, text, parent) => {
		const trusted = contextStrings.get(JSON.stringify(path));
		if (
			api === "anthropic-messages" &&
			path.at(-1) === "thinking" &&
			field(parent, "type") === "thinking" &&
			!field(parent, "redacted")
		) {
			const signed = contextStrings.get(JSON.stringify([...path.slice(0, -1), "thinkingSignature"]));
			// Enforce integrity at projection time, including a retry after JSON/toJSON normalization.
			if (signed && signed.original === field(parent, "thinkingSignature") && redact(text) !== text)
				throw new CredentialContentProjectionError("signed-content");
		}
		return trusted?.original === text ? trusted.projected : redact(text);
	};
	const protocolItem = (path: ContentPath, parent: unknown, root: unknown) => {
		const type = field(parent, "type");
		if (
			RESPONSES_APIS.has(api) &&
			path.length === 2 &&
			path[0] === "input" &&
			typeof path[1] === "number" &&
			type === "reasoning"
		)
			return { type: "reasoning", key: "encrypted_content", keys: RESPONSES_ITEM_KEYS };
		if (
			api === "openai-completions" &&
			path.length === 4 &&
			path[0] === "messages" &&
			typeof path[1] === "number" &&
			path[2] === "reasoning_details" &&
			typeof path[3] === "number" &&
			field(at(root, path.slice(0, 2)), "role") === "assistant" &&
			type === "reasoning.encrypted"
		)
			return { type: "reasoning.encrypted", key: "data", keys: COMPLETIONS_ITEM_KEYS };
		if (
			api === "anthropic-messages" &&
			path.length === 4 &&
			path[0] === "messages" &&
			typeof path[1] === "number" &&
			path[2] === "content" &&
			typeof path[3] === "number" &&
			field(at(root, path.slice(0, 2)), "role") === "assistant"
		) {
			const key = type === "thinking" ? "signature" : type === "redacted_thinking" ? "data" : undefined;
			if (key) return { type: type as string, key, keys: ANTHROPIC_ITEM_KEYS };
		}
		if (
			GOOGLE_APIS.has(api) &&
			path.length === 4 &&
			path[0] === "contents" &&
			typeof path[1] === "number" &&
			path[2] === "parts" &&
			typeof path[3] === "number" &&
			field(at(root, path.slice(0, 2)), "role") === "model"
		) {
			return { type: undefined, key: "thoughtSignature", keys: GOOGLE_PART_KEYS };
		}
		return undefined;
	};
	const summaryItem = (path: ContentPath, parent: unknown, root: unknown) => {
		if (
			!RESPONSES_APIS.has(api) ||
			path.length !== 4 ||
			path[0] !== "input" ||
			typeof path[1] !== "number" ||
			typeof path[3] !== "number"
		)
			return undefined;
		if (protocolItem(path.slice(0, 2), at(root, path.slice(0, 2)), root))
			return reasoningSummaryType(path.slice(2), parent);
		return undefined;
	};
	const payloadKey: CredentialKeyPreserver = (path, key, parent, root) => {
		if (protocolItem(path, parent, root)?.keys.has(key)) return true;
		if (summaryItem(path, parent, root) && (key === "type" || key === "text")) return true;
		// These are codec keys only at the actual request/message/part boundaries, never in arguments.
		if (path.length === 0) {
			const name = RESPONSES_APIS.has(api)
				? "input"
				: GOOGLE_APIS.has(api)
					? "contents"
					: api === "openai-completions" || api === "anthropic-messages"
						? "messages"
						: undefined;
			if (!name) return false;
			return key === name && Array.isArray(field(parent, name));
		}
		return (
			path.length === 2 &&
			typeof path[1] === "number" &&
			((path[0] === "messages" &&
				((api === "openai-completions" && key === "reasoning_details") ||
					(api === "anthropic-messages" && key === "content"))) ||
				(GOOGLE_APIS.has(api) && path[0] === "contents" && key === "parts"))
		);
	};
	const payloadString: CredentialStringProjector = (path, text, parent, root) => {
		const key = path.at(-1);
		const item = protocolItem(path.slice(0, -1), parent, root);
		if (item) {
			if ((key === item.key && opaque.has(text)) || (key === "type" && text === item.type)) return text;
			if (item.type === "reasoning" && key === "status" && isReasoningStatus(text)) return text;
			const signature = field(parent, "signature");
			if (
				api === "anthropic-messages" &&
				item.type === "thinking" &&
				key === "thinking" &&
				typeof signature === "string" &&
				opaque.has(signature) &&
				redact(text) !== text
			)
				throw new CredentialContentProjectionError("signed-content");
		}
		if (key === "type" && text === summaryItem(path.slice(0, -1), parent, root)) return text;
		// Native role enums are control fields, not readable content; no user/tool object matches this path.
		if (
			path.length === 3 &&
			typeof path[1] === "number" &&
			key === "role" &&
			(((((api === "openai-completions" || api === "anthropic-messages") && path[0] === "messages") ||
				(RESPONSES_APIS.has(api) && path[0] === "input")) &&
				(text === "assistant" ||
					text === "user" ||
					text === "system" ||
					text === "tool" ||
					text === "developer")) ||
				(GOOGLE_APIS.has(api) && path[0] === "contents" && (text === "model" || text === "user")))
		)
			return text;
		return redact(text);
	};
	return {
		contextString,
		contextKey(path: ContentPath, key: string, parent: object, root: unknown): boolean {
			if (
				(path.length === 0 && key === "messages" && Array.isArray(field(parent, key))) ||
				(path.length === 2 && path[0] === "messages" && typeof path[1] === "number" && key === "content")
			)
				return true;
			if (
				path.length !== 4 ||
				path[0] !== "messages" ||
				typeof path[1] !== "number" ||
				path[2] !== "content" ||
				typeof path[3] !== "number"
			)
				return false;
			const role = field(at(root, path.slice(0, 2)), "role");
			const type = field(parent, "type");
			if (role === "assistant") {
				return type === "thinking"
					? CONTEXT_THINKING_KEYS.has(key)
					: type === "text"
						? CONTEXT_TEXT_KEYS.has(key)
						: type === "toolCall"
							? CONTEXT_TOOL_KEYS.has(key)
							: false;
			}
			return (
				(role === "user" || role === "toolResult") &&
				(type === "text" ? CONTEXT_TEXT_KEYS.has(key) : type === "image" ? CONTEXT_IMAGE_KEYS.has(key) : false)
			);
		},
		payloadKey,
		payloadString,
		payloadObject(path: ContentPath, value: object): boolean {
			return (
				GOOGLE_APIS.has(api) &&
				path.length === 2 &&
				path[0] === "config" &&
				path[1] === "abortSignal" &&
				value instanceof AbortSignal
			);
		},
	};
}
