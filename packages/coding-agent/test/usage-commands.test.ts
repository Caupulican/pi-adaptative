import type {
	Api,
	Model,
	OpenAICodexAccountRequestOptions,
	OpenAICodexConsumeRateLimitResetResult,
	OpenAICodexRateLimitResetCredits,
} from "@caupulican/pi-ai";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { AccountUsageMonitor } from "../src/core/provider-admission/account-usage-monitor.ts";
import type { UsageActionSelectorComponent } from "../src/modes/interactive/components/usage-action-selector.ts";
import { UsageDashboardComponent } from "../src/modes/interactive/components/usage-dashboard.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import {
	handleUsageMenuCommand,
	type OpenAICodexUsageResetClient,
	resetCreditOptions,
	type UsageCommandHost,
} from "../src/modes/interactive/usage-commands.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const CODEX_TOKEN =
	"header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjb3VudC0xMjMifX0.signature";

const RESET_SUMMARY: OpenAICodexRateLimitResetCredits = {
	availableCount: 1,
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
};

function createModel(): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	};
}

function selectValue(selector: UsageActionSelectorComponent, value: string): void {
	const list = selector.getSelectList();
	list.setFilter(value);
	const item = list.getSelectedItem();
	if (!item) throw new Error(`Missing selector item ${value}`);
	list.onSelect?.(item);
}

function createHost(
	options: { oauth?: boolean; models?: Model<Api>[]; registry?: UsageCommandHost["session"]["modelRegistry"] } = {},
): {
	host: UsageCommandHost;
	selectors: UsageActionSelectorComponent[];
	dashboards: UsageDashboardComponent[];
	statuses: string[];
	errors: string[];
	resets: string[];
} {
	const resets: string[] = [];
	const selectors: UsageActionSelectorComponent[] = [];
	const dashboards: UsageDashboardComponent[] = [];
	const statuses: string[] = [];
	const errors: string[] = [];
	const models = options.models ?? [createModel()];
	const oauth = (provider: string) => provider === "openai-codex" && (options.oauth ?? true);
	const host: UsageCommandHost = {
		session: {
			model: models[0],
			noteSubscriptionUsageReset: (provider) => resets.push(provider),
			getCostSummary: () => ({ currentCost: 0.1, subagentCost: 0, todayCost: 0.2, todaySubagentCost: 0 }),
			getSessionStats: () => ({ tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }),
			getContextUsage: () => ({ tokens: 100, contextWindow: 400_000, percent: 0.025 }),
			getProviderLoadView: () => ({
				at: Date.now(),
				inflight: [],
				limits: [],
				usage: [],
				emergencyStop: { engaged: false, path: "/tmp/ESTOP" },
				configuredLimits: {},
			}),
			modelRegistry: options.registry ?? {
				getAll: () => models,
				getAuthenticatedProviders: () => [...new Set(models.map((model) => model.provider))].sort(),
				getProviderDisplayName: (provider) => provider,
				getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
				isUsingOAuth: (model) => oauth(model.provider),
				isUsingSubscription: (model) => oauth(model.provider),
				getApiKeyForProvider: async () => CODEX_TOKEN,
				authStorage: {
					get: (provider) =>
						oauth(provider)
							? ({ type: "oauth", access: CODEX_TOKEN, refresh: "r", expires: Date.now() + 3_600_000 } as never)
							: ({ type: "api_key", key: "k" } as never),
					getOAuthProviders: () => [{ id: "openai-codex", isSubscription: true }],
					getOAuthRequestHeaders: () => undefined,
				},
			},
		},
		usageMonitor: new AccountUsageMonitor({ adapters: [] }),
		showSelector: (create) => {
			const mounted = create(() => {});
			expect(mounted.focus).toBe(mounted.component);
			if (mounted.component instanceof UsageDashboardComponent) dashboards.push(mounted.component);
			else selectors.push(mounted.component as UsageActionSelectorComponent);
		},
		showStatus: (message) => statuses.push(message),
		showError: (message) => errors.push(message),
		requestRender: () => {},
		terminalRows: () => 40,
	};
	return { host, selectors, dashboards, statuses, errors, resets };
}

function chooseDashboardAction(dashboard: UsageDashboardComponent, label: string): void {
	for (let step = 0; step < 4; step++) {
		const rendered = dashboard.render(100).map(stripAnsi);
		if (rendered.some((line) => line.trimStart().startsWith(`→ ${label}`))) {
			dashboard.handleInput("\r");
			return;
		}
		dashboard.handleInput("\u001b[B");
	}
	throw new Error(`Missing dashboard action ${label}`);
}

