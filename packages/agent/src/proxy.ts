/**
 * Proxy stream function for apps that route LLM calls through a server.
 * The server manages auth and proxies requests to LLM providers.
 */

// Internal import for JSON parsing utility
import { EventStream } from "@caupulican/pi-ai/event-stream";
import { parseStreamingJson } from "@caupulican/pi-ai/json-parse";
import { StreamingLineDecoder } from "@caupulican/pi-ai/streaming-lines";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "@caupulican/pi-ai/types";
import { createEmptyUsage } from "@caupulican/pi-ai/usage";
import { GeometricStreamingProjector, StreamingTextBuffer } from "./utils/streaming-content.ts";

const textBuffers = new WeakMap<TextContent | ThinkingContent, StreamingTextBuffer>();
const toolArgumentProjectors = new WeakMap<ToolCall, GeometricStreamingProjector<Record<string, unknown>>>();

// Create stream class matching ProxyMessageEventStream
class ProxyMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

/**
 * Proxy event types - server sends these with partial field stripped to reduce bandwidth.
 */
export type ProxyAssistantMessageEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; contentSignature?: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; contentSignature?: string }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			usage: AssistantMessage["usage"];
	  }
	| {
			type: "error";
			reason: Extract<StopReason, "aborted" | "error">;
			errorMessage?: string;
			usage: AssistantMessage["usage"];
	  };

type ProxySerializableStreamOptions = Pick<
	SimpleStreamOptions,
	| "temperature"
	| "maxTokens"
	| "interactionMode"
	| "reasoning"
	| "cacheRetention"
	| "sessionId"
	| "headers"
	| "metadata"
	| "transport"
	| "thinkingBudgets"
	| "maxRetryDelayMs"
>;

export interface ProxyStreamOptions extends ProxySerializableStreamOptions {
	/** Local abort signal for the proxy request */
	signal?: AbortSignal;
	/** Auth token for the proxy server */
	authToken: string;
	/** Proxy server URL (e.g., "https://genai.example.com") */
	proxyUrl: string;
}

/**
 * Stream function that proxies through a server instead of calling LLM providers directly.
 * The server strips the partial field from delta events to reduce bandwidth.
 * We reconstruct the partial message client-side.
 *
 * Use this as the `streamFn` option when creating an Agent that needs to go through a proxy.
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   streamFn: (model, context, options) =>
 *     streamProxy(model, context, {
 *       ...options,
 *       authToken: await getAuthToken(),
 *       proxyUrl: "https://genai.example.com",
 *     }),
 * });
 * ```
 */
function buildProxyRequestOptions(options: ProxyStreamOptions): ProxySerializableStreamOptions {
	return {
		temperature: options.temperature,
		maxTokens: options.maxTokens,
		interactionMode: options.interactionMode,
		reasoning: options.reasoning,
		cacheRetention: options.cacheRetention,
		sessionId: options.sessionId,
		headers: options.headers,
		metadata: options.metadata,
		transport: options.transport,
		thinkingBudgets: options.thinkingBudgets,
		maxRetryDelayMs: options.maxRetryDelayMs,
	};
}

export function streamProxy(model: Model<Api>, context: Context, options: ProxyStreamOptions): ProxyMessageEventStream {
	const stream = new ProxyMessageEventStream();

	(async () => {
		// Initialize the partial message that we'll build up from events
		const partial: AssistantMessage = {
			role: "assistant",
			stopReason: "stop",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createEmptyUsage(),
			timestamp: Date.now(),
		};

		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let terminalPushed = false;
		const pushProxyLine = (line: string) => {
			if (!line.startsWith("data: ")) return;
			const data = line.slice(6).trim();
			if (!data) return;
			const proxyEvent = JSON.parse(data) as ProxyAssistantMessageEvent;
			const event = processProxyEvent(proxyEvent, partial);
			if (!event) return;
			if (event.type === "done" || event.type === "error") terminalPushed = true;
			stream.push(event);
		};

		const abortHandler = () => {
			if (reader) {
				reader.cancel("Request aborted by user").catch(() => {});
			}
		};

		if (options.signal) {
			options.signal.addEventListener("abort", abortHandler);
		}

		try {
			const response = await fetch(`${options.proxyUrl}/api/stream`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.authToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					context,
					options: buildProxyRequestOptions(options),
				}),
				signal: options.signal,
			});

			if (!response.ok) {
				let errorMessage = `Proxy error: ${response.status} ${response.statusText}`;
				try {
					const errorData = (await response.json()) as { error?: string };
					if (errorData.error) {
						errorMessage = `Proxy error: ${errorData.error}`;
					}
				} catch {
					// Couldn't parse error response
				}
				throw new Error(errorMessage);
			}

			reader = response.body!.getReader();
			const decoder = new TextDecoder();
			const lines = new StreamingLineDecoder(64 * 1024 * 1024);

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				if (options.signal?.aborted) {
					throw new Error("Request aborted by user");
				}

				for (const line of lines.push(decoder.decode(value, { stream: true }))) {
					pushProxyLine(line);
				}
			}

			for (const line of lines.push(decoder.decode())) {
				pushProxyLine(line);
			}
			const finalLine = lines.finish();
			if (finalLine) pushProxyLine(finalLine);

			if (options.signal?.aborted) {
				throw new Error("Request aborted by user");
			}

			if (!terminalPushed) {
				finalizeStreamingContent(partial);
				partial.stopReason = "error";
				partial.errorMessage = "stream ended before terminal event";
				stream.push({ type: "error", reason: "error", error: partial });
			}
			stream.end();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const reason = options.signal?.aborted ? "aborted" : "error";
			finalizeStreamingContent(partial);
			partial.stopReason = reason;
			partial.errorMessage = errorMessage;
			stream.push({
				type: "error",
				reason,
				error: partial,
			});
			stream.end();
		} finally {
			if (options.signal) {
				options.signal.removeEventListener("abort", abortHandler);
			}
		}
	})();

	return stream;
}

