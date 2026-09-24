/**
 * OpenAI Codex (ChatGPT OAuth) flow
 *
 * NOTE: This module uses Node.js crypto and http for the OAuth callback.
 * It is only intended for CLI use, not browser environments.
 */

// NEVER convert to top-level imports - breaks browser/Vite builds
let _randomBytes: typeof import("node:crypto").randomBytes | null = null;
let _http: typeof import("node:http") | null = null;
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	import("node:crypto").then((m) => {
		_randomBytes = m.randomBytes;
	});
	import("node:http").then((m) => {
		_http = m;
	});
}

import { readBoundedResponseText } from "../../providers/account-request.ts";
import {
	getOpenAICodexAccountId,
	getOpenAICodexFedrampClaim,
	getOpenAICodexTokenExpiry,
	OPENAI_CODEX_FEDRAMP_HEADER,
} from "../../providers/openai-codex-auth.ts";
import { parseAuthorizationInput, raceAuthorizationInput } from "./authorization-input.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";
import { OAuthRefreshRejectedError, type OAuthRefreshRejection } from "./refresh-rejected-error.ts";
import type {
	OAuthCredentials,
	OAuthDeviceCodeInfo,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthProviderInterface,
} from "./types.ts";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
export const OPENAI_CODEX_BROWSER_LOGIN_METHOD = "browser";
export const OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD = "device_code";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";

type OAuthToken = { access: string; refresh: string; expires: number; fedramp?: boolean };
type TokenOperation = "exchange" | "refresh";
const TOKEN_EXPIRY_EARLY_REFRESH_MS = 5 * 60 * 1000;

function getCallbackHost(): string {
	return typeof process !== "undefined" ? process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1" : "127.0.0.1";
}

type DeviceAuthInfo = {
	deviceAuthId: string;
	userCode: string;
	intervalSeconds: number;
};

type DeviceTokenSuccess = {
	authorizationCode: string;
	codeVerifier: string;
};

function createState(): string {
	if (!_randomBytes) {
		throw new Error("OpenAI Codex OAuth is only available in Node.js environments");
	}
	return _randomBytes(32).toString("base64url");
}

async function fetchWithLoginCancellation(input: string, init: RequestInit, what: string): Promise<Response> {
	try {
		return await fetch(input, init);
	} catch {
		if (init.signal?.aborted) {
			throw new Error("Login cancelled");
		}
		throw new Error(`OpenAI Codex ${what} request failed (network error)`);
	}
}

const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;

async function readBoundedJson(response: Response, what: string): Promise<unknown> {
	const text = await readBoundedResponseText(response, MAX_OAUTH_RESPONSE_BYTES).catch(() => {
		throw new Error(`OpenAI Codex ${what} response could not be read`);
	});
	if (text === undefined) throw new Error(`OpenAI Codex ${what} response exceeded the 64 KiB limit`);
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(`OpenAI Codex ${what} response was not valid JSON`);
	}
}

const MAX_TOKEN_ERROR_BODY_BYTES = 16 * 1024;
const TOKEN_ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const PERMANENT_REFRESH_CODES: Readonly<Record<string, OAuthRefreshRejection>> = {
	refresh_token_expired: "expired",
	refresh_token_reused: "reused",
	refresh_token_invalidated: "revoked",
};

function tokenErrorCode(body: string | undefined): string | undefined {
	if (!body) return undefined;
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (!json || typeof json !== "object") return undefined;
	const record = json as { error?: unknown; code?: unknown };
	const nested =
		record.error && typeof record.error === "object" ? (record.error as { code?: unknown }).code : undefined;
	const code = typeof record.error === "string" ? record.error : typeof nested === "string" ? nested : record.code;
	return typeof code === "string" && TOKEN_ERROR_CODE.test(code) ? code.toLowerCase() : undefined;
}

