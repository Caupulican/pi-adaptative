import { randomUUID } from "node:crypto";
import type {
	Api,
	Model,
	OpenAICodexAccountRequestOptions,
	OpenAICodexConsumeRateLimitResetResult,
	OpenAICodexRateLimitResetCredit,
	OpenAICodexRateLimitResetCredits,
} from "@caupulican/pi-ai";
import { consumeOpenAICodexRateLimitResetCredit, listOpenAICodexRateLimitResetCredits } from "@caupulican/pi-ai";
import type { Component } from "@caupulican/pi-tui";
import type { SessionCostSummary } from "../../core/cost/cost-summary.ts";
import { resolveProviderAccountKey } from "../../core/provider-admission/account-key.ts";
import type { AccountUsageMonitor } from "../../core/provider-admission/account-usage-monitor.ts";
import type { ProviderLoadView } from "../../core/provider-admission/load-view.ts";
import {
	type AuthenticatedAccount,
	buildUsageOverview,
	listAuthenticatedAccounts,
	OPENAI_CODEX_PROVIDER,
	openAICodexCredentialHeaders,
	type UsageOverview,
	type UsageOverviewRegistry,
} from "../../core/provider-admission/usage-overview.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { UsageActionSelectorComponent } from "./components/usage-action-selector.ts";
import { UsageDashboardComponent } from "./components/usage-dashboard.ts";

const ACCOUNT_REQUEST_TIMEOUT_MS = 15_000;

type UsageSessionModelRegistry = UsageOverviewRegistry & {
	isUsingOAuth(model: Model<Api>): boolean;
	isUsingSubscription(model: Model<Api>): boolean;
};

export interface UsageCommandHost {
	readonly session: {
		readonly modelRegistry: UsageSessionModelRegistry;
		readonly model: Model<Api> | undefined;
		/** A redeemed reset: the provider's recorded limits no longer hold, so it is routed to again. */
		noteSubscriptionUsageReset(provider: string): void;
		getCostSummary(): Pick<SessionCostSummary, "currentCost" | "subagentCost" | "todayCost" | "todaySubagentCost">;
		getSessionStats(): { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } };
		getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
		getProviderLoadView(): ProviderLoadView;
	};
	readonly usageMonitor: AccountUsageMonitor;
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void;
	showStatus(message: string): void;
	showError(message: string): void;
	requestRender(): void;
	terminalRows(): number;
}

export const USAGE_COMMAND_USAGE = "/usage · /usage reset";

export interface OpenAICodexUsageResetClient {
	list(options: OpenAICodexAccountRequestOptions): Promise<OpenAICodexRateLimitResetCredits>;
	consume(
		options: OpenAICodexAccountRequestOptions,
		redeemRequestId: string,
		creditId?: string,
	): Promise<OpenAICodexConsumeRateLimitResetResult>;
}

type UsageResetAuth = {
	accessToken: string;
	baseUrl?: string;
	credentialHeaders: Record<string, string> | undefined;
};

type ResetCreditOption = {
	value: string;
	creditId?: string;
	title: string;
	detail: string;
	description: string;
};

const DEFAULT_RESET_CLIENT: OpenAICodexUsageResetClient = {
	list: listOpenAICodexRateLimitResetCredits,
	consume: consumeOpenAICodexRateLimitResetCredit,
};

function formatError(error: unknown): string {
	return normalizedCopy(error instanceof Error ? error.message : String(error), "Unknown error", 2_000);
}

function accountRequestOptions(auth: UsageResetAuth): OpenAICodexAccountRequestOptions {
	return {
		accessToken: auth.accessToken,
		baseUrl: auth.baseUrl,
		credentialHeaders: auth.credentialHeaders,
		signal: AbortSignal.timeout(ACCOUNT_REQUEST_TIMEOUT_MS),
	};
}

function normalizedCopy(value: string | undefined, fallback: string, maxChars = 500): string {
	const normalized = value
		? stripAnsi(value)
				.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, maxChars)
		: undefined;
	return normalized || fallback;
}

function expirationDetail(expiresAt: string | undefined): string {
	if (!expiresAt) return "Does not expire";
	const date = new Date(expiresAt);
	if (Number.isNaN(date.getTime())) return "Expiration unavailable";
	return `Expires ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)}`;
}

