import { describe, expect, it } from "vitest";
import { judgeTransition } from "../src/core/objective-execution/transition-judgment.ts";
import { SteeringJudgmentUnavailableError } from "../src/core/steering/system-one-steering-plane.ts";

const options = { objectiveId: "objective-1", evidenceRevision: 1 };

describe("transition judgment autonomy", () => {
	it("keeps ambiguous optional judgments advisory", async () => {
		const result = await judgeTransition(
			{
				requireCertificate: async () => ({
					certificate_id: "cert-1",
					semantic_outcome: "gather_more",
					failed_semantic_predicates: ["claim_supported"],
				}),
			},
			"JEV-024",
			{},
			{ ...options, holdOnUnsettled: false },
		);

		expect(result.kind).toBe("advisory");
	});

	it("keeps an optional System One outage advisory", async () => {
		const result = await judgeTransition(
			{
				requireCertificate: async () => {
					throw new SteeringJudgmentUnavailableError("JEV-024", "objective_transition", "offline");
				},
			},
			"JEV-024",
			{},
			{ ...options, holdOnUnsettled: false },
		);

		expect(result.kind).toBe("advisory");
	});

	it("holds an unsettled transition when strict System One is explicitly required", async () => {
		const result = await judgeTransition(
			{
				requireCertificate: async () => ({
					certificate_id: "cert-1",
					semantic_outcome: "gather_more",
				}),
			},
			"JEV-024",
			{},
			options,
		);

		expect(result.kind).toBe("held");
	});
});