async function tokenResponseFailure(response: Response, operation: TokenOperation): Promise<Error> {
	const code = tokenErrorCode(
		await readBoundedResponseText(response, MAX_TOKEN_ERROR_BODY_BYTES).catch(() => undefined),
	);
	const message = `OpenAI Codex token ${operation} failed (HTTP ${response.status}${code ? `, ${code}` : ""})`;
	if (operation !== "refresh") return new Error(message);
	const reason =
		(code ? PERMANENT_REFRESH_CODES[code] : undefined) ??
		(response.status === 401 || (response.status === 400 && code === "invalid_grant") ? "rejected" : undefined);
	return reason ? new OAuthRefreshRejectedError("openai-codex", reason, message) : new Error(message);
}

async function readTokenResponse(
	response: Response,
	operation: TokenOperation,
	currentRefreshToken?: string,
): Promise<OAuthToken> {
	if (!response.ok) throw await tokenResponseFailure(response, operation);

	const json = (await readBoundedJson(response, `token ${operation}`)) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		id_token?: unknown;
	} | null;
	// As the Codex CLI does: a refresh that leaves the refresh token out keeps the current one, and the
	// access token's own `exp` claim is its expiry (`expires_in` only when the token carries none).
	const refresh = json?.refresh_token || currentRefreshToken;
	const expiresAt =
		(json?.access_token ? getOpenAICodexTokenExpiry(json.access_token) : undefined) ??
		(typeof json?.expires_in === "number" ? Date.now() + json.expires_in * 1000 : undefined);
	const idTokenSupplied = json?.id_token !== undefined && json?.id_token !== null;
	const idTokenMissing = operation === "exchange" && !idTokenSupplied;
	if (!json?.access_token || !refresh || expiresAt === undefined || idTokenMissing) {
		const missing = [
			...(json?.access_token ? [] : ["access_token"]),
			...(refresh ? [] : ["refresh_token"]),
			...(!json?.access_token || expiresAt !== undefined ? [] : ["expires_in (the token has no exp claim)"]),
			...(idTokenMissing ? ["id_token"] : []),
		];
		throw new Error(`OpenAI Codex token ${operation} response missing fields: ${missing.join(", ")}`);
	}

	const fedramp =
		idTokenSupplied && typeof json.id_token === "string" ? getOpenAICodexFedrampClaim(json.id_token) : undefined;
	if (idTokenSupplied && fedramp === undefined) {
		throw new Error(`OpenAI Codex token ${operation} response has a malformed id_token`);
	}

	return {
		access: json.access_token,
		refresh,
		expires: expiresAt - TOKEN_EXPIRY_EARLY_REFRESH_MS,
		...(fedramp === undefined ? {} : { fedramp }),
	};
}

async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	redirectUri: string = REDIRECT_URI,
	signal?: AbortSignal,
): Promise<OAuthToken> {
	const response = await fetchWithLoginCancellation(
		TOKEN_URL,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code,
				code_verifier: verifier,
				redirect_uri: redirectUri,
			}),
			signal,
		},
		"token exchange",
	);

	return readTokenResponse(response, "exchange");
}

async function refreshAccessToken(refreshToken: string): Promise<OAuthToken> {
	let response: Response;
	try {
		// The Codex CLI sends the ChatGPT refresh grant as JSON; the authorization-code exchange stays a form.
		response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken }),
		});
	} catch {
		throw new Error("OpenAI Codex token refresh request failed (network error)");
	}

	return readTokenResponse(response, "refresh", refreshToken);
}

const DEVICE_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

async function readDeviceJson(response: Response, what: string): Promise<Record<string, unknown> | null> {
	const json = await readBoundedJson(response, what);
	return json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
}

