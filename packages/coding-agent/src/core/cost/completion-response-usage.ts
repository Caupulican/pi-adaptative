import { randomUUID } from "node:crypto";
import type { Api, Model, ProviderResponseObserver, ProviderResponseTicket } from "@caupulican/pi-ai";
import { validateProviderUsage } from "../orchestration/attempt-usage.ts";
import type { CompletionUsageRoute } from "../review/system-one-review-port.ts";
import { priceCompletedUsage } from "../review/typesafe-usage.ts";
import type { AccountingOrigin } from "./accounting-evidence.ts";
import { type RequestSpendBudget, RequestSpendRefusal } from "./request-spend-budget.ts";
import type { MaintenanceUsageLease, SessionSemanticUsageDelivery } from "./semantic-usage-delivery.ts";

/** Physical response ownership, independent of whether the caller has a monetary budget. */
export class CompletionResponseUsage implements ProviderResponseObserver {
	private readonly owner: SessionSemanticUsageDelivery;
	private readonly lease: MaintenanceUsageLease;
	private readonly origin: AccountingOrigin;
	private readonly route: CompletionUsageRoute;
	private readonly spending: RequestSpendBudget | undefined;
	private readonly maxResponses: number;
	private responses = 0;
	private readonly pending = new Set<string>();
	private released = false;
	private admitting = false;
	private failure: unknown;

	constructor(
		owner: SessionSemanticUsageDelivery,
		route: CompletionUsageRoute,
		maxResponses: number,
		origin = owner.captureOrigin(),
		spending?: RequestSpendBudget,
	) {
		this.owner = owner;
		this.origin = Object.freeze({ ...origin });
		this.lease = owner.beginMaintenance(route, maxResponses, this.origin);
		this.route = route;
		this.maxResponses = maxResponses;
		this.spending = spending;
	}

	/** Replanning does not consume a response. Only physical dispatch transfers a reserved slot. */
	assertAvailable(): void {
		this.assertHealthy();
		if (this.released || this.responses >= this.maxResponses)
			throw new RequestSpendRefusal("Completion response allowance is closed or exhausted.");
		if (this.admitting) throw new RequestSpendRefusal("Completion request admission is already in progress.");
	}

	begin(model: Model<Api>, signal?: AbortSignal): ProviderResponseTicket {
		signal?.throwIfAborted();
		this.assertAvailable();
		const receiptId = randomUUID();
		const provider = model.provider;
		const modelId = model.id;
		const priceKnown = !model.costDefaulted;
		this.admitting = true;
		let reserved = false;
		try {
			this.lease.beginRequest({
				requestId: receiptId,
				provider,
				model: modelId,
				route: this.route,
				origin: this.origin,
				startedAt: new Date().toISOString(),
			});
			reserved = true;
			this.lease.assertCurrent();
			if (this.released) throw new RequestSpendRefusal("Completion ended during request admission.");
			signal?.throwIfAborted();
			// The last refusable step: an admission checkpoint it writes always belongs to a request that is dispatched.
			this.spending?.beginRequest(receiptId);
			this.pending.add(receiptId);
		} catch (error) {
			try {
				if (reserved) this.lease.cancelUndispatchedRequest(receiptId);
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "Completion admission failed to retire its reservation");
			} finally {
				this.spending?.endRequest(receiptId);
			}
			throw error;
		} finally {
			this.admitting = false;
			if (this.released && this.pending.size === 0) this.lease.release();
		}
		const attempt = ++this.responses;
		const failed = (error: unknown): void => {
			this.spending?.fail("Completion usage could not be measured and retained; further spending is suspended.");
			this.failure ??= error ?? new Error("The provider response failed without a diagnostic.");
			this.owner.reportUnresolvedRequest(receiptId);
		};
		const finish = (): void => {
			this.pending.delete(receiptId);
			this.spending?.endRequest(receiptId);
			if (this.released && this.pending.size === 0) this.lease.release();
		};
		return {
			complete: (message) => {
				if (!this.pending.has(receiptId)) return;
				try {
					const usage = validateProviderUsage(message.usage);
					this.spending?.record(receiptId, usage.cost.total, usage.totalTokens);
					if (usage.totalTokens === 0 && usage.cost.total === 0)
						throw new Error("The provider ended without reporting measured usage.");
					if (message.provider !== provider || message.model !== modelId)
						failed(new Error("A response does not match its dispatched provider and model."));
					const outcome = this.lease.record({
						...priceCompletedUsage(message.provider, message.model, usage),
						...(priceKnown ? { priceKnown: true as const } : {}),
						receiptId,
						responseTimestamp: new Date(message.timestamp).toISOString(),
						provider: message.provider,
						model: message.model,
						attempt,
						route: this.route,
						origin: this.origin,
					});
					if (outcome.kind === "unretained")
						throw new Error(`Completion usage could not be retained: ${outcome.cause}`);
				} catch (error) {
					failed(error);
				} finally {
					finish();
				}
			},
			failed: (error) => {
				if (!this.pending.has(receiptId)) return;
				failed(error);
				finish();
			},
		};
	}

	assertHealthy(): void {
		if (this.failure !== undefined) throw this.failure;
		this.spending?.assertHealthy();
		if (this.pending.size > 0) throw new RequestSpendRefusal("A provider response still has unsettled usage.");
	}

	/** Logical cancellation leaves physical tickets alive until they settle with their original owner. */
	release(): void {
		if (this.released) return;
		this.released = true;
		if (this.pending.size === 0 && !this.admitting) this.lease.release();
		else for (const id of this.pending) this.owner.reportUnresolvedRequest(id);
	}
}
