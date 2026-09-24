import { afterEach, describe, expect, it, vi } from "vitest";
import { getOpenAICodexUsage } from "../src/providers/openai-codex-account.ts";
import { buildOpenAICodexHeaders } from "../src/providers/openai-codex-auth.ts";
import { loginOpenAICodexDeviceCode, openaiCodexOAuthProvider } from "../src/utils/oauth/openai-codex.ts";
import { OAuthRefreshRejectedError } from "../src/utils/oauth/refresh-rejected-error.ts";

const SECRET = "zq9-token-endpoint-secret-7f3a";

function jwt(payload: Record<string, unknown>): string {
	return `header.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.signature`;
}

function accessToken(accountId = "acct-1"): string {
	return jwt({
		exp: Math.floor(Date.now() / 1000) + 3600,
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	});
}

function idToken(fedramp: boolean): string {
	return jwt({
		"https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_account_is_fedramp: fedramp },
	});
}

function deviceLogin(token: () => Response) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: unknown) => {
			const url = String(input);
			if (url.endsWith("/deviceauth/usercode")) {
				return new Response(JSON.stringify({ device_auth_id: "device", user_code: "CODE-1", interval: 0 }));
			}
			if (url.endsWith("/deviceauth/token")) {
				return new Response(JSON.stringify({ authorization_code: "auth-code", code_verifier: "verifier" }));
			}
			if (url.endsWith("/oauth/token")) return token();
			throw new Error(`unexpected ${url}`);
		}),
	);
	return loginOpenAICodexDeviceCode({ onDeviceCode: () => {} });
}

function refreshWith(response: () => Response, credentials: Record<string, unknown> = {}) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => response()),
	);
	return openaiCodexOAuthProvider.refreshToken({
		access: accessToken(),
		refresh: "refresh-token",
		expires: 0,
		accountId: "acct-1",
		...credentials,
	});
}

async function failure(promise: Promise<unknown>): Promise<Error> {
	return promise.then(
		() => {
			throw new Error("expected a failure");
		},
		(error: unknown) => error as Error,
	);
}

describe("OpenAI Codex token endpoint errors", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("reports an exchange failure by status and code only, never the body", async () => {
		const error = await failure(
			deviceLogin(
				() =>
					new Response(JSON.stringify({ error: { code: "invalid_request", message: SECRET }, code: SECRET }), {
						status: 400,
					}),
			),
		);
		expect(error.message).toBe("OpenAI Codex token exchange failed (HTTP 400, invalid_request)");
		expect(error.message).not.toContain(SECRET);
	});

	it("types a permanent refresh rejection and leaves a transient failure untyped", async () => {
		const cases: Array<[number, Record<string, unknown>, string | undefined]> = [
			[400, { error: "invalid_grant", error_description: SECRET }, "rejected"],
			[401, { error: "unauthorized" }, "rejected"],
			[400, { error: { code: "refresh_token_expired" } }, "expired"],
			[400, { code: "refresh_token_reused" }, "reused"],
			[400, { error: "refresh_token_invalidated" }, "revoked"],
			[500, { error: "server_error", error_description: SECRET }, undefined],
			[400, { error: "invalid_request" }, undefined],
		];
		for (const [status, body, reason] of cases) {
			const error = await failure(refreshWith(() => new Response(JSON.stringify(body), { status })));
			expect(error.message, JSON.stringify(body)).not.toContain(SECRET);
			if (reason) {
				expect(error, JSON.stringify(body)).toBeInstanceOf(OAuthRefreshRejectedError);
				expect((error as OAuthRefreshRejectedError).reason).toBe(reason);
			} else {
				expect(error, JSON.stringify(body)).not.toBeInstanceOf(OAuthRefreshRejectedError);
			}
		}
	});

	it("reports an unparsable token response without quoting it", async () => {
		const error = await failure(refreshWith(() => new Response(`{"access_token":"${SECRET}`)));
		expect(error.message).toBe("OpenAI Codex token refresh response was not valid JSON");
	});

	it("refuses an oversized successful token response before parsing it", async () => {
		const body = JSON.stringify({ access_token: accessToken(), refresh_token: SECRET, pad: "x".repeat(70 * 1024) });
		const error = await failure(refreshWith(() => new Response(body)));
		expect(error.message).toBe("OpenAI Codex token refresh response exceeded the 64 KiB limit");
		const login = await failure(deviceLogin(() => new Response(body)));
		expect(login.message).toBe("OpenAI Codex token exchange response exceeded the 64 KiB limit");
	});

	it("reports a network failure without the underlying error text", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError(`fetch failed https://auth.openai.com/oauth/token?code=${SECRET}`);
			}),
		);
		const refresh = await failure(
			openaiCodexOAuthProvider.refreshToken({ access: accessToken(), refresh: SECRET, expires: 0 }),
		);
		expect(refresh.message).toBe("OpenAI Codex token refresh request failed (network error)");
		const login = await failure(loginOpenAICodexDeviceCode({ onDeviceCode: () => {} }));
		expect(login.message).toBe("OpenAI Codex device code request failed (network error)");
		expect(`${String(refresh.cause)}${String(login.cause)}`).not.toContain(SECRET);
	});
});

