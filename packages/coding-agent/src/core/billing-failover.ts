export type BillingClass = "subscription" | "metered";

export type BillingFailoverAction =
	| { action: "failover"; to: { provider: string; modelId: string }; notice: string }
	| { action: "halt_ask"; notice: string };

export interface BillingFailoverInput {
	failedModel: { provider: string; id: string };
	billingClass: BillingClass;
	providerDefaultModelId: string | undefined;
	hopResolvesWithAuth: boolean;
	hopExhausted: boolean;
	subscriptionHop?: boolean;
	/**
	 * The router's usable model for the work when there is no usable same-provider hop: the configured
	 * tiers, strongest first, bounded by the owner's pool and policy and skipping exhausted models.
	 */
	fallback?: { provider: string; modelId: string };
}

function haltNotice(provider: string, modelId: string): string {
	return `Provider quota/limit reached for ${provider}/${modelId}: switch models (/model), wait for the limit window, or re-send to retry`;
}

export function decideBillingFailover(input: BillingFailoverInput): BillingFailoverAction {
	const { failedModel, providerDefaultModelId } = input;
	const subscriptionHop = input.subscriptionHop ?? true;
	if (
		input.billingClass === "subscription" &&
		subscriptionHop &&
		providerDefaultModelId &&
		providerDefaultModelId !== failedModel.id &&
		input.hopResolvesWithAuth &&
		!input.hopExhausted
	) {
		return {
			action: "failover",
			to: { provider: failedModel.provider, modelId: providerDefaultModelId },
			notice: `${failedModel.id} quota reached — switched to ${failedModel.provider}/${providerDefaultModelId}`,
		};
	}
	// A subscription that ran out has no spend to protect: the work moves to the router's choice. A metered
	// balance still halts, because moving it to another paid model is a spending decision the owner makes.
	if (input.billingClass === "subscription" && subscriptionHop && input.fallback) {
		return {
			action: "failover",
			to: input.fallback,
			notice: `${failedModel.id} quota reached — switched to ${input.fallback.provider}/${input.fallback.modelId}`,
		};
	}
	return { action: "halt_ask", notice: haltNotice(failedModel.provider, failedModel.id) };
}
