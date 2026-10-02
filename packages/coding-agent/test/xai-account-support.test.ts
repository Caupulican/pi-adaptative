import { describe, expect, it } from "vitest";
import { AccountUsageMonitor } from "../src/core/provider-admission/account-usage-monitor.ts";
import type { AuthenticatedAccount, UsageOverviewRegistry } from "../src/core/provider-admission/usage-overview.ts";

const account: AuthenticatedAccount = {
	provider: "xai",
	displayName: "xAI",
	accountKey: "xai#oauth:fixture",
	accountLabel: "fixture",
	auth: "subscription",
};
const registry: UsageOverviewRegistry = {
	getAll: () => [],
	getAuthenticatedProviders: () => ["xai"],
	getProviderDisplayName: () => "xAI",
	getProviderAuthStatus: () => ({ configured: true }),
	getApiKeyForProvider: async () => "fixture",
	authStorage: { get: () => undefined, getOAuthProviders: () => [], getOAuthRequestHeaders: () => undefined },
};

describe("packaged Grok account usage support", () => {
	it("admits the authenticated subscription transport", () => {
		expect(new AccountUsageMonitor().supports(account, registry)).toBe(true);
	});
	it("never admits an API key to subscription billing", () => {
		expect(new AccountUsageMonitor().supports({ ...account, auth: "api_key" }, registry)).toBe(false);
	});
});
