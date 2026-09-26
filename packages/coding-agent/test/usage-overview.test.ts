import { OpenAICodexAccountError } from "@caupulican/pi-ai";
import { visibleWidth } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import {
	AccountUsageMonitor,
	createOpenAICodexUsageAdapter,
	createOpenRouterUsageAdapter,
	describeAccountFailure,
} from "../src/core/provider-admission/account-usage-monitor.ts";
import type { ProviderLoadView } from "../src/core/provider-admission/load-view.ts";
import {
	type AccountUsageAdapter,
	type AuthenticatedAccount,
	buildUsageOverview,
	listAuthenticatedAccounts,
	type UsageOverview,
	type UsageOverviewRegistry,
} from "../src/core/provider-admission/usage-overview.ts";
import {
	formatUsageOverviewLines,
	UsageDashboardComponent,
} from "../src/modes/interactive/components/usage-dashboard.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const SECRET_TOKEN = "zq9-credential-material-7f3a";

function codexAccessToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toString("base64url");
	return `header.${payload}.${SECRET_TOKEN}`;
}

function emptyLoad(overrides: Partial<ProviderLoadView> = {}): ProviderLoadView {
	return {
		at: NOW,
		inflight: [],
		limits: [],
		usage: [],
		emergencyStop: { engaged: false, path: "/tmp/ESTOP" },
		configuredLimits: {},
		...overrides,
	} as ProviderLoadView;
}

function fakeRegistry(accounts: Record<string, { oauth?: boolean; accountId?: string }>): UsageOverviewRegistry {
	return {
		getAll: () =>
			Object.keys(accounts).map(
				(provider) => ({ provider, id: `${provider}-model`, baseUrl: "https://example.invalid" }) as never,
			),
		getAuthenticatedProviders: () => Object.keys(accounts).sort(),
		getProviderDisplayName: (provider) => provider,
		getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
		getApiKeyForProvider: async (provider) =>
			accounts[provider]?.oauth ? codexAccessToken(accounts[provider]?.accountId ?? "acct") : SECRET_TOKEN,
		authStorage: {
			get: (provider) =>
				accounts[provider]?.oauth
					? ({
							type: "oauth",
							access: codexAccessToken(accounts[provider]?.accountId ?? "acct"),
							refresh: SECRET_TOKEN,
							expires: NOW + 3_600_000,
							accountId: accounts[provider]?.accountId,
						} as never)
					: accounts[provider]
						? ({ type: "api_key", key: SECRET_TOKEN } as never)
						: undefined,
			getOAuthProviders: () => [{ id: "openai-codex", isSubscription: true }],
			getOAuthRequestHeaders: () => undefined,
		},
	};
}

function overviewFor(
	registry: UsageOverviewRegistry,
	monitor: AccountUsageMonitor,
	load: ProviderLoadView = emptyLoad(),
): UsageOverview {
	return buildUsageOverview({
		now: NOW,
		cost: { currentCost: 0.4213, subagentCost: 0.05, todayCost: 3.12, todaySubagentCost: 0.4 },
		tokens: { input: 120_000, output: 8_200, cacheRead: 96_000, cacheWrite: 4_000 },
		context: { tokens: 84_000, contextWindow: 200_000, percent: 42 },
		subscription: true,
		load,
		accounts: listAuthenticatedAccounts(registry),
		fetchState: (account) => monitor.state(account, registry),
		canRedeemReset: (account) => account.provider === "openai-codex",
	});
}

function plain(lines: string[]): string {
	return lines.map(stripAnsi).join("\n");
}

function adapter(
	provider: string,
	run: (account: AuthenticatedAccount, signal: AbortSignal) => Promise<{ windows: [] }>,
): AccountUsageAdapter {
	return { provider, request: (account) => ({ account, run: (signal) => run(account, signal) }) };
}

