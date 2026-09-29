import { describe, expect, it } from "vitest";
import { judgeTransition } from "../src/core/objective-execution/transition-judgment.ts";
import { SteeringJudgmentUnavailableError } from "../src/core/steering/system-one-steering-plane.ts";

const options = { objectiveId: "objective-1", evidenceRevision: 1 };

describe("transition judgment autonomy", () => {
	it.each(["JEV-024", "JEV-025", "JEV-026", "JEV-027", "JEV-028"])(
		"retains a %s rejection for verification in either mode",
		async (checkpoint) => {
			const certificate = {
				certificate_id: "rejected",
				semantic_outcome: "fail",
				failed_semantic_predicates: ["scope_uncertain"],
			};
			const result = await judgeTransition(
				{ requireCertificate: async () => certificate },
				checkpoint,
				{},
				{ ...options, holdOnUnsettled: false },
			);
			expect(result).toEqual({ kind: "judged", certificate });
			const strict = await judgeTransition(
				{ requireCertificate: async () => certificate },
				checkpoint,
				{},
				{ ...options, holdOnUnsettled: true },
			);
			expect(strict.kind).toBe("judged");
		},
	);

	it("retains ambiguous judgments for the receiving agent to verify", async () => {
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

		expect(result.kind).toBe("judged");
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

	it("keeps required ambiguity actionable without an owner-question latch", async () => {
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

		expect(result.kind).toBe("judged");
	});
});
