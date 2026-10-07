/**
 * Anthropic OAuth flow (Claude Pro/Max)
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback server.
 * It is only intended for CLI use, not browser environments.
 */

import type { createServer, Server } from "node:http";
import { readBoundedResponseText } from "../../providers/account-request.ts";
import type { AnthropicOAuthProtocol } from "../../providers/anthropic-compatibility-profile.ts";
import { resolveAnthropicCompatibility } from "../../providers/anthropic-identity.ts";
import { isRecord } from "../value-guards.ts";
import { awaitAuthorizationInput, parseAuthorizationInput, raceAuthorizationInput } from "./authorization-input.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";
import { createOAuthRequestSignal } from "./request-signal.ts";
import { parseOAuthTokenCredentials } from "./token-credentials.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthPrompt, OAuthProviderInterface } from "./types.ts";

type CallbackServerInfo = {
	server: Server;
	redirectUri: string;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string; state: string } | null>;
};

type NodeApis = {
	createServer: typeof createServer;
};

let nodeApis: NodeApis | null = null;
let nodeApisPromise: Promise<NodeApis> | null = null;

const CALLBACK_PORT = 53692;
const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

class AnthropicOAuthRequestError extends Error {
	readonly invalidScope: boolean;
	constructor(status: number, invalidScope: boolean, bodyTimedOut = false) {
		super(`Anthropic OAuth request failed (HTTP ${status})${bodyTimedOut ? "; response body timed out" : ""}`);
		this.invalidScope = invalidScope;
	}
}

function parseAnthropicCredentials(data: unknown, previousRefresh?: string): OAuthCredentials {
	const credentials = parseOAuthTokenCredentials(data, "Anthropic", 5 * 60, previousRefresh);
	const scope = (data as Record<string, unknown>).scope;
	return { ...credentials, scopes: typeof scope === "string" ? scope.split(" ").filter(Boolean) : [] };
}
async function getNodeApis(): Promise<NodeApis> {
	if (nodeApis) return nodeApis;
	if (!nodeApisPromise) {
		if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
			throw new Error("Anthropic OAuth is only available in Node.js environments");
		}
		nodeApisPromise = import("node:http").then((httpModule) => ({
			createServer: httpModule.createServer,
		}));
	}
	nodeApis = await nodeApisPromise;
	return nodeApis;
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

async function startCallbackServer(expectedState: string): Promise<CallbackServerInfo> {
	const { createServer } = await getNodeApis();
	const callbackHost = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";

	return new Promise((resolve, reject) => {
		let settleWait: ((value: { code: string; state: string } | Error | null) => void) | undefined;
		const waitForCodePromise = new Promise<{ code: string; state: string } | Error | null>((resolveWait) => {
			let settled = false;
			settleWait = (value) => {
				if (settled) return;
				settled = true;
				resolveWait(value);
			};
		});

		const server = createServer((req, res) => {
			try {
				const url = new URL(req.url || "", "http://localhost");
				if (url.pathname !== CALLBACK_PATH) {
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Callback route not found."));
					return;
				}

				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");

				if (state !== expectedState) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("State mismatch."));
					return;
				}

				if (error) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Anthropic authentication did not complete."));
					settleWait?.(new Error("Anthropic authentication did not complete."));
					return;
				}

				if (!code) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Missing code or state parameter."));
					return;
				}

				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthSuccessHtml("Anthropic authentication completed. You can close this window."));
				settleWait?.({ code, state });
			} catch {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Internal error");
			}
		});

		server.on("error", (err) => {
			// The startup promise is already settled after listen; terminal errors must also
			// reach the authorization waiter, which retains them as values until it attaches.
			settleWait?.(err);
			reject(err);
		});
		server.on("close", () => {
			const error = new Error("Anthropic OAuth callback server closed before authorization completed");
			settleWait?.(error);
			reject(error);
		});

		server.listen(CALLBACK_PORT, callbackHost, () => {
			resolve({
				server,
				redirectUri: REDIRECT_URI,
				cancelWait: () => {
					settleWait?.(null);
				},
				waitForCode: async () => {
					// Store a terminal error as a value until the login consumer attaches.
					const result = await waitForCodePromise;
					if (result instanceof Error) throw result;
					return result;
				},
			});
		});
	});
}

