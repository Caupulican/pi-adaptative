/**
 * Whether a subscription login still has allowance, read from the account usage the provider reports (`AccountUsageMonitor`):
 * a subscription's work is held by its own limits (a 5 hour window, a weekly one, whatever the account reports), never by
 * dollars, which hold metered (API) spend alone. The decision is code over the snapshot's facts; nothing here asks a
 * model. Credits and on-demand balances are money, so they never count as allowance: only the usage windows and the
 * provider's own limit flags do.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import { DEFAULT_OWNER_QUOTA_MAX_USED_PERCENT } from "../channels/channel-policy.ts";
import { isMeteredSpend } from "../orchestration/risk-budget.ts";
import type { TimerSource } from "../util/timer-port.ts";
import { resolveProviderAccountKey } from "./account-key.ts";
import { AccountUsageMonitor } from "./account-usage-monitor.ts";
import type { ModelExhaustion } from "./gate.ts";
import {
	type AccountUsageSnapshot,
	type AuthenticatedAccount,
	listAuthenticatedAccounts,
	type UsageOverviewRegistry,
	type UsageWindow,
} from "./usage-overview.ts";

/** How old a snapshot may be and still decide; past it the allowance is unknown (no usage window holds the work). */
export const SUBSCRIPTION_ALLOWANCE_MAX_AGE_MS = 5 * 60_000;

export type SubscriptionAllowance =
	| { readonly kind: "room"; readonly usedPercent: number }
	| {
			readonly kind: "exhausted";
			readonly usedPercent: number;
			readonly reason: string;
			/** When every exhausted window resets, if the account reports all of them; the allowance reopens then. */
			readonly retryAt?: number;
	  }
	| { readonly kind: "unknown"; readonly reason: string; readonly subscription: boolean };

/**
 * The ordered exits over one usage snapshot: a missing or stale reading is unknown; a window whose reset time has passed
 * no longer counts (its usage started over), and a reading whose windows have all reset is unknown; a provider-reported
 * limit, or any live window at or past `maxUsedPercent`, is exhausted, reopening when the last of those windows resets;
 * otherwise there is room.
 */
export function decideSubscriptionAllowance(
	snapshot: AccountUsageSnapshot | undefined,
	now: number,
	maxUsedPercent: number,
): SubscriptionAllowance {
	if (!snapshot) return { kind: "unknown", reason: "no usage reading yet", subscription: true };
	if (now - snapshot.observedAt > SUBSCRIPTION_ALLOWANCE_MAX_AGE_MS)
		return { kind: "unknown", reason: "the usage reading is stale", subscription: true };
	if (snapshot.windows.length === 0)
		return { kind: "unknown", reason: "the account reports no usage window", subscription: true };
	const live = snapshot.windows.filter((window) => window.resetsAt === undefined || window.resetsAt > now);
	if (live.length === 0)
		return { kind: "unknown", reason: "every usage window reset after the reading", subscription: true };
	const usedPercent = Math.max(...live.map((window) => window.usedPercent));
	const full = live.filter((window) => window.usedPercent >= maxUsedPercent);
	if (snapshot.limitReached) return exhausted(usedPercent, snapshot.limitReached, full.length > 0 ? full : live);
	if (full.length > 0) return exhausted(usedPercent, `a usage window is at ${Math.round(usedPercent)}%`, full);
	return { kind: "room", usedPercent };
}

function exhausted(usedPercent: number, reason: string, windows: readonly UsageWindow[]): SubscriptionAllowance {
	const resets = windows.map((window) => window.resetsAt);
	const retryAt = resets.every((at) => at !== undefined) ? Math.max(...(resets as number[])) : undefined;
	return { kind: "exhausted", usedPercent, reason, ...(retryAt !== undefined ? { retryAt } : {}) };
}

