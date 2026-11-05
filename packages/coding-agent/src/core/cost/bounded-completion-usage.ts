import type { Message } from "@caupulican/pi-ai";
import { resolveModelCost } from "@caupulican/pi-ai/usage";
import type { RequestPreflightContext } from "../../kernel/loop-config.ts";
import { estimateProviderRequestTokens } from "../../kernel/provider-request-estimator.ts";
import { captureUsageComponent } from "../../kernel/usage-components.ts";
import { affordableOutputTokenLimit } from "../cost-guard.ts";
import { validateProviderUsage } from "../orchestration/attempt-usage.ts";
import type { MaintenanceUsageRoute, SystemOneUsageLease } from "../review/system-one-review-port.ts";
import { priceCompletedUsage } from "../review/typesafe-usage.ts";
import type { AccountingOrigin } from "./accounting-evidence.ts";
import { RequestSpendBudget, RequestSpendRefusal } from "./request-spend-budget.ts";
import type { SessionSemanticUsageDelivery } from "./semantic-usage-delivery.ts";

/** One isolated completion's projected spending limit and original-session response receipts. */
export class BoundedCompletionUsage {
	private readonly lease: SystemOneUsageLease;
	private readonly origin: AccountingOrigin;
	private readonly route: MaintenanceUsageRoute;
	private readonly spending: RequestSpendBudget;
	private readonly maxResponses: number;
	private responses = 0;
	private readonly seen = new WeakSet<Message>();
	private requestIdentity: { provider: string; model: string } | undefined;
	private failure: unknown;

	constructor(
		owner: SessionSemanticUsageDelivery,
		route: MaintenanceUsageRoute,
		budget: number | RequestSpendBudget,
		maxResponses: number,
	) {
		this.spending = typeof budget === "number" ? new RequestSpendBudget(budget) : budget;
		this.origin = owner.captureOrigin();
		this.lease = owner.beginMaintenance(route, maxResponses, this.origin);
		this.route = route;
		this.maxResponses = maxResponses;
	}

	/** Replanning is read-only here: only received responses consume the allowance. */
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
		this.requestIdentity = { provider: request.model.provider, model: request.model.id };
		return { maxTokens };
	}

	/** Record paid replies before checking cancellation or freshness, including partial error replies. */
	record(message: Message): void {
		if (message.role !== "assistant" || this.seen.has(message)) return;
		this.seen.add(message);
		this.responses++;
		try {
			const usage = validateProviderUsage(message.usage);
			const component = captureUsageComponent({ ...message, usage });
			this.spending.record(component.sourceId, usage.cost.total, usage.totalTokens);
			if (component.provider !== this.requestIdentity?.provider || component.model !== this.requestIdentity.model)
				this.spending.fail("A response does not match the model whose price admitted the request.");
			const outcome = this.lease.record({
				...priceCompletedUsage(component.provider, component.model, usage),
				receiptId: component.sourceId,
				responseTimestamp: component.timestamp,
				provider: component.provider,
				model: component.model,
				attempt: 1,
				route: this.route,
				origin: this.origin,
			});
			if (outcome.kind === "unretained") throw new Error(`Completion usage could not be retained: ${outcome.cause}`);
			this.spending.assertHealthy();
		} catch (error) {
			this.spending.fail("Completion usage could not be measured and retained; further spending is suspended.");
			this.failure = error;
			throw error;
		}
	}

	assertHealthy(): void {
		if (this.failure !== undefined) throw this.failure;
		this.spending.assertHealthy();
	}

	release(): void {
		this.lease.release();
	}
}
