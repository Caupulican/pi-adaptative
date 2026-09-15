import { afterEach, describe, expect, it, vi } from "vitest";
import { loginAnthropic, refreshAnthropicToken } from "../src/utils/oauth/anthropic.ts";

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
					"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
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

	it("omits scope from refresh token requests", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://platform.claude.com/v1/oauth/token");
			expect(init?.method).toBe("POST");
			const body = getJsonBody(init);
			expect(body.grant_type).toBe("refresh_token");
			expect(body.client_id).toBeTruthy();
			expect(body.refresh_token).toBe("refresh-token");
			expect(body).not.toHaveProperty("scope");
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
