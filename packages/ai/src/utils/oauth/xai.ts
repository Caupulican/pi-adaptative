/** xAI OAuth device-code flow. */

import type { Api, Model } from "../../types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import { parseOAuthTokenCredentials } from "./token-credentials.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE =
	"openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write";
const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
const XAI_CLI_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const XAI_CLI_VERSION_HEADERS = { "x-grok-client-version": "1.0.40" } as const;
const XAI_DEVICE_FLOW_HEADERS = {
	...XAI_CLI_VERSION_HEADERS,
	"x-grok-client-surface": "cli",
} as const;
const XAI_CLI_PROXY_HEADERS = {
	...XAI_CLI_VERSION_HEADERS,
	"X-XAI-Token-Auth": "xai-grok-cli",
	"x-authenticateresponse": "authenticate-response",
	"x-grok-client-identifier": "grok-shell",
	"x-grok-client-mode": "interactive",
} as const;

type JsonObject = Record<string, unknown>;

type OAuthHttpResponse = {
	ok: boolean;
	status: number;
	body: JsonObject;
};

type XaiDeviceCode = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	intervalSeconds?: number;
	expiresInSeconds: number;
};

function requiredString(body: JsonObject, field: string): string {
	const value = body[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Invalid xAI OAuth response field: ${field}`);
	}
	return value;
}

function positiveNumber(body: JsonObject, field: string): number {
	const value = body[field];
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid xAI OAuth response field: ${field}`);
	}
	return value;
}

function validateVerificationUri(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("Untrusted verification URI in xAI OAuth response");
	}
	if (url.protocol !== "https:") {
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
	signal?.throwIfAborted();
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
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
		});
	} catch (error) {
		if (signal?.aborted) throw new Error("Login cancelled");
		throw error;
	}

	signal?.throwIfAborted();
	let body: JsonObject;
	try {
		const parsed = (await response.json()) as unknown;
		body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : {};
	} catch {
		if (signal?.aborted) throw new Error("Login cancelled");
		throw new Error(`xAI OAuth returned invalid JSON (HTTP ${response.status})`);
	}
	signal?.throwIfAborted();
	return { ok: response.ok, status: response.status, body };
}

function requestFailure(action: string, response: OAuthHttpResponse): Error {
	const error = typeof response.body.error === "string" ? response.body.error : undefined;
	const description =
		typeof response.body.error_description === "string" ? response.body.error_description : undefined;
	const detail = [error, description].filter(Boolean).join(": ");
	return new Error(`xAI OAuth ${action} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
}

function parseDeviceCode(body: JsonObject): XaiDeviceCode {
	const interval = body.interval;
	const verificationUriComplete = body.verification_uri_complete;
	return {
		deviceCode: requiredString(body, "device_code"),
		userCode: requiredString(body, "user_code"),
		verificationUri: validateVerificationUri(requiredString(body, "verification_uri")),
		verificationUriComplete:
			typeof verificationUriComplete === "string" && verificationUriComplete.length > 0
				? validateVerificationUri(verificationUriComplete)
				: undefined,
		intervalSeconds: typeof interval === "number" && Number.isFinite(interval) && interval > 0 ? interval : undefined,
		expiresInSeconds: positiveNumber(body, "expires_in"),
	};
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
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

function identityValue(body: JsonObject, keys: readonly string[]): string | undefined {
	for (const source of [body, jwtClaims(body.id_token), jwtClaims(body.access_token)]) {
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
): OAuthCredentials {
	const credentials = parseOAuthTokenCredentials(
		{ ...body, expires_in: body.expires_in === undefined ? DEFAULT_TOKEN_LIFETIME_SECONDS : body.expires_in },
		"xAI",
		5 * 60,
		previous?.refresh,
	);
	const userId = identityValue(body, ["user_id", "userId"]) ?? nonEmptyString(previous?.userId);
	const email = identityValue(body, ["email"]) ?? nonEmptyString(previous?.email);
	return {
		...credentials,
		...(userId ? { userId } : {}),
		...(email ? { email } : {}),
	};
}

async function requestDeviceCode(signal?: AbortSignal): Promise<XaiDeviceCode> {
	const response = await postForm(
		XAI_DEVICE_CODE_URL,
		{ client_id: XAI_CLIENT_ID, scope: XAI_SCOPE, referrer: "grok-build" },
		{ signal, headers: XAI_DEVICE_FLOW_HEADERS },
	);
	if (!response.ok) throw requestFailure("device authorization", response);
	return parseDeviceCode(response.body);
}

async function pollForTokens(device: XaiDeviceCode, signal?: AbortSignal): Promise<OAuthCredentials> {
	return pollOAuthDeviceCodeFlow<OAuthCredentials>({
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		waitBeforeFirstPoll: true,
		signal,
		poll: async () => {
			const response = await postForm(
				XAI_TOKEN_URL,
				{
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					client_id: XAI_CLIENT_ID,
					device_code: device.deviceCode,
				},
				{ signal, headers: XAI_DEVICE_FLOW_HEADERS },
			);
			if (response.ok) return { status: "complete", value: credentialsFromTokenResponse(response.body) };

			const error = response.body.error;
			if (error === "authorization_pending") return { status: "pending" };
			if (error === "slow_down") {
				const interval = response.body.interval;
				return {
					status: "slow_down",
					intervalSeconds:
						typeof interval === "number" && Number.isFinite(interval) && interval > 0 ? interval : undefined,
				};
			}
			if (error === "access_denied" || error === "authorization_denied") {
				return { status: "failed", message: "xAI device authorization was denied" };
			}
			if (error === "expired_token") return { status: "failed", message: "xAI device code expired" };
			return { status: "failed", message: requestFailure("device token polling", response).message };
		},
	});
}

export async function loginXai(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const device = await requestDeviceCode(callbacks.signal);
	callbacks.onDeviceCode({
		userCode: device.userCode,
		verificationUri: device.verificationUriComplete ?? device.verificationUri,
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
	});
	return pollForTokens(device, callbacks.signal);
}

export async function refreshXaiToken(
	refreshToken: string,
	options?: { signal?: AbortSignal; previous?: OAuthCredentials },
): Promise<OAuthCredentials> {
	const response = await postForm(
		XAI_TOKEN_URL,
		{
			grant_type: "refresh_token",
			client_id: XAI_CLIENT_ID,
			refresh_token: refreshToken,
		},
		{ signal: options?.signal, headers: XAI_DEVICE_FLOW_HEADERS },
	);
	if (!response.ok) throw requestFailure("token refresh", response);
	return credentialsFromTokenResponse(response.body, {
		refresh: refreshToken,
		userId: options?.previous?.userId,
		email: options?.previous?.email,
	});
}

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: "xai",
	name: "xAI (Grok/X subscription)",
	isSubscription: true,
	loginLabel: "Sign in with SuperGrok or X Premium",
	login: loginXai,
	refreshToken: (credentials) => refreshXaiToken(credentials.refresh, { previous: credentials }),
	getApiKey: (credentials) => credentials.access,
	modifyModels(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] {
		const userId = nonEmptyString(credentials.userId);
		const email = nonEmptyString(credentials.email);
		return models.map((model) => {
			if (model.provider !== "xai" || model.api !== "openai-responses") return model;
			return {
				...model,
				baseUrl: XAI_CLI_PROXY_BASE_URL,
				headers: {
					...model.headers,
					...XAI_CLI_PROXY_HEADERS,
					"x-grok-model-override": model.id,
					...(userId ? { "x-userid": userId } : {}),
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
