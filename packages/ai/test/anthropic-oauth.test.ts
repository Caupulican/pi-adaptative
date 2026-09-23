import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicOAuthProvider, loginAnthropic, refreshAnthropicToken } from "../src/utils/oauth/anthropic.ts";

import type { OAuthLoginCallbacks } from "../src/utils/oauth/types.ts";

const nativeFetch = globalThis.fetch;

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	if (input instanceof Request) {
		return input.url;
	}
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function getJsonBody(init?: RequestInit): Record<string, string> {
	if (typeof init?.body !== "string") {
		throw new Error(`Expected string request body, got ${typeof init?.body}`);
	}
	return JSON.parse(init.body) as Record<string, string>;
}

describe("Anthropic OAuth", { concurrent: false }, () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps the localhost redirect_uri for manual callback login", async () => {
		let authUrl = "";
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://platform.claude.com/v1/oauth/token");
			expect(init?.method).toBe("POST");
			const body = getJsonBody(init);
			expect(body.grant_type).toBe("authorization_code");
			expect(body.client_id).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
			expect(body.code).toBe("manual-code");
			expect(body.redirect_uri).toBe("http://localhost:53692/callback");
			return jsonResponse({
				access_token: "access-token",
				refresh_token: "refresh-token",
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await loginAnthropic({
			onAuth: (info) => {
				authUrl = info.url;
				const url = new URL(authUrl);
				expect(`${url.origin}${url.pathname}`).toBe("https://claude.com/cai/oauth/authorize");
				expect(url.searchParams.get("scope")).toBe(
					"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins",
				);
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => {
				const url = new URL(authUrl);
				const state = url.searchParams.get("state");
				const redirectUri = url.searchParams.get("redirect_uri");
				if (!state || !redirectUri) {
					throw new Error("Missing OAuth state or redirect_uri in auth URL");
				}
				return `${redirectUri}?code=manual-code&state=${state}`;
			},
		});

		expect(credentials.access).toBe("access-token");
		expect(credentials.refresh).toBe("refresh-token");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("keeps the PKCE verifier separate from browser-visible state", async () => {
		let authUrl: URL;
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
			const body = getJsonBody(init);
			expect(body.state).toBe(authUrl.searchParams.get("state"));
			expect(body.code_verifier).not.toBe(body.state);
			expect(authUrl.href).not.toContain(body.code_verifier);
			const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.code_verifier));
			expect(authUrl.searchParams.get("code_challenge")).toBe(Buffer.from(digest).toString("base64url"));
			expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
			return jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
		});
		vi.stubGlobal("fetch", fetchMock);
		await loginAnthropic({
			onAuth: ({ url }) => {
				authUrl = new URL(url);
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => `code#${authUrl.searchParams.get("state")}`,
		});
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("rejects mismatched callback state before exchanging tokens", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			loginAnthropic({
				onAuth: () => {},
				onPrompt: async () => "",
				onManualCodeInput: async () => "http://localhost:53692/callback?code=code&state=stale-state",
			}),
		).rejects.toThrow("OAuth state mismatch");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("preserves an unrotated refresh token across successive refreshes", async () => {
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getJsonBody(init).refresh_token).toBe("refresh-token");
			return jsonResponse({ access_token: "new-access-token", expires_in: 3600 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const first = await refreshAnthropicToken("refresh-token");
		expect(first.refresh).toBe("refresh-token");
		expect((await refreshAnthropicToken(first.refresh)).refresh).toBe("refresh-token");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("keeps the callback listener usable after rejecting stale state", async () => {
		let authUrl: URL;
		let callbackRequests: Promise<string> | undefined;
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
			const body = getJsonBody(init);
			expect(body.code).toBe("callback-code");
			expect(body.state).toBe(authUrl.searchParams.get("state"));
			expect(body.code_verifier).not.toBe(body.state);
			return jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const credentials = await loginAnthropic({
			onAuth: ({ url }) => {
				authUrl = new URL(url);
			},
			onPrompt: async () => "",
			onManualCodeInput: () => {
				callbackRequests = (async () => {
					const redirect = new URL(authUrl.searchParams.get("redirect_uri")!);
					redirect.searchParams.set("code", "callback-code");
					redirect.searchParams.set("state", "stale-state");
					const rejected = await nativeFetch(redirect);
					expect(rejected.status).toBe(400);
					await rejected.text();
					expect(fetchMock).not.toHaveBeenCalled();
					redirect.searchParams.set("state", authUrl.searchParams.get("state")!);
					const accepted = await nativeFetch(redirect);
					expect(accepted.status).toBe(200);
					await accepted.text();
					return "";
				})();
				return callbackRequests;
			},
		});
		await callbackRequests;
		expect(credentials.access).toBe("access");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("uses the current native default scopes when stored scope metadata is absent", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://platform.claude.com/v1/oauth/token");
			expect(init?.method).toBe("POST");
			const body = getJsonBody(init);
			expect(body.grant_type).toBe("refresh_token");
			expect(body.client_id).toBeTruthy();
			expect(body.refresh_token).toBe("refresh-token");
			// Claude 2.1.280 refresh sends these inference scopes when stored scope metadata is absent.
			expect(body.scope).toBe(
				"user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins",
			);
			return jsonResponse({
				access_token: "new-access-token",
				refresh_token: "new-refresh-token",
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshAnthropicToken("refresh-token");

		expect(credentials.access).toBe("new-access-token");
		expect(credentials.refresh).toBe("new-refresh-token");
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});

describe("Anthropic OAuth token acceptance", () => {
	it.each([
		{},
		null,
		{ access_token: "", expires_in: 3600 },
		{ access_token: "   ", expires_in: 3600 },
		{ access_token: "secret-fixture", expires_in: 0 },
		{ access_token: "secret-fixture", expires_in: 0.5 },
		{ access_token: "secret-fixture", expires_in: 31_536_001 },
		{ access_token: "secret-fixture", expires_in: -1 },
		{ access_token: "secret-fixture", expires_in: "3600" },
		{ access_token: "secret-fixture", expires_in: 1e308 },
		{ access_token: "secret-fixture", expires_in: 3600, refresh_token: null },
		{ access_token: "secret-fixture", expires_in: 3600, refresh_token: "" },
		{ access_token: "secret-fixture", expires_in: 3600, refresh_token: "   " },
	])("rejects malformed refresh credentials: %j", async (body) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
		await expect(refreshAnthropicToken("retained-refresh")).rejects.toThrow("invalid OAuth credentials");
	});

	it.each([400, 200])("does not disclose response bodies in HTTP %i errors", async (status) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret-response-fixture", { status })));
		const result = refreshAnthropicToken("refresh-fixture");
		await expect(result).rejects.toThrow();
		await expect(result).rejects.not.toThrow("secret-response-fixture");
	});

	it("retains the safe HTTP status when response cleanup rejects with provider text", async () => {
		const body = new ReadableStream({
			cancel() {
				throw new Error("secret-cleanup-fixture");
			},
		});
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 400 })));
		const result = refreshAnthropicToken("refresh-fixture");
		await expect(result).rejects.toThrow("HTTP 400");
		await expect(result).rejects.not.toThrow("secret-cleanup-fixture");
	});

	it("does not disclose fetch error messages or cyclic causes", async () => {
		const failure = new Error("secret-transport-fixture");
		failure.cause = failure;
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
		const result = refreshAnthropicToken("refresh-fixture");
		await expect(result).rejects.toThrow("Anthropic OAuth transport failed");
		await expect(result).rejects.not.toThrow("secret-transport-fixture");
	});

	it("requires a refresh token on initial authorization", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ access_token: "access", expires_in: 3600 })));
		await expect(
			loginAnthropic({ onAuth: () => {}, onPrompt: async () => "", onManualCodeInput: async () => "code" }),
		).rejects.toThrow("invalid OAuth credentials");
	});

	it("accepts an unrotated token with a short positive lifetime without backdating expiry", async () => {
		const before = Date.now();
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ access_token: "access", expires_in: 60 }));
		vi.stubGlobal("fetch", fetchMock);
		const credentials = await refreshAnthropicToken("retained-refresh");
		expect(credentials.access).toBe("access");
		expect(credentials.refresh).toBe("retained-refresh");
		expect(credentials.expires).toBeGreaterThanOrEqual(before);
		expect(fetchMock.mock.calls[0][1].redirect).toBe("error");
	});
});

