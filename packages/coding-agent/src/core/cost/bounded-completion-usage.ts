import { randomUUID } from "node:crypto";
import type { Api, Model, ProviderResponseObserver, ProviderResponseTicket } from "@caupulican/pi-ai";
import { resolveModelCost } from "@caupulican/pi-ai/usage";
import type { RequestPreflightContext } from "../../kernel/loop-config.ts";
import { estimateProviderRequestTokens } from "../../kernel/provider-request-estimator.ts";
import { affordableOutputTokenLimit } from "../cost-guard.ts";
import { validateProviderUsage } from "../orchestration/attempt-usage.ts";
import type { MaintenanceUsageRoute } from "../review/system-one-review-port.ts";
import { priceCompletedUsage } from "../review/typesafe-usage.ts";
import type { AccountingOrigin } from "./accounting-evidence.ts";
import { RequestSpendBudget, RequestSpendRefusal } from "./request-spend-budget.ts";
import type { MaintenanceUsageLease, SessionSemanticUsageDelivery } from "./semantic-usage-delivery.ts";

/** One isolated completion's projected spending limit and original-session response receipts. */
export class BoundedCompletionUsage implements ProviderResponseObserver {
	private readonly owner: SessionSemanticUsageDelivery;
	private readonly lease: MaintenanceUsageLease;
	private readonly origin: AccountingOrigin;
	private readonly route: MaintenanceUsageRoute;
	private readonly spending: RequestSpendBudget;
	private readonly maxResponses: number;
	private responses = 0;
	private readonly pending = new Set<string>();
	private released = false;
	private failure: unknown;
	private admittedModel: { provider: string; model: string } | undefined;

	constructor(
		owner: SessionSemanticUsageDelivery,
		route: MaintenanceUsageRoute,
		budget: number | RequestSpendBudget,
		maxResponses: number,
		origin = owner.captureOrigin(),
	) {
		this.owner = owner;
		this.spending = typeof budget === "number" ? new RequestSpendBudget(budget) : budget;
		this.origin = Object.freeze({ ...origin });
		this.lease = owner.beginMaintenance(route, maxResponses, this.origin);
		this.route = route;
		this.maxResponses = maxResponses;
	}

	/** Replanning is read-only here: only dispatched requests consume the allowance. */
	preflight(request: RequestPreflightContext): { maxTokens: number } {
		this.assertHealthy();
		if (this.responses >= this.maxResponses) throw new Error("Completion response allowance is exhausted.");
		if (request.model.costDefaulted)
			throw new RequestSpendRefusal("The selected model has no declared price for a bounded completion.");
		const inputTokens = estimateProviderRequestTokens(request.context, request.model);
		const maxTokens = affordableOutputTokenLimit({
			inputTokens,
			maxOutputTokens: Math.min(request.maxTokens ?? request.model.maxTokens, request.model.maxTokens),
			cost: resolveModelCost(request.model, inputTokens),
			remainingUsd: this.spending.remainingUsd(),
		});
		if (maxTokens < 1)
			throw new RequestSpendRefusal("Completion's remaining budget cannot cover the next projected request.");
		this.admittedModel = { provider: request.model.provider, model: request.model.id };
		return { maxTokens };
	}

	/** Each physical request owns its identity and reserved receipt slot until real settlement. */
	begin(model: Model<Api>): ProviderResponseTicket {
		this.assertHealthy();
		if (this.released || this.responses >= this.maxResponses)
			throw new RequestSpendRefusal("Completion response allowance is closed or exhausted.");
		if (
			model.costDefaulted ||
			model.provider !== this.admittedModel?.provider ||
			model.id !== this.admittedModel.model
		)
			throw new RequestSpendRefusal("The dispatched model has no matching price admission.");
		const receiptId = randomUUID();
		const provider = model.provider;
		const modelId = model.id;
		this.lease.beginRequest({
			requestId: receiptId,
			provider,
			model: modelId,
			route: this.route,
			origin: this.origin,
			startedAt: new Date().toISOString(),
		});
		this.spending.beginRequest(receiptId);
		this.pending.add(receiptId);
		this.responses++;
		const failed = (error: unknown): void => {
			this.spending.fail("Completion usage could not be measured and retained; further spending is suspended.");
			this.failure = error;
			this.owner.reportUnresolvedRequest(receiptId);
		};
		const finish = (): void => {
			this.pending.delete(receiptId);
			this.spending.endRequest(receiptId);
			if (this.released && this.pending.size === 0) this.lease.release();
		};
		return {
			complete: (message) => {
				if (!this.pending.has(receiptId)) return;
				try {
					const usage = validateProviderUsage(message.usage);
					this.spending.record(receiptId, usage.cost.total, usage.totalTokens);
					if (usage.totalTokens === 0 && usage.cost.total === 0)
						throw new Error("The provider ended without reporting measured usage.");
					if (message.provider !== provider || message.model !== modelId)
						this.spending.fail("A response does not match the model whose price admitted the request.");
					const outcome = this.lease.record({
						...priceCompletedUsage(message.provider, message.model, usage),
						priceKnown: true,
						receiptId,
						responseTimestamp: new Date(message.timestamp).toISOString(),
						provider: message.provider,
						model: message.model,
						attempt: 1,
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
		this.spending.assertHealthy();
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		if (this.pending.size === 0) this.lease.release();
		else for (const id of this.pending) this.owner.reportUnresolvedRequest(id);
	}
}
