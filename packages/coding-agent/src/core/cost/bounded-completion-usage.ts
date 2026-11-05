import type { Message } from "@caupulican/pi-ai";
import type { RequestPreflightContext } from "../../kernel/loop-config.ts";
import { estimateProviderRequestTokens } from "../../kernel/provider-request-estimator.ts";
import { captureUsageComponent } from "../../kernel/usage-components.ts";
import { affordableOutputTokenLimit } from "../cost-guard.ts";
import { validateProviderUsage } from "../orchestration/attempt-usage.ts";
import type { MaintenanceUsageRoute, SystemOneUsageLease } from "../review/system-one-review-port.ts";
import { priceCompletedUsage } from "../review/typesafe-usage.ts";
import type { AccountingOrigin } from "./accounting-evidence.ts";
import type { SessionSemanticUsageDelivery } from "./semantic-usage-delivery.ts";

/** One isolated completion's projected spending limit and original-session response receipts. */
export class BoundedCompletionUsage {
	private readonly lease: SystemOneUsageLease;
	private readonly origin: AccountingOrigin;
	private readonly route: MaintenanceUsageRoute;
	private readonly maxUsd: number;
	private readonly maxResponses: number;
	private responses = 0;
	private readonly seen = new WeakSet<Message>();
	private spentUsd = 0;
	private failure: unknown;

	constructor(
		owner: SessionSemanticUsageDelivery,
		route: MaintenanceUsageRoute,
		maxUsd: number,
		maxResponses: number,
	) {
		if (!Number.isFinite(maxUsd) || maxUsd < 0) throw new Error("Completion spending limit must be non-negative.");
		this.origin = owner.captureOrigin();
		this.lease = owner.beginMaintenance(route, maxResponses, this.origin);
		this.route = route;
		this.maxUsd = maxUsd;
		this.maxResponses = maxResponses;
	}

	/** Replanning is read-only here: only received responses consume the allowance. */
	preflight(request: RequestPreflightContext): { maxTokens: number } {
		this.assertHealthy();
		if (this.responses >= this.maxResponses) throw new Error("Completion response allowance is exhausted.");
		const maxTokens = affordableOutputTokenLimit({
			inputTokens: estimateProviderRequestTokens(request.context, request.model),
			maxOutputTokens: Math.min(request.maxTokens ?? request.model.maxTokens, request.model.maxTokens),
			cost: request.model.cost,
			longContextPricing: request.model.longContextPricing,
			remainingUsd: this.maxUsd - this.spentUsd,
		});
		if (maxTokens < 1) throw new Error("Completion's remaining budget cannot cover the next projected request.");
		return { maxTokens };
	}

	/** Record paid replies before checking cancellation or freshness, including partial error replies. */
	record(message: Message): void {
		if (message.role !== "assistant" || this.seen.has(message)) return;
		this.seen.add(message);
		this.responses++;
		try {
			const usage = validateProviderUsage(message.usage);
			this.spentUsd += usage.cost.total;
			const component = captureUsageComponent({ ...message, usage });
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
			if (usage.totalTokens === 0)
				throw new Error("Completion returned no measured token usage; further spending is suspended.");
			if (!Number.isFinite(this.spentUsd) || this.spentUsd > this.maxUsd)
				throw new Error("Completion's measured spending exceeded its projected limit.");
		} catch (error) {
			this.failure = error;
			throw error;
		}
	}

	assertHealthy(): void {
		if (this.failure !== undefined) throw this.failure;
	}

	release(): void {
		this.lease.release();
	}
}