async function startOpenAICodexDeviceAuth(signal?: AbortSignal): Promise<DeviceAuthInfo> {
	const response = await fetchWithLoginCancellation(
		DEVICE_USER_CODE_URL,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ client_id: CLIENT_ID }),
			signal,
		},
		"device code",
	);

	if (!response.ok) {
		if (response.status === 404) {
			throw new Error(
				"OpenAI Codex device code login is not enabled for this server. Use browser login or verify the server URL.",
			);
		}
		await response.body?.cancel().catch(() => {});
		throw new Error(`OpenAI Codex device code request failed with status ${response.status}`);
	}

	const json = await readDeviceJson(response, "device code");
	const deviceAuthId =
		typeof json?.device_auth_id === "string" && json.device_auth_id ? json.device_auth_id : undefined;
	const userCode = typeof json?.user_code === "string" && json.user_code ? json.user_code : undefined;
	const intervalSeconds = typeof json?.interval === "string" ? Number(json.interval.trim()) : json?.interval;
	const validInterval =
		typeof intervalSeconds === "number" && Number.isFinite(intervalSeconds) && intervalSeconds >= 0;
	if (!deviceAuthId || !userCode || !validInterval) {
		const missing = [
			...(deviceAuthId ? [] : ["device_auth_id"]),
			...(userCode ? [] : ["user_code"]),
			...(validInterval ? [] : ["interval"]),
		];
		throw new Error(`Invalid OpenAI Codex device code response: missing or invalid ${missing.join(", ")}`);
	}

	return { deviceAuthId, userCode, intervalSeconds };
}

async function pollOpenAICodexDeviceAuth(device: DeviceAuthInfo, signal?: AbortSignal): Promise<DeviceTokenSuccess> {
	return pollOAuthDeviceCodeFlow<DeviceTokenSuccess>({
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS,
		signal,
		poll: async () => {
			const response = await fetchWithLoginCancellation(
				DEVICE_TOKEN_URL,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						device_auth_id: device.deviceAuthId,
						user_code: device.userCode,
					}),
					signal,
				},
				"device auth token",
			);

			if (response.ok) {
				let json: Record<string, unknown> | null;
				try {
					json = await readDeviceJson(response, "device auth token");
				} catch (error) {
					return { status: "failed", message: (error as Error).message };
				}
				const authorizationCode =
					typeof json?.authorization_code === "string" && json.authorization_code
						? json.authorization_code
						: undefined;
				const codeVerifier =
					typeof json?.code_verifier === "string" && json.code_verifier ? json.code_verifier : undefined;
				if (!authorizationCode || !codeVerifier) {
					const missing = [
						...(authorizationCode ? [] : ["authorization_code"]),
						...(codeVerifier ? [] : ["code_verifier"]),
					];
					return {
						status: "failed",
						message: `Invalid OpenAI Codex device auth token response: missing ${missing.join(", ")}`,
					};
				}
				return { status: "complete", value: { authorizationCode, codeVerifier } };
			}

			if (response.status === 403 || response.status === 404) {
				return { status: "pending" };
			}

			const responseBody = await response.text().catch(() => "");
			let errorCode: unknown;
			try {
				const json = JSON.parse(responseBody) as { error?: string | { code?: string } } | null;
				const error = json?.error;
				errorCode = typeof error === "object" ? error?.code : error;
			} catch {}

			if (errorCode === "deviceauth_authorization_pending") {
				return { status: "pending" };
			}
			if (errorCode === "slow_down") {
				return { status: "slow_down" };
			}

			const code = typeof errorCode === "string" && DEVICE_ERROR_CODE.test(errorCode) ? ` (${errorCode})` : "";
			return { status: "failed", message: `OpenAI Codex device auth failed with status ${response.status}${code}` };
		},
	});
}

async function createAuthorizationFlow(
	originator: string = "pi",
): Promise<{ verifier: string; state: string; url: string }> {
	const { verifier, challenge } = await generatePKCE();
	const state = createState();

	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("redirect_uri", REDIRECT_URI);
	url.searchParams.set("scope", SCOPE);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	url.searchParams.set("id_token_add_organizations", "true");
	url.searchParams.set("codex_cli_simplified_flow", "true");
	url.searchParams.set("originator", originator);

	return { verifier, state, url: url.toString() };
}

type OAuthCallbackOutcome = { code: string } | { error: string };

type OAuthServerInfo = {
	close: () => void;
	cancelWait: () => void;
	waitForCode: () => Promise<OAuthCallbackOutcome | null>;
};

const LIFE_SCIENCES_OAUTH_STATE_SUFFIX = ".onboarding_entrypoint=life_sciences";

