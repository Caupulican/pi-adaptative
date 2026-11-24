/**
 * Anthropic request-header ownership: explicit authorization detection, deterministic merging and
 * the Claude Code subscription identity/session headers.
 */

import type { ProviderRequestContext } from "../utils/oauth/types.ts";
import type { AnthropicCompatibilitySnapshot } from "./anthropic-identity.ts";

const ANTHROPIC_OAUTH_CONTEXT = Object.freeze({ provider: "anthropic", authentication: "oauth" } as const);

export function mergeAnthropicHeaders(
	...headerSources: (Record<string, string | null> | undefined)[]
): Record<string, string | null> {
	return Object.assign({}, ...headerSources.filter((headers) => headers !== undefined));
}

export function hasAnthropicAuthorizationHeader(...headerSources: (Record<string, string> | undefined)[]): boolean {
	return headerSources.some((headers) =>
		Object.entries(headers ?? {}).some(
			([name, value]) => name.toLowerCase() === "authorization" && value.trim().length > 0,
		),
	);
}

/** The credential owner, rather than token spelling, marks stored Anthropic subscription OAuth. */
export function anthropicOAuthRequestContext(): ProviderRequestContext {
	return ANTHROPIC_OAUTH_CONTEXT;
}

export function resolveAnthropicOAuthAuthentication(
	context: ProviderRequestContext | undefined,
	accessToken: string,
): boolean {
	if (context !== undefined) {
		if (context.provider !== "anthropic" || context.authentication !== "oauth") {
			throw new Error("Invalid Anthropic account session; resolve credentials again");
		}
		return true;
	}
	// Raw overrides have no credential record. Match Claude Code's bounded environment-token check.
	return accessToken.startsWith("sk-ant-oat");
}

/** A session id is sent only when it is 1-200 printable, non-space ASCII characters. */
function isValidOAuthSessionId(sessionId: unknown): sessionId is string {
	return (
		typeof sessionId === "string" &&
		sessionId.length >= 1 &&
		sessionId.length <= 200 &&
		/^[\x21-\x7e]+$/.test(sessionId)
	);
}

export function buildAnthropicOAuthHeaders(
	betaFeatures: readonly string[],
	userAgent: string,
	sessionId?: string,
): Record<string, string> {
	const headers: Record<string, string> = {
		accept: "application/json",
		"anthropic-dangerous-direct-browser-access": "true",
		"anthropic-beta": ["claude-code-20250219", "oauth-2025-04-20", ...betaFeatures].join(","),
		"user-agent": userAgent,
		"x-app": "cli",
	};

	if (isValidOAuthSessionId(sessionId)) {
		headers["X-Claude-Code-Session-Id"] = sessionId;
	}

	return headers;
}

/** Build the SDK boundary options and reviewed identity as one OAuth-owned snapshot. */
export async function buildAnthropicOAuthClientOptions(input: {
	accessToken: string;
	baseUrl: string;
	betaFeatures: readonly string[];
	modelHeaders?: Record<string, string>;
	optionsHeaders?: Record<string, string>;
	sessionId?: string;
	getCompatibility: () => Promise<AnthropicCompatibilitySnapshot>;
}): Promise<{
	compatibility: AnthropicCompatibilitySnapshot;
	options: {
		apiKey: null;
		authToken: string;
		baseURL: string;
		defaultHeaders: Record<string, string>;
	};
}> {
	const compatibility = await input.getCompatibility();
	return {
		compatibility,
		options: {
			apiKey: null,
			authToken: input.accessToken,
			baseURL: input.baseUrl,
			defaultHeaders: {
				...buildAnthropicOAuthHeaders(
					input.betaFeatures,
					compatibility.identity.messagesUserAgent,
					input.sessionId,
				),
				...input.modelHeaders,
				...input.optionsHeaders,
			},
		},
	};
}
