/**
 * Whether a subscription login still has allowance, read from the account usage the provider reports (`AccountUsageMonitor`):
 * the owner channel lets a turn run past its dollar ceilings while the subscription's own limits (a 5 hour window, a
 * weekly one, whatever the account reports) have room. The decision is code over the snapshot's facts; nothing here asks a
 * model. Credits and on-demand balances are money, so they never count as allowance: only the usage windows and the
 * provider's own limit flags do.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import type { AccountUsageMonitor } from "./account-usage-monitor.ts";
import {
	type AccountUsageSnapshot,
	type AuthenticatedAccount,
	listAuthenticatedAccounts,
	type UsageOverviewRegistry,
} from "./usage-overview.ts";

/** How old a snapshot may be and still decide; past it the allowance is unknown (the dollar ceilings apply). */
export const SUBSCRIPTION_ALLOWANCE_MAX_AGE_MS = 5 * 60_000;

export type SubscriptionAllowance =
	| { readonly kind: "room"; readonly usedPercent: number }
	| { readonly kind: "exhausted"; readonly usedPercent: number; readonly reason: string }
	| { readonly kind: "unknown"; readonly reason: string };

/**
 * The ordered exits over one usage snapshot: a missing or stale reading is unknown; a provider-reported limit, or any
 * window at or past `maxUsedPercent`, is exhausted; otherwise there is room.
 */
export function decideSubscriptionAllowance(
	snapshot: AccountUsageSnapshot | undefined,
	now: number,
	maxUsedPercent: number,
): SubscriptionAllowance {
	if (!snapshot) return { kind: "unknown", reason: "no usage reading yet" };
	if (now - snapshot.observedAt > SUBSCRIPTION_ALLOWANCE_MAX_AGE_MS)
		return { kind: "unknown", reason: "the usage reading is stale" };
	if (snapshot.windows.length === 0) return { kind: "unknown", reason: "the account reports no usage window" };
	const usedPercent = Math.max(...snapshot.windows.map((window) => window.usedPercent));
	if (snapshot.limitReached) return { kind: "exhausted", usedPercent, reason: snapshot.limitReached };
	if (usedPercent >= maxUsedPercent)
		return { kind: "exhausted", usedPercent, reason: `a usage window is at ${Math.round(usedPercent)}%` };
	return { kind: "room", usedPercent };
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
export class SubscriptionAllowanceReader {
	private readonly deps: SubscriptionAllowanceReaderDeps;

	constructor(deps: SubscriptionAllowanceReaderDeps) {
		this.deps = deps;
	}

	read(maxUsedPercent: number): SubscriptionAllowance {
		const model = this.deps.getModel();
		const registry = this.deps.getRegistry();
		if (!model || !registry.isUsingSubscription(model))
			return { kind: "unknown", reason: "the model is not a subscription login" };
		const account: AuthenticatedAccount | undefined = listAuthenticatedAccounts(registry).find(
			(candidate) => candidate.provider === model.provider,
		);
		if (!account) return { kind: "unknown", reason: "the account is not signed in" };
		const state = this.deps.monitor.state(account, registry);
		if (state.kind === "unsupported") return { kind: "unknown", reason: "the provider reports no usage" };
		void this.deps.monitor
			.refresh([account], registry, { currentAccountKey: this.deps.currentAccountKey })
			.catch(() => undefined);
		const snapshot =
			state.kind === "fetched"
				? state.snapshot
				: state.kind === "pending" || state.kind === "failed"
					? state.last
					: undefined;
		return decideSubscriptionAllowance(snapshot, this.deps.now(), maxUsedPercent);
	}
}