function callbacks(overrides: Partial<OAuthLoginCallbacks> = {}): OAuthLoginCallbacks {
	return {
		onAuth: vi.fn(),
		onDeviceCode: vi.fn(),
		onSelect: vi.fn(),
		onPrompt: vi.fn().mockResolvedValue("code"),
		onManualCodeInput: vi.fn().mockResolvedValue("code"),
		...overrides,
	};
}

describe("Anthropic OAuth cancellation", () => {
	it("rejects pre-cancelled login before opening authorization or exchanging a code", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }));
		vi.stubGlobal("fetch", fetchMock);
		const options = callbacks({ signal: AbortSignal.abort(new Error("login cancelled")) });
		await expect(anthropicOAuthProvider.login(options)).rejects.toThrow("login cancelled");
		expect(options.onAuth).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("cancels pending manual input and releases the callback port before a late code arrives", async () => {
		const controller = new AbortController();
		const input = Promise.withResolvers<string>();
		const fetchMock = vi
			.fn()
			.mockResolvedValue(Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }));
		vi.stubGlobal("fetch", fetchMock);
		const result = anthropicOAuthProvider.login(
			callbacks({
				signal: controller.signal,
				onManualCodeInput: () => {
					controller.abort(new Error("login cancelled"));
					return input.promise;
				},
			}),
		);
		const settlement = result.then(
			() => "resolved",
			() => "cancelled",
		);
		const observed = await Promise.race([
			settlement,
			new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 100)),
		]);
		input.resolve("late-code");
		await settlement;
		expect(observed).toBe("cancelled");
		expect(fetchMock).not.toHaveBeenCalled();
		// A fresh attempt must be able to acquire the same callback listener.
		await expect(anthropicOAuthProvider.login(callbacks())).resolves.toMatchObject({ access: "access" });
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("threads cancellation into token exchange and rejects a response racing cancellation", async () => {
		const controller = new AbortController();
		let requestSignal: AbortSignal | null | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				requestSignal = init?.signal;
				controller.abort(new Error("login cancelled"));
				return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
			}),
		);
		await expect(anthropicOAuthProvider.login(callbacks({ signal: controller.signal }))).rejects.toThrow(
			"login cancelled",
		);
		expect(requestSignal?.aborted).toBe(true);
	});
});