export function resetCreditOptions(summary: OpenAICodexRateLimitResetCredits): ResetCreditOption[] {
	const available = summary.credits
		.filter((credit) => credit.status === "available" && credit.resetType === "codex_rate_limits")
		.sort((left, right) => {
			const leftTime = left.expiresAt ? Date.parse(left.expiresAt) : Number.POSITIVE_INFINITY;
			const rightTime = right.expiresAt ? Date.parse(right.expiresAt) : Number.POSITIVE_INFINITY;
			return (
				(Number.isNaN(leftTime) ? Number.POSITIVE_INFINITY : leftTime) -
				(Number.isNaN(rightTime) ? Number.POSITIVE_INFINITY : rightTime)
			);
		})
		.slice(0, summary.availableCount);

	if (summary.availableCount > 0 && available.length === 0) {
		return [
			{
				value: "credit:automatic",
				title: "Full reset",
				detail: "Backend-selected reset",
				description: "Reset your current eligible usage limits.",
			},
		];
	}

	return available.map((credit: OpenAICodexRateLimitResetCredit, index) => ({
		value: `credit:${index}`,
		creditId: credit.id,
		title: normalizedCopy(credit.title, "Full reset", 120),
		detail: expirationDetail(credit.expiresAt),
		description: normalizedCopy(credit.description, "Reset your current eligible usage limits."),
	}));
}

/**
 * The owner's OpenAI Codex subscription lane, whatever model the session runs: resets belong to the
 * ChatGPT account, which routing, workers or the session may be using.
 */
function codexSubscriptionModel(host: UsageCommandHost): Model<Api> | undefined {
	const registry = host.session.modelRegistry;
	return registry.getAll().find((model) => model.provider === "openai-codex" && registry.isUsingOAuth(model));
}

function canRedeemReset(account: AuthenticatedAccount): boolean {
	return account.provider === OPENAI_CODEX_PROVIDER && (account.auth === "subscription" || account.auth === "oauth");
}

function buildOverview(host: UsageCommandHost, accounts: readonly AuthenticatedAccount[]): UsageOverview {
	const session = host.session;
	const registry = session.modelRegistry;
	const model = session.model;
	const context = session.getContextUsage();
	return buildUsageOverview({
		now: Date.now(),
		cost: session.getCostSummary(),
		tokens: session.getSessionStats().tokens,
		...(context ? { context } : {}),
		subscription: model ? registry.isUsingSubscription(model) : false,
		load: session.getProviderLoadView(),
		accounts: [...accounts],
		fetchState: (account) => host.usageMonitor.state(account, registry),
		canRedeemReset,
	});
}

function openUsageDashboard(host: UsageCommandHost, client: OpenAICodexUsageResetClient): void {
	const registry = host.session.modelRegistry;
	const currentAccountKey = (provider: string) => resolveProviderAccountKey(registry.authStorage, provider);
	host.showSelector((done) => {
		let open = true;
		let accounts = listAuthenticatedAccounts(registry);
		const close = () => {
			open = false;
			done();
		};
		const refresh = (force: boolean) => {
			accounts = listAuthenticatedAccounts(registry);
			const running = host.usageMonitor.refresh(accounts, registry, { force, currentAccountKey });
			dashboard.update(buildOverview(host, accounts));
			host.requestRender();
			void running.then(() => {
				if (!open) return;
				dashboard.update(buildOverview(host, accounts));
				host.requestRender();
			});
		};
		const dashboard = new UsageDashboardComponent({
			overview: buildOverview(host, accounts),
			canRedeemReset: accounts.some(canRedeemReset),
			maxRows: () => host.terminalRows(),
			onAction: (action) => {
				if (action === "refresh") {
					refresh(true);
					return;
				}
				close();
				if (action === "reset") void loadResetCredits(host, client);
			},
		});
		refresh(false);
		return { component: dashboard, focus: dashboard };
	});
}

async function loadResetCredits(host: UsageCommandHost, client: OpenAICodexUsageResetClient): Promise<void> {
	const model = codexSubscriptionModel(host);
	if (!model) {
		host.showError("Usage limit resets need an OpenAI Codex subscription login (/login).");
		return;
	}

	host.showStatus("Checking available usage limit resets...");
	try {
		const accessToken = await host.session.modelRegistry.getApiKeyForProvider(model.provider);
		if (!accessToken) throw new Error("OpenAI Codex subscription credentials are unavailable. Run /login.");
		const auth = {
			accessToken,
			baseUrl: model.baseUrl,
			credentialHeaders: openAICodexCredentialHeaders(host.session.modelRegistry, accessToken),
		};
		const summary = await client.list(accountRequestOptions(auth));
		const options = resetCreditOptions(summary);
		if (summary.availableCount === 0 || options.length === 0) {
			host.showStatus("No usage limit resets are available for this OpenAI subscription.");
			return;
		}
		showResetCreditPicker(host, client, auth, summary.availableCount, options);
	} catch (error) {
		host.showError(`Couldn't load usage limit resets: ${formatError(error)}`);
	}
}