async function postJson(
	url: string,
	body: Record<string, string | number>,
	signal?: AbortSignal,
	inspectScopeError = false,
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
		let bodyTimedOut = false;
		if (inspectScopeError && response.status === 400) {
			try {
				const raw = await readBoundedResponseText(response, MAX_OAUTH_RESPONSE_BYTES);
				const data: unknown = raw === undefined ? undefined : JSON.parse(raw);
				if (isRecord(data)) {
					const error = data.error;
					invalidScope = error === "invalid_scope" || (isRecord(error) && error.type === "invalid_scope");
				}
			} catch {
				// Unparseable response bodies never authorize the scope fallback.
			}
			if (requestSignal.aborted) {
				invalidScope = false;
				bodyTimedOut = true;
			}
		}
		try {
			await response.body?.cancel();
		} catch {
			// Cleanup must not replace the HTTP status with untrusted transport diagnostics.
		}
		signal?.throwIfAborted();
		throw new AnthropicOAuthRequestError(response.status, invalidScope, bodyTimedOut);
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

/**
 * Login with Anthropic OAuth (authorization code + PKCE)
 */
export async function loginAnthropic(options: {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	options.signal?.throwIfAborted();
	const compatibility = await awaitAuthorizationInput(resolveAnthropicCompatibility, options.signal);
	if (compatibility.warning) options.onProgress?.(compatibility.warning);
	const protocol = compatibility.oauth;
	const { verifier, challenge } = await generatePKCE();
	options.signal?.throwIfAborted();
	const expectedState = crypto.randomUUID();
	const server = await startCallbackServer(expectedState).catch((error: unknown) => {
		options.signal?.throwIfAborted();
		if (
			typeof error !== "object" ||
			error === null ||
			!("code" in error) ||
			(error.code !== "EADDRINUSE" && error.code !== "EACCES")
		) {
			throw error;
		}
		options.onProgress?.("Local callback unavailable. Continuing with manual authorization.");
		return undefined;
	});

	let code: string | undefined;
	let state: string | undefined;
	const redirectUriForExchange = server?.redirectUri ?? protocol.manualRedirectUri;

	try {
		options.signal?.throwIfAborted();
		const authParams = new URLSearchParams({
			code: "true",
			client_id: protocol.clientId,
			response_type: "code",
			redirect_uri: redirectUriForExchange,
			scope: ["org:create_api_key", ...protocol.inferenceScopes].join(" "),
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: expectedState,
		});

		options.onAuth({
			url: `${protocol.authorizeUrl}?${authParams.toString()}`,
			instructions:
				"Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		const manualInput = options.onManualCodeInput;
		if (server && manualInput) {
			const authorization = await awaitAuthorizationInput(
				() =>
					raceAuthorizationInput({
						manualInput,
						waitForCallback: server.waitForCode,
						cancelWait: server.cancelWait,
						expectedState,
						stateMismatchMessage: "OAuth state mismatch",
					}),
				options.signal,
			);
			if (authorization) {
				code = authorization.code;
				state = authorization.state ?? expectedState;
			}
		} else if (server) {
			const result = await awaitAuthorizationInput(server.waitForCode, options.signal);
			if (result?.code) {
				code = result.code;
				state = result.state;
			}
		}

		if (!code) {
			const input = await awaitAuthorizationInput(
				!server && manualInput
					? manualInput
					: () =>
							options.onPrompt({
								message: "Paste the authorization code or full redirect URL:",
								placeholder: redirectUriForExchange,
							}),
				options.signal,
			);
			const parsed = parseAuthorizationInput(input);
			if (parsed.state && parsed.state !== expectedState) {
				throw new Error("OAuth state mismatch");
			}
			code = parsed.code;
			state = parsed.state ?? expectedState;
		}

		if (!code) {
			throw new Error("Missing authorization code");
		}

		if (!state) {
			throw new Error("Missing OAuth state");
		}

		options.onProgress?.("Exchanging authorization code for tokens...");
		return await exchangeAuthorizationCode(protocol, code, state, verifier, redirectUriForExchange, options.signal);
	} finally {
		server?.cancelWait();
		server?.server.close();
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
						scope === "user:design:read" ||
						scope === "user:design:write",
				),
			]
		: originalScopes.length
			? originalScopes
			: protocol.inferenceScopes;
	const body = {
		grant_type: "refresh_token",
		client_id: clientId ?? protocol.clientId,
		refresh_token: refreshToken,
		scope: [...new Set(scopes)].join(" "),
	};
	let data: unknown;
	try {
		try {
			data = await postJson(protocol.tokenUrl, body, options.signal, migrate && hasInference);
		} catch (error) {
			if (!migrate || !hasInference || !(error instanceof AnthropicOAuthRequestError) || !error.invalidScope)
				throw error;
			data = await postJson(protocol.tokenUrl, { ...body, scope: originalScopes.join(" ") }, options.signal);
		}
	} catch (error) {
		options.signal?.throwIfAborted();
		throw new Error(
			`Anthropic token refresh request failed. url=${protocol.tokenUrl}; details=${formatErrorDetails(error)}`,
		);
	}

	return {
		...parseAnthropicCredentials(data, refreshToken),
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
			subscriptionType: credentials.subscriptionType,
		});
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