describe("usage overview membership", () => {
	it("lists only providers this registry holds credentials for, never a no-auth local runtime", () => {
		const auth = AuthStorage.inMemory({ openrouter: { type: "api_key", key: SECRET_TOKEN } });
		const registry = ModelRegistry.inMemory(auth);
		const providers = registry.getAuthenticatedProviders();
		expect(providers).toContain("openrouter");
		expect(providers).not.toContain("llama-cpp");
		expect(registry.getAvailable().some((model) => model.provider === "llama-cpp")).toBe(
			registry.getAll().some((model) => model.provider === "llama-cpp"),
		);
		const accounts = listAuthenticatedAccounts(registry);
		expect(accounts.find((account) => account.provider === "openrouter")).toMatchObject({ auth: "api_key" });
		expect(JSON.stringify(accounts)).not.toContain(SECRET_TOKEN);
	});

	it("shows only the signed-in account's windows and counts other accounts' work only in the machine totals", () => {
		initTheme("dark");
		const registry = fakeRegistry({ "openai-codex": { oauth: true, accountId: "acct-now" } });
		const monitor = new AccountUsageMonitor({ adapters: [] });
		const window = (percent: number) => [
			{ limitId: "codex", primary: { usedPercent: percent, windowMinutes: 300, resetsAt: NOW / 1000 + 600 } },
		];
		const overview = overviewFor(
			registry,
			monitor,
			emptyLoad({
				usage: [
					{ provider: "openai-codex#acct-old", at: NOW - 1000, pid: 1, rateLimits: window(99) },
					{ provider: "openai-codex#acct-now", at: NOW - 1000, pid: 1, rateLimits: window(12) },
				],
				inflight: [
					{
						id: "a",
						provider: "openai-codex",
						account: "acct-old",
						lane: "worker",
						pid: 2,
						startedAt: "",
						heartbeatAt: "",
					},
					{
						id: "b",
						provider: "openai-codex",
						account: "acct-now",
						lane: "foreground",
						pid: 3,
						startedAt: "",
						heartbeatAt: "",
					},
				] as never,
			}),
		);
		const text = plain(formatUsageOverviewLines(overview, 120, NOW));
		expect(text).toContain("12%");
		expect(text).not.toContain("99%");
		expect(overview.machine).toMatchObject({ inflight: 2, otherAccountsInflight: 1 });
		expect(overview.accounts[0]?.inflight.foreground).toBe(1);
	});
});