function callbackState(received: string, expected: string): string {
	return received.endsWith(LIFE_SCIENCES_OAUTH_STATE_SUFFIX) &&
		received.slice(0, -LIFE_SCIENCES_OAUTH_STATE_SUFFIX.length) === expected
		? expected
		: received;
}

function providerCallbackError(code: string, description: string | null): string {
	const safeCode = /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "error";
	const safeDescription = (description ?? "")
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200);
	return `OpenAI sign-in failed: ${safeCode}${safeDescription ? ` (${safeDescription})` : ""}`;
}

function startLocalOAuthServer(state: string): Promise<OAuthServerInfo> {
	if (!_http) {
		throw new Error("OpenAI Codex OAuth is only available in Node.js environments");
	}

	let settleWait: ((value: OAuthCallbackOutcome | null) => void) | undefined;
	const waitForCodePromise = new Promise<OAuthCallbackOutcome | null>((resolve) => {
		let settled = false;
		settleWait = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
	});

	const server = _http.createServer((req, res) => {
		try {
			const url = new URL(req.url || "", "http://localhost");
			if (url.pathname !== "/auth/callback") {
				res.statusCode = 404;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("Callback route not found."));
				return;
			}
			if (callbackState(url.searchParams.get("state") ?? "", state) !== state) {
				res.statusCode = 400;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("State mismatch."));
				return;
			}
			const providerError = url.searchParams.get("error");
			if (providerError) {
				res.statusCode = 400;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("OpenAI sign-in did not complete. Return to the terminal."));
				settleWait?.({ error: providerCallbackError(providerError, url.searchParams.get("error_description")) });
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				res.statusCode = 400;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("Missing authorization code."));
				return;
			}
			res.statusCode = 200;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.end(oauthSuccessHtml("OpenAI authentication completed. You can close this window."));
			settleWait?.({ code });
		} catch {
			res.statusCode = 500;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.end(oauthErrorHtml("Internal error while processing OAuth callback."));
		}
	});

	return new Promise((resolve) => {
		server
			.listen(1455, getCallbackHost(), () => {
				resolve({
					close: () => server.close(),
					cancelWait: () => {
						settleWait?.(null);
					},
					waitForCode: () => waitForCodePromise,
				});
			})
			.on("error", (_err: NodeJS.ErrnoException) => {
				settleWait?.(null);
				resolve({
					close: () => {
						try {
							server.close();
						} catch {
							// ignore
						}
					},
					cancelWait: () => {},
					waitForCode: async () => null,
				});
			});
	});
}

function credentialsFromToken(token: OAuthToken, previous?: OAuthCredentials): OAuthCredentials {
	const accountId = getOpenAICodexAccountId(token.access);
	if (!accountId) {
		throw new Error("Failed to extract accountId from token");
	}
	const fedramp = token.fedramp ?? (previous?.chatgptAccountIsFedramp === true && previous.accountId === accountId);

	return {
		access: token.access,
		refresh: token.refresh,
		expires: token.expires,
		accountId,
		...(fedramp ? { chatgptAccountIsFedramp: true } : {}),
	};
}

async function exchangeAuthorizationCodeForCredentials(
	code: string,
	verifier: string,
	redirectUri: string,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	return credentialsFromToken(await exchangeAuthorizationCode(code, verifier, redirectUri, signal));
}

/**
 * Login with OpenAI Codex OAuth using the Codex device-code flow.
 */
