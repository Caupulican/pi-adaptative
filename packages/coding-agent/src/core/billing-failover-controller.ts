import type { Agent } from "@caupulican/pi-agent-core";
import { classifyFailure } from "@caupulican/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@caupulican/pi-ai";
import { decideBillingFailover } from "./billing-failover.ts";
import type { ModelRegistry } from "./model-registry.ts";

const DEFAULT_MODEL_PER_PROVIDER: Record<string, string> = {
	"openai-codex": "gpt-5.5",
};

export class ExhaustedProviderRegistry {
	private readonly exhausted = new Map<string, number | undefined>();

	markExhausted(ref: string, until?: number): void {
		this.exhausted.set(ref, until);
	}

	isExhausted(ref: string): boolean {
		const until = this.exhausted.get(ref);
		if (until === undefined) return this.exhausted.has(ref);
		if (Date.now() < until) return true;
		this.exhausted.delete(ref);
		return false;
	}

	snapshot(): string[] {
		return [...this.exhausted.keys()].filter((ref) => this.isExhausted(ref));
	}
}

export interface BillingFailoverControllerDeps {
	agent: Agent;
	modelRegistry: ModelRegistry;
	emit(event: { type: "warning"; message: string }): void;
	exhausted: ExhaustedProviderRegistry;
	subscriptionHop?: boolean;
}

export class BillingFailoverController {
	private readonly deps: BillingFailoverControllerDeps;

	constructor(deps: BillingFailoverControllerDeps) {
		this.deps = deps;
	}

	async handleAssistantError(message: AssistantMessage): Promise<boolean> {
		if (message.stopReason !== "error") return false;
		const classified = classifyFailure({ message: message.errorMessage ?? "", provider: message.provider });
		if (classified.reason !== "billing_or_quota") return false;
		const failedModel = this.deps.modelRegistry.find(message.provider, message.model) ?? this.deps.agent.state.model;
		const failedRef = `${failedModel.provider}/${failedModel.id}`;
		this.deps.exhausted.markExhausted(failedRef, expiryFromRetryAfter(classified.retryAfterMs));

		const defaultModelId = DEFAULT_MODEL_PER_PROVIDER[failedModel.provider];
		const hop = defaultModelId ? this.deps.modelRegistry.find(failedModel.provider, defaultModelId) : undefined;
		const action = decideBillingFailover({
			failedModel: { provider: failedModel.provider, id: failedModel.id },
			billingClass: this.deps.modelRegistry.isUsingOAuth(failedModel) ? "subscription" : "metered",
			providerDefaultModelId: defaultModelId,
			hopResolvesWithAuth: Boolean(hop && this.deps.modelRegistry.hasConfiguredAuth(hop)),
			hopExhausted: hop ? this.deps.exhausted.isExhausted(`${hop.provider}/${hop.id}`) : false,
			subscriptionHop: this.deps.subscriptionHop,
		});
		if (action.action === "failover") {
			this.deps.agent.state.model = hop as Model<Api>;
		}
		this.deps.emit({ type: "warning", message: action.notice });
		return true;
	}
}

function expiryFromRetryAfter(retryAfterMs: number | undefined): number | undefined {
	return retryAfterMs === undefined ? undefined : Date.now() + retryAfterMs;
}
