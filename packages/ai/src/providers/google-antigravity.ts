import type { GenerateContentParameters } from "@google/genai";
import type { Model, SimpleStreamOptions, StreamFunction } from "../types.ts";
import {
	ANTIGRAVITY_ENDPOINT,
	antigravityHeaders,
	antigravityThinkingBudget,
	antigravityThinkingLevel,
	resolveAntigravityProjectOnce,
	toAntigravityThinkingLevel,
} from "../utils/antigravity.ts";
import { AntigravityStreamAdapter } from "./antigravity-stream.ts";
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

async function generateAntigravityContent(
	model: Model<"google-antigravity">,
	options: GoogleGenAiOptions,
	params: GenerateContentParameters,
): Promise<AsyncIterable<GoogleGenAiResponse>> {
	const token = options.apiKey;
	if (!token?.trim()) throw new Error("Missing Antigravity credentials. Sign in with /login.");
	if (model.baseUrl !== ANTIGRAVITY_ENDPOINT) throw new Error("Antigravity requires its trusted service endpoint");
	const config = params.config;
	const projectId = await resolveAntigravityProjectOnce(token, config?.abortSignal);
	config?.abortSignal?.throwIfAborted();
	const headers = new Headers({ ...model.headers, ...options.headers });
	for (const [key, value] of Object.entries(antigravityHeaders(token))) headers.set(key, value);
	headers.set("Accept", "text/event-stream");
	const budget = model.reasoning ? antigravityThinkingBudget(model) : undefined;
	const thinkingLevel = antigravityThinkingLevel(model);
	const callerThinkingLevel = toAntigravityThinkingLevel(config?.thinkingConfig?.thinkingLevel);
	// Thinking counts inside the output cap on every upstream (Anthropic rejects a cap at or below the
	// budget): a fixed budget runs on top of the caller's cap for the answer, within the model's maximum.
	const requestedOutput = config?.maxOutputTokens;
	const maxOutputTokens =
		budget !== undefined && budget > 0 && requestedOutput !== undefined
			? Math.min(model.maxTokens, requestedOutput + budget)
			: requestedOutput;
	const systemInstruction =
		typeof config?.systemInstruction === "string"
			? { role: "user", parts: [{ text: config.systemInstruction }] }
			: config?.systemInstruction;
	return new AntigravityStreamAdapter(
		{
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
					maxOutputTokens,
					// Catalog presets take precedence; unpreset models use the shared request's caller level.
					...(thinkingLevel !== undefined
						? { thinkingConfig: { thinkingLevel, includeThoughts: true } }
						: budget !== undefined
							? { thinkingConfig: { thinkingBudget: budget, includeThoughts: true } }
							: callerThinkingLevel !== undefined
								? {
										thinkingConfig: {
											thinkingLevel: callerThinkingLevel,
											includeThoughts: config?.thinkingConfig?.includeThoughts,
										},
									}
								: {}),
				},
			},
		},
		headers,
		{ signal: config?.abortSignal, maxRetries: options.maxRetries, maxRetryDelayMs: options.maxRetryDelayMs },
	).open();
}

export function createAntigravityClient(
	model: Model<"google-antigravity">,
	options: GoogleGenAiOptions,
): GoogleGenAiClient {
	return { models: { generateContentStream: (params) => generateAntigravityContent(model, options, params) } };
}
