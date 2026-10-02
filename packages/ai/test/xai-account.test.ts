import { describe, expect, it, vi } from "vitest";
import { MAX_ACCOUNT_RESPONSE_BYTES } from "../src/providers/account-request.ts";
import { getXaiAccountUsage, XaiAccountError } from "../src/providers/xai-account.ts";
import { XAI_CLIENT_CONFIG } from "../src/providers/xai-client-config.generated.ts";

const TOKEN = "oauth-fixture";
const BILLING = {
	config: {
		creditUsagePercent: 37.5,
		currentPeriod: { start: "2026-10-01T00:00:00Z", end: "2026-10-08T00:00:00Z", type: "WEEKLY" },
		monthlyLimit: { val: 2500 },
		onDemandCap: { val: 1000 },
		onDemandUsed: { val: 123 },
		prepaidBalance: { val: -45 },
	},
	on_demand_enabled: true,
};

describe("Grok account billing", () => {
	it("uses the subscription billing route and client identity", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			expect(String(input)).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
			expect(init?.method).toBe("GET");
			expect(init?.redirect).toBe("error");
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
			expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
			expect(headers.get("x-grok-client-version")).toBe(XAI_CLIENT_CONFIG.version);
			expect(headers.get("x-grok-client-mode")).toBe("interactive");
			expect(headers.get("x-userid")).toBe("user-fixture");
			for (const name of [
				"x-email",
				"x-grok-model-override",
				"x-authenticateresponse",
				"x-grok-client-identifier",
			]) {
				expect(headers.has(name)).toBe(false);
			}
			return Response.json(BILLING);
		});
		await expect(
			getXaiAccountUsage({ accessToken: TOKEN, userId: "user-fixture", fetch: fetchMock }),
		).resolves.toEqual({
			usedPercent: 37.5,
			periodType: "WEEKLY",
			resetsAt: Date.parse("2026-10-08T00:00:00Z"),
			monthlyLimitCents: 2500,
			onDemandCapCents: 1000,
			onDemandUsedCents: 123,
			prepaidBalanceCents: -45,
			onDemandEnabled: true,
		});
	});

	it("preserves zero, missing values and percentage scale without invented limits", async () => {
		const read = (config: unknown) =>
			getXaiAccountUsage({ accessToken: TOKEN, fetch: async () => Response.json({ config }) });
		await expect(read({ creditUsagePercent: 0, prepaidBalance: { val: 0 }, currentPeriod: null })).resolves.toEqual({
			usedPercent: 0,
			prepaidBalanceCents: 0,
		});
		await expect(read({ creditUsagePercent: 125, onDemandCap: null })).resolves.toEqual({ usedPercent: 125 });
		await expect(read({ prepaidBalance: { val: 300 } })).resolves.toEqual({ prepaidBalanceCents: 300 });
	});

	it.each([
		{},
		{ config: null },
		{ config: [] },
		{ config: {} },
		{ creditUsagePercent: 17 },
		{ config: { creditUsagePercent: "17" } },
		{ config: { creditUsagePercent: -1 } },
		{ config: { creditUsagePercent: 17, currentPeriod: { end: "soon" } } },
		{ config: { creditUsagePercent: 17, currentPeriod: { end: 123 } } },
		{ config: { creditUsagePercent: 17, currentPeriod: [] } },
		{ config: { onDemandUsed: 123 } },
		{ config: { prepaidBalance: { val: 1.5 } } },
		{ config: { prepaidBalance: { val: Number.MAX_SAFE_INTEGER + 1 } } },
		{ config: { prepaidBalance: {} } },
		{ config: { creditUsagePercent: 17 }, on_demand_enabled: "yes" },
	])("rejects malformed or unsupported envelopes: %j", async (body) => {
		await expect(
			getXaiAccountUsage({ accessToken: TOKEN, fetch: async () => Response.json(body) }),
		).rejects.toBeInstanceOf(XaiAccountError);
	});

	it("bounds response bodies and keeps HTTP errors free of server material", async () => {
		await expect(
			getXaiAccountUsage({
				accessToken: TOKEN,
				fetch: async () => new Response("x".repeat(MAX_ACCOUNT_RESPONSE_BYTES + 1)),
			}),
		).rejects.toThrow("256 KiB");
		await expect(
			getXaiAccountUsage({ accessToken: TOKEN, fetch: async () => new Response("not json") }),
		).rejects.toBeInstanceOf(XaiAccountError);
		for (const status of [401, 403, 429, 503]) {
			await expect(
				getXaiAccountUsage({
					accessToken: TOKEN,
					fetch: async () => new Response("server-secret", { status, headers: { "Retry-After": "40" } }),
				}),
			).rejects.toMatchObject({
				message: `xAI account request failed (HTTP ${status})`,
				status,
				retryAfterMs: 40_000,
			});
		}
	});

	it("rejects unsafe headers and cancellation before or after network completion", async () => {
		const fetchMock = vi.fn(async () => Response.json(BILLING));
		for (const accessToken of ["", "bad token", "bad\nvalue"])
			await expect(getXaiAccountUsage({ accessToken, fetch: fetchMock })).rejects.toBeInstanceOf(XaiAccountError);
		await expect(
			getXaiAccountUsage({ accessToken: TOKEN, userId: "bad\nvalue", fetch: fetchMock }),
		).rejects.toBeInstanceOf(XaiAccountError);
		const controller = new AbortController();
		controller.abort();
		await expect(
			getXaiAccountUsage({ accessToken: TOKEN, signal: controller.signal, fetch: fetchMock }),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
		const late = new AbortController();
		await expect(
			getXaiAccountUsage({
				accessToken: TOKEN,
				signal: late.signal,
				fetch: async () => {
					late.abort();
					return Response.json(BILLING);
				},
			}),
		).rejects.toThrow();
	});
});
