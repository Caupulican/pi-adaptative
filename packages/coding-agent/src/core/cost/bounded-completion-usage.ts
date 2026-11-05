import type { Api, Model, ProviderResponseObserver, ProviderResponseTicket } from "@caupulican/pi-ai";
import { resolveModelCost } from "@caupulican/pi-ai/usage";
import type { AgentLoopConfig, RequestPreflightContext } from "../../kernel/loop-config.ts";
import { estimateProviderRequestTokens } from "../../kernel/provider-request-estimator.ts";
import { affordableOutputTokenLimit } from "../cost-guard.ts";
import type { MaintenanceUsageRoute } from "../review/system-one-review-port.ts";
import { CompletionResponseUsage } from "./completion-response-usage.ts";
import { RequestSpendBudget, RequestSpendRefusal } from "./request-spend-budget.ts";
import type { SessionSemanticUsageDelivery } from "./semantic-usage-delivery.ts";

/** One isolated completion's projected spending limit and original-session response receipts. */
export class BoundedCompletionUsage implements ProviderResponseObserver {
	private readonly responses: CompletionResponseUsage;
	private readonly spending: RequestSpendBudget;
	private admittedModel: { provider: string; model: string } | undefined;

	constructor(
		owner: SessionSemanticUsageDelivery,
		route: MaintenanceUsageRoute,
		budget: number | RequestSpendBudget,
		maxResponses: number,
		origin = owner.captureOrigin(),
	) {
		this.spending = typeof budget === "number" ? new RequestSpendBudget(budget) : budget;
		this.responses = new CompletionResponseUsage(owner, route, maxResponses, origin, this.spending);
	}

	/** Replanning is read-only here: only dispatched requests consume the allowance. */
	preflight(request: RequestPreflightContext): { maxTokens: number } {
		this.responses.assertAvailable();
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
	begin(model: Model<Api>, signal?: AbortSignal): ProviderResponseTicket {
		if (
			model.costDefaulted ||
			model.provider !== this.admittedModel?.provider ||
			model.id !== this.admittedModel.model
		)
			throw new RequestSpendRefusal("The dispatched model has no matching price admission.");
		return this.responses.begin(model, signal);
	}

	assertHealthy(): void {
		this.responses.assertHealthy();
	}

	/**
	 * The loop hooks of a completion that ends in one structured submission:
	 * - every request is priced and admitted here;
	 * - every dispatch re-checks the allowance and `assertCurrent`;
	 * - a tool call re-checks only `assertCurrent`: it runs on a response already received, so that response's own
	 *   measured charge never blocks it (a failed allowance refuses the next dispatch instead);
	 * - the submission must be the only tool call of its message (`reason` tells the model so).
	 */
	submissionHooks(
		reason: string,
		assertCurrent?: () => void,
	): Required<
		Pick<AgentLoopConfig, "beforeToolCall" | "requestPreflight" | "requestGuard" | "providerResponseObserver">
	> {
		return {
			beforeToolCall: async (context) => {
				assertCurrent?.();
				return context.assistantMessage.content.filter((part) => part.type === "toolCall").length === 1
					? undefined
					: { block: true, reason };
			},
			requestPreflight: (request) => this.preflight(request),
			requestGuard: () => {
				assertCurrent?.();
				this.assertHealthy();
			},
			providerResponseObserver: this,
		};
	}

	release(): void {
		this.responses.release();
	}
}
