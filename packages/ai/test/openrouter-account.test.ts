import { describe, expect, it, vi } from "vitest";
import { getOpenRouterAccountUsage, OpenRouterAccountError } from "../src/providers/openrouter-account.ts";

const KEY = "sk-or-v1-fixture";

function route(responses: Record<string, () => Response>) {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		expect(init?.method).toBe("GET");
		expect(init?.redirect).toBe("error");
		expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
		const path = new URL(String(input)).pathname;
		const respond = responses[path];
		if (!respond) throw new Error(`unexpected ${path}`);
		return respond();
	});
}

const credits = () => new Response(JSON.stringify({ data: { total_credits: 110, total_usage: 100.429211805 } }));
const key = () =>
	new Response(
		JSON.stringify({
			data: {
				label: "private label",
				limit: 0.5,
				limit_remaining: 0.271371739,
				limit_reset: null,
				usage: 0.228628261,
				usage_daily: 0.01,
				usage_weekly: 0.1,
				usage_monthly: 0.2,
				rate_limit: { requests: 10, interval: "10s" },
			},
		}),
	);

describe("OpenRouter account usage client", () => {
	it("reads the verified credits and key shapes in parallel, without key metadata", async () => {
		const fetchMock = route({ "/api/v1/credits": credits, "/api/v1/key": key });
		const usage = await getOpenRouterAccountUsage({ apiKey: KEY, fetch: fetchMock });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(usage).toEqual({
			totalCredits: 110,
			totalUsage: 100.429211805,
			key: {
				limit: 0.5,
				limitRemaining: 0.271371739,
				usage: 0.228628261,
				usageDaily: 0.01,
				usageWeekly: 0.1,
				usageMonthly: 0.2,
			},
		});
		expect(JSON.stringify(usage)).not.toContain("private label");
	});

	it("keeps a valid balance when the optional key request fails, and marks the key data unavailable", async () => {
		const usage = await getOpenRouterAccountUsage({
			apiKey: KEY,
			fetch: route({ "/api/v1/credits": credits, "/api/v1/key": () => new Response("down", { status: 503 }) }),
		});
		expect(usage).toEqual({ totalCredits: 110, totalUsage: 100.429211805, keyUnavailable: true });
	});

	it("requires valid credits and reports structural failures only", async () => {
		const secret = "zq9-openrouter-secret";
		const failure = await getOpenRouterAccountUsage({
			apiKey: KEY,
			fetch: route({ "/api/v1/credits": () => new Response(secret, { status: 401 }), "/api/v1/key": key }),
		}).then(
			() => {
				throw new Error("expected a failure");
			},
			(error: unknown) => error as OpenRouterAccountError,
		);
		expect(failure.message).toBe("OpenRouter account request failed (HTTP 401)");
		expect(failure.message).not.toContain(secret);
		for (const body of [
			{ data: { total_credits: "110", total_usage: 1 } },
			{ data: { total_credits: -1, total_usage: 1 } },
			{},
		]) {
			await expect(
				getOpenRouterAccountUsage({
					apiKey: KEY,
					fetch: route({ "/api/v1/credits": () => new Response(JSON.stringify(body)), "/api/v1/key": key }),
				}),
				JSON.stringify(body),
			).rejects.toBeInstanceOf(OpenRouterAccountError);
		}
	});
});
