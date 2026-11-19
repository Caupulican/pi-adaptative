/**
 * Anthropic OAuth flow (Claude Pro/Max)
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback server.
 * It is only intended for CLI use, not browser environments.
 */

import { readBoundedResponseText } from "../../providers/account-request.ts";
import type { AnthropicOAuthProtocol } from "../../providers/anthropic-compatibility-profile.ts";
import { resolveAnthropicCompatibility } from "../../providers/anthropic-identity.ts";
import { isRecord } from "../value-guards.ts";
import { startAnthropicCallback } from "./anthropic-callback.ts";
import { awaitAuthorizationInput } from "./authorization-input.ts";
import { base64urlEncode, generatePKCE } from "./pkce.ts";
import { OAuthRefreshRejectedError, type OAuthRefreshRejection } from "./refresh-rejected-error.ts";
import { createOAuthRequestSignal } from "./request-signal.ts";
import { parseOAuthTokenCredentials } from "./token-credentials.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;

class AnthropicOAuthRequestError extends Error {
	readonly invalidScope: boolean;
	readonly refreshRejection?: OAuthRefreshRejection;
	constructor(status: number, invalidScope: boolean, refreshRejection?: OAuthRefreshRejection, bodyTimedOut = false) {
		super(`Anthropic OAuth request failed (HTTP ${status})${bodyTimedOut ? "; response body timed out" : ""}`);
		this.invalidScope = invalidScope;
		this.refreshRejection = refreshRejection;
	}
}

function isValidAnthropicAccountId(value: unknown): value is string {
	return typeof value === "string" && value.length <= 256 && /^[\x21-\x7e]+$/.test(value);
}

function parseAnthropicCredentials(
	data: unknown,
	previousRefresh?: string,
	previousAccountId?: string,
	fallbackScopes?: readonly string[],
): OAuthCredentials {
	const credentials = parseOAuthTokenCredentials(data, "Anthropic", 5 * 60, previousRefresh);
	const response = data as Record<string, unknown>;
	const scope = response.scope;
	const parsedScopes = typeof scope === "string" ? scope.split(" ").filter(Boolean) : [];
	const account = response.account;
	const responseAccountId = isRecord(account) ? account.uuid : undefined;
	const accountId = isValidAnthropicAccountId(responseAccountId) ? responseAccountId : previousAccountId;
	return {
		...credentials,
		scopes: parsedScopes.length > 0 ? parsedScopes : fallbackScopes ? [...fallbackScopes] : [],
		...(accountId ? { accountId } : {}),
	};
}

function classifyAnthropicRefreshRejection(
	status: number,
	code: string | undefined,
	description: string | undefined,
): OAuthRefreshRejection | undefined {
	if (
		(status === 400 || status === 401 || status === 403) &&
		(code === "invalid_grant" || code === "access_denied") &&
		description === "account_on_hold"
	)
		return "rejected";
	if ((status !== 400 && status !== 401) || code !== "invalid_grant") return undefined;
	if (description === "Refresh token expired") return "expired";
	if (description === "Refresh token not found or invalid") return "revoked";
	return "rejected";
}
function formatErrorDetails(error: unknown): string {
	if (error instanceof Error) {
		const details: string[] = [`${error.name}: ${error.message}`];
		const errorWithCode = error as Error & { code?: string; errno?: number | string; cause?: unknown };
		if (errorWithCode.code) details.push(`code=${errorWithCode.code}`);
		if (typeof errorWithCode.errno !== "undefined") details.push(`errno=${String(errorWithCode.errno)}`);
		if (typeof error.cause !== "undefined") {
			details.push(`cause=${formatErrorDetails(error.cause)}`);
		}
		if (error.stack) {
			details.push(`stack=${error.stack}`);
		}
		return details.join("; ");
	}
	return String(error);
}

