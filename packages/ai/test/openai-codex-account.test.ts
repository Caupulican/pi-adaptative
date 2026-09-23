import { describe, expect, it, vi } from "vitest";
import {
	consumeOpenAICodexRateLimitResetCredit,
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
		).rejects.toThrow("OpenAI Codex account request failed (503): account unavailable");

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
});