describe("account usage monitor", () => {
	it("shares one fetch between concurrent opens, serves a fresh cache, and refetches on explicit refresh", async () => {
		const registry = fakeRegistry({ "openai-codex": { oauth: true } });
		const accounts = listAuthenticatedAccounts(registry);
		const run = vi.fn(async () => ({ windows: [] as [] }));
		let now = NOW;
		const monitor = new AccountUsageMonitor({ adapters: [adapter("openai-codex", run)], now: () => now });
		const key = (provider: string) => accounts.find((account) => account.provider === provider)!.accountKey;
		await Promise.all([
			monitor.refresh(accounts, registry, { currentAccountKey: key }),
			monitor.refresh(accounts, registry, { currentAccountKey: key }),
		]);
		expect(run).toHaveBeenCalledTimes(1);
		now += 10_000;
		await monitor.refresh(accounts, registry, { currentAccountKey: key });
		expect(run).toHaveBeenCalledTimes(1);
		await monitor.refresh(accounts, registry, { force: true, currentAccountKey: key });
		expect(run).toHaveBeenCalledTimes(1);
		now += 25_000;
		await monitor.refresh(accounts, registry, { force: true, currentAccountKey: key });
		expect(run).toHaveBeenCalledTimes(2);
		expect(monitor.state(accounts[0]!, registry)).toMatchObject({ kind: "fetched" });
	});

	it("times a slow account out without holding the others, and keeps failures structural", async () => {
		const registry = fakeRegistry({ "openai-codex": { oauth: true }, anthropic: { oauth: true } });
		const accounts = listAuthenticatedAccounts(registry);
		const slow = adapter(
			"openai-codex",
			(_account, signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason));
				}),
		);
		const failing = adapter("anthropic", async () => {
			throw new OpenAICodexAccountError(`secret body ${SECRET_TOKEN}`, 500);
		});
		const monitor = new AccountUsageMonitor({ adapters: [slow, failing], timeoutMs: 30 });
		await monitor.refresh(accounts, registry, {
			currentAccountKey: (provider) => accounts.find((account) => account.provider === provider)!.accountKey,
		});
		const states = accounts.map((account) => monitor.state(account, registry));
		expect(states).toEqual([
			{ kind: "failed", at: expect.any(Number), error: "HTTP 500", nextRefreshAt: expect.any(Number) },
			{ kind: "failed", at: expect.any(Number), error: "timed out", nextRefreshAt: expect.any(Number) },
		]);
		expect(JSON.stringify(states)).not.toContain(SECRET_TOKEN);
		expect(describeAccountFailure(new Error(`unrecognized ${SECRET_TOKEN}`))).toBe("unavailable");
		expect(describeAccountFailure(new OpenAICodexAccountError("not json", 200))).toBe("unreadable response");
	});

	it("discards a result that lands after the account signed in again as someone else", async () => {
		const registry = fakeRegistry({ "openai-codex": { oauth: true, accountId: "acct-a" } });
		const accounts = listAuthenticatedAccounts(registry);
		let current = accounts[0]!.accountKey;
		const monitor = new AccountUsageMonitor({
			adapters: [
				adapter("openai-codex", async () => {
					current = "openai-codex#acct-b";
					return { windows: [] };
				}),
			],
		});
		await monitor.refresh(accounts, registry, { currentAccountKey: () => current });
		expect(monitor.state(accounts[0]!, registry)).toEqual({ kind: "idle" });
	});

	it("does not start a queued usage request after that provider switches accounts", async () => {
		const registry = fakeRegistry({ anthropic: { oauth: true, accountId: "acct-a" }, openrouter: {} });
		const accounts = listAuthenticatedAccounts(registry);
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const staleRun = vi.fn(async () => ({ windows: [] as [] }));
		const monitor = new AccountUsageMonitor({
			adapters: [
				adapter("anthropic", async () => {
					firstStarted.resolve();
					await releaseFirst.promise;
					return { windows: [] };
				}),
				adapter("openrouter", staleRun),
			],
			concurrency: 1,
			minIntervalMs: 0,
		});
		const current = new Map(accounts.map((account) => [account.provider, account.accountKey]));
		const refresh = monitor.refresh(accounts, registry, {
			currentAccountKey: (provider) => current.get(provider) ?? provider,
		});

		await firstStarted.promise;
		current.set("openrouter", "openrouter#replacement");
		releaseFirst.resolve();
		await refresh;

		expect(staleRun).not.toHaveBeenCalled();
		const oldAccount = accounts.find((account) => account.provider === "openrouter")!;
		expect(monitor.state(oldAccount, registry)).toEqual({ kind: "idle" });
	});

	it("starts a queued usage request while its captured account remains current", async () => {
		const registry = fakeRegistry({ anthropic: { oauth: true, accountId: "acct-a" }, openrouter: {} });
		const accounts = listAuthenticatedAccounts(registry);
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const queuedRun = vi.fn(async () => ({ windows: [] as [] }));
		const monitor = new AccountUsageMonitor({
			adapters: [
				adapter("anthropic", async () => {
					firstStarted.resolve();
					await releaseFirst.promise;
					return { windows: [] };
				}),
				adapter("openrouter", queuedRun),
			],
			concurrency: 1,
			minIntervalMs: 0,
		});
		const current = new Map(accounts.map((account) => [account.provider, account.accountKey]));
		const refresh = monitor.refresh(accounts, registry, {
			currentAccountKey: (provider) => current.get(provider) ?? provider,
		});

		await firstStarted.promise;
		releaseFirst.resolve();
		await refresh;

		expect(queuedRun).toHaveBeenCalledOnce();
		const currentAccount = accounts.find((account) => account.provider === "openrouter")!;
		expect(monitor.state(currentAccount, registry)).toMatchObject({ kind: "fetched" });
	});

	it("does not send after the account switches during credential resolution", async () => {
		const baseRegistry = fakeRegistry({ openrouter: {} });
		const credential = Promise.withResolvers<string | undefined>();
		const getApiKeyForProvider = vi.fn(() => credential.promise);
		const registry: UsageOverviewRegistry = { ...baseRegistry, getApiKeyForProvider };
		const accounts = listAuthenticatedAccounts(registry);
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { limit: 1, usage: 0 } })));
		const monitor = new AccountUsageMonitor({
			adapters: [createOpenRouterUsageAdapter(fetchMock)],
			minIntervalMs: 0,
		});
		let current = accounts[0]!.accountKey;
		const refresh = monitor.refresh(accounts, registry, { currentAccountKey: () => current });

		await vi.waitFor(() => expect(getApiKeyForProvider).toHaveBeenCalledOnce());
		current = "openrouter#replacement";
		credential.resolve(SECRET_TOKEN);
		await refresh;

		expect(fetchMock).not.toHaveBeenCalled();
		expect(monitor.state(accounts[0]!, registry)).toEqual({ kind: "idle" });
	});

	it("reads Codex usage through the real adapter and never renders an unparsable balance", async () => {
		initTheme("dark");
		const registry = fakeRegistry({ "openai-codex": { oauth: true, accountId: "acct-real" } });
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						plan_type: "plus",
						rate_limit: {
							allowed: true,
							limit_reached: false,
							primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_at: NOW / 1000 + 3600 },
							secondary_window: {
								used_percent: 7,
								limit_window_seconds: 604_800,
								reset_at: NOW / 1000 + 86_400,
							},
						},
						credits: { has_credits: true, unlimited: false, balance: "\u001b[31m9999\u001b[0m" },
						rate_limit_reset_credits: { available_count: 1 },
					}),
				),
		);
		const monitor = new AccountUsageMonitor({ adapters: [createOpenAICodexUsageAdapter(fetchMock)], now: () => NOW });
		const accounts = listAuthenticatedAccounts(registry);
		await monitor.refresh(accounts, registry, { currentAccountKey: () => accounts[0]!.accountKey });
		const text = plain(formatUsageOverviewLines(overviewFor(registry, monitor), 120, NOW));
		expect(text).toContain("codex 5h");
		expect(text).toContain("codex weekly");
		expect(text).toContain("credits available");
		expect(text).toContain("1 earned reset available");
		expect(text).toContain("fetched");
		expect(text).not.toContain("9999");
		expect(text).not.toContain(SECRET_TOKEN);
	});
});

