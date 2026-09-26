import {
	AnthropicAccountError,
	getAnthropicOAuthUsage,
	getOpenAICodexUsage,
	getOpenRouterAccountUsage,
	OpenAICodexAccountError,
	OpenRouterAccountError,
} from "@caupulican/pi-ai";
import {
	type AccountUsageAdapter,
	type AccountUsageFetchState,
	type AccountUsageRequest,
	type AccountUsageSnapshot,
	ANTHROPIC_PROVIDER,
	type AuthenticatedAccount,
	anthropicUsageSnapshot,
	codexUsageSnapshot,
	OPENAI_CODEX_PROVIDER,
	OPENROUTER_PROVIDER,
	openAICodexCredentialHeaders,
	openRouterUsageSnapshot,
	type UsageOverviewRegistry,
} from "./usage-overview.ts";

export const ACCOUNT_USAGE_TIMEOUT_MS = 10_000;
export const ACCOUNT_USAGE_FRESH_MS = 60_000;
export const ACCOUNT_USAGE_CONCURRENCY = 4;
export const ACCOUNT_USAGE_MIN_INTERVAL_MS = 30_000;

export class AccountCredentialsUnavailableError extends Error {
	constructor() {
		super("Account credentials are unavailable");
		this.name = "AccountCredentialsUnavailableError";
	}
}

function isSubscriptionLogin(account: AuthenticatedAccount): boolean {
	return account.auth === "subscription" || account.auth === "oauth";
}

export function createOpenAICodexUsageAdapter(fetchImpl?: typeof fetch): AccountUsageAdapter {
	return {
		provider: OPENAI_CODEX_PROVIDER,
		request(account, registry) {
			if (!isSubscriptionLogin(account)) return undefined;
			const model = registry.getAll().find((candidate) => candidate.provider === OPENAI_CODEX_PROVIDER);
			return {
				account,
				run: async (signal, isCurrent) => {
					const accessToken = await registry.getApiKeyForProvider(OPENAI_CODEX_PROVIDER);
					if (!accessToken) throw new AccountCredentialsUnavailableError();
					if (!isCurrent()) return undefined;
					return codexUsageSnapshot(
						await getOpenAICodexUsage({
							accessToken,
							credentialHeaders: openAICodexCredentialHeaders(registry, accessToken),
							baseUrl: model?.baseUrl,
							signal,
							...(fetchImpl ? { fetch: fetchImpl } : {}),
						}),
					);
				},
			};
		},
	};
}

export function createAnthropicUsageAdapter(fetchImpl?: typeof fetch): AccountUsageAdapter {
	return {
		provider: ANTHROPIC_PROVIDER,
		request(account, registry) {
			if (!isSubscriptionLogin(account)) return undefined;
			return {
				account,
				run: async (signal, isCurrent) => {
					const accessToken = await registry.getApiKeyForProvider(ANTHROPIC_PROVIDER);
					if (!accessToken) throw new AccountCredentialsUnavailableError();
					if (!isCurrent()) return undefined;
					return anthropicUsageSnapshot(
						await getAnthropicOAuthUsage({ accessToken, signal, ...(fetchImpl ? { fetch: fetchImpl } : {}) }),
					);
				},
			};
		},
	};
}

export function createOpenRouterUsageAdapter(fetchImpl?: typeof fetch): AccountUsageAdapter {
	return {
		provider: OPENROUTER_PROVIDER,
		request(account, registry) {
			const model = registry.getAll().find((candidate) => candidate.provider === OPENROUTER_PROVIDER);
			return {
				account,
				run: async (signal, isCurrent) => {
					const apiKey = await registry.getApiKeyForProvider(OPENROUTER_PROVIDER);
					if (!apiKey) throw new AccountCredentialsUnavailableError();
					if (!isCurrent()) return undefined;
					return openRouterUsageSnapshot(
						await getOpenRouterAccountUsage({
							apiKey,
							baseUrl: model?.baseUrl,
							signal,
							...(fetchImpl ? { fetch: fetchImpl } : {}),
						}),
					);
				},
			};
		},
	};
}

export function describeAccountFailure(error: unknown): string {
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "timed out";
	if (error instanceof AccountCredentialsUnavailableError) return "credentials unavailable (run /login)";
	if (
		error instanceof OpenAICodexAccountError ||
		error instanceof AnthropicAccountError ||
		error instanceof OpenRouterAccountError
	) {
		const status = error.status;
		if (status === undefined || status < 400) return "unreadable response";
		if (status === 401 || status === 403) return `HTTP ${status} (sign-in rejected)`;
		if (status === 429) return "HTTP 429 (rate limited)";
		return `HTTP ${status}`;
	}
	if (error instanceof TypeError) return "network error";
	return "unavailable";
}

interface CachedUsage {
	snapshot?: AccountUsageSnapshot;
	failure?: { at: number; error: string };
}

export interface AccountUsageMonitorOptions {
	adapters?: readonly AccountUsageAdapter[];
	now?: () => number;
	timeoutMs?: number;
	freshMs?: number;
	minIntervalMs?: number;
	concurrency?: number;
}

function retryAfterOf(error: unknown): number | undefined {
	const isAccountError =
		error instanceof OpenAICodexAccountError ||
		error instanceof AnthropicAccountError ||
		error instanceof OpenRouterAccountError;
	return isAccountError && typeof error.retryAfterMs === "number" && error.retryAfterMs > 0
		? error.retryAfterMs
		: undefined;
}