async function postJson(
	url: string,
	body: Record<string, string | number>,
	signal?: AbortSignal,
	inspectRefreshError = false,
): Promise<unknown> {
	const requestSignal = createOAuthRequestSignal(signal);
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(body),
			redirect: "error",
			signal: requestSignal,
		});
	} catch {
		signal?.throwIfAborted();
		throw new Error(requestSignal.aborted ? "Anthropic OAuth request timed out" : "Anthropic OAuth transport failed");
	}
	signal?.throwIfAborted();
	if (!response.ok) {
		let invalidScope = false;
		let refreshRejection: OAuthRefreshRejection | undefined;
		let bodyTimedOut = false;
		if (inspectRefreshError && (response.status === 400 || response.status === 401 || response.status === 403)) {
			try {
				const raw = await readBoundedResponseText(response, MAX_OAUTH_RESPONSE_BYTES);
				const data: unknown = raw === undefined ? undefined : JSON.parse(raw);
				if (isRecord(data)) {
					const error = data.error;
					const code =
						typeof error === "string"
							? error
							: isRecord(error) && typeof error.type === "string"
								? error.type
								: undefined;
					const description = typeof data.error_description === "string" ? data.error_description : undefined;
					invalidScope = response.status === 400 && code === "invalid_scope";
					refreshRejection = classifyAnthropicRefreshRejection(response.status, code, description);
				}
			} catch {
				// Unparseable response bodies never authorize scope fallback or terminal rejection caching.
			}
			if (requestSignal.aborted) {
				invalidScope = false;
				refreshRejection = undefined;
				bodyTimedOut = true;
			}
		}
		try {
			await response.body?.cancel();
		} catch {
			// Cleanup must not replace the HTTP status with untrusted transport diagnostics.
		}
		signal?.throwIfAborted();
		throw new AnthropicOAuthRequestError(response.status, invalidScope, refreshRejection, bodyTimedOut);
	}
	let raw: string | undefined;
	try {
		raw = await readBoundedResponseText(response, MAX_OAUTH_RESPONSE_BYTES);
	} catch {
		signal?.throwIfAborted();
		throw new Error(
			requestSignal.aborted ? "Anthropic OAuth request timed out" : "Anthropic OAuth response read failed",
		);
	}
	signal?.throwIfAborted();
	if (requestSignal.aborted) throw new Error("Anthropic OAuth request timed out");
	if (raw === undefined) throw new Error("Anthropic OAuth response exceeded the 64 KiB limit");
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		throw new Error("Anthropic OAuth returned invalid JSON");
	}
}

async function exchangeAuthorizationCode(
	protocol: AnthropicOAuthProtocol,
	code: string,
	state: string,
	verifier: string,
	redirectUri: string,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	let tokenData: unknown;
	try {
		tokenData = await postJson(
			protocol.tokenUrl,
			{
				grant_type: "authorization_code",
				client_id: protocol.clientId,
				code,
				state,
				redirect_uri: redirectUri,
				code_verifier: verifier,
			},
			signal,
		);
	} catch (error) {
		signal?.throwIfAborted();
		throw new Error(
			`Token exchange request failed. url=${protocol.tokenUrl}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${formatErrorDetails(error)}`,
		);
	}

	return parseAnthropicCredentials(tokenData);
}

