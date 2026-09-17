import type { OAuthCredentials } from "./types.ts";

/** Accept expiring OAuth tokens before they can enter persistent credential storage. */
export function parseOAuthTokenCredentials(
	value: unknown,
	provider: string,
	earlyRefreshSeconds: number,
	previousRefresh?: string,
): OAuthCredentials {
	const invalid = () => new Error(`${provider} returned invalid OAuth credentials`);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
	const token = value as Record<string, unknown>;
	const refresh = token.refresh_token === undefined ? previousRefresh : token.refresh_token;
	if (
		typeof token.access_token !== "string" ||
		!token.access_token.trim() ||
		typeof refresh !== "string" ||
		!refresh.trim() ||
		typeof token.expires_in !== "number" ||
		!Number.isSafeInteger(token.expires_in) ||
		token.expires_in <= 0 ||
		token.expires_in > 31_536_000
	) {
		throw invalid();
	}
	return {
		access: token.access_token,
		refresh,
		// A short-lived valid token must remain usable instead of expiring at issuance.
		expires: Date.now() + (token.expires_in - Math.min(earlyRefreshSeconds, token.expires_in / 2)) * 1000,
	};
}
