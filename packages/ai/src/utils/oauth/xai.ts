/** xAI OAuth browser/OIDC and device-code flows. */

import { readBoundedResponseText } from "../../providers/account-request.ts";
import { XAI_CLI_PROXY_BASE_URL, XAI_CLI_VERSION_HEADERS, xaiCliHeaders } from "../../providers/xai-cli-identity.ts";
import type { Api, Model } from "../../types.ts";
import { awaitAuthorizationInput, parseAuthorizationInput } from "./authorization-input.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import { base64urlEncode, generatePKCE } from "./pkce.ts";
import { OAuthRefreshRejectedError } from "./refresh-rejected-error.ts";
import { createOAuthRequestSignal } from "./request-signal.ts";
import { parseOAuthTokenCredentials } from "./token-credentials.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";
import { startXaiCallback } from "./xai-callback.ts";
import { discoverXaiOidc, verifyXaiIdToken, type XaiOidcDiscovery } from "./xai-oidc.ts";

const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_ISSUER = "https://auth.x.ai";
const XAI_LOCAL_ISSUER = "http://localhost:22255";
const XAI_TEAM_SCOPES = [
	"profile",
	"offline_access",
	"grok-cli:access",
	"api:access",
	"team:read",
	"conversations:read",
	"conversations:write",
	"workspaces:read",
	"workspaces:write",
] as const;
const XAI_CONSUMER_SCOPES = [
	"openid",
	"profile",
	"email",
	"offline_access",
	"grok-cli:access",
	"api:access",
	"conversations:read",
	"conversations:write",
	"workspaces:read",
	"workspaces:write",
] as const;
const XAI_CUSTOM_OIDC_SCOPES = ["openid", "profile", "email", "offline_access", "api:access"] as const;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;
const XAI_DEVICE_FLOW_HEADERS = {
	...XAI_CLI_VERSION_HEADERS,
	"x-grok-client-surface": "cli",
} as const;
const XAI_CLI_PROXY_HEADERS = {
	"x-authenticateresponse": "authenticate-response",
	"x-grok-client-identifier": "grok-shell",
} as const;

type JsonObject = Record<string, unknown>;

type OAuthHttpResponse = {
	ok: boolean;
	status: number;
	body: JsonObject;
};

type XaiOAuth2Config = {
	issuer: string;
	clientId: string;
	scopes: readonly string[];
	referrer: string;
	principalType?: string;
	principalId?: string;
};

type XaiBrowserConfig = {
	issuer: string;
	clientId: string;
	scopes: readonly string[];
	audience?: string;
	principalType?: string;
	principalId?: string;
	referrer?: string;
};

type XaiDeviceCode = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	intervalSeconds?: number;
	expiresInSeconds: number;
};

class XaiOAuthHttpError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "XaiOAuthHttpError";
		this.status = status;
	}
}

class XaiOAuthRequestError extends XaiOAuthHttpError {
	readonly code?: string;

	constructor(action: string, response: OAuthHttpResponse) {
		const error = typeof response.body.error === "string" ? response.body.error : undefined;
		const description =
			typeof response.body.error_description === "string" ? response.body.error_description : undefined;
		const detail = [error, description].filter(Boolean).join(": ");
		super(`xAI OAuth ${action} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`, response.status);
		this.name = "XaiOAuthRequestError";
		this.code = error;
	}
}

