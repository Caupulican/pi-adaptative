import type {
	AnthropicOAuthUsage,
	Api,
	Model,
	OpenAICodexLimitReachedType,
	OpenAICodexUsage,
	OpenRouterAccountUsage,
} from "@caupulican/pi-ai";
import type { AuthCredential } from "../auth-storage.ts";
import type { SessionCostSummary } from "../cost/cost-summary.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { describeProviderAccountKey, providerAccountKey } from "./account-key.ts";
import { entryKey } from "./ledger.ts";
import type { ProviderLimitReason, ProviderUsageRecord } from "./limit-state.ts";
import type { ProviderLoadView } from "./load-view.ts";

export interface UsageWindow {
	label: string;
	usedPercent: number;
	resetsAt?: number;
	detail?: string;
}

export interface AccountUsageSnapshot {
	observedAt: number;
	source: "account_api" | "response_headers";
	plan?: string;
	windows: UsageWindow[];
	balance?: string;
	limitReached?: string;
	resetCredits?: number;
	details?: string[];
}

export type AccountUsageFetchState =
	| { kind: "unsupported" }
	| { kind: "idle" }
	| { kind: "pending"; last?: AccountUsageSnapshot }
	| { kind: "fetched"; snapshot: AccountUsageSnapshot; nextRefreshAt?: number }
	| { kind: "failed"; at: number; error: string; last?: AccountUsageSnapshot; nextRefreshAt?: number };

export type AccountAuthKind = "subscription" | "oauth" | "api_key" | "environment" | "models_json" | "headers";

export interface AuthenticatedAccount {
	provider: string;
	displayName: string;
	accountKey: string;
	accountLabel: string;
	auth: AccountAuthKind;
}

export interface AccountOverview extends AuthenticatedAccount {
	inflight: { foreground: number; worker: number; background: number };
	limit?: { until: number; reason: ProviderLimitReason; detail?: string };
	passive?: AccountUsageSnapshot;
	fetch: AccountUsageFetchState;
	canRedeemReset: boolean;
}

export interface UsageOverview {
	at: number;
	session: {
		costUsd: number;
		subagentCostUsd: number;
		subscription: boolean;
		tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
		context: { tokens: number | null; window: number; percent: number | null } | null;
	};
	today: { costUsd: number; subagentCostUsd: number };
	machine: {
		inflight: number;
		otherAccountsInflight: number;
		otherAccountLimits: number;
		emergencyStop: { engaged: boolean; reason?: string };
	};
	accounts: AccountOverview[];
}

export interface UsageOverviewRegistry {
	getAll(): Model<Api>[];
	getAuthenticatedProviders(): string[];
	getProviderDisplayName(provider: string): string;
	getProviderAuthStatus(provider: string): { configured: boolean; source?: string };
	getApiKeyForProvider(provider: string): Promise<string | undefined>;
	readonly authStorage: {
		get(provider: string): AuthCredential | undefined;
		getOAuthProviders(): ReadonlyArray<{ id: string; isSubscription?: boolean }>;
		getOAuthRequestHeaders(provider: string, apiKey: string): Record<string, string> | undefined;
	};
}

export interface AccountUsageRequest {
	account: AuthenticatedAccount;
	run(signal: AbortSignal): Promise<Omit<AccountUsageSnapshot, "observedAt" | "source">>;
}

export interface AccountUsageAdapter {
	provider: string;
	request(account: AuthenticatedAccount, registry: UsageOverviewRegistry): AccountUsageRequest | undefined;
}

export const OPENAI_CODEX_PROVIDER = "openai-codex";

export function openAICodexCredentialHeaders(
	registry: UsageOverviewRegistry,
	accessToken: string,
): Record<string, string> | undefined {
	return registry.authStorage.getOAuthRequestHeaders(OPENAI_CODEX_PROVIDER, accessToken);
}
export const ANTHROPIC_PROVIDER = "anthropic";
export const OPENROUTER_PROVIDER = "openrouter";

