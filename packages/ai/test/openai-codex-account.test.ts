import { describe, expect, it, vi } from "vitest";
import {
	consumeOpenAICodexRateLimitResetCredit,
	getOpenAICodexUsage,
	listOpenAICodexAccountModels,
	listOpenAICodexRateLimitResetCredits,
	OPENAI_CODEX_CLIENT_VERSION,
	resolveOpenAICodexAccountEndpoint,
} from "../src/providers/openai-codex-account.ts";

function createAccessToken(accountId = "account-123"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toString("base64url");
	return `header.${payload}.signature`;
}

function unexpectedSuccess(): never {
	throw new Error("expected the request to fail");
}

describe("OpenAI Codex account client", () => {
	it("resolves ChatGPT and Codex API endpoint styles", () => {
		expect(resolveOpenAICodexAccountEndpoint(undefined, "reset-credits")).toBe(
			"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
		);
		expect(resolveOpenAICodexAccountEndpoint("https://chatgpt.com", "consume-reset-credit")).toBe(
			"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
		);
		expect(resolveOpenAICodexAccountEndpoint("https://example.test", "usage")).toBe(
			"https://example.test/api/codex/usage",
		);
		expect(resolveOpenAICodexAccountEndpoint("https://example.test/api/codex/responses", "usage")).toBe(
			"https://example.test/api/codex/usage",
		);
	});

	it("lists the account's models for the Codex client version pi speaks", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			expect(`${url.origin}${url.pathname}`).toBe("https://chatgpt.com/backend-api/codex/models");
			expect(url.searchParams.get("client_version")).toBe(OPENAI_CODEX_CLIENT_VERSION);
			expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("account-123");
			return new Response(
				JSON.stringify({
					models: [
						{
							slug: "gpt-5.6-sol",
							display_name: "GPT-5.6 Sol",
							visibility: "list",
							supported_in_api: true,
							priority: 4,
						},
						{ slug: "codex-auto-review", visibility: "hide", supported_in_api: true, priority: 43 },
					],
				}),
				{ status: 200 },
			);
		});
		await expect(
			listOpenAICodexAccountModels({ accessToken: createAccessToken(), fetch: fetchMock }),
		).resolves.toEqual([
			{ slug: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", visibility: "list", supportedInApi: true, priority: 4 },
			{
				slug: "codex-auto-review",
				displayName: "codex-auto-review",
				visibility: "hide",
				supportedInApi: true,
				priority: 43,
			},
		]);
		await expect(
			listOpenAICodexAccountModels({
				accessToken: createAccessToken(),
				fetch: async () => new Response(JSON.stringify({ detail: "no" }), { status: 200 }),
			}),
		).rejects.toThrow("no models list");
	});

	it("lists detailed reset credits with subscription headers", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			expect(String(input)).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
			expect(init?.method).toBe("GET");
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe(`Bearer ${createAccessToken()}`);
			expect(headers.get("chatgpt-account-id")).toBe("account-123");
			expect(headers.get("originator")).toBe("pi");
			return new Response(
				JSON.stringify({
					credits: [
						{
							id: "credit-1",
							reset_type: "codex_rate_limits",
							status: "available",
							granted_at: "2026-07-01T00:00:00Z",
							expires_at: "2026-08-01T00:00:00Z",
							title: "Full reset",
							description: "Reset weekly and five-hour windows.",
						},
					],
					available_count: 1,
				}),
				{ status: 200 },
			);
		});

		await expect(
			listOpenAICodexRateLimitResetCredits({ accessToken: createAccessToken(), fetch: fetchMock }),
		).resolves.toEqual({
			credits: [
				{
					id: "credit-1",
					resetType: "codex_rate_limits",
					status: "available",
					grantedAt: "2026-07-01T00:00:00Z",
					expiresAt: "2026-08-01T00:00:00Z",
					title: "Full reset",
					description: "Reset weekly and five-hour windows.",
				},
			],
			availableCount: 1,
		});
	});

	it("consumes a selected credit with a stable redemption request id", async () => {
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			expect(init?.method).toBe("POST");
			expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
			expect(JSON.parse(String(init?.body))).toEqual({
				redeem_request_id: "redeem-123",
				credit_id: "credit-1",
			});
			return new Response(JSON.stringify({ code: "reset", windows_reset: 2 }), { status: 200 });
		});

		await expect(
			consumeOpenAICodexRateLimitResetCredit(
				{ accessToken: createAccessToken(), fetch: fetchMock },
				"redeem-123",
				"credit-1",
			),
		).resolves.toEqual({ outcome: "reset", windowsReset: 2 });
	});

	it("surfaces bounded HTTP failures without accepting malformed success payloads", async () => {
		await expect(
			listOpenAICodexRateLimitResetCredits({
				accessToken: createAccessToken(),
				fetch: async () => new Response("account unavailable", { status: 503 }),
			}),
		).rejects.toThrow("OpenAI Codex account request failed (HTTP 503)");

		await expect(
			consumeOpenAICodexRateLimitResetCredit(
				{
					accessToken: createAccessToken(),
					fetch: async () => new Response(JSON.stringify({ code: "unexpected", windows_reset: 0 })),
				},
				"redeem-123",
			),
		).rejects.toThrow("unknown reset outcome");
	});

	it("reads the usage windows and credits with the account headers, read-only", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			expect(String(input)).toBe("https://chatgpt.com/backend-api/wham/usage");
			expect(init?.method).toBe("GET");
			expect(init?.redirect).toBe("error");
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe(`Bearer ${createAccessToken()}`);
			expect(headers.get("chatgpt-account-id")).toBe("account-123");
			expect(headers.get("originator")).toBe("pi");
			return new Response(
				JSON.stringify({
					plan_type: "plus",
					rate_limit: {
						allowed: true,
						limit_reached: false,
						primary_window: {
							used_percent: 42,
							limit_window_seconds: 18000,
							reset_after_seconds: 60,
							reset_at: 1_900_000_000,
						},
						secondary_window: { used_percent: 7, limit_window_seconds: 604800, reset_at: 1_900_500_000 },
					},
					additional_rate_limits: [
						{
							limit_name: "codex-sonic",
							metered_feature: "sonic",
							rate_limit: { primary_window: { used_percent: 3 } },
						},
						{ limit_name: "broken", rate_limit: { primary_window: { used_percent: "3" } } },
					],
					credits: { has_credits: true, unlimited: false, balance: "5.00" },
				}),
			);
		});
		await expect(getOpenAICodexUsage({ accessToken: createAccessToken(), fetch: fetchMock })).resolves.toEqual({
			planType: "plus",
			limits: [
				{
					name: "codex",
					allowed: true,
					limitReached: false,
					primary: { usedPercent: 42, windowSeconds: 18000, resetsAt: 1_900_000_000 },
					secondary: { usedPercent: 7, windowSeconds: 604800, resetsAt: 1_900_500_000 },
				},
				{ name: "codex-sonic", primary: { usedPercent: 3 } },
			],
			credits: { hasCredits: true, unlimited: false, balance: "5.00" },
		});
	});

	it("keeps missing usage fields absent and never turns a no-credit balance into one", async () => {
		const usage = await getOpenAICodexUsage({
			accessToken: createAccessToken(),
			fetch: async () =>
				new Response(
					JSON.stringify({ rate_limit: null, credits: { has_credits: false, unlimited: false, balance: "0" } }),
				),
		});
		expect(usage).toEqual({ limits: [], credits: { hasCredits: false, unlimited: false } });
		await expect(
			getOpenAICodexUsage({ accessToken: createAccessToken(), fetch: async () => new Response("[]") }),
		).rejects.toThrow("OpenAI Codex usage response is not an object");
	});

	it("never carries a failed response body or follows a redirect", async () => {
		const secret = "zq9-unrecognized-secret-7f3a";
		const failure = await getOpenAICodexUsage({
			accessToken: createAccessToken(),
			fetch: async () => new Response(`{"error":"denied","echo":"${secret}"}`, { status: 401 }),
		}).then(unexpectedSuccess, (error: unknown) => error as Error);
		expect(failure.message).toBe("OpenAI Codex account request failed (HTTP 401)");
		expect(failure.message).not.toContain(secret);
		const redirected = await getOpenAICodexUsage({
			accessToken: createAccessToken(),
			fetch: async () => new Response(null, { status: 302, headers: { location: `https://evil.test/${secret}` } }),
		}).then(unexpectedSuccess, (error: unknown) => error as Error);
		expect(redirected.message).toBe("OpenAI Codex account request failed (HTTP 302)");
		expect(redirected.message).not.toContain(secret);
	});

	it("reads the reached reason, the inline reset count and the spend control the Codex CLI reads", async () => {
		const usage = await getOpenAICodexUsage({
			accessToken: createAccessToken(),
			fetch: async () =>
				new Response(
					JSON.stringify({
						plan_type: "pro",
						rate_limit_reached_type: { type: "workspace_owner_credits_depleted" },
						rate_limit_reset_credits: { available_count: 2 },
						spend_control: {
							reached: true,
							individual_limit: {
								source: "workspace",
								limit: "1000",
								used: "250.5",
								remaining: "749.5",
								used_percent: 25,
								remaining_percent: 75,
								reset_after_seconds: 60,
								reset_at: 1_900_000_000,
							},
						},
					}),
				),
		});
		expect(usage).toMatchObject({
			limitReachedType: "workspace_owner_credits_depleted",
			resetCreditsAvailable: 2,
			spendControl: {
				reached: true,
				individualLimit: { usedPercent: 25, used: "250.5", limit: "1000", resetsAt: 1_900_000_000 },
			},
		});
	});

	it("treats an absent or null spend control as none and rejects a malformed one", async () => {
		const read = (body: Record<string, unknown>) =>
			getOpenAICodexUsage({
				accessToken: createAccessToken(),
				fetch: async () => new Response(JSON.stringify(body)),
			});
		expect((await read({ spend_control: null })).spendControl).toBeUndefined();
		expect((await read({ spend_control: { reached: false, individual_limit: null } })).spendControl).toEqual({
			reached: false,
		});
		expect((await read({ rate_limit_reached_type: "rate_limit_reached" })).limitReachedType).toBeUndefined();
		for (const spend_control of [
			{ reached: "yes" },
			{ reached: true, individual_limit: [] },
			{ reached: true, individual_limit: { limit: "\u001b[31m9\u001b[0m", used: "1", remaining_percent: 50 } },
			{ reached: true, individual_limit: { limit: "10", used: "1", remaining_percent: 150 } },
		]) {
			await expect(read({ spend_control }), JSON.stringify(spend_control)).rejects.toThrow("invalid spend_control");
		}
	});

	it("keeps a denial without windows and never passes an unrecognized reason through as text", async () => {
		const usage = await getOpenAICodexUsage({
			accessToken: createAccessToken(),
			fetch: async () =>
				new Response(
					JSON.stringify({
						rate_limit: { allowed: false, limit_reached: true, primary_window: null, secondary_window: null },
						rate_limit_reached_type: { type: "\u001b[31mfree money\u001b[0m" },
					}),
				),
		});
		expect(usage.limits).toEqual([{ name: "codex", allowed: false, limitReached: true }]);
		expect(usage.limitReachedType).toBe("unknown");
		const known = await getOpenAICodexUsage({
			accessToken: createAccessToken(),
			fetch: async () =>
				new Response(JSON.stringify({ rate_limit_reached_type: { type: "workspace_member_usage_limit_reached" } })),
		});
		expect(known.limitReachedType).toBe("workspace_member_usage_limit_reached");
	});
});
