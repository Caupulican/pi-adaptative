import {
	ANTIGRAVITY_PROVIDER,
	antigravityObject,
	discoverAntigravityAccount,
	parseAntigravityModels,
} from "../antigravity.ts";
import { parseAuthorizationInput } from "./authorization-input.ts";
import { generatePKCE } from "./pkce.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

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
	const token = antigravityObject(await response.json());
	const refresh = token.refresh_token ?? previous?.refresh;
	if (
		typeof token.access_token !== "string" ||
		!token.access_token ||
		typeof refresh !== "string" ||
		!refresh ||
		typeof token.expires_in !== "number" ||
		!Number.isSafeInteger(token.expires_in) ||
		token.expires_in <= 0 ||
		token.expires_in > 31_536_000
	) {
		throw new Error("Antigravity returned invalid OAuth credentials");
	}
	return {
		...previous,
		access: token.access_token,
		refresh,
		expires: Date.now() + Math.max(0, token.expires_in - 60) * 1000,
	};
}

async function promptAuthorizationCode(callbacks: OAuthLoginCallbacks): Promise<string> {
	const signal = callbacks.signal;
	let onAbort: (() => void) | undefined;
	try {
		const cancelled = new Promise<never>((_, reject) => {
			onAbort = () => reject(signal?.reason ?? new Error("Antigravity login cancelled"));
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
		});
		return await Promise.race([
			cancelled,
			callbacks.onPrompt({ message: "Paste the Antigravity authorization code or callback URL:" }),
		]);
	} finally {
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
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
		const input = await promptAuthorizationCode(callbacks);
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
		const refreshed = await exchangeToken(
			{ grant_type: "refresh_token", refresh_token: credentials.refresh },
			credentials,
		);
		return { ...refreshed, ...(await discoverAntigravityAccount(refreshed.access)) };
	},
	getApiKey(credentials) {
		return credentials.access;
	},
	modifyModels(models, credentials) {
		const discovered = parseAntigravityModels(credentials.modelCatalog ?? {});
		return [...models.filter((model) => model.provider !== ANTIGRAVITY_PROVIDER), ...discovered];
	},
};