export async function loginOpenAICodexDeviceCode(options: {
	onDeviceCode: (info: OAuthDeviceCodeInfo) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const device = await startOpenAICodexDeviceAuth(options.signal);
	options.onDeviceCode({
		userCode: device.userCode,
		verificationUri: DEVICE_VERIFICATION_URI,
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS,
	});
	const code = await pollOpenAICodexDeviceAuth(device, options.signal);
	return exchangeAuthorizationCodeForCredentials(
		code.authorizationCode,
		code.codeVerifier,
		DEVICE_REDIRECT_URI,
		options.signal,
	);
}

/**
 * Login with OpenAI Codex OAuth
 *
 * @param options.onAuth - Called with URL and instructions when auth starts
 * @param options.onPrompt - Called to prompt user for manual code paste (fallback if no onManualCodeInput)
 * @param options.onProgress - Optional progress messages
 * @param options.onManualCodeInput - Optional promise that resolves with user-pasted code.
 *                                    Races with browser callback - whichever completes first wins.
 *                                    Useful for showing paste input immediately alongside browser flow.
 * @param options.originator - OAuth originator parameter (defaults to "pi")
 */
export async function loginOpenAICodex(options: {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
	originator?: string;
}): Promise<OAuthCredentials> {
	const { verifier, state, url } = await createAuthorizationFlow(options.originator);
	const server = await startLocalOAuthServer(state);

	options.onAuth({ url, instructions: "A browser window should open. Complete login to finish." });

	let code: string | undefined;
	try {
		if (options.onManualCodeInput) {
			const authorization = await raceAuthorizationInput({
				manualInput: options.onManualCodeInput,
				waitForCallback: async () => {
					const outcome = await server.waitForCode();
					if (outcome && "error" in outcome) throw new Error(outcome.error);
					return outcome;
				},
				cancelWait: server.cancelWait,
				expectedState: state,
				stateMismatchMessage: "State mismatch",
				normalizeState: (received) => callbackState(received, state),
			});
			code = authorization?.code;
		} else {
			// Original flow: wait for callback, then prompt if needed
			const result = await server.waitForCode();
			if (result && "error" in result) throw new Error(result.error);
			if (result?.code) {
				code = result.code;
			}
		}

		// Fallback to onPrompt if still no code
		if (!code) {
			const input = await options.onPrompt({
				message: "Paste the authorization code (or full redirect URL):",
			});
			const parsed = parseAuthorizationInput(input);
			if (parsed.state && callbackState(parsed.state, state) !== state) {
				throw new Error("State mismatch");
			}
			code = parsed.code;
		}

		if (!code) {
			throw new Error("Missing authorization code");
		}

		return exchangeAuthorizationCodeForCredentials(code, verifier, REDIRECT_URI);
	} finally {
		server.close();
	}
}

/**
 * Refresh OpenAI Codex OAuth token
 */
export async function refreshOpenAICodexToken(
	refreshToken: string,
	previous?: OAuthCredentials,
): Promise<OAuthCredentials> {
	return credentialsFromToken(await refreshAccessToken(refreshToken), previous);
}

export const openaiCodexOAuthProvider: OAuthProviderInterface = {
	id: "openai-codex",
	name: "ChatGPT Plus/Pro (Codex Subscription)",
	isSubscription: true,
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		const loginMethod = await callbacks.onSelect({
			message: "Select OpenAI Codex login method:",
			options: [
				{ id: OPENAI_CODEX_BROWSER_LOGIN_METHOD, label: "Browser login (default)" },
				{ id: OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD, label: "Device code login (headless)" },
			],
		});
		if (!loginMethod) {
			throw new Error("Login cancelled");
		}

		if (loginMethod === OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD) {
			return loginOpenAICodexDeviceCode({
				onDeviceCode: callbacks.onDeviceCode,
				signal: callbacks.signal,
			});
		}

		if (loginMethod !== OPENAI_CODEX_BROWSER_LOGIN_METHOD) {
			throw new Error(`Unknown OpenAI Codex login method: ${loginMethod}`);
		}

		return loginOpenAICodex({
			onAuth: callbacks.onAuth,
			onPrompt: callbacks.onPrompt,
			onProgress: callbacks.onProgress,
			onManualCodeInput: callbacks.onManualCodeInput,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshOpenAICodexToken(credentials.refresh, credentials);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},

	getRequestHeaders(credentials: OAuthCredentials): Record<string, string> | undefined {
		return credentials.chatgptAccountIsFedramp === true ? { [OPENAI_CODEX_FEDRAMP_HEADER]: "true" } : undefined;
	},
};