describe("Claude OAuth callback denial", () => {
	it.each([false, true])("settles a matching denial with parallel manual input=%s", async (manual) => {
		const auth = Promise.withResolvers<URL>();
		const input = Promise.withResolvers<string>();
		const controller = new AbortController();
		const exchange = vi.fn(async () =>
			Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
		);
		vi.stubGlobal("fetch", exchange);
		const prompt = vi.fn(async () => "unexpected-code");
		const result = loginAnthropic({
			onAuth: ({ url }) => auth.resolve(new URL(url)),
			onPrompt: prompt,
			onManualCodeInput: manual ? () => input.promise : undefined,
			signal: controller.signal,
		}).then(
			() => "unexpected success",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		try {
			const authorization = await auth.promise;
			const callback = new URL(authorization.searchParams.get("redirect_uri")!);
			expect(callback.origin).toBe("http://localhost:53692");
			callback.searchParams.set("state", authorization.searchParams.get("state")!);
			callback.searchParams.set("error", "untrusted-error-fixture");
			callback.searchParams.set("error_description", "untrusted-description-fixture");
			const response = await nativeFetch(callback);
			expect(response.status).toBe(400);
			await response.text();
			const observed = await Promise.race([
				result,
				new Promise<string>((resolve) => {
					watchdog = setTimeout(() => resolve("still waiting after denial"), 100);
				}),
			]);
			expect(observed).toBe("Anthropic authentication did not complete.");
			input.resolve("late-code");
			await Promise.resolve();
			expect(exchange).not.toHaveBeenCalled();
			expect(prompt).not.toHaveBeenCalled();
			// Completion must release the callback port, not silently select hosted fallback.
			await expect(
				loginAnthropic({
					onAuth: ({ url }) => {
						expect(new URL(url).searchParams.get("redirect_uri")).toBe("http://localhost:53692/callback");
					},
					onPrompt: async () => "",
					onManualCodeInput: async () => "fresh-code",
				}),
			).resolves.toMatchObject({ access: "access" });
			expect(exchange).toHaveBeenCalledOnce();
		} finally {
			clearTimeout(watchdog);
			controller.abort(new Error("test cleanup"));
			input.resolve("");
			await result;
		}
	});

	it.each(["stale-state", null])("ignores an unauthenticated denial with state=%s", async (state) => {
		const auth = Promise.withResolvers<URL>();
		const controller = new AbortController();
		const exchange = vi.fn(async () =>
			Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
		);
		vi.stubGlobal("fetch", exchange);
		const result = loginAnthropic({
			onAuth: ({ url }) => auth.resolve(new URL(url)),
			onPrompt: async () => "",
			signal: controller.signal,
		});
		const settlement = result.then(
			(credentials) => credentials.access,
			(error: unknown) => error,
		);
		try {
			const authorization = await auth.promise;
			const callback = new URL(authorization.searchParams.get("redirect_uri")!);
			expect(callback.origin).toBe("http://localhost:53692");
			callback.searchParams.set("error", "access_denied");
			if (state !== null) callback.searchParams.set("state", state);
			const rejected = await nativeFetch(callback);
			expect(rejected.status).toBe(400);
			await rejected.text();
			expect(exchange).not.toHaveBeenCalled();
			callback.searchParams.delete("error");
			callback.searchParams.set("state", authorization.searchParams.get("state")!);
			callback.searchParams.set("code", "valid-code");
			const accepted = await nativeFetch(callback);
			expect(accepted.status).toBe(200);
			await accepted.text();
			expect(await settlement).toBe("access");
			expect(exchange).toHaveBeenCalledOnce();
		} finally {
			controller.abort(new Error("test cleanup"));
			await settlement;
		}
	});
});
