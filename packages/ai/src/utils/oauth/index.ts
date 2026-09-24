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
export { antigravityOAuthProvider } from "./google-antigravity.ts";
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
export { OAuthRefreshCompletedError } from "./refresh-completed-error.ts";
export { OAuthRefreshRejectedError, type OAuthRefreshRejection } from "./refresh-rejected-error.ts";
export * from "./types.ts";
export { loginXai, refreshXaiToken, xaiOAuthProvider } from "./xai.ts";

// ============================================================================
// Provider Registry
// ============================================================================

import { SourceRegistry } from "../source-registry.ts";
import { anthropicOAuthProvider } from "./anthropic.ts";
import { githubCopilotOAuthProvider } from "./github-copilot.ts";
import { antigravityOAuthProvider } from "./google-antigravity.ts";
import { kimiCodingOAuthProvider } from "./kimi-coding.ts";
import { openaiCodexOAuthProvider } from "./openai-codex.ts";
import { openRouterOAuthProvider } from "./openrouter.ts";
import { OAuthRefreshCompletedError } from "./refresh-completed-error.ts";
import type { OAuthCredentials, OAuthProviderId, OAuthProviderInfo, OAuthProviderInterface } from "./types.ts";
import { xaiOAuthProvider } from "./xai.ts";

const BUILT_IN_OAUTH_PROVIDERS: OAuthProviderInterface[] = [
	anthropicOAuthProvider,
	antigravityOAuthProvider,
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

// A provider ID can name a replacement adapter or credentials for several accounts.
// Only callers using the same adapter and refresh token may share a rotation.
const inFlightRefreshes = new WeakMap<OAuthProviderInterface, Map<string, Promise<OAuthCredentials>>>();

function resolveOAuthProvider(providerOrId: OAuthProviderId | OAuthProviderInterface): OAuthProviderInterface {
	const provider = typeof providerOrId === "string" ? getOAuthProvider(providerOrId) : providerOrId;
	if (!provider) {
		throw new Error(`Unknown OAuth provider: ${providerOrId}`);
	}
	return provider;
}

/**
 * Refresh credentials for a captured adapter or a registered provider.
 * Expiry and rejected-key recovery share the same pending token exchange.
 */
export async function refreshOAuthToken(
	providerOrId: OAuthProviderId | OAuthProviderInterface,
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	const provider = resolveOAuthProvider(providerOrId);
	let providerRefreshes = inFlightRefreshes.get(provider);
	if (!providerRefreshes) {
		providerRefreshes = new Map();
		inFlightRefreshes.set(provider, providerRefreshes);
	}
	const refreshToken = credentials.refresh;
	let refresh = providerRefreshes.get(refreshToken);
	if (!refresh) {
		refresh = provider.refreshToken(credentials).finally(() => {
			providerRefreshes.delete(refreshToken);
		});
		providerRefreshes.set(refreshToken, refresh);
	}
	return refresh;
}

/**
 * Get API key for a provider from OAuth credentials.
 * Automatically refreshes expired tokens.
 * Pass a captured adapter when a caller must retain its identity across awaited work.
 *
 * @returns API key string and updated credentials, or null if no credentials
 * @throws Error if refresh fails
 */
export async function getOAuthApiKey(
	providerOrId: OAuthProviderId | OAuthProviderInterface,
	credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	const provider = resolveOAuthProvider(providerOrId);
	const providerId = provider.id;

	let creds = credentials[providerId];
	if (!creds) {
		return null;
	}

	// Refresh if expired, or stored by an older provider version that lacks data it now reads
	if (Date.now() >= creds.expires || provider.needsRefresh?.(creds)) {
		try {
			creds = await refreshOAuthToken(provider, creds);
		} catch (error) {
			if (error instanceof OAuthRefreshCompletedError) throw error;
			// The provider's own failure (HTTP status, invalid_grant, network) is the reason a caller
			// can act on; it rides as the cause so the user-facing message can name it.
			throw new Error(`Failed to refresh OAuth token for ${providerId}`, { cause: error });
		}
	}

	const apiKey = provider.getApiKey(creds);
	return { newCredentials: creds, apiKey };
}