function authKind(registry: UsageOverviewRegistry, provider: string): AccountAuthKind {
	let credential: AuthCredential | undefined;
	try {
		credential = registry.authStorage.get(provider);
	} catch {
		credential = undefined;
	}
	if (credential?.type === "oauth") {
		return registry.authStorage.getOAuthProviders().some((oauth) => oauth.id === provider && oauth.isSubscription)
			? "subscription"
			: "oauth";
	}
	if (credential) return "api_key";
	const source = registry.getProviderAuthStatus(provider).source;
	if (source === "environment" || source === "runtime") return "environment";
	if (source === "models_json_key" || source === "models_json_command") return "models_json";
	return "headers";
}

export function listAuthenticatedAccounts(registry: UsageOverviewRegistry): AuthenticatedAccount[] {
	return registry.getAuthenticatedProviders().map((provider) => {
		let credential: AuthCredential | undefined;
		try {
			credential = registry.authStorage.get(provider);
		} catch {
			credential = undefined;
		}
		const accountKey = providerAccountKey(provider, credential);
		return {
			provider,
			displayName: registry.getProviderDisplayName(provider),
			accountKey,
			accountLabel: describeProviderAccountKey(accountKey).slice(provider.length).trim(),
			auth: authKind(registry, provider),
		};
	});
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function providerText(value: string, maxChars = 48): string {
	const cleaned = value
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1)}…` : cleaned;
}

const NAMED_WINDOWS: ReadonlyArray<readonly [number, string]> = [
	[5 * 60, "5h"],
	[24 * 60, "daily"],
	[7 * 24 * 60, "weekly"],
	[30 * 24 * 60, "monthly"],
	[365 * 24 * 60, "annual"],
];

export function windowLabel(name: string, seconds: number | undefined): string {
	if (seconds === undefined || seconds <= 0) return providerText(name);
	const minutes = Math.ceil(seconds / 60);
	const named = NAMED_WINDOWS.find(([expected]) => minutes >= expected * 0.95 && minutes <= expected * 1.05)?.[1];
	const span = named ?? (minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes}m`);
	return `${providerText(name)} ${span}`;
}

function passiveWindow(name: string, value: unknown): UsageWindow | undefined {
	if (!isPlainRecord(value)) return undefined;
	const usedPercent = finite(value.usedPercent);
	if (usedPercent === undefined) return undefined;
	const minutes = finite(value.windowMinutes);
	const resetsAt = finite(value.resetsAt);
	return {
		label: windowLabel(name, minutes === undefined ? undefined : minutes * 60),
		usedPercent,
		...(resetsAt !== undefined && resetsAt > 0 ? { resetsAt: resetsAt * 1000 } : {}),
	};
}

const NUMERIC_BALANCE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function formatCodexCredits(credits: {
	hasCredits: boolean;
	unlimited: boolean;
	balance?: string;
}): string | undefined {
	if (credits.unlimited) return "credits unlimited";
	if (!credits.hasCredits) return undefined;
	const raw = credits.balance?.trim() ?? "";
	const value = NUMERIC_BALANCE.test(raw) ? Number(raw) : Number.NaN;
	return Number.isFinite(value) && value > 0 && value < 1e15
		? `${Math.round(value).toLocaleString("en-US")} credits`
		: "credits available";
}

export function passiveSnapshot(record: ProviderUsageRecord): AccountUsageSnapshot | undefined {
	const windows: UsageWindow[] = [];
	for (const entry of record.rateLimits) {
		if (!isPlainRecord(entry)) continue;
		const name =
			typeof entry.limitName === "string" && entry.limitName.trim()
				? entry.limitName.trim()
				: typeof entry.limitId === "string" && entry.limitId.trim()
					? entry.limitId.trim()
					: "window";
		for (const key of ["primary", "secondary"] as const) {
			const window = passiveWindow(name, entry[key]);
			if (window) windows.push(window);
		}
	}
	const balance = record.credits ? formatCodexCredits(record.credits) : undefined;
	if (windows.length === 0 && !balance) return undefined;
	return {
		observedAt: record.at,
		source: "response_headers",
		windows,
		...(balance ? { balance } : {}),
	};
}

