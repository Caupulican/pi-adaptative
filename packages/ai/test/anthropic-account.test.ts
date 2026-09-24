import { describe, expect, it, vi } from "vitest";
import {
	ANTHROPIC_OAUTH_USAGE_URL,
	ANTHROPIC_OAUTH_USAGE_USER_AGENT,
	AnthropicAccountError,
	getAnthropicOAuthUsage,
} from "../src/providers/anthropic-account.ts";

const TOKEN = "oauth-access-fixture";
const mockIdentity = vi.hoisted(() => ({
	version: "7.8.9",
	messagesUserAgent: "claude-cli/7.8.9 (external, cli)",
	usageUserAgent: "claude-code/7.8.9",
}));

vi.mock("../src/providers/anthropic-client-config.generated.ts", () => ({ ANTHROPIC_CLIENT_CONFIG: mockIdentity }));

function unexpectedSuccess(): never {
	throw new Error("expected the request to fail");
}

describe("Anthropic OAuth account usage client", () => {
	it("sends the verified read-only request and parses the verified windows", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			expect(String(input)).toBe(ANTHROPIC_OAUTH_USAGE_URL);
			expect(init?.method).toBe("GET");
			expect(init?.redirect).toBe("error");
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
			expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
			expect(headers.get("user-agent")).toBe(ANTHROPIC_OAUTH_USAGE_USER_AGENT);
			expect(headers.get("user-agent")).toBe(mockIdentity.usageUserAgent);
			return new Response(
				JSON.stringify({
					five_hour: { utilization: 17, resets_at: "2026-09-24T20:00:00Z" },
					seven_day: { utilization: 5, resets_at: "2026-09-29T12:00:00Z", locked_reason: null },
					seven_day_opus: null,
					seven_day_sonnet: null,
					seven_day_oauth_apps: null,
					extra_usage: { is_enabled: false, used_credits: null, monthly_limit: null, currency: null },
					spend: { used: 1, limit: 2, percent: 50, balance: 1, enabled: true },
				}),
			);
		});
		await expect(getAnthropicOAuthUsage({ accessToken: TOKEN, fetch: fetchMock })).resolves.toEqual({
			windows: [
				{ name: "five_hour", usedPercent: 17, resetsAt: Date.parse("2026-09-24T20:00:00Z") },
				{ name: "seven_day", usedPercent: 5, resetsAt: Date.parse("2026-09-29T12:00:00Z") },
			],
			extraUsage: { enabled: false },
		});
	});

	it("rejects malformed windows instead of guessing", async () => {
		for (const body of [
			{ five_hour: { utilization: "17" } },
			{ five_hour: { utilization: 17, resets_at: "soon" } },
			{ five_hour: [] },
			[],
		]) {
			await expect(
				getAnthropicOAuthUsage({ accessToken: TOKEN, fetch: async () => new Response(JSON.stringify(body)) }),
				JSON.stringify(body),
			).rejects.toBeInstanceOf(AnthropicAccountError);
		}
	});

	it("keeps failures structural and refuses redirects and header-unsafe tokens", async () => {
		const secret = "zq9-unrecognized-secret-7f3a";
		const failure = await getAnthropicOAuthUsage({
			accessToken: TOKEN,
			fetch: async () => new Response(`denied ${secret}`, { status: 403 }),
		}).then(unexpectedSuccess, (error: unknown) => error as AnthropicAccountError);
		expect(failure.message).toBe("Anthropic account request failed (HTTP 403)");
		expect(failure.status).toBe(403);
		expect(failure.message).not.toContain(secret);
		const fetchMock = vi.fn();
		await expect(getAnthropicOAuthUsage({ accessToken: "bad token\n", fetch: fetchMock })).rejects.toThrow(
			"not a valid header value",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reads enabled extra usage amounts only when they are valid, and nothing from spend", async () => {
		const read = (extra_usage: unknown) =>
			getAnthropicOAuthUsage({
				accessToken: TOKEN,
				fetch: async () =>
					new Response(JSON.stringify({ extra_usage, spend: { balance: 99, enabled: true, limit: 100 } })),
			});
		await expect(read({ is_enabled: true, used_credits: 12.3, monthly_limit: 50, currency: "usd" })).resolves.toEqual(
			{
				windows: [],
				extraUsage: { enabled: true, usedCredits: 12.3, monthlyLimit: 50, currency: "USD" },
			},
		);
		await expect(
			read({ is_enabled: true, used_credits: null, monthly_limit: null, currency: null }),
		).resolves.toEqual({
			windows: [],
			extraUsage: { enabled: true },
		});
		await expect(read({ is_enabled: false, used_credits: 5, monthly_limit: 10 })).resolves.toEqual({
			windows: [],
			extraUsage: { enabled: false },
		});
		await expect(read({ is_enabled: true, used_credits: "12" })).rejects.toBeInstanceOf(AnthropicAccountError);
		await expect(read({ is_enabled: "yes" })).rejects.toBeInstanceOf(AnthropicAccountError);
	});
});
