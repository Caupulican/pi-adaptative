/**
 * Command Code's generate route: one streamed post per model turn, answered as newline-delimited JSON events.
 *
 * A turn is complete only when a `finish` event arrives: a stream that ends without one was cut short. A turn the
 * service paused (`pause_turn`) continues by posting the same request again, as the service's own client does. A
 * call the service ran itself is not the caller's to run and stays out of the message.
 */

import { calculateCost } from "../models.ts";
import type {
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { parseStreamingJsonState } from "../utils/json-parse.ts";
import { dropNullOptionals } from "../utils/nullable-optionals.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { StreamingLineDecoder } from "../utils/streaming-lines.ts";
import { createToolNameMap, type ToolNameMap } from "../utils/tool-names.ts";
import { uuidv7 } from "../utils/uuid.ts";
import { isRecord } from "../utils/value-guards.ts";
import { readBoundedResponseText } from "./account-request.ts";
import {
	buildCommandCodeRequest,
	COMMAND_CODE_GENERATE_ROUTE,
	commandCodeHeaders,
	sendsNullForUnset,
} from "./command-code-request.ts";
import {
	applyProviderPayloadHook,
	beginAssistantResponseStream,
	buildClampedSimpleOptions,
	completeAssistantStream,
	createAssistantMessage,
	createProviderRetryOptions,
	finishTextOrThinkingBlock,
	resolveCacheRetention,
	terminateAssistantStreamWithError,
} from "./provider-runtime.ts";

export interface CommandCodeOptions extends StreamOptions {
	/** The effort sent as `reasoning_effort`. Left out, the model's own default applies. */
	reasoningEffort?: string;
}

/** How many times the service's client continues a turn the service paused. */
const MAX_PAUSE_CONTINUATIONS = 5;
/** One event line: a tool call arrives whole, so a line can hold a file's worth of arguments. */
const MAX_EVENT_CHARS = 16 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_ERROR_TEXT_CHARS = 500;
const REFUSAL_FINISH_REASONS = new Set(["refusal", "content_filter", "content-filter"]);
/** Failures the service reports with no status that another try cannot change. */
const TERMINAL_ERROR_MARKERS = ["premium_credits_exhausted", "model_not_in_plan", "insufficient credits"];

type ServiceEvent = Record<string, unknown> & { type: string };

/** A refused or failed request, in the shape the shared retry policy reads. */
class CommandCodeError extends Error {
	readonly status: number | undefined;
	readonly headers: Headers | undefined;
	/** The service's own word on trying again, when it gave one. */
	readonly error: { availability: { retryable: boolean } } | undefined;

	constructor(
		message: string,
		detail: { status?: number; headers?: Headers; retryable?: boolean; cause?: unknown } = {},
	) {
		super(message, detail.cause === undefined ? undefined : { cause: detail.cause });
		this.name = "CommandCodeError";
		this.status = detail.status;
		this.headers = detail.headers;
		this.error = detail.retryable === undefined ? undefined : { availability: { retryable: detail.retryable } };
	}
}

function boundedText(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= MAX_ERROR_TEXT_CHARS ? flat : `${flat.slice(0, MAX_ERROR_TEXT_CHARS - 1)}…`;
}

/** A service error that travels as text: an optional status, then JSON holding `error.message`. */
function readEmbeddedError(text: string): { status?: number; message: string } | undefined {
	const at = text.indexOf("{");
	if (at < 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(at));
	} catch {
		return undefined;
	}
	const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
	if (!error || typeof error.message !== "string") return undefined;
	const prefix = text.slice(0, at).trim();
	return {
		...(/^\d{3}$/.test(prefix) ? { status: Number(prefix) } : {}),
		message: boundedText(typeof error.type === "string" ? `${error.type}: ${error.message}` : error.message),
	};
}

async function httpFailure(response: Response): Promise<CommandCodeError> {
	const raw = ((await readBoundedResponseText(response, MAX_ERROR_BODY_BYTES).catch(() => "")) ?? "").trim();
	const detail = readEmbeddedError(raw)?.message ?? boundedText(raw);
	return new CommandCodeError(`Command Code request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`, {
		status: response.status,
		headers: response.headers,
	});
}