/** What the owner channel and the cost guard ask: the allowance of a model's subscription (the running model when none is named). */
export interface SubscriptionAllowancePort {
	read(maxUsedPercent: number, forModel?: Model<Api>): SubscriptionAllowance;
	/** The usage account a model's requests count against: the key `subscribe` names and the fleet waits on. */
	accountKey(model: Model<Api>): string;
	/** Hears the key of an account whose reading changed, so a wait on that account (the fleet's allowance term) is asked again. */
	subscribe(listener: (accountKey: string) => void): () => void;
}

/**
 * Whether a model's turns cost no marginal dollars: a subscription login whose account has allowance at the owner-channel
 * quota line, or reports none. Past that line, extra usage is money.
 */
export function hasAllowance(
	registry: { isUsingSubscription(model: Model<Api>): boolean },
	allowance: SubscriptionAllowancePort,
	model: Model<Api>,
): boolean {
	return (
		!isMeteredSpend(model, registry) &&
		allowance.read(DEFAULT_OWNER_QUOTA_MAX_USED_PERCENT, model).kind !== "exhausted"
	);
}

/** A subscription's used-up usage windows, held as a model exhaustion until the last of them resets. */
export interface UsageWindowExhaustion extends ModelExhaustion {
	readonly until: number;
	readonly usageWindow: true;
}

/**
 * How long a subscription's used-up usage holds `model`: until the last of its full windows resets, read at the quota
 * line the fleet's allowance term holds new dispatches at. Undefined while the account has room, when the reading is
 * missing or stale, when the model is not a subscription login, and when the account reports no reset for a full
 * window, because no wait could then end.
 */
export function allowanceExhaustion(
	allowance: SubscriptionAllowancePort,
	model: Model<Api> | undefined,
): UsageWindowExhaustion | undefined {
	if (!model) return undefined;
	const reading = allowance.read(DEFAULT_OWNER_QUOTA_MAX_USED_PERCENT, model);
	return reading.kind === "exhausted" && reading.retryAt !== undefined
		? { until: reading.retryAt, usageWindow: true }
		: undefined;
}

/**
 * The quota exhaustion a model's lanes wait out: the one recorded from a provider's refusal or the used-up usage of its
 * subscription (`allowanceExhaustion`), whichever holds longer. A recorded one with no reset holds open-ended. The
 * usage is never recorded: it is read again at each ask, so it lifts with the first reading that has room. A request held
 * by it past its lane's wait is refused as the account's usage-window limit (`ModelExhaustion.usageWindow`), which a
 * worker's ladder waits out as a usage reset on the same model, so the model is neither marked exhausted nor routed around.
 */
export function heldModelExhaustion(
	recorded: ModelExhaustion | undefined,
	spent: UsageWindowExhaustion | undefined,
): ModelExhaustion | undefined {
	if (!recorded || !spent) return recorded ?? spent;
	return recorded.until === undefined || recorded.until >= spent.until ? recorded : spent;
}

/**
 * The quota exhaustion a request on `ref` waits out: the host's recorded one (`recorded`, from a provider's refusal) or
 * the used-up usage windows of the model's subscription, whichever holds longer (`heldModelExhaustion`).
 */
export function heldExhaustion(
	ref: string,
	recorded: { modelExhaustion(ref: string): ModelExhaustion | undefined },
	allowance: SubscriptionAllowancePort,
	registry: { find(provider: string, modelId: string): Model<Api> | undefined },
): ModelExhaustion | undefined {
	const slash = ref.indexOf("/");
	const model = slash > 0 ? registry.find(ref.slice(0, slash), ref.slice(slash + 1)) : undefined;
	return heldModelExhaustion(recorded.modelExhaustion(ref), allowanceExhaustion(allowance, model));
}

export interface SubscriptionAllowanceReaderDeps {
	getRegistry(): UsageOverviewRegistry & { isUsingSubscription(model: Model<Api>): boolean };
	readonly monitor: Pick<AccountUsageMonitor, "state" | "refresh">;
	/** The model the turns run on now. */
	getModel(): Model<Api> | undefined;
	currentAccountKey(provider: string): string;
	now(): number;
}

