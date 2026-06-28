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

		it("returns a no-signal sentinel when recall adds nothing beyond the query (Bug #14)", () => {
			const query = "kubernetes helm chart staging values";
			const recall = "kubernetes helm chart staging values";
			const response = "kubernetes helm chart staging values are all set.";
			// No distinctive tokens → no usable signal (negative sentinel) so the tracker skips it rather
			// than recording a misleading zero.
			expect(distinctiveRecallUsage(recall, query, response)).toBeLessThan(0);
		});

		it("does not penalize a long recall snippet that the response reused a few key tokens from (Bug #14)", () => {
			const query = "how do I deploy";
			const longRecall = `deploy using helm chart staging values infra directory ${Array.from({ length: 40 }, (_, i) => `extra${i}`).join(" ")}`;
			const response = "Use the helm chart with staging values from infra.";
			// Only ~4 key tokens reused out of a long snippet — must still read as clearly useful.
			expect(distinctiveRecallUsage(longRecall, query, response)).toBeGreaterThan(0.6);
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