function showResetCreditPicker(
	host: UsageCommandHost,
	client: OpenAICodexUsageResetClient,
	auth: UsageResetAuth,
	availableCount: number,
	options: ResetCreditOption[],
): void {
	host.showSelector((done) => {
		const selector = new UsageActionSelectorComponent({
			title: "Usage limit resets",
			subtitle: `${availableCount} ${availableCount === 1 ? "reset" : "resets"} available.`,
			items: [
				...options.map((option) => ({ value: option.value, label: option.title, description: option.detail })),
				{ value: "cancel", label: "Cancel", description: "Keep current usage windows" },
			],
			onSelect: (value) => {
				if (value === "cancel") {
					done();
					return;
				}
				const option = options.find((candidate) => candidate.value === value);
				if (!option) return;
				done();
				showResetConfirmation(host, client, auth, availableCount, options, option);
			},
			onCancel: done,
		});
		return { component: selector, focus: selector };
	});
}

function showResetConfirmation(
	host: UsageCommandHost,
	client: OpenAICodexUsageResetClient,
	auth: UsageResetAuth,
	availableCount: number,
	options: ResetCreditOption[],
	option: ResetCreditOption,
): void {
	const redeemRequestId = randomUUID();
	host.showSelector((done) => {
		const selector = new UsageActionSelectorComponent({
			title: "Use this reset?",
			subtitle: `${option.title} · ${option.detail}`,
			items: [
				{ value: "confirm", label: "Yes, use reset", description: option.description },
				{ value: "cancel", label: "No, go back", description: "Choose a different reset" },
			],
			initialSelectedIndex: 1,
			onSelect: (value) => {
				done();
				if (value === "confirm") {
					void consumeResetCredit(host, client, auth, option, redeemRequestId);
				} else {
					showResetCreditPicker(host, client, auth, availableCount, options);
				}
			},
			onCancel: done,
		});
		return { component: selector, focus: selector };
	});
}

async function consumeResetCredit(
	host: UsageCommandHost,
	client: OpenAICodexUsageResetClient,
	auth: UsageResetAuth,
	option: ResetCreditOption,
	redeemRequestId: string,
): Promise<void> {
	host.showStatus("Resetting OpenAI subscription usage...");
	try {
		const result = await client.consume(accountRequestOptions(auth), redeemRequestId, option.creditId);
		switch (result.outcome) {
			case "reset":
			case "already_redeemed":
				host.session.noteSubscriptionUsageReset("openai-codex");
				await refreshAfterReset(host, client, auth);
				return;
			case "nothing_to_reset":
				host.showStatus("Your OpenAI subscription usage does not need a reset right now.");
				return;
			case "no_credit":
				host.showStatus("That usage limit reset is no longer available.");
				return;
		}
	} catch (error) {
		host.showError(`Couldn't reset OpenAI subscription usage: ${formatError(error)}`);
		showResetRetry(host, client, auth, option, redeemRequestId);
	}
}

async function refreshAfterReset(
	host: UsageCommandHost,
	client: OpenAICodexUsageResetClient,
	auth: UsageResetAuth,
): Promise<void> {
	try {
		const summary = await client.list(accountRequestOptions(auth));
		host.showStatus(
			`Usage reset. You have ${summary.availableCount} ${summary.availableCount === 1 ? "reset" : "resets"} left.`,
		);
	} catch {
		host.showStatus("Usage reset. Remaining reset availability could not be refreshed.");
	}
}

function showResetRetry(
	host: UsageCommandHost,
	client: OpenAICodexUsageResetClient,
	auth: UsageResetAuth,
	option: ResetCreditOption,
	redeemRequestId: string,
): void {
	host.showSelector((done) => {
		const selector = new UsageActionSelectorComponent({
			title: "Reset failed",
			subtitle: "Retry the same idempotent redemption request?",
			items: [
				{ value: "retry", label: "Try again", description: "Reuse the same request safely" },
				{ value: "cancel", label: "Cancel", description: "Leave usage unchanged" },
			],
			initialSelectedIndex: 1,
			onSelect: (value) => {
				done();
				if (value === "retry") void consumeResetCredit(host, client, auth, option, redeemRequestId);
			},
			onCancel: done,
		});
		return { component: selector, focus: selector };
	});
}

export function handleUsageMenuCommand(
	host: UsageCommandHost,
	text = "/usage",
	client: OpenAICodexUsageResetClient = DEFAULT_RESET_CLIENT,
): void {
	const args = text.replace(/^\/usage\b/, "").trim();
	if (args === "reset") {
		void loadResetCredits(host, client);
		return;
	}
	if (args.length > 0) {
		host.showError(USAGE_COMMAND_USAGE);
		return;
	}
	openUsageDashboard(host, client);
}