/** The hosted redirect shows one code#state pair. A bad paste leaves the browser listener available. */
async function readManualCode(
	options: Pick<OAuthLoginCallbacks, "onPrompt" | "onManualCodeInput">,
	expectedState: string,
	signal: AbortSignal,
): Promise<string> {
	let message = "Paste the full authorization code, including the #.";
	let read = options.onManualCodeInput ?? (() => options.onPrompt({ message }));
	while (true) {
		const input = (await awaitAuthorizationInput(read, signal)).trim();
		const match = /^([^#\s]+)#([^#\s]+)$/.exec(input);
		if (match && !input.includes("://")) {
			if (match[2] !== expectedState) throw new Error("OAuth state mismatch");
			return match[1]!;
		}
		message = "Open the manual sign-in link and paste the full code shown on its last page, including the #.";
		read = () => options.onPrompt({ message });
	}
}

/**
 * Login with Anthropic OAuth (authorization code + PKCE)
 */
export async function loginAnthropic(
	options: Pick<OAuthLoginCallbacks, "onAuth" | "onPrompt" | "onProgress" | "onManualCodeInput" | "signal">,
): Promise<OAuthCredentials> {
	options.signal?.throwIfAborted();
	const compatibility = await awaitAuthorizationInput(resolveAnthropicCompatibility, options.signal);
	if (compatibility.warning) options.onProgress?.(compatibility.warning);
	const protocol = compatibility.oauth;
	const { verifier, challenge } = await generatePKCE();
	options.signal?.throwIfAborted();
	const expectedState = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
	const listener = await startAnthropicCallback(expectedState).catch((error: unknown) => {
		options.signal?.throwIfAborted();
		if (!isRecord(error) || typeof error.code !== "string" || error.code === "EMFILE" || error.code === "ENFILE")
			throw error;
		options.onProgress?.("Local callback unavailable. Continuing with manual authorization.");
		return undefined;
	});

	const inputLifetime = new AbortController();
	const inputSignal = options.signal ? AbortSignal.any([options.signal, inputLifetime.signal]) : inputLifetime.signal;
	let browserSucceeded = false;
	try {
		inputSignal.throwIfAborted();
		const params = new URLSearchParams({
			code: "true",
			client_id: protocol.clientId,
			response_type: "code",
			redirect_uri: protocol.manualRedirectUri,
			scope: protocol.loginScopes.join(" "),
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: expectedState,
		});
		const manualUrl = `${protocol.authorizeUrl}?${params}`;
		if (listener) params.set("redirect_uri", listener.redirectUri);
		options.onAuth({
			url: `${protocol.authorizeUrl}?${params}`,
			manualUrl: listener && options.onManualCodeInput ? manualUrl : undefined,
			instructions: listener
				? options.onManualCodeInput
					? "To sign in on another machine, open the manual sign-in link and paste the full code it shows, including the #."
					: "Complete sign-in in a browser on this machine."
				: "Complete sign-in in your browser and paste the full code, including the #.",
		});

		const authorization = await awaitAuthorizationInput(() => {
			const manual = () =>
				readManualCode(options, expectedState, inputSignal).then((code) => ({
					code,
					redirectUri: protocol.manualRedirectUri,
				}));
			if (!listener) return manual();
			const browser = listener.waitForCode().then((code) => ({ code, redirectUri: listener.redirectUri }));
			return options.onManualCodeInput ? Promise.race([browser, manual()]) : browser;
		}, inputSignal);
		inputLifetime.abort();
		if (authorization.redirectUri === protocol.manualRedirectUri) listener?.finish(false);

		options.onProgress?.("Exchanging authorization code for tokens...");
		const credentials = await exchangeAuthorizationCode(
			protocol,
			authorization.code,
			expectedState,
			verifier,
			authorization.redirectUri,
			options.signal,
		);
		options.signal?.throwIfAborted();
		browserSucceeded = authorization.redirectUri === listener?.redirectUri;
		return credentials;
	} finally {
		inputLifetime.abort();
		listener?.finish(browserSucceeded);
	}
}

/**
 * Refresh Anthropic OAuth token
 */
export async function refreshAnthropicToken(
	refreshToken: string,
	options: {
		scopes?: unknown;
		clientId?: unknown;
		accountId?: unknown;
		subscriptionType?: unknown;
		signal?: AbortSignal;
		onProgress?: (message: string) => void;
	} = {},
): Promise<OAuthCredentials> {
	options.signal?.throwIfAborted();
	if (
		options.scopes !== undefined &&
		(!Array.isArray(options.scopes) ||
			!options.scopes.every(
				(scope): scope is string => typeof scope === "string" && scope.length > 0 && !/\s/.test(scope),
			))
	) {
		throw new Error("Anthropic stored OAuth scopes are invalid");
	}
	if (options.clientId !== undefined && (typeof options.clientId !== "string" || !options.clientId.trim())) {
		throw new Error("Anthropic stored OAuth client identity is invalid");
	}
	if (options.accountId !== undefined && !isValidAnthropicAccountId(options.accountId)) {
		throw new Error("Anthropic stored OAuth account identity is invalid");
	}
	const compatibility = await awaitAuthorizationInput(resolveAnthropicCompatibility, options.signal);
	if (compatibility.warning) options.onProgress?.(compatibility.warning);
	const protocol = compatibility.oauth;
	const originalScopes: string[] = options.scopes === undefined ? [] : [...options.scopes];
	const clientId = options.clientId;
	const hasInference = originalScopes.includes("user:inference");
	const migrate =
		!clientId && (hasInference || (typeof options.subscriptionType === "string" && !!options.subscriptionType));
	const scopes = migrate
		? [
				...protocol.inferenceScopes,
				...originalScopes.filter(
					(scope) =>
						scope === "user:projects:read" ||
						scope === "user:projects:write" ||
						scope === "user:privacy_consents:write",
				),
			]
		: originalScopes.length
			? originalScopes
			: protocol.inferenceScopes;
	const requestedScopes = [...new Set(scopes)];
	const fallbackScopes = [...new Set(originalScopes)];
	const requestedScope = requestedScopes.join(" ");
	const fallbackScope = fallbackScopes.join(" ");
	const sameScopeSet =
		fallbackScopes.length === requestedScopes.length &&
		fallbackScopes.every((scope) => requestedScopes.includes(scope));
	const body = {
		grant_type: "refresh_token",
		client_id: clientId ?? protocol.clientId,
		refresh_token: refreshToken,
		scope: requestedScope,
	};
	let data: unknown;
	let effectiveFallbackScopes: readonly string[] = requestedScopes;
	try {
		try {
			data = await postJson(protocol.tokenUrl, body, options.signal, true);
		} catch (error) {
			if (
				!migrate ||
				!hasInference ||
				!fallbackScope ||
				sameScopeSet ||
				!(error instanceof AnthropicOAuthRequestError) ||
				!error.invalidScope
			)
				throw error;
			effectiveFallbackScopes = fallbackScopes;
			data = await postJson(protocol.tokenUrl, { ...body, scope: fallbackScope }, options.signal, true);
		}
	} catch (error) {
		options.signal?.throwIfAborted();
		if (error instanceof AnthropicOAuthRequestError && error.refreshRejection) {
			throw new OAuthRefreshRejectedError(
				"anthropic",
				error.refreshRejection,
				`Anthropic token refresh was rejected. url=${protocol.tokenUrl}; details=${formatErrorDetails(error)}`,
			);
		}
		throw new Error(
			`Anthropic token refresh request failed. url=${protocol.tokenUrl}; details=${formatErrorDetails(error)}`,
			{ cause: error },
		);
	}

	return {
		...parseAnthropicCredentials(
			data,
			refreshToken,
			typeof options.accountId === "string" ? options.accountId : undefined,
			effectiveFallbackScopes,
		),
		...(clientId ? { clientId } : {}),
		...(typeof options.subscriptionType === "string" ? { subscriptionType: options.subscriptionType } : {}),
	};
}

export const anthropicOAuthProvider: OAuthProviderInterface = {
	id: "anthropic",
	name: "Anthropic (Claude Pro/Max)",
	isSubscription: true,
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginAnthropic({
			onAuth: callbacks.onAuth,
			onPrompt: callbacks.onPrompt,
			onProgress: callbacks.onProgress,
			onManualCodeInput: callbacks.onManualCodeInput,
			signal: callbacks.signal,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshAnthropicToken(credentials.refresh, {
			scopes: credentials.scopes,
			clientId: credentials.clientId,
			accountId: credentials.accountId,
			subscriptionType: credentials.subscriptionType,
		});
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