/** The failure an `error` event reports, before or in the middle of an answer. */
function streamFailure(event: ServiceEvent): CommandCodeError {
	const reported = isRecord(event.error) ? event.error : undefined;
	const text =
		typeof event.error === "string" && event.error
			? event.error
			: typeof reported?.message === "string" && reported.message
				? reported.message
				: "Stream error";
	const embedded = readEmbeddedError(text);
	const status = embedded?.status ?? (typeof reported?.statusCode === "number" ? reported.statusCode : undefined);
	const message = embedded?.message ?? boundedText(text);
	const lower = message.toLowerCase();
	// With a status the shared policy decides by it; with none, only the service's flag and its terminal failures do.
	const retryable =
		reported?.isRetryable === true
			? true
			: status === undefined &&
					(reported?.isRetryable === false || TERMINAL_ERROR_MARKERS.some((marker) => lower.includes(marker)))
				? false
				: undefined;
	return new CommandCodeError(`Command Code reported an error: ${message}`, { status, retryable });
}

async function postGenerate(
	model: Model<"command-code-generate">,
	headers: Headers,
	body: string,
	signal: AbortSignal | undefined,
): Promise<Response> {
	signal?.throwIfAborted();
	let response: Response;
	try {
		response = await fetch(`${model.baseUrl.replace(/\/+$/, "")}${COMMAND_CODE_GENERATE_ROUTE}`, {
			method: "POST",
			// The key goes to the service's own host only.
			redirect: "error",
			headers,
			body,
			signal,
		});
	} catch (error) {
		signal?.throwIfAborted();
		throw new CommandCodeError("Command Code could not be reached", { retryable: true, cause: error });
	}
	if (!response.ok) throw await httpFailure(response);
	if (!response.body) {
		throw new CommandCodeError("Command Code answered with no stream", {
			retryable: true,
			status: response.status,
			headers: response.headers,
		});
	}
	return response;
}

/** A line that is not a JSON event is passed over, as the service's client passes it over. */
function parseEventLine(line: string): ServiceEvent | undefined {
	const text = line.trim();
	if (!text) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	return isRecord(value) && typeof value.type === "string" ? (value as ServiceEvent) : undefined;
}