/**
 * Process a proxy event and update the partial message.
 */
function processProxyEvent(
	proxyEvent: ProxyAssistantMessageEvent,
	partial: AssistantMessage,
): AssistantMessageEvent | undefined {
	switch (proxyEvent.type) {
		case "start":
			return { type: "start", partial };

		case "text_start":
			partial.content[proxyEvent.contentIndex] = createStreamingTextContent("text");
			return { type: "text_start", contentIndex: proxyEvent.contentIndex, partial };

		case "text_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				textBuffers.get(content)?.append(proxyEvent.delta);
				return {
					type: "text_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received text_delta for non-text content");
		}

		case "text_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				finalizeStreamingText(content);
				content.textSignature = proxyEvent.contentSignature;
				return {
					type: "text_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.text,
					partial,
				};
			}
			throw new Error("Received text_end for non-text content");
		}

		case "thinking_start":
			partial.content[proxyEvent.contentIndex] = createStreamingTextContent("thinking");
			return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };

		case "thinking_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				textBuffers.get(content)?.append(proxyEvent.delta);
				return {
					type: "thinking_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received thinking_delta for non-thinking content");
		}

		case "thinking_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				finalizeStreamingText(content);
				content.thinkingSignature = proxyEvent.contentSignature;
				return {
					type: "thinking_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.thinking,
					partial,
				};
			}
			throw new Error("Received thinking_end for non-thinking content");
		}

		case "toolcall_start": {
			const toolCall: ToolCall = {
				type: "toolCall",
				id: proxyEvent.id,
				name: proxyEvent.toolName,
				arguments: {},
			};
			toolArgumentProjectors.set(
				toolCall,
				new GeometricStreamingProjector((text) => parseStreamingJson<Record<string, unknown>>(text)),
			);
			partial.content[proxyEvent.contentIndex] = toolCall;
			return { type: "toolcall_start", contentIndex: proxyEvent.contentIndex, partial };
		}

		case "toolcall_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				const projected = toolArgumentProjectors.get(content)?.append(proxyEvent.delta);
				if (projected) content.arguments = projected;
				partial.content[proxyEvent.contentIndex] = { ...content }; // Trigger reactivity
				const projectedContent = partial.content[proxyEvent.contentIndex];
				if (projectedContent.type === "toolCall") {
					const projector = toolArgumentProjectors.get(content);
					if (projector) toolArgumentProjectors.set(projectedContent, projector);
				}
				return {
					type: "toolcall_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received toolcall_delta for non-toolCall content");
		}

		case "toolcall_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				content.arguments = toolArgumentProjectors.get(content)?.finish() ?? content.arguments;
				toolArgumentProjectors.delete(content);
				return {
					type: "toolcall_end",
					contentIndex: proxyEvent.contentIndex,
					toolCall: content,
					partial,
				};
			}
			return undefined;
		}

		case "done":
			finalizeStreamingContent(partial);
			partial.stopReason = proxyEvent.reason;
			partial.usage = proxyEvent.usage;
			return { type: "done", reason: proxyEvent.reason, message: partial };

		case "error":
			finalizeStreamingContent(partial);
			partial.stopReason = proxyEvent.reason;
			partial.errorMessage = proxyEvent.errorMessage;
			partial.usage = proxyEvent.usage;
			return { type: "error", reason: proxyEvent.reason, error: partial };

		default: {
			const _exhaustiveCheck: never = proxyEvent;
			console.warn(`Unhandled proxy event type: ${(proxyEvent as { type?: unknown }).type}`);
			return undefined;
		}
	}
}

function createStreamingTextContent(type: "text"): TextContent;
function createStreamingTextContent(type: "thinking"): ThinkingContent;
function createStreamingTextContent(type: "text" | "thinking"): TextContent | ThinkingContent {
	const buffer = new StreamingTextBuffer();
	const content =
		type === "text" ? ({ type, text: "" } satisfies TextContent) : ({ type, thinking: "" } satisfies ThinkingContent);
	const field = type === "text" ? "text" : "thinking";
	Object.defineProperty(content, field, {
		configurable: true,
		enumerable: true,
		get: () => buffer.materialize(),
	});
	textBuffers.set(content, buffer);
	return content;
}

function finalizeStreamingText(content: TextContent | ThinkingContent): void {
	const buffer = textBuffers.get(content);
	if (!buffer) return;
	const field = content.type === "text" ? "text" : "thinking";
	Object.defineProperty(content, field, {
		configurable: true,
		enumerable: true,
		value: buffer.materialize(),
		writable: true,
	});
	textBuffers.delete(content);
}

function finalizeStreamingContent(message: AssistantMessage): void {
	for (const content of message.content) {
		if (content.type === "text" || content.type === "thinking") {
			finalizeStreamingText(content);
		} else {
			content.arguments = toolArgumentProjectors.get(content)?.finish() ?? content.arguments;
			toolArgumentProjectors.delete(content);
		}
	}
}
