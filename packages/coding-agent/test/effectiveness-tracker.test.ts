import { describe, expect, it } from "vitest";
import { distinctiveRecallUsage, EffectivenessTracker } from "../src/core/memory/effectiveness-tracker.ts";

describe("R4 effectiveness feedback", () => {
	describe("distinctiveRecallUsage", () => {
		it("is high when the response uses recall content the query did not carry", () => {
			const query = "how do I deploy";
			const recall = "deploy using the helm chart and the staging values file in infra";
			const response = "Run the helm chart with the staging values file from infra.";
			expect(distinctiveRecallUsage(recall, query, response)).toBeGreaterThan(0.5);
		});

		it("is zero when the response ignores the recalled content", () => {
			const query = "how do I deploy";
			const recall = "deploy using the helm chart and the staging values file in infra";
			const response = "I'm not sure, could you clarify what you mean?";
			expect(distinctiveRecallUsage(recall, query, response)).toBe(0);
		});

		it("is zero when recall adds nothing beyond the query", () => {
			const query = "kubernetes helm chart staging values";
			const recall = "kubernetes helm chart staging values";
			const response = "kubernetes helm chart staging values are all set.";
			// No distinctive tokens → recall contributed nothing measurable.
			expect(distinctiveRecallUsage(recall, query, response)).toBe(0);
		});
	});

	describe("EffectivenessTracker", () => {
		it("starts at a neutral prior and moves toward observed usage", () => {
			const t = new EffectivenessTracker();
			expect(t.usefulLately()).toBeCloseTo(0.5, 5);
			expect(t.sampleCount).toBe(0);

			// Several turns where recall is clearly used → score climbs above the prior.
			for (let i = 0; i < 5; i++) {
				t.recordRecallOutcome(
					"alpha beta gamma delta epsilon",
					"query",
					"alpha beta gamma delta epsilon used here",
				);
			}
			expect(t.usefulLately()).toBeGreaterThan(0.7);
			expect(t.sampleCount).toBe(5);
		});

		it("decays toward zero when recall is consistently unused", () => {
			const t = new EffectivenessTracker();
			for (let i = 0; i < 8; i++) {
				t.recordRecallOutcome("alpha beta gamma delta epsilon", "query", "totally unrelated response text here");
			}
			expect(t.usefulLately()).toBeLessThan(0.15);
		});
	});
});