async function* readEvents(response: Response, signal: AbortSignal | undefined): AsyncGenerator<ServiceEvent> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	const lines = new StreamingLineDecoder(MAX_EVENT_CHARS);
	try {
		for (;;) {
			let chunk: Awaited<ReturnType<typeof reader.read>>;
			try {
				chunk = await reader.read();
			} catch (error) {
				signal?.throwIfAborted();
				throw new CommandCodeError("Command Code's stream broke mid-answer", { retryable: true, cause: error });
			}
			if (chunk.done) break;
			for (const line of lines.push(decoder.decode(chunk.value, { stream: true }))) {
				const event = parseEventLine(line);
				if (event) yield event;
			}
		}
		const rest = [...lines.push(decoder.decode()), lines.finish() ?? ""];
		for (const line of rest) {
			const event = parseEventLine(line);
			if (event) yield event;
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

function tokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** What a tool input was read as: its arguments, and why it could not be read as arguments when it could not. */
interface ToolInput {
	arguments: Record<string, unknown>;
	errorMessage?: string;
}

/** A few words naming the shape of a value, never its content. */
function describeShape(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return `a list of ${value.length} ${value.length === 1 ? "item" : "items"}`;
	if (typeof value === "string") return "text";
	if (typeof value === "number") return "a number";
	if (typeof value === "boolean") return "a boolean";
	return typeof value;
}

/** An object, or the object alone in a list: the two shapes that hold arguments. */
function argumentsOf(value: unknown): Record<string, unknown> | undefined {
	if (isRecord(value)) return value;
	if (Array.isArray(value) && value.length === 1 && isRecord(value[0])) return value[0];
	return undefined;
}

/**
 * Reads a tool input the way the service's own client does: an object, a list of one object, JSON text of either,
 * or nothing. Any other shape yields no arguments and a message that names it, for the model to correct.
 */
function readToolInput(raw: unknown): ToolInput {
	if (raw === undefined || raw === null) return { arguments: {} };
	let value = raw;
	if (typeof raw === "string") {
		const parsed = parseStreamingJsonState<object>(raw);
		if (!parsed.complete) {
			return {
				arguments: {},
				errorMessage:
					"Tool call arguments were truncated before complete JSON was received. Retry the tool call with complete JSON arguments.",
			};
		}
		value = parsed.value;
	}
	const found = argumentsOf(value);
	if (found) return { arguments: found };
	return {
		arguments: {},
		errorMessage: `Tool call arguments must be a JSON object, but ${describeShape(value)} was received. Retry the tool call with a JSON object of arguments.`,
	};
}

/** One model turn being assembled from the service's events, over one or more posts. */
class CommandCodeTurn {
	private open: TextContent | ThinkingContent | undefined;
	private readonly model: Model<"command-code-generate">;
	private readonly output: AssistantMessage;
	private readonly stream: AssistantMessageEventStream;
	private readonly toolNameMap: ToolNameMap;
	/** The tools' own schemas by provider tool name. */
	private readonly toolSchemas: ReadonlyMap<string, object>;

	constructor(
		model: Model<"command-code-generate">,
		output: AssistantMessage,
		stream: AssistantMessageEventStream,
		toolNameMap: ToolNameMap,
		toolSchemas: ReadonlyMap<string, object>,
	) {
		this.model = model;
		this.output = output;
		this.stream = stream;
		this.toolNameMap = toolNameMap;
		this.toolSchemas = toolSchemas;
	}

	/** Reads one post's answer; returns the service's own finish reason. */
	async readLeg(response: Response, signal: AbortSignal | undefined): Promise<string | undefined> {
		let finish: ServiceEvent | undefined;
		let aborted = false;
		let cacheWriteSeen: number | undefined;
		for await (const event of readEvents(response, signal)) {
			switch (event.type) {
				case "text-delta":
					if (typeof event.text === "string" && event.text) this.append("text", event.text);
					break;
				case "reasoning-start":
				case "reasoning-end":
					this.close();
					break;
				case "reasoning-delta":
					if (typeof event.text === "string" && event.text) this.append("thinking", event.text);
					break;
				case "tool-call":
					this.close();
					if (event.providerExecuted !== true) this.toolCall(event);
					break;
				case "tool-result":
					// The result of a call the service ran itself.
					this.close();
					break;
				case "cache-write-tokens":
					cacheWriteSeen = tokenCount(event.cacheWriteTokens) || cacheWriteSeen;
					break;
				case "finish":
					finish = event;
					break;
				case "abort":
					aborted = true;
					break;
				case "error":
					throw streamFailure(event);
			}
		}
		this.close();
		if (!finish) {
			signal?.throwIfAborted();
			throw new CommandCodeError(
				aborted
					? "Command Code aborted the answer before it finished"
					: "Command Code's stream ended before the answer finished",
				{ retryable: true },
			);
		}
		return this.finishLeg(finish, cacheWriteSeen);
	}

	private append(kind: "text" | "thinking", text: string): void {
		let block = this.open;
		if (block?.type !== kind) {
			this.close();
			block = kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
			this.open = block;
			this.output.content.push(block);
			this.stream.push({ type: `${kind}_start`, contentIndex: this.lastIndex(), partial: this.output });
		}
		if (block.type === "text") block.text += text;
		else block.thinking += text;
		this.stream.push({ type: `${kind}_delta`, contentIndex: this.lastIndex(), delta: text, partial: this.output });
	}

	private close(): void {
		finishTextOrThinkingBlock(this.stream, this.output, this.open, this.lastIndex());
		this.open = undefined;
	}

	private lastIndex(): number {
		return this.output.content.length - 1;
	}

	private toolCall(event: ServiceEvent): void {
		const input = readToolInput(event.input ?? event.args);
		const schema = typeof event.toolName === "string" ? this.toolSchemas.get(event.toolName) : undefined;
		// An OpenAI-family model was asked to send null for a parameter it leaves unset; the caller never sees those.
		if (sendsNullForUnset(this.model) && schema) input.arguments = dropNullOptionals(input.arguments, schema);
		const toolCall: ToolCall = {
			type: "toolCall",
			id: typeof event.toolCallId === "string" && event.toolCallId ? event.toolCallId : `call_${uuidv7()}`,
			name: this.toolNameMap.toOriginalName(typeof event.toolName === "string" ? event.toolName : ""),
			arguments: input.arguments,
			...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
		};
		this.output.content.push(toolCall);
		const contentIndex = this.lastIndex();
		this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
		this.stream.push({
			type: "toolcall_delta",
			contentIndex,
			delta: JSON.stringify(toolCall.arguments),
			partial: this.output,
		});
		this.stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: this.output });
	}

	private finishLeg(finish: ServiceEvent, cacheWriteSeen: number | undefined): string | undefined {
		const reason = typeof finish.finishReason === "string" ? finish.finishReason : undefined;
		const raw = typeof finish.rawFinishReason === "string" ? finish.rawFinishReason : reason;
		const reported = isRecord(finish.totalUsage) ? finish.totalUsage : {};
		const details = isRecord(reported.inputTokenDetails) ? reported.inputTokenDetails : {};
		const cacheRead = tokenCount(details.cacheReadTokens);
		const cacheWrite = tokenCount(details.cacheWriteTokens) || (cacheWriteSeen ?? 0);
		const usage = this.output.usage;
		// The service counts cached tokens inside its input total; a paused turn's posts add up.
		usage.input += Math.max(0, tokenCount(reported.inputTokens) - cacheRead - cacheWrite);
		usage.output += tokenCount(reported.outputTokens);
		usage.cacheRead += cacheRead;
		usage.cacheWrite += cacheWrite;
		usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		calculateCost(this.model, usage);

		for (const value of [reason, raw]) {
			if (value !== undefined && REFUSAL_FINISH_REASONS.has(value.trim().toLowerCase())) {
				throw new CommandCodeError(`Command Code finish reason: ${value}`, { retryable: false });
			}
		}
		if (this.output.content.some((block) => block.type === "toolCall") && reason !== "length") {
			this.output.stopReason = "toolUse";
		} else {
			this.output.stopReason = reason === "length" ? "length" : reason === "tool-calls" ? "toolUse" : "stop";
		}
		return raw;
	}
}

