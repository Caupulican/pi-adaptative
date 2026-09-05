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
import { stripAnsi } from "../../utils/ansi.ts";
import { UsageActionSelectorComponent } from "./components/usage-action-selector.ts";

const ACCOUNT_REQUEST_TIMEOUT_MS = 15_000;

type UsageSessionModelRegistry = {
	isUsingOAuth(model: Model<Api>): boolean;
	getApiKeyForProvider(provider: string): Promise<string | undefined>;
};

export interface UsageCommandHost {
	readonly session: {
		readonly model: Model<Api> | undefined;
		readonly modelRegistry: UsageSessionModelRegistry;
	};
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void;
	showStatus(message: string): void;
	showError(message: string): void;
	showUsageReport(): void;
}

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

function showUsageMenu(host: UsageCommandHost, client: OpenAICodexUsageResetClient): void {
	host.showSelector((done) => {
		const selector = new UsageActionSelectorComponent({
			title: "Usage",
			subtitle: "Inspect this session or redeem an earned OpenAI subscription reset.",
			items: [
				{ value: "report", label: "Show usage", description: "Tokens, cost, context, and optimization" },
				{
					value: "reset",
					label: "Redeem usage limit reset",
					description: "Check earned reset-pass availability",
				},
			],
			onSelect: (value) => {
				done();
				if (value === "report") {
					host.showUsageReport();
					return;
				}
				void loadResetCredits(host, client);
			},
			onCancel: done,
		});
		return { component: selector, focus: selector };
	});
}

async function loadResetCredits(host: UsageCommandHost, client: OpenAICodexUsageResetClient): Promise<void> {
	const model = host.session.model;
	if (model?.provider !== "openai-codex" || !host.session.modelRegistry.isUsingOAuth(model)) {
		host.showError("Usage limit resets require an active OpenAI Codex subscription lane.");
		return;
	}

	host.showStatus("Checking available usage limit resets...");
	try {
		const accessToken = await host.session.modelRegistry.getApiKeyForProvider(model.provider);
		if (!accessToken) throw new Error("OpenAI Codex subscription credentials are unavailable. Run /login.");
		const auth = { accessToken, baseUrl: model.baseUrl };
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
	client: OpenAICodexUsageResetClient = DEFAULT_RESET_CLIENT,
): void {
	const model = host.session.model;
	if (model?.provider !== "openai-codex" || !host.session.modelRegistry.isUsingOAuth(model)) {
		host.showUsageReport();
		return;
	}
	showUsageMenu(host, client);
}
