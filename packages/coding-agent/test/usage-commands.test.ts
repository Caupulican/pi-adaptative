import type {
	Api,
	Model,
	OpenAICodexAccountRequestOptions,
	OpenAICodexConsumeRateLimitResetResult,
	OpenAICodexRateLimitResetCredits,
} from "@caupulican/pi-ai";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { UsageActionSelectorComponent } from "../src/modes/interactive/components/usage-action-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import {
	handleUsageMenuCommand,
	type OpenAICodexUsageResetClient,
	resetCreditOptions,
	type UsageCommandHost,
} from "../src/modes/interactive/usage-commands.ts";

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

function createHost(options: { oauth?: boolean; model?: Model<Api> } = {}): {
	host: UsageCommandHost;
	selectors: UsageActionSelectorComponent[];
	statuses: string[];
	errors: string[];
	showUsageReport: ReturnType<typeof vi.fn>;
} {
	const selectors: UsageActionSelectorComponent[] = [];
	const statuses: string[] = [];
	const errors: string[] = [];
	const showUsageReport = vi.fn();
	const host: UsageCommandHost = {
		session: {
			model: options.model ?? createModel(),
			modelRegistry: {
				isUsingOAuth: () => options.oauth ?? true,
				getApiKeyForProvider: async () =>
					"header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjb3VudC0xMjMifX0.signature",
			},
		},
		showSelector: (create) => {
			const mounted = create(() => {});
			expect(mounted.focus).toBe(mounted.component);
			selectors.push(mounted.component as UsageActionSelectorComponent);
		},
		showStatus: (message) => statuses.push(message),
		showError: (message) => errors.push(message),
		showUsageReport,
	};
	return { host, selectors, statuses, errors, showUsageReport };
}

describe("OpenAI subscription usage reset flow", () => {
	beforeAll(() => initTheme("dark"));

	test("keeps non-subscription providers on the provider-neutral usage report", () => {
		const { host, selectors, showUsageReport } = createHost({ oauth: false });
		const client: OpenAICodexUsageResetClient = {
			list: vi.fn(),
			consume: vi.fn(),
		};

		handleUsageMenuCommand(host, client);

		expect(showUsageReport).toHaveBeenCalledOnce();
		expect(selectors).toHaveLength(0);
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
		const { host, selectors, statuses, errors } = createHost();
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

		handleUsageMenuCommand(host, client);
		expect(selectors[0]?.render(100).join("\n")).toContain("Redeem usage limit reset");
		selectValue(selectors[0]!, "reset");

		await vi.waitFor(() => expect(selectors).toHaveLength(2));
		selectValue(selectors[1]!, "credit:0");
		expect(selectors).toHaveLength(3);
		expect(selectors[2]?.getSelectList().getSelectedItem()?.value).toBe("cancel");
		expect(selectors[2]?.render(100).join("\n")).toContain("Use this reset?");

		selectValue(selectors[2]!, "confirm");
		await vi.waitFor(() => expect(consume).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(statuses.at(-1)).toBe("Usage reset. You have 0 resets left."));

		const call = consume.mock.calls[0];
		expect(call?.[1]).toMatch(/^[0-9a-f-]{36}$/);
		expect(call?.[2]).toBe("credit-1");
		expect(errors).toEqual([]);
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

		handleUsageMenuCommand(host, client);
		selectValue(selectors[0]!, "reset");
		await vi.waitFor(() => expect(selectors).toHaveLength(2));
		selectValue(selectors[1]!, "credit:0");
		selectValue(selectors[2]!, "confirm");

		await vi.waitFor(() => expect(selectors).toHaveLength(4));
		expect(selectors[3]?.getSelectList().getSelectedItem()?.value).toBe("cancel");
		selectValue(selectors[3]!, "retry");
		await vi.waitFor(() => expect(requestIds).toHaveLength(2));

		expect(requestIds[0]).toBe(requestIds[1]);
		expect(errors).toEqual(["Couldn't reset OpenAI subscription usage: temporary failure"]);
	});
});
