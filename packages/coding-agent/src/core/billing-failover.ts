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
	return { action: "halt_ask", notice: haltNotice(failedModel.provider, failedModel.id) };
}
