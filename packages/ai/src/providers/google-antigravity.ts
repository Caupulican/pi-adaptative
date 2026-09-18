import type { GenerateContentParameters } from "@google/genai";
import type { Model, SimpleStreamOptions, StreamFunction } from "../types.ts";
import {
	ANTIGRAVITY_ENDPOINT,
	antigravityHeaders,
	antigravityObject,
	resolveAntigravityProject,
} from "../utils/antigravity.ts";
import { StreamingLineDecoder } from "../utils/streaming-lines.ts";
import {
	buildGoogleSimpleOptions,
	type GoogleGenAiClient,
	type GoogleGenAiOptions,
	type GoogleGenAiResponse,
	streamGoogleGenAi,
} from "./google-streaming.ts";

export const streamAntigravity: StreamFunction<"google-antigravity", GoogleGenAiOptions> = (model, context, options) =>
	streamGoogleGenAi(model, context, options, () => createAntigravityClient(model, options ?? {}));

export const streamSimpleAntigravity: StreamFunction<"google-antigravity", SimpleStreamOptions> = (
	model,
	context,
	options,
) => streamAntigravity(model, context, buildGoogleSimpleOptions(model, options, options?.apiKey));

async function* readAntigravityEvents(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	abortSignal?: AbortSignal,
): AsyncGenerator<GoogleGenAiResponse> {
	const decoder = new TextDecoder();
	const lines = new StreamingLineDecoder(2 * 1024 * 1024);
	let data: string[] = [];
	let size = 0;
	let sawTerminal = false;
	function consume(line: string): GoogleGenAiResponse | undefined {
		if (line.startsWith("data:")) {
			const value = line.slice(5).replace(/^ /, "");
			size += value.length + 1;
			if (size > 2 * 1024 * 1024) throw new Error("Antigravity event exceeds its size limit");
			data.push(value);
			return;
		}
		if (line !== "" || data.length === 0) return;
		const text = data.join("\n");
		data = [];
		size = 0;
		if (text === "[DONE]") return;
		let envelope: Record<string, unknown>;
		try {
			envelope = antigravityObject(JSON.parse(text));
		} catch {
			throw new Error("Invalid Antigravity event JSON");
		}
		if (envelope.error) throw new Error("Antigravity returned a stream error");
		const raw = antigravityObject(envelope.response);
		if (raw.candidates !== undefined && !Array.isArray(raw.candidates))
			throw new Error("Invalid Antigravity candidates");
		for (const candidate of (raw.candidates ?? []) as unknown[]) {
			const entry = antigravityObject(candidate);
			if (entry.finishReason !== undefined && typeof entry.finishReason !== "string")
				throw new Error("Invalid Antigravity finish reason");
			if (entry.finishReason) sawTerminal = true;
			if (entry.content) {
				const content = antigravityObject(entry.content);
				if (!Array.isArray(content.parts)) throw new Error("Invalid Antigravity content");
				for (const value of content.parts) {
					const part = antigravityObject(value);
					if (part.text !== undefined && typeof part.text !== "string")
						throw new Error("Invalid Antigravity text");
					if (part.thoughtSignature !== undefined && typeof part.thoughtSignature !== "string")
						throw new Error("Invalid Antigravity signature");
					if (part.functionCall !== undefined) {
						const call = antigravityObject(part.functionCall);
						if (
							typeof call.name !== "string" ||
							!call.name ||
							(call.id !== undefined && typeof call.id !== "string")
						)
							throw new Error("Invalid Antigravity function call");
						if (call.args !== undefined) antigravityObject(call.args);
					}
				}
			}
		}
		if (raw.usageMetadata !== undefined) {
			const usage = antigravityObject(raw.usageMetadata);
			for (const key of [
				"promptTokenCount",
				"candidatesTokenCount",
				"thoughtsTokenCount",
				"cachedContentTokenCount",
				"totalTokenCount",
			]) {
				if (usage[key] !== undefined && (!Number.isSafeInteger(usage[key]) || (usage[key] as number) < 0))
					throw new Error("Invalid Antigravity token usage");
			}
			if (((usage.cachedContentTokenCount as number) ?? 0) > ((usage.promptTokenCount as number) ?? 0))
				throw new Error("Invalid Antigravity cached usage");
		}
		return {
			candidates: raw.candidates as GoogleGenAiResponse["candidates"],
			usageMetadata: raw.usageMetadata as GoogleGenAiResponse["usageMetadata"],
			responseId:
				typeof envelope.traceId === "string"
					? envelope.traceId
					: typeof raw.responseId === "string"
						? raw.responseId
						: undefined,
		};
	}
	try {
		while (true) {
			abortSignal?.throwIfAborted();
			const chunk = await reader.read();
			if (chunk.done) break;
			for (const line of lines.push(decoder.decode(chunk.value, { stream: true }))) {
				const event = consume(line);
				if (event) yield event;
			}
		}
		for (const line of lines.push(decoder.decode())) {
			const event = consume(line);
			if (event) yield event;
		}
		const lastLine = lines.finish();
		if (lastLine !== undefined) consume(lastLine);
		const final = consume("");
		if (final) yield final;
		if (!sawTerminal) throw new Error("Antigravity stream ended without a terminal response");
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

async function generateAntigravityContent(
	model: Model<"google-antigravity">,
	options: GoogleGenAiOptions,
	params: GenerateContentParameters,
): Promise<AsyncIterable<GoogleGenAiResponse>> {
	const token = options.apiKey;
	if (!token?.trim()) throw new Error("Missing Antigravity credentials. Sign in with /login.");
	if (model.baseUrl !== ANTIGRAVITY_ENDPOINT) throw new Error("Antigravity requires its trusted service endpoint");
	const config = params.config;
	const projectId = await resolveAntigravityProject(token, config?.abortSignal);
	config?.abortSignal?.throwIfAborted();
	const headers = new Headers({ ...model.headers, ...options.headers });
	for (const [key, value] of Object.entries(antigravityHeaders(token))) headers.set(key, value);
	headers.set("Accept", "text/event-stream");
	const systemInstruction =
		typeof config?.systemInstruction === "string"
			? { role: "user", parts: [{ text: config.systemInstruction }] }
			: config?.systemInstruction;
	const response = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`, {
		method: "POST",
		redirect: "error",
		signal: config?.abortSignal,
		headers,
		body: JSON.stringify({
			project: projectId,
			model: params.model,
			requestId: crypto.randomUUID(),
			requestType: "agent",
			userAgent: "antigravity",
			request: {
				contents: params.contents,
				systemInstruction,
				tools: config?.tools,
				toolConfig: config?.toolConfig,
				sessionId: options.sessionId,
				generationConfig: {
					temperature: config?.temperature,
					maxOutputTokens: config?.maxOutputTokens,
					thinkingConfig: config?.thinkingConfig,
				},
			},
		}),
	});
	if (!response.ok) {
		const error = new Error(`Antigravity inference failed (HTTP ${response.status})`);
		(error as Error & { status?: number }).status = response.status;
		throw error;
	}
	if (!response.body) throw new Error("Antigravity returned no stream");
	const reader = response.body.getReader();
	return readAntigravityEvents(reader, config?.abortSignal);
}

export function createAntigravityClient(
	model: Model<"google-antigravity">,
	options: GoogleGenAiOptions,
): GoogleGenAiClient {
	return { models: { generateContentStream: (params) => generateAntigravityContent(model, options, params) } };
}