describe("account usage FedRAMP routing", () => {
	it("sends the routing header only with the stored FedRAMP credential's own token, never with a runtime override", async () => {
		const seen: Array<string | null> = [];
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			seen.push(new Headers(init?.headers).get("X-OpenAI-Fedramp"));
			return new Response(JSON.stringify({ plan_type: "enterprise" }));
		});
		const credential = {
			type: "oauth" as const,
			access: codexAccessToken("acct-stored"),
			refresh: SECRET_TOKEN,
			expires: Date.now() + 3_600_000,
			accountId: "acct-stored",
		};
		const run = async (storage: AuthStorage) => {
			const registry = ModelRegistry.inMemory(storage);
			const account = listAuthenticatedAccounts(registry).find((entry) => entry.provider === "openai-codex");
			await createOpenAICodexUsageAdapter(fetchMock)
				.request(account!, registry)!
				.run(AbortSignal.timeout(5_000), () => true);
		};
		await run(AuthStorage.inMemory({ "openai-codex": { ...credential, chatgptAccountIsFedramp: true } }));
		await run(AuthStorage.inMemory({ "openai-codex": credential }));
		const overridden = AuthStorage.inMemory({ "openai-codex": { ...credential, chatgptAccountIsFedramp: true } });
		overridden.setRuntimeApiKey("openai-codex", codexAccessToken("acct-override"));
		await run(overridden);
		expect(seen).toEqual(["true", null, null]);
	});
});

