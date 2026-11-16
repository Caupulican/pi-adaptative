/**
 * Owns the spend budget shared by a sequence of model requests, with projected admission, measured settlement and the refusal error for a controlled spending hold.
 */
import type { Api, Model } from "@caupulican/pi-ai";
import { harnessLog } from "../../kernel/harness-log.ts";
import { isMeteredSpend, type ModelBilling } from "../orchestration/risk-budget.ts";

/** The billing a dollar limit reads: a credential's billing kind, and the model a usage receipt names. */
export interface SpendBilling extends ModelBilling {
	find(provider: string, modelId: string): Model<Api> | undefined;
}

/**
 * Whether spend on `model` counts against a dollar limit read under `billing`: metered spend only (`isMeteredSpend`),
 * since a subscription's limit is its plan's usage windows. A limit that reads no billing counts every spend.
 */
export function countsAgainstDollars(model: Model<Api> | undefined, billing: ModelBilling | undefined): boolean {
	return billing === undefined || isMeteredSpend(model, billing);
}

/** The same for spend a usage receipt names by provider and model; a model the registry does not hold (System One's) is metered. */
export function receiptCountsAgainstDollars(
	spend: { readonly provider: string; readonly model: string },
	billing: SpendBilling,
): boolean {
	return isMeteredSpend(billing.find(spend.provider, spend.model), billing);
}

/** The same for spend an engine names by its `provider/model` reference; a reference with no such model (System One's) is metered. */
export function referenceCountsAgainstDollars(reference: string, billing: SpendBilling | undefined): boolean {
	const slash = reference.indexOf("/");
	return (
		billing === undefined ||
		slash <= 0 ||
		receiptCountsAgainstDollars({ provider: reference.slice(0, slash), model: reference.slice(slash + 1) }, billing)
	);
}

/** Controlled spending hold; callers must not retry it as a provider outage. */
export class RequestSpendRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RequestSpendRefusal";
	}
}

/** Transport wrappers may retain paid receipts while preserving this refusal as their cause. */
export function isRequestSpendRefusal(error: unknown): boolean {
	for (let depth = 0; depth < 8 && error instanceof Error; depth++) {
		if (error instanceof RequestSpendRefusal) return true;
		error = error.cause;
	}
	return false;
}

/** Projected admission and measured settlement shared by a sequence of model requests. */
export class RequestSpendBudget {
	private readonly maxUsd: number;
	private spentUsd = 0;
	private readonly charges = new Map<string, number>();
	private failure: RequestSpendRefusal | undefined;
	private pending: string | undefined;
	private readonly admissionListeners = new Set<(requestId: string) => void>();
	private readonly gate: (() => void) | undefined;
	private readonly billing: ModelBilling | undefined;
	/** Admitted requests whose spend is not metered: none of their dollars is projected against or charged to `maxUsd`. */
	private readonly unmetered = new Set<string>();

	/**
	 * `gate` is the caller's cooperative stop. It runs when a physical request is admitted, before any admission
	 * checkpoint. If it throws, only that request is withheld, before dispatch; the budget is never failed, and
	 * requests already sent are not touched.
	 * `billing`, when given, makes `maxUsd` a limit on metered spend (`countsAgainstDollars`): a request on a subscription
	 * model passes every other check here and is neither projected against nor charged to it.
	 */
	constructor(maxUsd: number, gate?: () => void, billing?: ModelBilling) {
		if (!Number.isFinite(maxUsd) || maxUsd < 0) throw new Error("Request spending limit must be non-negative.");
		this.maxUsd = maxUsd;
		this.gate = gate;
		this.billing = billing;
	}

	/** Bounded synchronous work checkpoints at the physical request boundary; not another spend counter. */
	subscribeAdmission(listener: (requestId: string) => void): () => void {
		if (this.admissionListeners.size >= 32) throw new Error("Request admission listener capacity exceeded");
		this.admissionListeners.add(listener);
		return () => {
			this.admissionListeners.delete(listener);
		};
	}

	/** Callers serialize requests sharing this budget; preflight never reserves or records a charge. */
	remainingUsd(): number {
		this.assertHealthy();
		return Math.max(0, this.maxUsd - this.spentUsd);
	}

	/** The dollars a request on `model` may be projected against; undefined when its spend is not metered. */
	remainingUsdFor(model: Model<Api>): number | undefined {
		const remaining = this.remainingUsd();
		return countsAgainstDollars(model, this.billing) ? remaining : undefined;
	}

	assertAffordable(projectedUsd: number): void {
		if (!Number.isFinite(projectedUsd) || projectedUsd < 0 || projectedUsd > this.remainingUsd()) {
			harnessLog.warn("cost", "a request was refused: the remaining budget cannot cover it", () => ({
				projectedUsd,
				remainingUsd: Math.max(0, this.maxUsd - this.spentUsd),
			}));
			throw new RequestSpendRefusal("The remaining budget cannot cover the next projected request.");
		}
	}

	/**
	 * The last refusable step before transport: callers run every other refusal first, so a checkpoint written by an
	 * admission listener always belongs to a dispatched request. A cancelled logical caller cannot start another
	 * request while billing is still unknown. `model` is the dispatched model; a request that names none is metered.
	 */
	beginRequest(receiptId: string, model?: Model<Api>): void {
		this.assertHealthy();
		this.gate?.();
		this.pending = receiptId;
		if (!countsAgainstDollars(model, this.billing)) this.unmetered.add(receiptId);
		try {
			for (const listener of this.admissionListeners) listener(receiptId);
		} catch {
			this.fail("A request admission checkpoint failed; dispatch and further spending are suspended.");
			this.assertHealthy();
		}
	}

	endRequest(receiptId: string): void {
		if (this.pending === receiptId) this.pending = undefined;
		this.unmetered.delete(receiptId);
	}

	/** Record before checking health, so even an overspend never interrupts durable usage delivery. */
	record(receiptId: string, costUsd: number, measuredTokens: number): void {
		if (!Number.isFinite(costUsd) || costUsd < 0) {
			this.fail("A model response has no valid measured cost.");
			return;
		}
		const previous = this.charges.get(receiptId);
		if (previous !== undefined) {
			if (previous !== costUsd) this.fail("A response receipt changed its measured cost.");
			return;
		}
		if (this.charges.size >= 8_192) {
			this.fail("The request budget's response receipt capacity is exhausted.");
			return;
		}
		this.charges.set(receiptId, costUsd);
		// Spend that is not metered is held by its plan's usage windows, never by this dollar limit.
		if (!this.unmetered.has(receiptId)) this.spentUsd += costUsd;
		harnessLog.trace("cost", "a model response's measured cost was recorded", () => ({
			costUsd,
			tokens: measuredTokens,
			spentUsd: this.spentUsd,
			maxUsd: this.maxUsd,
		}));
		if (!Number.isSafeInteger(measuredTokens) || measuredTokens < 1)
			this.fail("A model response has no measured token usage; further spending is suspended.");
		if (!Number.isFinite(this.spentUsd) || this.spentUsd > this.maxUsd)
			this.fail("Measured request spending exceeded its projected limit.");
	}

	fail(reason: string): void {
		if (this.failure) return;
		this.failure = new RequestSpendRefusal(reason);
		harnessLog.warn("cost", "the request budget stopped further spending", () => ({
			reason,
			spentUsd: this.spentUsd,
			maxUsd: this.maxUsd,
		}));
	}

	assertHealthy(): void {
		if (this.failure) throw this.failure;
		if (this.pending) throw new RequestSpendRefusal("A provider request still has unsettled usage.");
	}
}
