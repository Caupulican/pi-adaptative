/**
 * The local lanes' claims on the two room terms that follow a worker across its run: the account window it occupies
 * (`capacity/account-window.ts`) and the metered dollars it reserves (`capacity/cost-room.ts`). A worker claims both when
 * it starts and settles both when its run ends; a claim whose attempt is no longer live (a start that failed between its
 * claim and its run, a run whose end was never reported) is settled by the next selection pass, so a lost release never
 * shrinks an account's room or a budget for good.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import type { ResolvedFleetSettings } from "../settings/settings-schema.ts";
import { type AccountWindowCaller, type AccountWindows, accountWindowsFor } from "./capacity/account-window.ts";
import { allowanceWaitKey } from "./capacity/allowance-room.ts";
import { MeteredSpend } from "./capacity/cost-room.ts";
import type { RoomTerm } from "./fleet-types.ts";

export type SpendBrakeState = { readonly engaged: true; readonly text: string } | { readonly engaged: false };

export interface FleetLocalClaimsDeps {
	readonly agentDir: string;
	now(): number;
	settings(): ResolvedFleetSettings;
	/** The provider account a model's requests are charged to (the provider gate's keying); absent leaves windows out. */
	accountKey?(provider: string): string;
	/** The owner's concurrency limit for a provider (`providerAdmission.limits`), when set. */
	providerLimit?(provider: string): number | undefined;
	/** True when a model's work is paid per request (an API key), not a subscription login; absent means none is. */
	isMetered?(model: Model<Api>): boolean;
	onBrake?(state: SpendBrakeState): void;
}

interface Claim {
	readonly releaseWorker?: () => void;
	/** The worker's work is paid per request: its cost is charged at release, whatever model it finished on. */
	readonly metered: boolean;
	readonly objectiveId?: string;
}

export class FleetLocalClaims {
	private readonly deps: FleetLocalClaimsDeps;
	private readonly windows: AccountWindows | undefined;
	/** This fleet's own clock and ceiling, passed into every window read it makes. */
	private readonly caller: AccountWindowCaller;
	private readonly spend: MeteredSpend;
	private readonly claims = new Map<string, Claim>();

	constructor(deps: FleetLocalClaimsDeps) {
		this.deps = deps;
		this.windows = deps.accountKey ? accountWindowsFor(deps.agentDir) : undefined;
		this.caller = { now: deps.now, ceiling: () => deps.settings().ceiling.running };
		this.spend = new MeteredSpend({
			agentDir: deps.agentDir,
			now: deps.now,
			settings: () => {
				const { budgets, brake } = deps.settings();
				return {
					meteredUsdPerDay: budgets.meteredUsdPerDay,
					meteredUsdPerGoal: budgets.meteredUsdPerGoal,
					brakeMinUsd: brake.minUsd,
				};
			},
			...(deps.onBrake ? { onBrake: deps.onBrake } : {}),
		});
	}

	/** Calls `listener` with the wait key of an account whose window grew or reopened. */
	subscribe(listener: (waitKey: string) => void): () => void {
		return this.windows?.subscribe((accountKey) => listener(allowanceWaitKey(accountKey))) ?? (() => {});
	}

	/** The account-window and cost terms for one more worker on `model`. */
	terms(model: Model<Api>, objectiveId: string | undefined, estimatedTokens?: number): RoomTerm[] {
		const terms: RoomTerm[] = [];
		const accountKey = this.deps.accountKey?.(model.provider);
		if (this.windows && accountKey !== undefined)
			terms.push(this.windows.term(accountKey, this.deps.providerLimit?.(model.provider), this.caller));
		const estimateUsd = this.meteredEstimate(model, estimatedTokens);
		if (estimateUsd !== undefined) {
			const cost = this.spend.term({ estimateUsd, ...(objectiveId ? { objectiveId } : {}) });
			if (cost) terms.push(cost);
		}
		return terms;
	}

	/** A local worker on `model` started: it occupies its account's window and reserves its metered estimate. */
	admitted(attemptId: string, model: Model<Api>, objectiveId: string | undefined): void {
		if (this.claims.has(attemptId)) return;
		const accountKey = this.deps.accountKey?.(model.provider);
		const estimateUsd = this.meteredEstimate(model, undefined);
		if (estimateUsd !== undefined)
			this.spend.reserve(attemptId, {
				modelRef: `${model.provider}/${model.id}`,
				usd: estimateUsd,
				...(objectiveId ? { objectiveId } : {}),
			});
		this.claims.set(attemptId, {
			...(this.windows && accountKey !== undefined ? { releaseWorker: this.windows.acquireWorker(accountKey) } : {}),
			metered: this.deps.isMetered?.(model) === true,
			...(objectiveId ? { objectiveId } : {}),
		});
	}

	/**
	 * A local worker's run ended: its window claim ends and its measured cost is charged when the work is metered, on its
	 * start model or on the model it finished on (`finalModel`, a failover to a metered candidate). `terminal` says the attempt
	 * has ended and will not run again; the charge's record is then the first the shared file evicts.
	 */
	released(attemptId: string, measuredUsd: () => number | undefined, finalModel?: Model<Api>, terminal = false): void {
		const claim = this.claims.get(attemptId);
		if (!claim) return;
		this.claims.delete(attemptId);
		claim.releaseWorker?.();
		const metered = claim.metered || (finalModel !== undefined && this.deps.isMetered?.(finalModel) === true);
		if (metered) this.spend.charge(attemptId, measuredUsd(), claim.objectiveId, terminal);
	}

	/** Settles every claim whose attempt is no longer live: such an attempt has ended. */
	prune(isLive: (attemptId: string) => boolean, measuredUsd: (attemptId: string) => number | undefined): void {
		for (const attemptId of [...this.claims.keys()])
			if (!isLive(attemptId)) this.released(attemptId, () => measuredUsd(attemptId), undefined, true);
	}

	/** The jitter added to a reopen alarm of an account wait key; 0 for any other resource. */
	reopenJitterMs(waitKey: string, at: number): number {
		const prefix = allowanceWaitKey("");
		return this.windows && waitKey.startsWith(prefix)
			? this.windows.reopenJitterMs(waitKey.slice(prefix.length), at)
			: 0;
	}

	/** After a resume or a restart, every window releases half of itself until its first success; a resume lifts the brake. */
	rampAll(): void {
		this.windows?.rampAll();
	}

	liftBrake(): void {
		this.spend.liftBrake();
	}

	/** The accounts' windows as room per account, for the room snapshot. */
	perAccount(): { accountKey: string; room: number; retryAt?: number }[] {
		const now = this.deps.now();
		return (this.windows?.snapshot(this.caller) ?? []).map((account) =>
			account.blockedUntil !== undefined && account.blockedUntil > now
				? { accountKey: account.accountKey, room: 0, retryAt: account.blockedUntil }
				: { accountKey: account.accountKey, room: Math.max(0, account.window - account.running) },
		);
	}

	/**
	 * Releases every claim (the scheduler is disposed). Their attempts may be suspended and resumed by another process, so none
	 * is marked terminal here.
	 */
	dispose(measuredUsd: (attemptId: string) => number | undefined): void {
		for (const attemptId of [...this.claims.keys()]) this.released(attemptId, () => measuredUsd(attemptId));
		this.spend.close();
	}

	private meteredEstimate(model: Model<Api>, estimatedTokens: number | undefined): number | undefined {
		if (!this.deps.isMetered?.(model)) return undefined;
		const estimate = this.spend.estimate(model, estimatedTokens);
		return estimate > 0 ? estimate : undefined;
	}
}
