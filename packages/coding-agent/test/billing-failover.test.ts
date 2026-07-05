import { describe, expect, it } from "vitest";
import { decideBillingFailover } from "../src/core/billing-failover.ts";

const failedModel = { provider: "openai-codex", id: "codex-spark" };

describe("decideBillingFailover", () => {
	it("halts metered providers without an automatic hop", () => {
		expect(
			decideBillingFailover({
				failedModel,
				billingClass: "metered",
				providerDefaultModelId: "gpt-5.5",
				hopResolvesWithAuth: true,
				hopExhausted: false,
			}),
		).toEqual({
			action: "halt_ask",
			notice:
				"Provider quota/limit reached for openai-codex/codex-spark: switch models (/model), wait for the limit window, or re-send to retry",
		});
	});

	it("hops a subscription provider to its available default model", () => {
		expect(
			decideBillingFailover({
				failedModel,
				billingClass: "subscription",
				providerDefaultModelId: "gpt-5.5",
				hopResolvesWithAuth: true,
				hopExhausted: false,
			}),
		).toEqual({
			action: "failover",
			to: { provider: "openai-codex", modelId: "gpt-5.5" },
			notice: "codex-spark quota reached — switched to openai-codex/gpt-5.5",
		});
	});

	it("halts subscription providers when the hop is unavailable, exhausted, disabled, or already default", () => {
		for (const input of [
			{ providerDefaultModelId: "codex-spark", hopResolvesWithAuth: true, hopExhausted: false },
			{ providerDefaultModelId: "gpt-5.5", hopResolvesWithAuth: false, hopExhausted: false },
			{ providerDefaultModelId: "gpt-5.5", hopResolvesWithAuth: true, hopExhausted: true },
			{ providerDefaultModelId: "gpt-5.5", hopResolvesWithAuth: true, hopExhausted: false, subscriptionHop: false },
		]) {
			expect(decideBillingFailover({ failedModel, billingClass: "subscription", ...input }).action).toBe("halt_ask");
		}
	});
});
