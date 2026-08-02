import { GoogleGenAI } from "@google/genai";
import type { Context, Model, SimpleStreamOptions, StreamFunction } from "../types.ts";
import { buildGoogleSimpleOptions, type GoogleGenAiOptions, streamGoogleGenAi } from "./google-streaming.ts";

export type GoogleOptions = GoogleGenAiOptions;

export const streamGoogle: StreamFunction<"google-generative-ai", GoogleOptions> = (
	model: Model<"google-generative-ai">,
	context: Context,
	options?: GoogleOptions,
) =>
	streamGoogleGenAi(model, context, options, () => {
		const apiKey = options?.apiKey;
		if (!apiKey) {
			throw new Error(`No API key for provider: ${model.provider}`);
		}
		return createClient(model, apiKey, options?.headers);
	});

export const streamSimpleGoogle: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
	model: Model<"google-generative-ai">,
	context: Context,
	options?: SimpleStreamOptions,
) => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	return streamGoogle(model, context, buildGoogleSimpleOptions(model, options, apiKey));
};

function createClient(
	model: Model<"google-generative-ai">,
	apiKey: string,
	optionsHeaders?: Record<string, string>,
): GoogleGenAI {
	const httpOptions: { baseUrl?: string; apiVersion?: string; headers?: Record<string, string> } = {};
	if (model.baseUrl) {
		httpOptions.baseUrl = model.baseUrl;
		httpOptions.apiVersion = "";
	}
	if (model.headers || optionsHeaders) {
		httpOptions.headers = { ...model.headers, ...optionsHeaders };
	}

	return new GoogleGenAI({
		apiKey,
		httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
	});
}