export class AccountUsageMonitor {
	private readonly adapters: readonly AccountUsageAdapter[];
	private readonly now: () => number;
	private readonly timeoutMs: number;
	private readonly freshMs: number;
	private readonly minIntervalMs: number;
	private readonly concurrency: number;
	private readonly notBefore = new Map<string, number>();
	private readonly cache = new Map<string, CachedUsage>();
	private readonly inflight = new Map<string, Promise<void>>();
	private readonly waiting: Array<() => void> = [];
	private active = 0;

	constructor(options: AccountUsageMonitorOptions = {}) {
		this.adapters = options.adapters ?? [
			createOpenAICodexUsageAdapter(),
			createAnthropicUsageAdapter(),
			createOpenRouterUsageAdapter(),
		];
		this.now = options.now ?? Date.now;
		this.timeoutMs = options.timeoutMs ?? ACCOUNT_USAGE_TIMEOUT_MS;
		this.freshMs = options.freshMs ?? ACCOUNT_USAGE_FRESH_MS;
		this.minIntervalMs = options.minIntervalMs ?? ACCOUNT_USAGE_MIN_INTERVAL_MS;
		this.concurrency = Math.max(1, options.concurrency ?? ACCOUNT_USAGE_CONCURRENCY);
	}

	private requestFor(account: AuthenticatedAccount, registry: UsageOverviewRegistry): AccountUsageRequest | undefined {
		return this.adapters.find((adapter) => adapter.provider === account.provider)?.request(account, registry);
	}

	supports(account: AuthenticatedAccount, registry: UsageOverviewRegistry): boolean {
		return this.requestFor(account, registry) !== undefined;
	}

	state(account: AuthenticatedAccount, registry: UsageOverviewRegistry): AccountUsageFetchState {
		if (!this.supports(account, registry)) return { kind: "unsupported" };
		const cached = this.cache.get(account.accountKey);
		if (this.inflight.has(account.accountKey)) {
			return { kind: "pending", ...(cached?.snapshot ? { last: cached.snapshot } : {}) };
		}
		const nextAt = this.notBefore.get(account.accountKey);
		const next = nextAt !== undefined && nextAt > this.now() ? { nextRefreshAt: nextAt } : {};
		if (cached?.failure) {
			return {
				kind: "failed",
				at: cached.failure.at,
				error: cached.failure.error,
				...(cached.snapshot ? { last: cached.snapshot } : {}),
				...next,
			};
		}
		return cached?.snapshot ? { kind: "fetched", snapshot: cached.snapshot, ...next } : { kind: "idle" };
	}

	isInflight(): boolean {
		return this.inflight.size > 0;
	}

	async refresh(
		accounts: readonly AuthenticatedAccount[],
		registry: UsageOverviewRegistry,
		options: { force?: boolean; currentAccountKey(provider: string): string },
	): Promise<void> {
		const keys = new Set(accounts.map((account) => account.accountKey));
		for (const key of [...this.cache.keys()]) if (!keys.has(key)) this.cache.delete(key);
		for (const key of [...this.notBefore.keys()]) if (!keys.has(key)) this.notBefore.delete(key);
		const pending: Promise<void>[] = [];
		const queue: AccountUsageRequest[] = [];
		for (const account of accounts) {
			const running = this.inflight.get(account.accountKey);
			if (running) {
				pending.push(running);
				continue;
			}
			const request = this.requestFor(account, registry);
			if (!request) continue;
			if (this.now() < (this.notBefore.get(account.accountKey) ?? 0)) continue;
			const cached = this.cache.get(account.accountKey);
			const at = cached?.failure?.at ?? cached?.snapshot?.observedAt;
			if (!options.force && at !== undefined && this.now() - at < this.freshMs) continue;
			queue.push(request);
		}
		for (const request of queue) {
			this.notBefore.set(request.account.accountKey, this.now() + this.minIntervalMs);
			const run = this.queued(request, options.currentAccountKey);
			this.inflight.set(request.account.accountKey, run);
			pending.push(run);
		}
		await Promise.all(pending);
	}

	private async queued(request: AccountUsageRequest, currentAccountKey: (provider: string) => string): Promise<void> {
		if (this.active >= this.concurrency) await new Promise<void>((resolve) => this.waiting.push(resolve));
		this.active++;
		try {
			await this.run(request, currentAccountKey);
		} finally {
			this.active--;
			this.waiting.shift()?.();
		}
	}

	private async run(request: AccountUsageRequest, currentAccountKey: (provider: string) => string): Promise<void> {
		const key = request.account.accountKey;
		const previous = this.cache.get(key)?.snapshot;
		try {
			const isCurrent = () => currentAccountKey(request.account.provider) === key;
			if (!isCurrent()) return;
			const result = await request.run(AbortSignal.timeout(this.timeoutMs), isCurrent);
			if (!result) return;
			if (currentAccountKey(request.account.provider) !== key) return;
			this.cache.set(key, { snapshot: { ...result, observedAt: this.now(), source: "account_api" } });
		} catch (error) {
			if (currentAccountKey(request.account.provider) !== key) return;
			const retryAfter = retryAfterOf(error);
			if (retryAfter !== undefined) {
				this.notBefore.set(key, Math.max(this.notBefore.get(key) ?? 0, this.now() + retryAfter));
			}
			this.cache.set(key, {
				...(previous ? { snapshot: previous } : {}),
				failure: { at: this.now(), error: describeAccountFailure(error) },
			});
		} finally {
			this.inflight.delete(key);
		}
	}
}
