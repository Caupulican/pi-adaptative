import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";
import { evaluationInputSchema, reviewInputSchema } from "../src/core/review/typesafe-contract.ts";
import { TypeSafeEvidenceMaterializer } from "../src/core/review/typesafe-evidence-materializer.ts";
import { TypeSafeEvidenceStore } from "../src/core/review/typesafe-evidence-store.ts";
import { TypeSafeReviewer } from "../src/core/review/typesafe-reviewer.ts";
import { createTypeSafeReviewToolDefinition } from "../src/core/tools/typesafe-review.ts";

const review = {
	state: "fixture source",
	questions: {
		claim: { instructions: "Supported?", criteria: { yes: "Supported", no: "Contradicted" }, expected: "yes" },
	},
};

describe("TypeSafe input contract", () => {
	it("advertises the same mandatory schemas the reviewer validates", () => {
		const tool = createTypeSafeReviewToolDefinition(
			new TypeSafeReviewer({ getApiKey: async () => "fixture-key" }),
			new TypeSafeEvidenceStore(createInMemoryArtifactStore()),
		);
		const { evaluation, review: advertisedReview } = tool.parameters.properties;
		expect(evaluation).toMatchObject(evaluationInputSchema);
		expect(advertisedReview).toMatchObject(reviewInputSchema);
		expect(Value.Check(tool.parameters, { action: "review", review })).toBe(true);
		expect(
			Value.Check(tool.parameters, {
				action: "resolve_uncertainty",
				uncertainty: {
					evaluationId: "evaluation-1",
					question: "behavior boundary",
					disposition: "conservative_path",
					reason: "The current implementation preserves the established invariant.",
					evidence: "The relevant branch and regression test agree.",
				},
			}),
		).toBe(true);
		expect(
			Value.Check(tool.parameters, {
				action: "resolve_uncertainty",
				uncertainty: {
					evaluationId: "evaluation-1",
					question: "behavior boundary",
					disposition: "accepted",
					reason: "",
					evidence: "The relevant branch and regression test agree.",
				},
			}),
		).toBe(false);
		expect(
			Value.Check(tool.parameters, {
				action: "review",
				review: { ...review, questions: { claim: { ...review.questions.claim, criteria: "yes or no" } } },
			}),
		).toBe(false);
	});
	it.each([
		{
			input: { ...review, questions: { claim: { ...review.questions.claim, criteria: "private-source-value" } } },
			path: "/questions/claim/criteria",
		},
		{
			input: { ...review, questions: { claim: { ...review.questions.claim, criteria: { yes: "Only option" } } } },
			path: "/questions/claim/criteria",
		},
		{
			input: { ...review, questions: { claim: { ...review.questions.claim, expected: "missing" } } },
			path: "/questions/claim/expected",
		},
	])("returns bounded field repair diagnostics without source values: $path", async ({ input, path }) => {
		const fetcher = vi.fn<typeof fetch>();
		const reviewer = new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher });
		let message = "";
		try {
			await reviewer.review(input as typeof review);
		} catch (error) {
			message = String(error);
		}
		expect(message).toContain(path);
		expect(message).toMatch(/expected/i);
		expect(message).toMatch(/received/i);
		expect(message.length).toBeLessThan(2200);
		expect(message).not.toContain("private-source-value");
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("points an invalid question type at its field before credential lookup", async () => {
		const getApiKey = vi.fn(async () => "fixture-key");
		const reviewer = new TypeSafeReviewer({ getApiKey });
		await expect(
			reviewer.evaluate(
				JSON.parse('{"state":"fixture","questions":{"q":{"type":"invalid","instructions":"Check"}}}'),
			),
		).rejects.toThrow("/questions/q/type");
		expect(getApiKey).not.toHaveBeenCalled();
	});
	it("bounds many malformed questions and long identifiers", async () => {
		const reviewer = new TypeSafeReviewer({ getApiKey: async () => "fixture-key" });
		const questions = Object.fromEntries(
			Array.from({ length: 100 }, (_, index) => [
				`${"q".repeat(4000)}${index}`,
				{ type: "invalid", instructions: "private-source-value" },
			]),
		);
		let message = "";
		try {
			await reviewer.evaluate(JSON.parse(JSON.stringify({ state: "fixture", questions })));
		} catch (error) {
			message = String(error);
		}
		expect(message.length).toBeLessThan(2200);
		expect(message).not.toContain("private-source-value");
	});
	it("reports discriminated Score criteria instead of an opaque union mismatch", async () => {
		const reviewer = new TypeSafeReviewer({ getApiKey: async () => "fixture-key" });
		await expect(
			reviewer.evaluate(
				JSON.parse(
					'{"state":"fixture","questions":{"score":{"type":"score","instructions":"Degree?","criteria":["one"]}}}',
				),
			),
		).rejects.toThrow("/questions/score/criteria");
	});
	it("accepts the canonical valid option map without changing confidence semantics", async () => {
		const reviewer = new TypeSafeReviewer({
			getApiKey: async () => "fixture-key",
			fetch: async () =>
				Response.json({
					model: "jev-1.13.0",
					answers: {
						claim: { type: "choice", choice: "yes", confidence: 0.94, probabilities: { yes: 1, no: 0 } },
					},
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
		});
		expect(await reviewer.review(review)).toMatchObject({ accepted: false, failures: ["claim"] });
	});
	it.each(["missing", "yes"])("validates expected=%s before evidence materialization", async (expected) => {
		const materializer = new TypeSafeEvidenceMaterializer({ getCwd: () => "/fixture" });
		const materialize = vi
			.spyOn(materializer, "materialize")
			.mockResolvedValue({ state: { schema_version: "1.0", sources: [] }, manifest: [] });
		const fetcher = vi.fn<typeof fetch>(async () =>
			Response.json({
				model: "jev-1.13.0",
				answers: { claim: { type: "choice", choice: "yes", confidence: 1, probabilities: { yes: 1, no: 0 } } },
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		);
		const tool = createTypeSafeReviewToolDefinition(
			new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher }),
			new TypeSafeEvidenceStore(createInMemoryArtifactStore()),
			undefined,
			materializer,
		);
		const result = await tool.execute("check", {
			action: "review",
			evidenceRefs: ["file:source.ts"],
			review: { ...review, questions: { claim: { ...review.questions.claim, expected } } },
		});
		expect(result.isError).toBe(expected === "missing");
		expect(materialize).toHaveBeenCalledTimes(expected === "missing" ? 0 : 1);
		expect(fetcher).toHaveBeenCalledTimes(expected === "missing" ? 0 : 1);
	});
	it.each(["apikey_PRIVATE_SECRET", "claim"])(
		"keeps recognized credentials out of diagnostic paths: %s",
		async (id) => {
			const reviewer = new TypeSafeReviewer({ getApiKey: async () => "fixture-key" });
			let message = "";
			try {
				await reviewer.evaluate(
					JSON.parse(
						JSON.stringify({ state: "fixture", questions: { [id]: { type: "invalid", instructions: "Check" } } }),
					),
				);
			} catch (error) {
				message = String(error);
			}
			expect(message).not.toContain("apikey_PRIVATE_SECRET");
			expect(message).toContain(id === "claim" ? "/questions/claim/type" : "[REDACTED]");
		},
	);
});