describe("account usage pacing", () => {
	it("never sends a manual refresh before the minimum interval, and honors a bounded Retry-After", async () => {
		const registry = fakeRegistry({ "openai-codex": { oauth: true }, openrouter: {} });
		const accounts = listAuthenticatedAccounts(registry);
		let now = NOW;
		const codex = vi.fn(async () => ({ windows: [] as [] }));
		let limited = true;
		const openrouter = vi.fn(async () => {
			if (limited) throw new OpenAICodexAccountError("rate limited", 429, 120_000);
			return { windows: [] as [] };
		});
		const monitor = new AccountUsageMonitor({
			adapters: [adapter("openai-codex", codex), adapter("openrouter", openrouter)],
			now: () => now,
			minIntervalMs: 30_000,
		});
		const key = (provider: string) => accounts.find((account) => account.provider === provider)!.accountKey;
		await monitor.refresh(accounts, registry, { force: true, currentAccountKey: key });
		expect([codex.mock.calls.length, openrouter.mock.calls.length]).toEqual([1, 1]);
		for (let tap = 0; tap < 5; tap++) {
			now += 1000;
			await monitor.refresh(accounts, registry, { force: true, currentAccountKey: key });
		}
		expect([codex.mock.calls.length, openrouter.mock.calls.length]).toEqual([1, 1]);
		const codexAccount = accounts.find((account) => account.provider === "openai-codex")!;
		expect(monitor.state(codexAccount, registry)).toMatchObject({ kind: "fetched", nextRefreshAt: NOW + 30_000 });
		now = NOW + 31_000;
		limited = false;
		await monitor.refresh(accounts, registry, { force: true, currentAccountKey: key });
		expect([codex.mock.calls.length, openrouter.mock.calls.length]).toEqual([2, 1]);
		now = NOW + 121_000;
		await monitor.refresh(accounts, registry, { force: true, currentAccountKey: key });
		expect(openrouter.mock.calls.length).toBe(2);
	});
});

describe("usage dashboard rendering", () => {
	beforeAll(() => initTheme("dark"));

	it("labels old data stale and keeps every line within a narrow width", () => {
		const registry = fakeRegistry({ "openai-codex": { oauth: true } });
		const overview = overviewFor(
			registry,
			new AccountUsageMonitor({ adapters: [] }),
			emptyLoad({
				usage: [
					{
						provider: listAuthenticatedAccounts(registry)[0]!.accountKey,
						at: NOW - 20 * 60_000,
						pid: 1,
						rateLimits: [{ limitId: "codex", primary: { usedPercent: 50, windowMinutes: 300 } }],
					},
				],
			}),
		);
		expect(plain(formatUsageOverviewLines(overview, 120, NOW))).toContain("stale");
		for (const width of [20, 30, 40, 80]) {
			for (const line of formatUsageOverviewLines(overview, width, NOW))
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps the actions visible at 80x24 with five accounts and scrolls the accounts instead", () => {
		const providers = ["openai-codex", "anthropic", "openrouter", "xai", "google-antigravity"];
		const registry = fakeRegistry(
			Object.fromEntries(providers.map((provider) => [provider, { oauth: provider !== "openrouter" }])),
		);
		const load = emptyLoad({
			usage: listAuthenticatedAccounts(registry).map((account) => ({
				provider: account.accountKey,
				at: NOW - 1000,
				pid: 1,
				rateLimits: [
					{
						limitId: "a",
						primary: { usedPercent: 10, windowMinutes: 300 },
						secondary: { usedPercent: 20, windowMinutes: 10_080 },
					},
					{ limitId: "b", primary: { usedPercent: 30, windowMinutes: 300 } },
				],
			})),
		});
		const dashboard = new UsageDashboardComponent({
			overview: overviewFor(registry, new AccountUsageMonitor({ adapters: [] }), load),
			canRedeemReset: true,
			now: () => NOW,
			maxRows: () => 24,
			onAction: () => {},
		});
		const first = dashboard.render(80).map(stripAnsi);
		expect(first.length).toBeLessThanOrEqual(24);
		expect(first.join("\n")).toContain("Refresh");
		expect(first.join("\n")).toContain("Close");
		expect(first.join("\n")).toMatch(/lines 1–\d+ of \d+/);
		dashboard.handleInput("\u001b[6~");
		const scrolled = dashboard.render(80).map(stripAnsi);
		expect(scrolled.length).toBeLessThanOrEqual(24);
		expect(scrolled.join("\n")).not.toEqual(first.join("\n"));
		expect(scrolled.join("\n")).toContain("Close");
	});
});