const CODEX_LIMIT_REACHED_TEXT: Readonly<Record<OpenAICodexLimitReachedType, string>> = {
	rate_limit_reached: "rate limit reached",
	workspace_owner_credits_depleted: "workspace owner credits depleted",
	workspace_member_credits_depleted: "workspace member credits depleted",
	workspace_owner_usage_limit_reached: "workspace owner usage limit reached",
	workspace_member_usage_limit_reached: "workspace member usage limit reached",
	unknown: "limit reached (unrecognized reason)",
};

export function codexUsageSnapshot(usage: OpenAICodexUsage): Omit<AccountUsageSnapshot, "observedAt" | "source"> {
	const windows: UsageWindow[] = [];
	for (const limit of usage.limits) {
		for (const window of [limit.primary, limit.secondary]) {
			if (!window) continue;
			windows.push({
				label: windowLabel(limit.name, window.windowSeconds),
				usedPercent: window.usedPercent,
				...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt * 1000 } : {}),
			});
		}
	}
	const balance = usage.credits ? formatCodexCredits(usage.credits) : undefined;
	const monthly = usage.spendControl?.individualLimit;
	if (monthly) {
		windows.push({
			label: "monthly credit limit",
			usedPercent: monthly.usedPercent,
			...(monthly.resetsAt !== undefined ? { resetsAt: monthly.resetsAt * 1000 } : {}),
			detail: `${monthly.used} of ${monthly.limit} credits used`,
		});
	}
	const reasons = [
		...(usage.limitReachedType ? [CODEX_LIMIT_REACHED_TEXT[usage.limitReachedType]] : []),
		...usage.limits
			.filter((limit) => limit.allowed === false || limit.limitReached === true)
			.map((limit) => `${providerText(limit.name)} ${limit.allowed === false ? "not allowed" : "limit reached"}`),
		...(usage.spendControl?.reached ? ["spend limit reached"] : []),
	];
	const limitReached = reasons.length > 0 ? [...new Set(reasons)].join("; ") : undefined;
	return {
		windows,
		...(usage.planType ? { plan: providerText(usage.planType, 24) } : {}),
		...(balance ? { balance } : {}),
		...(limitReached ? { limitReached } : {}),
		...(usage.resetCreditsAvailable !== undefined ? { resetCredits: usage.resetCreditsAvailable } : {}),
	};
}

const ANTHROPIC_WINDOW_LABELS: Readonly<Record<string, string>> = {
	five_hour: "5h",
	seven_day: "7d",
	seven_day_opus: "7d opus",
	seven_day_sonnet: "7d sonnet",
	seven_day_oauth_apps: "7d oauth apps",
};

export function anthropicUsageSnapshot(
	usage: AnthropicOAuthUsage,
): Omit<AccountUsageSnapshot, "observedAt" | "source"> {
	const locked = usage.windows.find((window) => window.lockedReason);
	const extra = usage.extraUsage;
	const balance = !extra
		? undefined
		: !extra.enabled
			? "extra usage disabled"
			: extra.usedCredits !== undefined && extra.monthlyLimit !== undefined
				? `extra usage ${extra.usedCredits.toFixed(2)} / ${extra.monthlyLimit.toFixed(2)} ${extra.currency ?? "USD"}`
				: "extra usage enabled";
	return {
		...(balance ? { balance } : {}),
		windows: usage.windows.map((window) => ({
			label: ANTHROPIC_WINDOW_LABELS[window.name] ?? window.name,
			usedPercent: window.usedPercent,
			...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
		})),
		...(locked?.lockedReason ? { limitReached: providerText(locked.lockedReason) } : {}),
	};
}

function usd(value: number): string {
	return `$${value.toFixed(2)}`;
}