describe("OpenAI Codex FedRAMP routing", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("records the id_token FedRAMP claim at login and routes requests with it", async () => {
		const credentials = await deviceLogin(
			() =>
				new Response(
					JSON.stringify({ access_token: accessToken(), refresh_token: "refresh", id_token: idToken(true) }),
				),
		);
		expect(credentials.chatgptAccountIsFedramp).toBe(true);
		expect(openaiCodexOAuthProvider.getRequestHeaders?.(credentials)).toEqual({ "X-OpenAI-Fedramp": "true" });
	});

	it("keeps the claim across a refresh without an id_token, drops it when a new id_token says so, and never invents it", async () => {
		const kept = await refreshWith(
			() => new Response(JSON.stringify({ access_token: accessToken(), refresh_token: "next" })),
			{ chatgptAccountIsFedramp: true },
		);
		expect(kept.chatgptAccountIsFedramp).toBe(true);
		const dropped = await refreshWith(
			() =>
				new Response(
					JSON.stringify({ access_token: accessToken(), refresh_token: "next", id_token: idToken(false) }),
				),
			{ chatgptAccountIsFedramp: true },
		);
		expect(dropped.chatgptAccountIsFedramp).toBeUndefined();
		expect(openaiCodexOAuthProvider.getRequestHeaders?.(dropped)).toBeUndefined();
		const legacy = { access: accessToken(), refresh: "r", expires: Date.now() + 60_000, accountId: "acct-1" };
		expect(openaiCodexOAuthProvider.getRequestHeaders?.(legacy)).toBeUndefined();
	});

	it("requires a well-formed id_token on the login exchange, as the Codex CLI does", async () => {
		const exchanged = (id_token?: unknown) =>
			failure(
				deviceLogin(
					() =>
						new Response(
							JSON.stringify({
								access_token: accessToken(),
								refresh_token: SECRET,
								...(id_token === undefined ? {} : { id_token }),
							}),
						),
				),
			);
		for (const id_token of [undefined, null]) {
			const error = await exchanged(id_token);
			expect(error.message).toBe("OpenAI Codex token exchange response missing fields: id_token");
		}
		for (const id_token of [`header.${SECRET}.signature`, SECRET, 42]) {
			const error = await exchanged(id_token);
			expect(error.message).toBe("OpenAI Codex token exchange response has a malformed id_token");
			expect(error.message).not.toContain(SECRET);
		}
	});

	it("rejects a supplied malformed id_token structurally, and keeps the flag only when it is absent", async () => {
		const malformed = [
			`${SECRET}`,
			`header.${SECRET}.signature`,
			jwt({ "https://api.openai.com/auth": { chatgpt_account_is_fedramp: SECRET } }),
			jwt({ "https://api.openai.com/auth": SECRET }),
			42,
		];
		for (const id_token of malformed) {
			const error = await failure(
				refreshWith(
					() => new Response(JSON.stringify({ access_token: accessToken(), refresh_token: "next", id_token })),
					{ chatgptAccountIsFedramp: true },
				),
			);
			expect(error.message).toBe("OpenAI Codex token refresh response has a malformed id_token");
		}
		const absent = await refreshWith(
			() => new Response(JSON.stringify({ access_token: accessToken(), refresh_token: "next", id_token: null })),
			{ chatgptAccountIsFedramp: true },
		);
		expect(absent.chatgptAccountIsFedramp).toBe(true);
		const noClaim = await refreshWith(
			() => new Response(JSON.stringify({ access_token: accessToken(), refresh_token: "next", id_token: jwt({}) })),
			{ chatgptAccountIsFedramp: true },
		);
		expect(noClaim.chatgptAccountIsFedramp).toBeUndefined();
		const otherAccount = await refreshWith(
			() => new Response(JSON.stringify({ access_token: accessToken("acct-2"), refresh_token: "next" })),
			{ chatgptAccountIsFedramp: true },
		);
		expect(otherAccount.chatgptAccountIsFedramp).toBeUndefined();
	});

	it("sends the routing header on account requests only for a FedRAMP account", async () => {
		const credentialHeaders = { "X-OpenAI-Fedramp": "true" };
		expect(buildOpenAICodexHeaders({ token: accessToken(), credentialHeaders }).get("X-OpenAI-Fedramp")).toBe("true");
		expect(buildOpenAICodexHeaders({ token: accessToken() }).get("X-OpenAI-Fedramp")).toBeNull();
		expect(
			buildOpenAICodexHeaders({
				token: accessToken(),
				initial: { "x-openai-fedramp": "true" },
				additional: { "X-OpenAI-Fedramp": "true" },
			}).get("X-OpenAI-Fedramp"),
		).toBeNull();
		const seen: Array<string | null> = [];
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			seen.push(new Headers(init?.headers).get("X-OpenAI-Fedramp"));
			return new Response(JSON.stringify({ plan_type: "enterprise" }));
		});
		await getOpenAICodexUsage({ accessToken: accessToken(), fetch: fetchMock, credentialHeaders });
		await getOpenAICodexUsage({ accessToken: accessToken(), fetch: fetchMock });
		expect(seen).toEqual(["true", null]);
	});

	it("reads the account id the Codex CLI reads from the access token, unchanged", () => {
		const headers = buildOpenAICodexHeaders({ token: accessToken("acct-from-access") });
		expect(headers.get("chatgpt-account-id")).toBe("acct-from-access");
	});
});
