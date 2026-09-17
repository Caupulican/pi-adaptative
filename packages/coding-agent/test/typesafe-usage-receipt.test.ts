import { describe, expect, it, vi } from "vitest";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";
import { TypeSafeEvidenceStore } from "../src/core/review/typesafe-evidence-store.ts";
import { TypeSafeReviewer } from "../src/core/review/typesafe-reviewer.ts";
import { createTypeSafeReviewToolDefinition } from "../src/core/tools/typesafe-review.ts";

describe("TypeSafe billing receipt delivery", () => {
	it.each([false, true])(
		"delivers one receipt without retrying a local accounting failure=%s",
		async (failAccounting) => {
			const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
				Response.json({
					model: "jev-1.13.0",
					answers: { q: { type: "noul", noul: 0.9 } },
					usage: { input_tokens: 100, output_tokens: 10 },
				}),
			);
			const accounting = vi.fn(() => {
				if (failAccounting)
					throw Object.assign(new Error("fixture accounting storage error"), {
						status: 503,
						headers: { "retry-after": "0" },
					});
			});
			const tool = createTypeSafeReviewToolDefinition(
				new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher }),
				new TypeSafeEvidenceStore(createInMemoryArtifactStore()),
				accounting,
			);
			const result = await tool.execute("receipt", {
				action: "evaluate",
				evaluation: { state: "fixture", questions: { q: { type: "noul", instructions: "Is this a fixture?" } } },
			});
			expect(Boolean(result.isError)).toBe(failAccounting);
			expect(result).toMatchObject({ usage: { input: 100, output: 10, totalTokens: 110 } });
			expect(fetcher).toHaveBeenCalledOnce();
			expect(accounting).toHaveBeenCalledOnce();
		},
	);
});
