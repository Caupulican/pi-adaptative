import { describe, expect, it, vi } from "vitest";
import type { OAuthCredential } from "../src/core/auth-storage.ts";
import { AccountUsageMonitor, createXaiUsageAdapter } from "../src/core/provider-admission/account-usage-monitor.ts";
import {
	listAuthenticatedAccounts,
	type UsageOverviewRegistry,
} from "../src/core/provider-admission/usage-overview.ts";

function registryFixture() {
	let credential: OAuthCredential = {
		type: "oauth",
		access: "access-a",
		refresh: "refresh-a",
		expires: Number.MAX_SAFE_INTEGER,
		userId: "user-a",
	};
	const registry: UsageOverviewRegistry = {
		getAll: () => [],
		getAuthenticatedProviders: () => ["xai"],
		getProviderDisplayName: () => "xAI",
		getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
		getApiKeyForProvider: async () => credential.access,
		authStorage: {
			get: () => credential,
			getOAuthProviders: () => [{ id: "xai", isSubscription: true }],
			getOAuthRequestHeaders: () => undefined,
		},
	};
	return {
		registry,
		switchAccount: () => {
			credential = { ...credential, access: "access-b", refresh: "refresh-b", userId: "user-b" };
		},
	};
}

describe("Grok usage monitor account boundary", () => {
	it("supports subscription login by default and excludes API keys", () => {
		const { registry } = registryFixture();
		const account = listAuthenticatedAccounts(registry)[0];
		const monitor = new AccountUsageMonitor();
		expect(monitor.supports(account, registry)).toBe(true);
		for (const auth of ["api_key", "environment", "models_json", "headers"] as const)
			expect(monitor.supports({ ...account, auth }, registry)).toBe(false);
	});

	it("projects server percentages, reset time and cents without inferring spend", async () => {
		const { registry } = registryFixture();
		const account = listAuthenticatedAccounts(registry)[0];
		const monitor = new AccountUsageMonitor({
			adapters: [
				createXaiUsageAdapter(async () =>
					Response.json({
						config: {
							creditUsagePercent: 12.5,
							currentPeriod: { type: "WEEKLY", end: "2026-10-08T00:00:00Z" },
							prepaidBalance: { val: -45 },
							onDemandCap: { val: 0 },
							onDemandUsed: { val: 123 },
						},
						on_demand_enabled: true,
					}),
				),
			],
		});
		await monitor.refresh([account], registry, { currentAccountKey: () => account.accountKey });
		expect(monitor.state(account, registry)).toMatchObject({
			kind: "fetched",
			snapshot: {
				windows: [{ label: "weekly", usedPercent: 12.5, resetsAt: Date.parse("2026-10-08T00:00:00Z") }],
				balance: "$-0.45 prepaid credit",
				details: ["on-demand enabled", "on-demand $1.23 used", "on-demand cap $0.00"],
			},
		});
	});

	it("does not combine a resolved token with another account's user id or a runtime API key", async () => {
		const { registry, switchAccount } = registryFixture();
		const account = listAuthenticatedAccounts(registry)[0];
		const fetchMock = vi.fn(async () => Response.json({ config: { creditUsagePercent: 17 } }));
		const monitor = new AccountUsageMonitor({ adapters: [createXaiUsageAdapter(fetchMock)] });
		registry.getApiKeyForProvider = async () => {
			switchAccount();
			return "access-a";
		};
		await monitor.refresh([account], registry, {
			currentAccountKey: () => listAuthenticatedAccounts(registry)[0].accountKey,
		});
		expect(fetchMock).not.toHaveBeenCalled();
		const next = listAuthenticatedAccounts(registry)[0];
		registry.getApiKeyForProvider = async () => "runtime-key";
		await monitor.refresh([next], registry, { currentAccountKey: () => next.accountKey });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(monitor.state(next, registry)).toMatchObject({
			kind: "failed",
			error: "credentials unavailable (run /login)",
		});
	});

	it("discards late results after an account change", async () => {
		const { registry, switchAccount } = registryFixture();
		const account = listAuthenticatedAccounts(registry)[0];
		const monitor = new AccountUsageMonitor({
			adapters: [
				createXaiUsageAdapter(async () => {
					switchAccount();
					return Response.json({ config: { creditUsagePercent: 17 } });
				}),
			],
		});
		await monitor.refresh([account], registry, {
			currentAccountKey: () => listAuthenticatedAccounts(registry)[0].accountKey,
		});
		expect(monitor.state(account, registry)).toEqual({ kind: "idle" });
		expect(monitor.state(listAuthenticatedAccounts(registry)[0], registry)).toEqual({ kind: "idle" });
	});

	it("preserves last evidence after malformed responses and respects Retry-After on forced refresh", async () => {
		const { registry } = registryFixture();
		const account = listAuthenticatedAccounts(registry)[0];
		let now = 1000;
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ config: { creditUsagePercent: 0 } }))
			.mockResolvedValueOnce(Response.json({ config: {} }))
			.mockResolvedValue(new Response("secret", { status: 429, headers: { "Retry-After": "120" } }));
		const monitor = new AccountUsageMonitor({ adapters: [createXaiUsageAdapter(fetchMock)], now: () => now });
		const options = { force: true, currentAccountKey: () => account.accountKey };
		await monitor.refresh([account], registry, options);
		now += 30_000;
		await monitor.refresh([account], registry, options);
		expect(monitor.state(account, registry)).toMatchObject({
			kind: "failed",
			error: "unreadable response",
			last: { windows: [{ usedPercent: 0 }] },
		});
		now += 30_000;
		await monitor.refresh([account], registry, options);
		expect(monitor.state(account, registry)).toMatchObject({
			kind: "failed",
			error: "HTTP 429 (rate limited)",
			nextRefreshAt: now + 120_000,
		});
		now += 30_000;
		await monitor.refresh([account], registry, options);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
});
