import { readBoundedResponseText } from "../../providers/account-request.ts";
import { ANTIGRAVITY_CLIENT_CONFIG } from "../../providers/antigravity-client-config.generated.ts";
import {
	ANTIGRAVITY_CATALOG_VERSION,
	ANTIGRAVITY_PROVIDER,
	antigravityCredentialProjectId,
	antigravityCredentialRequestContext,
	discoverAntigravityAccount,
	parseAntigravityModels,
} from "../antigravity.ts";
import { awaitAuthorizationInput, parseAuthorizationInput } from "./authorization-input.ts";
import { base64urlEncode, generatePKCE } from "./pkce.ts";
import { OAuthRefreshRejectedError } from "./refresh-rejected-error.ts";
import { createOAuthRequestSignal } from "./request-signal.ts";
import { parseOAuthTokenCredentials } from "./token-credentials.ts";
import type { OAuthCredentials, OAuthProviderInterface } from "./types.ts";

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const REDIRECT_URI = "https://antigravity.google/oauth-callback";
const SCOPES = ["cloud-platform", "userinfo.email", "userinfo.profile", "cclog", "experimentsandconfigs", "aicode"]
	.map((scope) => `https://www.googleapis.com/auth/${scope}`)
	.concat("openid");

type TokenOperation = "exchange" | "refresh";

function tokenFailure(status: number, raw: string, operation: TokenOperation): Error {
	let code: string | undefined;
	try {
		const body = JSON.parse(raw) as unknown;
		if (body && typeof body === "object" && !Array.isArray(body)) {
			const candidate = (body as Record<string, unknown>).error;
			if (typeof candidate === "string" && /^[a-z_]{1,80}$/.test(candidate)) code = candidate;
		}
	} catch {}
	const message = `Antigravity token ${operation} failed (HTTP ${status}${code ? `, ${code}` : ""})`;
	if (operation === "refresh" && (status === 401 || code === "invalid_grant")) {
		return new OAuthRefreshRejectedError(ANTIGRAVITY_PROVIDER, "rejected", message);
	}
	return new Error(message);
}

async function exchangeToken(
	fields: Record<string, string>,
	previous?: OAuthCredentials,
	signal?: AbortSignal,
	operation: TokenOperation = "exchange",
): Promise<OAuthCredentials> {
	const requestSignal = createOAuthRequestSignal(signal);
	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		redirect: "error",
		body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...fields }),
		signal: requestSignal,
	});
	const raw = await readBoundedResponseText(response, 64 * 1024);
	requestSignal.throwIfAborted();
	if (raw === undefined) throw new Error("Antigravity token response exceeded the 64 KiB limit");
	if (!response.ok) throw tokenFailure(response.status, raw, operation);
	let token: unknown;
	try {
		token = JSON.parse(raw);
	} catch {
		throw new Error("Invalid Antigravity token response JSON");
	}
	signal?.throwIfAborted();
	return {
		...previous,
		...parseOAuthTokenCredentials(token, "Antigravity", 5 * 60, previous?.refresh),
	};
}

export const antigravityOAuthProvider: OAuthProviderInterface = {
	id: ANTIGRAVITY_PROVIDER,
	name: "Google Antigravity",
	isSubscription: true,
	async login(callbacks) {
		callbacks.signal?.throwIfAborted();
		const { verifier, challenge } = await generatePKCE();
		callbacks.signal?.throwIfAborted();
		const state = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
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
		const parsed = parseAuthorizationInput(input, REDIRECT_URI);
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
	async refreshToken(credentials, options) {
		// Native savingTokenSource rotates and saves tokens independently of account discovery.
		const submitted = structuredClone(credentials);
		return exchangeToken(
			{ grant_type: "refresh_token", refresh_token: submitted.refresh },
			submitted,
			options?.signal,
			"refresh",
		);
	},
	async updateCredentials(credentials) {
		const submitted = structuredClone(credentials);
		return { ...submitted, ...(await discoverAntigravityAccount(submitted.access)) };
	},
	getApiKey(credentials) {
		return credentials.access;
	},
	needsCredentialUpdate(credentials) {
		return (
			credentials.catalogVersion !== ANTIGRAVITY_CATALOG_VERSION ||
			credentials.clientVersion !== ANTIGRAVITY_CLIENT_CONFIG.version
		);
	},
	getRequestContext(credentials) {
		return antigravityCredentialRequestContext(credentials);
	},
	getAccountId(credentials) {
		return antigravityCredentialProjectId(credentials);
	},
	modifyModels(models, credentials) {
		const discovered = parseAntigravityModels(credentials.modelCatalog ?? {});
		return [...models.filter((model) => model.provider !== ANTIGRAVITY_PROVIDER), ...discovered];
	},
};