export function openRouterUsageSnapshot(
	usage: OpenRouterAccountUsage,
): Omit<AccountUsageSnapshot, "observedAt" | "source"> {
	const key = usage.key ?? {};
	const windows: UsageWindow[] = [];
	if (
		key.limit !== undefined &&
		key.limit > 0 &&
		key.limitRemaining !== undefined &&
		key.limitRemaining <= key.limit
	) {
		windows.push({
			label: "key limit",
			usedPercent: ((key.limit - key.limitRemaining) / key.limit) * 100,
			detail: `${usd(key.limitRemaining)} of ${usd(key.limit)} left${key.limitReset ? ` · resets ${key.limitReset}` : ""}`,
		});
	}
	const spend = [
		key.usage !== undefined ? `${usd(key.usage)} total` : undefined,
		key.usageDaily !== undefined ? `${usd(key.usageDaily)} today` : undefined,
		key.usageWeekly !== undefined ? `${usd(key.usageWeekly)} this week` : undefined,
		key.usageMonthly !== undefined ? `${usd(key.usageMonthly)} this month` : undefined,
	].filter(Boolean);
	return {
		windows,
		balance: `${usd(Math.max(0, usage.totalCredits - usage.totalUsage))} credit left of ${usd(usage.totalCredits)}`,
		...(usage.keyUnavailable
			? { details: ["key limit and spend unavailable (key request failed)"] }
			: spend.length > 0
				? { details: [`key spend ${spend.join(" · ")}`] }
				: {}),
	};
}

export interface UsageOverviewInput {
	now: number;
	cost: Pick<SessionCostSummary, "currentCost" | "subagentCost" | "todayCost" | "todaySubagentCost">;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
	context?: { tokens: number | null; contextWindow: number; percent: number | null };
	subscription: boolean;
	load: ProviderLoadView;
	accounts: AuthenticatedAccount[];
	fetchState(account: AuthenticatedAccount): AccountUsageFetchState;
	canRedeemReset(account: AuthenticatedAccount): boolean;
}

export function buildUsageOverview(input: UsageOverviewInput): UsageOverview {
	const current = new Set(input.accounts.map((account) => account.accountKey));
	const otherInflight = input.load.inflight.filter((entry) => !current.has(entryKey(entry))).length;
	const otherLimits = input.load.limits.filter((limit) => !current.has(limit.provider)).length;
	return {
		at: input.now,
		session: {
			costUsd: input.cost.currentCost,
			subagentCostUsd: input.cost.subagentCost,
			subscription: input.subscription,
			tokens: input.tokens,
			context: input.context
				? { tokens: input.context.tokens, window: input.context.contextWindow, percent: input.context.percent }
				: null,
		},
		today: { costUsd: input.cost.todayCost, subagentCostUsd: input.cost.todaySubagentCost },
		machine: {
			inflight: input.load.inflight.length,
			otherAccountsInflight: otherInflight,
			otherAccountLimits: otherLimits,
			emergencyStop: {
				engaged: input.load.emergencyStop.engaged,
				...(input.load.emergencyStop.reason ? { reason: input.load.emergencyStop.reason } : {}),
			},
		},
		accounts: input.accounts.map((account) => {
			const inflight = { foreground: 0, worker: 0, background: 0 };
			for (const entry of input.load.inflight) if (entryKey(entry) === account.accountKey) inflight[entry.lane] += 1;
			const limit = input.load.limits.find((record) => record.provider === account.accountKey);
			const usage = input.load.usage.find((record) => record.provider === account.accountKey);
			const passive = usage ? passiveSnapshot(usage) : undefined;
			return {
				...account,
				inflight,
				...(limit
					? {
							limit: {
								until: limit.limitedUntil,
								reason: limit.reason,
								...(limit.detail ? { detail: limit.detail } : {}),
							},
						}
					: {}),
				...(passive ? { passive } : {}),
				fetch: input.fetchState(account),
				canRedeemReset: input.canRedeemReset(account),
			};
		}),
	};
}