describe("OpenAI subscription usage reset flow", () => {
	beforeAll(() => initTheme("dark"));

	test("opens the overview at once for every configuration, with the reset only where it exists", () => {
		const grok = { ...createModel(), id: "grok-4.7", provider: "xai" } as Model<Api>;
		const apiOnly = createHost({ models: [grok] });
		const client: OpenAICodexUsageResetClient = { list: vi.fn(), consume: vi.fn() };
		handleUsageMenuCommand(apiOnly.host, "/usage", client);
		expect(apiOnly.selectors).toHaveLength(0);
		const text = apiOnly.dashboards[0]?.render(100).map(stripAnsi).join("\n") ?? "";
		expect(text).toContain("Usage & limits");
		expect(text).toContain("xai");
		expect(text).not.toContain("Redeem earned reset");

		const codex = createHost({ models: [grok, createModel()] });
		handleUsageMenuCommand(codex.host, "/usage", client);
		expect(codex.dashboards[0]?.render(100).map(stripAnsi).join("\n")).toContain("Redeem earned reset");
		expect(client.list).not.toHaveBeenCalled();
		expect(client.consume).not.toHaveBeenCalled();
	});

	test("rejects unknown /usage arguments", () => {
		const { host, errors, dashboards } = createHost();
		handleUsageMenuCommand(host, "/usage everything", { list: vi.fn(), consume: vi.fn() });
		expect(errors).toEqual(["/usage · /usage reset"]);
		expect(dashboards).toHaveLength(0);
	});

	test("the overview's reset action enters the confirmation flow and redeems nothing on its own", async () => {
		const { host, dashboards, selectors } = createHost();
		const client: OpenAICodexUsageResetClient = { list: vi.fn(async () => RESET_SUMMARY), consume: vi.fn() };
		handleUsageMenuCommand(host, "/usage", client);
		chooseDashboardAction(dashboards[0]!, "Redeem earned reset");
		await vi.waitFor(() => expect(selectors).toHaveLength(1));
		expect(selectors[0]?.render(100).join("\n")).toContain("Usage limit resets");
		expect(client.consume).not.toHaveBeenCalled();
	});

	test("sanitizes backend-provided reset copy before rendering it", () => {
		const options = resetCreditOptions({
			availableCount: 1,
			credits: [
				{
					...RESET_SUMMARY.credits[0]!,
					title: "\u001b]8;;https://example.test\u0007Injected\u001b]8;;\u0007\n title",
					description: "line one\r\nline two",
				},
			],
		});

		expect(options[0]?.title).toBe("Injected title");
		expect(options[0]?.description).toBe("line one line two");
	});

	test("requires a safe confirmation and refreshes availability after redemption", async () => {
		const { host, selectors, statuses, errors, resets } = createHost();
		let listCalls = 0;
		const consume = vi.fn(
			async (
				_options: OpenAICodexAccountRequestOptions,
				_requestId: string,
				_creditId?: string,
			): Promise<OpenAICodexConsumeRateLimitResetResult> => ({ outcome: "reset", windowsReset: 2 }),
		);
		const client: OpenAICodexUsageResetClient = {
			list: vi.fn(async () => {
				listCalls++;
				return listCalls === 1 ? RESET_SUMMARY : { availableCount: 0, credits: [] };
			}),
			consume,
		};

		handleUsageMenuCommand(host, "/usage reset", client);

		await vi.waitFor(() => expect(selectors).toHaveLength(1));
		selectValue(selectors[0]!, "credit:0");
		expect(selectors).toHaveLength(2);
		expect(selectors[1]?.getSelectList().getSelectedItem()?.value).toBe("cancel");
		expect(selectors[1]?.render(100).join("\n")).toContain("Use this reset?");

		selectValue(selectors[1]!, "confirm");
		await vi.waitFor(() => expect(consume).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(statuses.at(-1)).toBe("Usage reset. You have 0 resets left."));
		// The redeemed reset clears pi's own record of the exhausted Codex limits.
		expect(resets).toEqual(["openai-codex"]);

		const call = consume.mock.calls[0];
		expect(call?.[1]).toMatch(/^[0-9a-f-]{36}$/);
		expect(call?.[2]).toBe("credit-1");
		expect(call?.[0].credentialHeaders).toBeUndefined();
		expect(errors).toEqual([]);
	});

	test("routes reset account requests as FedRAMP only with the stored FedRAMP credential's own token", async () => {
		const fedrampFor = async (storage: AuthStorage) => {
			const { host, selectors } = createHost({ registry: ModelRegistry.inMemory(storage) });
			const list = vi.fn(async (_options: OpenAICodexAccountRequestOptions) => RESET_SUMMARY);
			handleUsageMenuCommand(host, "/usage reset", { list, consume: vi.fn() });
			await vi.waitFor(() => expect(selectors).toHaveLength(1));
			return list.mock.calls[0]?.[0].credentialHeaders?.["X-OpenAI-Fedramp"] === "true";
		};
		const credential = {
			type: "oauth" as const,
			access: CODEX_TOKEN,
			refresh: "r",
			expires: Date.now() + 3_600_000,
			accountId: "account-123",
			chatgptAccountIsFedramp: true,
		};
		expect(await fedrampFor(AuthStorage.inMemory({ "openai-codex": credential }))).toBe(true);
		const overridden = AuthStorage.inMemory({ "openai-codex": credential });
		overridden.setRuntimeApiKey("openai-codex", "override-token");
		expect(await fedrampFor(overridden)).toBe(false);
	});

	test("retries a failed redemption with the same idempotency key", async () => {
		const { host, selectors, errors } = createHost();
		const requestIds: string[] = [];
		let consumeCalls = 0;
		const client: OpenAICodexUsageResetClient = {
			list: vi.fn(async () => RESET_SUMMARY),
			consume: vi.fn(async (_options: OpenAICodexAccountRequestOptions, requestId: string) => {
				requestIds.push(requestId);
				consumeCalls++;
				if (consumeCalls === 1) throw new Error("temporary failure");
				return { outcome: "already_redeemed" as const, windowsReset: 2 };
			}),
		};

		handleUsageMenuCommand(host, "/usage reset", client);
		await vi.waitFor(() => expect(selectors).toHaveLength(1));
		selectValue(selectors[0]!, "credit:0");
		selectValue(selectors[1]!, "confirm");

		await vi.waitFor(() => expect(selectors).toHaveLength(3));
		expect(selectors[2]?.getSelectList().getSelectedItem()?.value).toBe("cancel");
		selectValue(selectors[2]!, "retry");
		await vi.waitFor(() => expect(requestIds).toHaveLength(2));

		expect(requestIds[0]).toBe(requestIds[1]);
		expect(errors).toEqual(["Couldn't reset OpenAI subscription usage: temporary failure"]);
	});
});
