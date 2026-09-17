import { ANTIGRAVITY_PROVIDER, discoverAntigravityAccount, parseAntigravityModels } from "../antigravity.ts";
import { awaitAuthorizationInput, parseAuthorizationInput } from "./authorization-input.ts";
import { generatePKCE } from "./pkce.ts";
import { OAuthRefreshCompletedError } from "./refresh-completed-error.ts";
import { parseOAuthTokenCredentials } from "./token-credentials.ts";
import type { OAuthCredentials, OAuthProviderInterface } from "./types.ts";

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const REDIRECT_URI = "https://antigravity.google/oauth-callback";
const SCOPES = ["cloud-platform", "userinfo.email", "userinfo.profile", "cclog", "experimentsandconfigs", "aicode"]
	.map((scope) => `https://www.googleapis.com/auth/${scope}`)
	.concat("openid");

async function exchangeToken(
	fields: Record<string, string>,
	previous?: OAuthCredentials,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		redirect: "error",
		body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...fields }),
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`Antigravity token exchange failed (HTTP ${response.status})`);
	const token: unknown = await response.json();
	signal?.throwIfAborted();
	return {
		...previous,
		...parseOAuthTokenCredentials(token, "Antigravity", 60, previous?.refresh),
	};
}

export const antigravityOAuthProvider: OAuthProviderInterface = {
	id: ANTIGRAVITY_PROVIDER,
	name: "Google Antigravity (Gemini)",
	isSubscription: true,
	async login(callbacks) {
		callbacks.signal?.throwIfAborted();
		const { verifier, challenge } = await generatePKCE();
		const state = crypto.randomUUID();
		const params = new URLSearchParams({
			client_id: CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			response_type: "code",
			scope: SCOPES.join(" "),
			access_type: "offline",
			prompt: "consent",
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
		});
		callbacks.onAuth({
			url: `https://accounts.google.com/o/oauth2/auth?${params}`,
			instructions: "Sign in, then copy the authorization code from the Antigravity page.",
		});
		const input = await awaitAuthorizationInput(
			() => callbacks.onPrompt({ message: "Paste the Antigravity authorization code or callback URL:" }),
			callbacks.signal,
		);
		callbacks.signal?.throwIfAborted();
		const parsed = parseAuthorizationInput(input);
		if (!parsed.code || (parsed.state !== undefined && parsed.state !== state))
			throw new Error("Invalid Antigravity authorization code or state");
		const credentials = await exchangeToken(
			{ grant_type: "authorization_code", code: parsed.code, code_verifier: verifier, redirect_uri: REDIRECT_URI },
			undefined,
			callbacks.signal,
		);
		callbacks.onProgress?.("Discovering Antigravity models...");
		return { ...credentials, ...(await discoverAntigravityAccount(credentials.access, callbacks.signal)) };
	},
	async refreshToken(credentials) {
		// The omitted-token fallback and retained account metadata must describe
		// the credential submitted, even if the caller mutates its object during I/O.
		const submitted = structuredClone(credentials);
		const refreshed = await exchangeToken(
			{ grant_type: "refresh_token", refresh_token: submitted.refresh },
			submitted,
		);
		try {
			return { ...refreshed, ...(await discoverAntigravityAccount(refreshed.access)) };
		} catch (error) {
			throw new OAuthRefreshCompletedError(ANTIGRAVITY_PROVIDER, refreshed, error);
		}
	},
	getApiKey(credentials) {
		return credentials.access;
	},
	modifyModels(models, credentials) {
		const discovered = parseAntigravityModels(credentials.modelCatalog ?? {});
		return [...models.filter((model) => model.provider !== ANTIGRAVITY_PROVIDER), ...discovered];
	},
};