function requiredString(body: JsonObject, field: string): string {
	const value = body[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Invalid xAI OAuth response field: ${field}`);
	}
	return value;
}

function positiveInteger(body: JsonObject, field: string): number {
	const value = body[field];
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`Invalid xAI OAuth response field: ${field}`);
	}
	return value;
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function enabledEnvironmentValue(name: string): boolean {
	const value = process.env[name];
	return value !== undefined && value.length > 0 && value !== "0";
}

function booleanEnvironmentValue(name: string): boolean {
	const value = process.env[name]?.toLowerCase();
	return value === "1" || value === "true" || value === "yes" || value === "on" || value === "enabled";
}

function environmentString(name: string, fallback: string): string {
	return process.env[name] ?? fallback;
}

function environmentScopes(name: string, fallback: readonly string[]): readonly string[] {
	const value = process.env[name];
	if (value === undefined) return fallback;
	return value.split(",").map((scope) => scope.trim());
}

function defaultIssuer(): string {
	return enabledEnvironmentValue("GROK_LOCAL_AUTH") ? XAI_LOCAL_ISSUER : XAI_ISSUER;
}

function configuredIdentity(
	issuerVariable: "GROK_OAUTH2_ISSUER" | "GROK_OIDC_ISSUER",
	clientVariable: "GROK_OAUTH2_CLIENT_ID" | "GROK_OIDC_CLIENT_ID",
): Pick<XaiOAuth2Config, "issuer" | "clientId"> | undefined {
	const issuer = process.env[issuerVariable];
	const clientId = process.env[clientVariable];
	if (issuer === undefined || clientId === undefined) return undefined;
	return { issuer, clientId };
}

function oauth2Identity(): Pick<XaiOAuth2Config, "issuer" | "clientId"> {
	return (
		configuredIdentity("GROK_OAUTH2_ISSUER", "GROK_OAUTH2_CLIENT_ID") ?? {
			issuer: defaultIssuer(),
			clientId: XAI_CLIENT_ID,
		}
	);
}

function oauth2Config(): XaiOAuth2Config {
	const configured = configuredIdentity("GROK_OAUTH2_ISSUER", "GROK_OAUTH2_CLIENT_ID");
	if (!configured) {
		return {
			issuer: defaultIssuer(),
			clientId: XAI_CLIENT_ID,
			scopes: XAI_CONSUMER_SCOPES,
			referrer: "grok-build",
		};
	}
	const principalType = process.env.GROK_OAUTH2_PRINCIPAL_TYPE;
	const principalId = process.env.GROK_OAUTH2_PRINCIPAL_ID;
	return {
		...configured,
		scopes: environmentScopes("GROK_OAUTH2_SCOPES", principalType === "Team" ? XAI_TEAM_SCOPES : XAI_CONSUMER_SCOPES),
		referrer: environmentString("GROK_OAUTH2_REFERRER", "grok-build"),
		...(principalType !== undefined ? { principalType } : {}),
		...(principalId !== undefined ? { principalId } : {}),
	};
}

function browserIdentity(): Pick<XaiBrowserConfig, "issuer" | "clientId"> {
	return configuredIdentity("GROK_OIDC_ISSUER", "GROK_OIDC_CLIENT_ID") ?? oauth2Identity();
}

function browserConfig(): XaiBrowserConfig {
	const configured = configuredIdentity("GROK_OIDC_ISSUER", "GROK_OIDC_CLIENT_ID");
	if (!configured) {
		const oauth2 = oauth2Config();
		return {
			issuer: oauth2.issuer,
			clientId: oauth2.clientId,
			scopes: oauth2.scopes,
			...(oauth2.principalType !== undefined ? { principalType: oauth2.principalType } : {}),
			...(oauth2.principalId !== undefined ? { principalId: oauth2.principalId } : {}),
			referrer: oauth2.referrer,
		};
	}
	return {
		...configured,
		scopes: environmentScopes("GROK_OIDC_SCOPES", XAI_CUSTOM_OIDC_SCOPES),
		...(process.env.GROK_OIDC_AUDIENCE !== undefined ? { audience: process.env.GROK_OIDC_AUDIENCE } : {}),
	};
}

function oauthEndpoint(issuer: string, path: string): string {
	return `${issuer.replace(/\/+$/, "")}${path}`;
}

function validateVerificationUri(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("Untrusted verification URI in xAI OAuth response");
	}
	const local = url.protocol === "http:" && url.hostname === "localhost" && enabledEnvironmentValue("GROK_LOCAL_AUTH");
	if (url.protocol !== "https:" && !local) {
		throw new Error("Untrusted verification URI in xAI OAuth response");
	}
	return url.href;
}

async function postForm(
	url: string,
	fields: Record<string, string>,
	options: { signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<OAuthHttpResponse> {
	const { signal } = options;
	const requestSignal = createOAuthRequestSignal(signal);
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				...options.headers,
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(fields),
			redirect: "error",
			signal: requestSignal,
		});
	} catch (error) {
		signal?.throwIfAborted();
		throw error;
	}

	let body: JsonObject;
	try {
		requestSignal.throwIfAborted();
		const text = await readBoundedResponseText(response, MAX_OAUTH_RESPONSE_BYTES);
		requestSignal.throwIfAborted();
		if (text === undefined) {
			throw new XaiOAuthHttpError(
				`xAI OAuth response exceeded the 64 KiB limit (HTTP ${response.status})`,
				response.status,
			);
		}
		const parsed = JSON.parse(text) as unknown;
		body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : {};
	} catch (error) {
		signal?.throwIfAborted();
		requestSignal.throwIfAborted();
		if (!(error instanceof SyntaxError)) throw error;
		throw new XaiOAuthHttpError(`xAI OAuth returned invalid JSON (HTTP ${response.status})`, response.status);
	} finally {
		await response.body?.cancel().catch(() => {});
	}
	signal?.throwIfAborted();
	return { ok: response.ok, status: response.status, body };
}

function parseDeviceCode(body: JsonObject): XaiDeviceCode {
	const interval = body.interval;
	const complete = nonEmptyString(body.verification_uri_complete);
	const verification = nonEmptyString(body.verification_uri);
	const userCode = requiredString(body, "user_code");
	if (/[^A-Za-z0-9-]/.test(userCode)) throw new Error("Invalid xAI OAuth response field: user_code");
	if (!complete && !verification) throw new Error("Invalid xAI OAuth response field: verification_uri");
	return {
		deviceCode: requiredString(body, "device_code"),
		userCode,
		verificationUri: validateVerificationUri(verification ?? complete!),
		verificationUriComplete: complete ? validateVerificationUri(complete) : undefined,
		intervalSeconds:
			typeof interval === "number" && Number.isSafeInteger(interval) && interval > 0 ? interval : undefined,
		expiresInSeconds: positiveInteger(body, "expires_in"),
	};
}

function jwtClaims(token: unknown): JsonObject | undefined {
	if (typeof token !== "string") return undefined;
	const payload = token.split(".")[1];
	if (!payload) return undefined;
	try {
		const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return parsed as JsonObject;
	} catch {
		return undefined;
	}
}

function identityValue(body: JsonObject, keys: readonly string[], trustedClaims?: JsonObject): string | undefined {
	for (const source of [body, trustedClaims, jwtClaims(body.access_token)]) {
		if (!source) continue;
		for (const key of keys) {
			const value = nonEmptyString(source[key]);
			if (value) return value;
		}
	}
	return undefined;
}

function credentialsFromTokenResponse(
	body: JsonObject,
	previous?: { refresh?: string; userId?: unknown; email?: unknown },
	trustedClaims?: JsonObject,
): OAuthCredentials {
	const credentials = parseOAuthTokenCredentials(
		{ ...body, expires_in: body.expires_in === undefined ? DEFAULT_TOKEN_LIFETIME_SECONDS : body.expires_in },
		"xAI",
		5 * 60,
		previous?.refresh,
	);
	const userId = identityValue(body, ["user_id", "userId", "sub"], trustedClaims) ?? nonEmptyString(previous?.userId);
	const email = identityValue(body, ["email"], trustedClaims) ?? nonEmptyString(previous?.email);
	return {
		...credentials,
		...(userId ? { userId } : {}),
		...(email ? { email } : {}),
	};
}

async function requestDeviceCode(config: XaiOAuth2Config, signal?: AbortSignal): Promise<XaiDeviceCode> {
	const response = await postForm(
		oauthEndpoint(config.issuer, "/oauth2/device/code"),
		{
			client_id: config.clientId,
			scope: config.scopes.join(" "),
			referrer: "grok-build",
		},
		{ signal, headers: XAI_DEVICE_FLOW_HEADERS },
	);
	if (!response.ok) throw new XaiOAuthRequestError("device authorization", response);
	return parseDeviceCode(response.body);
}

async function pollForTokens(
	config: XaiOAuth2Config,
	device: XaiDeviceCode,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	return pollOAuthDeviceCodeFlow<OAuthCredentials>({
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		waitBeforeFirstPoll: true,
		signal,
		poll: async () => {
			const response = await postForm(
				oauthEndpoint(config.issuer, "/oauth2/token"),
				{
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					client_id: config.clientId,
					device_code: device.deviceCode,
				},
				{ signal, headers: XAI_DEVICE_FLOW_HEADERS },
			);
			if (response.ok) {
				return {
					status: "complete",
					value: {
						...credentialsFromTokenResponse(response.body),
						authMethod: "device",
						issuer: config.issuer,
						clientId: config.clientId,
						scopes: [...config.scopes],
						...(config.principalType !== undefined ? { principalType: config.principalType } : {}),
						...(config.principalId !== undefined ? { principalId: config.principalId } : {}),
					},
				};
			}

			const error = response.body.error;
			if (error === "authorization_pending") return { status: "pending" };
			if (error === "slow_down") return { status: "slow_down" };
			if (error === "access_denied" || error === "authorization_denied") {
				return { status: "failed", message: "xAI device authorization was denied" };
			}
			if (error === "expired_token") return { status: "failed", message: "xAI device code expired" };
			return { status: "failed", message: new XaiOAuthRequestError("device token polling", response).message };
		},
	});
}

async function loginXaiDevice(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const config = oauth2Config();
	const device = await requestDeviceCode(config, callbacks.signal);
	callbacks.onDeviceCode({
		userCode: device.userCode,
		verificationUri: device.verificationUriComplete ?? device.verificationUri,
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
	});
	return pollForTokens(config, device, callbacks.signal);
}

function randomOAuthValue(): string {
	const value = new Uint8Array(32);
	crypto.getRandomValues(value);
	return base64urlEncode(value);
}

function buildAuthorizationUrl(
	discovery: XaiOidcDiscovery,
	config: XaiBrowserConfig,
	redirectUri: string,
	challenge: string,
	state: string,
	nonce: string,
): string {
	const url = new URL(discovery.authorizationEndpoint);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: config.clientId,
		redirect_uri: redirectUri,
		scope: config.scopes.join(" "),
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		nonce,
		...(config.audience !== undefined ? { audience: config.audience } : {}),
		...(config.principalType !== undefined ? { principal_type: config.principalType } : {}),
		...(config.principalId !== undefined ? { principal_id: config.principalId } : {}),
		...(config.referrer !== undefined ? { referrer: config.referrer } : {}),
	}).toString();
	return url.toString();
}

async function exchangeBrowserCode(options: {
	discovery: XaiOidcDiscovery;
	config: XaiBrowserConfig;
	code: string;
	redirectUri: string;
	verifier: string;
	nonce: string;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const response = await postForm(
		options.discovery.tokenEndpoint,
		{
			grant_type: "authorization_code",
			code: options.code,
			redirect_uri: options.redirectUri,
			client_id: options.config.clientId,
			code_verifier: options.verifier,
		},
		{ signal: options.signal },
	);
	if (!response.ok) throw new XaiOAuthRequestError("authorization code exchange", response);
	const idToken = requiredString(response.body, "id_token");
	const claims = await verifyXaiIdToken({
		token: idToken,
		discovery: options.discovery,
		clientId: options.config.clientId,
		nonce: options.nonce,
		signal: options.signal,
	});
	return {
		...credentialsFromTokenResponse(response.body, undefined, claims),
		authMethod: "oidc",
		issuer: options.discovery.issuer,
		clientId: options.config.clientId,
		scopes: [...options.config.scopes],
		...(options.config.audience !== undefined ? { audience: options.config.audience } : {}),
		...(options.config.principalType !== undefined ? { principalType: options.config.principalType } : {}),
		...(options.config.principalId !== undefined ? { principalId: options.config.principalId } : {}),
	};
}

async function loginXaiBrowser(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	callbacks.signal?.throwIfAborted();
	const config = browserConfig();
	const discovery = await discoverXaiOidc(config.issuer, callbacks.signal);
	const { verifier, challenge } = await generatePKCE();
	const state = randomOAuthValue();
	const nonce = randomOAuthValue();
	const callback = await startXaiCallback(state);
	const inputLifetime = new AbortController();
	const timeout = AbortSignal.timeout(LOGIN_TIMEOUT_MS);
	const inputSignal = callbacks.signal
		? AbortSignal.any([callbacks.signal, timeout, inputLifetime.signal])
		: AbortSignal.any([timeout, inputLifetime.signal]);
	let browserSucceeded = false;
	try {
		inputSignal.throwIfAborted();
		const url = buildAuthorizationUrl(discovery, config, callback.redirectUri, challenge, state, nonce);
		callbacks.onProgress?.(`Listening for xAI OAuth callback on ${callback.redirectUri}`);
		callbacks.onAuth({
			url,
			manualUrl: callbacks.onManualCodeInput ? url : undefined,
			instructions: callbacks.onManualCodeInput
				? "Complete sign-in in your browser, or paste the resulting callback URL."
				: "Complete sign-in in your browser.",
		});

		const callbackInput = callback.waitForAuthorization().then((authorization) => ({
			...authorization,
			source: "callback" as const,
		}));
		const manualInput = callbacks.onManualCodeInput
			? awaitAuthorizationInput(callbacks.onManualCodeInput, inputSignal).then((input) => {
					const parsed = parseAuthorizationInput(input, callback.redirectUri);
					if (!parsed.code || parsed.state !== state) throw new Error("xAI OAuth state mismatch");
					return { code: parsed.code, state: parsed.state, source: "manual" as const };
				})
			: undefined;
		let authorization: { code: string; state: string; source: "callback" | "manual" };
		try {
			authorization = await awaitAuthorizationInput(
				() => (manualInput ? Promise.race([callbackInput, manualInput]) : callbackInput),
				inputSignal,
			);
		} catch (error) {
			callbacks.signal?.throwIfAborted();
			if (timeout.aborted) throw new Error("xAI OAuth login timed out after 10 minutes");
			throw error;
		}
		inputLifetime.abort();
		callbacks.onProgress?.("Exchanging xAI authorization code for tokens...");
		const credentials = await exchangeBrowserCode({
			discovery,
			config,
			code: authorization.code,
			redirectUri: callback.redirectUri,
			verifier,
			nonce,
			signal: callbacks.signal,
		});
		browserSucceeded = authorization.source === "callback";
		return credentials;
	} finally {
		inputLifetime.abort();
		callback.finish(browserSucceeded);
	}
}

export async function loginXai(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	if (!booleanEnvironmentValue("GROK_LOGIN_DEVICE_FLOW")) return loginXaiBrowser(callbacks);
	try {
		return await loginXaiDevice(callbacks);
	} catch (error) {
		if (!(error instanceof XaiOAuthHttpError) || error.status !== 404) throw error;
		callbacks.onProgress?.("Device-code login isn't available for this SSO provider; using browser sign-in.");
		return loginXaiBrowser(callbacks);
	}
}

function storedAuthMethod(credentials: OAuthCredentials | undefined): "device" | "oidc" {
	return credentials?.authMethod === "oidc" ? "oidc" : "device";
}

export async function refreshXaiToken(
	refreshToken: string,
	options?: { signal?: AbortSignal; previous?: OAuthCredentials },
): Promise<OAuthCredentials> {
	const previous = options?.previous;
	const authMethod = storedAuthMethod(previous);
	const storedIssuer = nonEmptyString(previous?.issuer);
	const storedClientId = nonEmptyString(previous?.clientId);
	const principalType = typeof previous?.principalType === "string" ? previous.principalType : undefined;
	const principalId = typeof previous?.principalId === "string" ? previous.principalId : undefined;
	const audience = typeof previous?.audience === "string" ? previous.audience : undefined;
	const fallback =
		storedIssuer && storedClientId ? undefined : authMethod === "oidc" ? browserIdentity() : oauth2Identity();
	const issuer = storedIssuer ?? fallback!.issuer;
	const clientId = storedClientId ?? fallback!.clientId;
	const discovery = authMethod === "oidc" ? await discoverXaiOidc(issuer, options?.signal) : undefined;
	const response = await postForm(
		discovery?.tokenEndpoint ?? oauthEndpoint(issuer, "/oauth2/token"),
		{
			grant_type: "refresh_token",
			client_id: clientId,
			refresh_token: refreshToken,
			...(principalType !== undefined ? { principal_type: principalType } : {}),
			...(principalId !== undefined ? { principal_id: principalId } : {}),
		},
		{ signal: options?.signal, headers: authMethod === "device" ? XAI_DEVICE_FLOW_HEADERS : undefined },
	);
	if (!response.ok) {
		const error = new XaiOAuthRequestError("token refresh", response);
		if (error.code === "invalid_grant" || error.code === "invalid_client") {
			throw new OAuthRefreshRejectedError("xai", "rejected", error.message);
		}
		throw error;
	}
	return {
		...credentialsFromTokenResponse(response.body, {
			refresh: refreshToken,
			userId: previous?.userId,
			email: previous?.email,
		}),
		authMethod,
		issuer,
		clientId,
		...(Array.isArray(previous?.scopes) ? { scopes: previous.scopes } : {}),
		...(audience !== undefined ? { audience } : {}),
		...(principalType !== undefined ? { principalType } : {}),
		...(principalId !== undefined ? { principalId } : {}),
	};
}

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: "xai",
	name: "xAI (Grok/X subscription)",
	isSubscription: true,
	usesCallbackServer: true,
	requiresRefreshPersistencePreflight: true,
	loginLabel: "Sign in with SuperGrok or X Premium",
	login: loginXai,
	refreshToken: (credentials, options) =>
		refreshXaiToken(credentials.refresh, { previous: credentials, signal: options?.signal }),
	getApiKey: (credentials) => credentials.access,
	modifyModels(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] {
		const userId = nonEmptyString(credentials.userId);
		const email = nonEmptyString(credentials.email);
		return models.map((model) => {
			if (model.provider !== "xai" || model.api !== "openai-responses") return model;
			const { "x-userid": _previousUserId, "x-email": _previousEmail, ...preservedHeaders } = model.headers ?? {};
			return {
				...model,
				baseUrl: XAI_CLI_PROXY_BASE_URL,
				headers: {
					...preservedHeaders,
					...xaiCliHeaders(userId),
					...XAI_CLI_PROXY_HEADERS,
					"x-grok-model-override": model.id,
					...(email ? { "x-email": email } : {}),
				},
				compat: {
					...model.compat,
					requestFormat: "xai-cli",
					supportsLongCacheRetention: false,
				},
			};
		});
	},
};
