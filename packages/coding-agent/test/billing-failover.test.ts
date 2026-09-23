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

	it("moves a subscription with no usable hop to the router's fallback, and keeps halting a metered balance", () => {
		const xai = { provider: "xai", id: "grok-4.7" };
		const fallback = { provider: "google-antigravity", modelId: "gemini-3.1-pro-low" };
		expect(
			decideBillingFailover({
				failedModel: xai,
				billingClass: "subscription",
				providerDefaultModelId: undefined,
				hopResolvesWithAuth: false,
				hopExhausted: false,
				fallback,
			}),
		).toEqual({
			action: "failover",
			to: fallback,
			notice: "grok-4.7 quota reached — switched to google-antigravity/gemini-3.1-pro-low",
		});
		// A same-provider hop that is usable still comes first.
		expect(
			decideBillingFailover({
				failedModel,
				billingClass: "subscription",
				providerDefaultModelId: "gpt-5.5",
				hopResolvesWithAuth: true,
				hopExhausted: false,
				fallback,
			}),
		).toMatchObject({ action: "failover", to: { provider: "openai-codex", modelId: "gpt-5.5" } });
		// Moving a metered balance to another paid model is a spending decision: it still halts.
		expect(
			decideBillingFailover({
				failedModel: xai,
				billingClass: "metered",
				providerDefaultModelId: undefined,
				hopResolvesWithAuth: false,
				hopExhausted: false,
				fallback,
			}).action,
		).toBe("halt_ask");
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
