import { describe, expect, it, vi } from "vitest";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";
import { TypeSafeEvidenceStore } from "../src/core/review/typesafe-evidence-store.ts";
import { SystemOneReviewer } from "../src/core/review/typesafe-reviewer.ts";
import { SystemOneJevAdapter } from "../src/core/system-one/adapter.ts";
import { createSystemOneToolDefinition } from "../src/core/tools/systemone.ts";

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
			const tool = createSystemOneToolDefinition(
				new SystemOneReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher }),
				new TypeSafeEvidenceStore(createInMemoryArtifactStore()),
				accounting,
			);
			const result = await tool.execute("receipt", {
				action: "evaluate",
				evaluation: { state: "fixture", questions: { q: { type: "noul", instructions: "Is this a fixture?" } } },
			});
			expect(Boolean(result.isError)).toBe(failAccounting);
			expect(result).toMatchObject({ usage: { input: 100, output: 10, totalTokens: 110 } });
			expect(result.usage?.cost.input).toBeCloseTo(0.000025, 12);
			expect(result.usage?.cost.output).toBeCloseTo(0.0000125, 12);
			expect(result.usage?.cost.total).toBeCloseTo(0.0000375, 12);
			expect(result.usage?.cost).toMatchObject({ cacheRead: 0, cacheWrite: 0 });
			expect(result.details).toMatchObject({
				costStatus: "catalog_priced",
				costProvenance: { provider: "typesafe", model: "jev-1.13.0" },
			});
			expect(fetcher).toHaveBeenCalledOnce();
			expect(accounting).toHaveBeenCalledOnce();
			expect(accounting).toHaveBeenCalledWith("receipt", expect.objectContaining({ cost: result.usage?.cost }));
		},
	);

	it("prices OpenRouter independently from direct TypeSafe pricing", async () => {
		const tool = createSystemOneToolDefinition(
			new SystemOneReviewer({
				provider: "openrouter",
				getApiKey: async () => "fixture-key",
				fetch: async () =>
					Response.json({
						model: "typesafe/jev-1.13",
						answers: { q: { type: "noul", noul: 0.9 } },
						usage: { input_tokens: 100, output_tokens: 10 },
					}),
			}),
			new TypeSafeEvidenceStore(createInMemoryArtifactStore()),
		);
		const result = await tool.execute("openrouter", {
			action: "evaluate",
			evaluation: { state: "fixture", questions: { q: { type: "noul", instructions: "Fixture?" } } },
		});

		expect(result.usage?.cost.total).toBeCloseTo(0.0000042, 12);
		expect(result.details).toMatchObject({
			costStatus: "catalog_priced",
			costProvenance: { provider: "openrouter", model: "typesafe/jev-1.13" },
		});
	});

	it("emits one priced internal receipt for every provider response, including retries", async () => {
		const receipts = vi.fn();
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json(
					{ error: "overloaded", usage: { input_tokens: 40, output_tokens: 4 } },
					{ status: 529, headers: { "retry-after": "0" } },
				),
			)
			.mockResolvedValueOnce(
				Response.json({
					model: "jev-1.13.0",
					answers: { q: { type: "noul", noul: 0.9 } },
					usage: { input_tokens: 100, output_tokens: 10 },
				}),
			);
		const reviewer = new SystemOneReviewer({
			getApiKey: async () => "fixture-key",
			fetch: fetcher,
			onUsage: receipts,
		});

		await reviewer.evaluate({
			state: "fixture",
			questions: { q: { type: "noul", instructions: "Fixture?" } },
		});

		expect(receipts).toHaveBeenCalledTimes(2);
		expect(receipts.mock.calls.map(([receipt]) => receipt.attempt)).toEqual([1, 2]);
		expect(receipts.mock.calls[0]?.[0].usage.cost.total).toBeCloseTo(0.000015, 12);
		expect(receipts.mock.calls[1]?.[0].usage.cost.total).toBeCloseTo(0.0000375, 12);
		expect(receipts.mock.calls.map(([receipt]) => receipt.receiptId)).toEqual([
			expect.stringMatching(/:1$/),
			expect.stringMatching(/:2$/),
		]);
	});

	it("does not resend an internal judgment when durable receipt recording fails", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({
				model: "jev-1.13.0",
				answers: { q: { type: "noul", noul: 0.9 } },
				usage: { input_tokens: 100, output_tokens: 10 },
			}),
		);
		const reviewer = new SystemOneReviewer({
			getApiKey: async () => "fixture-key",
			fetch: fetcher,
			onUsage: () => {
				throw new Error("durable usage store failed");
			},
		});
		const adapter = new SystemOneJevAdapter(reviewer, undefined, {
			getApiKey: () => "fixture-key",
			sleep: async () => {},
		});

		await expect(
			adapter.evaluate({ state: "fixture", questions: { q: { type: "noul", instructions: "Fixture?" } } }),
		).rejects.toThrow("usage recording failed");
		expect(fetcher).toHaveBeenCalledOnce();
	});
});