export const streamCommandCode: StreamFunction<"command-code-generate", CommandCodeOptions> = (
	model: Model<"command-code-generate">,
	context: Context,
	options?: CommandCodeOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output = createAssistantMessage(model);
		try {
			const apiKey = options?.apiKey;
			if (!apiKey) throw new Error("No Command Code key. Sign in with /login or set COMMAND_CODE_API_KEY.");
			const toolNameMap = createToolNameMap(context.tools ?? []);
			const payload = await applyProviderPayloadHook(
				buildCommandCodeRequest(model, context, toolNameMap, {
					maxTokens: options?.maxTokens,
					temperature: options?.temperature,
					reasoningEffort: options?.reasoningEffort,
					cacheRetention: resolveCacheRetention(options?.cacheRetention),
					sessionId: options?.sessionId,
				}),
				model,
				options?.onPayload,
			);
			const body = JSON.stringify(payload);
			const headers = commandCodeHeaders(apiKey, options?.sessionId ?? uuidv7(), {
				...model.headers,
				...options?.headers,
			});
			const turn = new CommandCodeTurn(
				model,
				output,
				stream,
				toolNameMap,
				new Map((context.tools ?? []).map((tool) => [toolNameMap.toProviderName(tool.name), tool.parameters])),
			);
			for (let post = 0; ; post++) {
				const response = await retryProviderRequest(
					() => postGenerate(model, headers, body, options?.signal),
					createProviderRetryOptions(options),
				);
				if (post === 0) await beginAssistantResponseStream(stream, output, response, model, options?.onResponse);
				const finishReason = await turn.readLeg(response, options?.signal);
				if (finishReason !== "pause_turn" || post >= MAX_PAUSE_CONTINUATIONS) break;
			}
			completeAssistantStream(stream, output, options?.signal);
		} catch (error) {
			terminateAssistantStreamWithError(stream, output, options?.signal, error, {
				formatError: (failure) => (failure instanceof Error ? failure.message : String(failure)),
			});
		}
	})();

	return stream;
};

export const streamSimpleCommandCode: StreamFunction<"command-code-generate", SimpleStreamOptions> = (
	model: Model<"command-code-generate">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const { base, clampedReasoning } = buildClampedSimpleOptions(model, options);
	return streamCommandCode(model, context, {
		...base,
		// A model with no effort control takes none; one with it takes the level's own name unless the catalog maps it.
		reasoningEffort:
			model.reasoning && clampedReasoning
				? (model.thinkingLevelMap?.[clampedReasoning] ?? clampedReasoning)
				: undefined,
	} satisfies CommandCodeOptions);
};