/**
 * The cached reading of the running model's subscription, synchronously: each read also asks the monitor for a refresh
 * (it spaces its own requests), so a reading is there by the time the next one is asked. A model that is not a
 * subscription login, an account the monitor cannot read, and a failed or missing reading are all unknown.
 */
export class SubscriptionAllowanceReader implements SubscriptionAllowancePort {
	private readonly deps: SubscriptionAllowanceReaderDeps;
	private readonly listeners = new Set<(accountKey: string) => void>();

	constructor(deps: SubscriptionAllowanceReaderDeps) {
		this.deps = deps;
	}

	/**
	 * Calls `listener` with the account's key each time a refresh this reader asked for brings a different usage reading
	 * (a new observation time). A refresh that finds the reading fresh, or fails without a new one, stays silent.
	 */
	subscribe(listener: (accountKey: string) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** The usage account a model's requests count against; the provider id when it is not signed in. */
	accountKey(model: Model<Api>): string {
		return this.accountFor(model)?.accountKey ?? model.provider;
	}

	read(maxUsedPercent: number, forModel?: Model<Api>): SubscriptionAllowance {
		const model = forModel ?? this.deps.getModel();
		const registry = this.deps.getRegistry();
		if (!model || isMeteredSpend(model, registry))
			return { kind: "unknown", reason: "the model is not a subscription login", subscription: false };
		const account = this.accountFor(model);
		if (!account) return { kind: "unknown", reason: "the account is not signed in", subscription: true };
		const state = this.deps.monitor.state(account, registry);
		if (state.kind === "unsupported")
			return { kind: "unknown", reason: "the provider reports no usage", subscription: true };
		const snapshot = snapshotOf(state);
		void this.deps.monitor
			.refresh([account], registry, { currentAccountKey: this.deps.currentAccountKey })
			.then(() => {
				const next = snapshotOf(this.deps.monitor.state(account, registry));
				if (next?.observedAt === snapshot?.observedAt) return;
				for (const listener of [...this.listeners]) {
					try {
						listener(account.accountKey);
					} catch {
						// A listener's failure never stops the others from hearing the new reading.
					}
				}
			})
			.catch(() => undefined);
		return decideSubscriptionAllowance(snapshot, this.deps.now(), maxUsedPercent);
	}

	private accountFor(model: Model<Api>): AuthenticatedAccount | undefined {
		return listAuthenticatedAccounts(this.deps.getRegistry()).find(
			(candidate) => candidate.provider === model.provider,
		);
	}
}

function snapshotOf(state: ReturnType<AccountUsageMonitor["state"]>): AccountUsageSnapshot | undefined {
	return state.kind === "fetched"
		? state.snapshot
		: state.kind === "pending" || state.kind === "failed"
			? state.last
			: undefined;
}

/** The production reader of a session: its own usage monitor over the provider's usage endpoint, for the registry and model it names. */
export function createSubscriptionAllowanceReader(
	deps: Pick<SubscriptionAllowanceReaderDeps, "getRegistry" | "getModel"> & { now?: () => number },
): SubscriptionAllowanceReader {
	const now = deps.now ?? (() => Date.now());
	return new SubscriptionAllowanceReader({
		...deps,
		monitor: new AccountUsageMonitor({ now }),
		currentAccountKey: (provider) => resolveProviderAccountKey(deps.getRegistry().authStorage, provider),
		now,
	});
}

/** The session's subscription allowance port: an injected port as-is, or a production reader on its `provider-admission` clock. */
export function openSubscriptionAllowance(
	config: {
		subscriptionAllowance?: SubscriptionAllowancePort;
		modelRegistry: ReturnType<SubscriptionAllowanceReaderDeps["getRegistry"]>;
		timers: Pick<TimerSource, "port">;
	},
	getModel: SubscriptionAllowanceReaderDeps["getModel"],
): SubscriptionAllowancePort {
	return (
		config.subscriptionAllowance ??
		createSubscriptionAllowanceReader({
			getRegistry: () => config.modelRegistry,
			getModel,
			now: () => config.timers.port("provider-admission").now(),
		})
	);
}
