import OpenAI from "openai";
import type { Api, Context, Model, SessionAffinityFormat } from "../types.ts";
import { isCloudflareProvider, resolveCloudflareBaseUrl } from "./cloudflare.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";

interface OpenAIClientSession {
	id: string;
	format: SessionAffinityFormat;
	includeLegacyAffinity: boolean;
}

interface OpenAIClientOptions {
	baseUrl?: string;
	callerHeaders?: Record<string, string>;
	context?: Context;
	session?: OpenAIClientSession;
}

export function buildOpenAIClientHeaders<TApi extends Api>(
	model: Model<TApi>,
	apiKey: string,
	options: Omit<OpenAIClientOptions, "baseUrl"> = {},
): Record<string, string | null> {
	const headers: Record<string, string | null> = { ...model.headers };
	if (model.provider === "github-copilot" && options.context) {
		Object.assign(
			headers,
			buildCopilotDynamicHeaders({
				messages: options.context.messages,
				hasImages: hasCopilotVisionInput(options.context.messages),
			}),
		);
	}

	const session = options.session;
	if (session) {
		if (session.format === "openrouter") {
			headers["x-session-id"] = session.id;
		} else {
			if (session.format === "openai") headers.session_id = session.id;
			headers["x-client-request-id"] = session.id;
			if (session.includeLegacyAffinity) headers["x-session-affinity"] = session.id;
		}
	}

	if (options.callerHeaders) Object.assign(headers, options.callerHeaders);
	if (model.provider !== "cloudflare-ai-gateway") return headers;
	return {
		...headers,
		Authorization: headers.Authorization ?? null,
		"cf-aig-authorization": `Bearer ${apiKey}`,
	};
}

export function createOpenAIClient<TApi extends Api>(
	model: Model<TApi>,
	apiKey: string,
	options: OpenAIClientOptions = {},
): OpenAI {
	return new OpenAI({
		apiKey,
		baseURL:
			options.baseUrl ?? (isCloudflareProvider(model.provider) ? resolveCloudflareBaseUrl(model) : model.baseUrl),
		dangerouslyAllowBrowser: true,
		defaultHeaders: buildOpenAIClientHeaders(model, apiKey, options),
	});
}
