/**
 * OAuth credential management for AI providers.
 *
 * This module handles login, token refresh, and credential storage
 * for OAuth-based providers:
 * - Anthropic (Claude Pro/Max)
 * - GitHub Copilot
 */

// Anthropic
export { anthropicOAuthProvider, loginAnthropic, refreshAnthropicToken } from "./anthropic.ts";
export * from "./device-code.ts";
// GitHub Copilot
export {
	getGitHubCopilotBaseUrl,
	githubCopilotOAuthProvider,
	loginGitHubCopilot,
	normalizeDomain,
	refreshGitHubCopilotToken,
} from "./github-copilot.ts";
export { kimiCodingOAuthProvider, loginKimiCoding } from "./kimi-coding.ts";
// OpenAI Codex (ChatGPT OAuth)
export {
	loginOpenAICodex,
	loginOpenAICodexDeviceCode,
	OPENAI_CODEX_BROWSER_LOGIN_METHOD,
	OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD,
	openaiCodexOAuthProvider,
	refreshOpenAICodexToken,
} from "./openai-codex.ts";
export { loginOpenRouter, openRouterOAuthProvider } from "./openrouter.ts";
export * from "./types.ts";
export { loginXai, refreshXaiToken, xaiOAuthProvider } from "./xai.ts";

// ============================================================================
// Provider Registry
// ============================================================================

import { SourceRegistry } from "../source-registry.ts";
import { anthropicOAuthProvider } from "./anthropic.ts";
import { githubCopilotOAuthProvider } from "./github-copilot.ts";
import { kimiCodingOAuthProvider } from "./kimi-coding.ts";
import { openaiCodexOAuthProvider } from "./openai-codex.ts";
import { openRouterOAuthProvider } from "./openrouter.ts";
import type { OAuthCredentials, OAuthProviderId, OAuthProviderInfo, OAuthProviderInterface } from "./types.ts";
import { xaiOAuthProvider } from "./xai.ts";

const BUILT_IN_OAUTH_PROVIDERS: OAuthProviderInterface[] = [
	anthropicOAuthProvider,
	githubCopilotOAuthProvider,
	openaiCodexOAuthProvider,
	xaiOAuthProvider,
	kimiCodingOAuthProvider,
	openRouterOAuthProvider,
];

const oauthProviderRegistry = new SourceRegistry<OAuthProviderInterface>();
for (const provider of BUILT_IN_OAUTH_PROVIDERS) oauthProviderRegistry.set(provider.id, provider);

/**
 * Get an OAuth provider by ID
 */
export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return oauthProviderRegistry.get(id);
}

/**
 * Register a custom OAuth provider
 */
export function registerOAuthProvider(provider: OAuthProviderInterface, sourceId?: string): void {
	oauthProviderRegistry.set(provider.id, provider, sourceId);
}

/** Retire one runtime owner's overrides without disturbing external registrations. */
export function unregisterOAuthProviders(sourceId: string): void {
	oauthProviderRegistry.removeSource(sourceId);
}

/**
 * Unregister an OAuth provider.
 *
 * If the provider is built-in, restores the built-in implementation.
 * Custom providers are removed completely.
 */
export function unregisterOAuthProvider(id: string): void {
	oauthProviderRegistry.delete(id);
	const builtInProvider = BUILT_IN_OAUTH_PROVIDERS.find((provider) => provider.id === id);
	if (builtInProvider) {
		oauthProviderRegistry.set(id, builtInProvider);
	}
}

/**
 * Reset OAuth providers to built-ins.
 */
export function resetOAuthProviders(): void {
	oauthProviderRegistry.clear();
	for (const provider of BUILT_IN_OAUTH_PROVIDERS) {
		oauthProviderRegistry.set(provider.id, provider);
	}
}

/**
 * Get all registered OAuth providers
 */
export function getOAuthProviders(): OAuthProviderInterface[] {
	return oauthProviderRegistry.values();
}

/**
 * @deprecated Use getOAuthProviders() which returns OAuthProviderInterface[]
 */
export function getOAuthProviderInfoList(): OAuthProviderInfo[] {
	return getOAuthProviders().map((p) => ({
		id: p.id,
		name: p.name,
		available: true,
	}));
}

// ============================================================================
// High-level API (uses provider registry)
// ============================================================================

const inFlightRefreshes = new Map<OAuthProviderId, Promise<OAuthCredentials>>();

/**
 * Refresh token for any OAuth provider.
 * @deprecated Use getOAuthProvider(id).refreshToken() instead
 */
export async function refreshOAuthToken(
	providerId: OAuthProviderId,
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		throw new Error(`Unknown OAuth provider: ${providerId}`);
	}
	return provider.refreshToken(credentials);
}

/**
 * Get API key for a provider from OAuth credentials.
 * Automatically refreshes expired tokens.
 *
 * @returns API key string and updated credentials, or null if no credentials
 * @throws Error if refresh fails
 */
export async function getOAuthApiKey(
	providerId: OAuthProviderId,
	credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		throw new Error(`Unknown OAuth provider: ${providerId}`);
	}

	let creds = credentials[providerId];
	if (!creds) {
		return null;
	}

	// Refresh if expired
	if (Date.now() >= creds.expires) {
		let refresh = inFlightRefreshes.get(providerId);
		if (!refresh) {
			refresh = provider.refreshToken(creds).finally(() => {
				inFlightRefreshes.delete(providerId);
			});
			inFlightRefreshes.set(providerId, refresh);
		}
		try {
			creds = await refresh;
		} catch (_error) {
			throw new Error(`Failed to refresh OAuth token for ${providerId}`);
		}
	}

	const apiKey = provider.getApiKey(creds);
	return { newCredentials: creds, apiKey };
}
