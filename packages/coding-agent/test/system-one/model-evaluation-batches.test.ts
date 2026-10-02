import { describe, expect, it, vi } from "vitest";
import { lightweightQuestionId, supersededQuestionId } from "../../src/core/expert-routing/system-one-choice.ts";
import type { EvaluationInput } from "../../src/core/review/typesafe-contract.ts";
import { SystemOneReviewer } from "../../src/core/review/typesafe-reviewer.ts";
import { SystemOneJevAdapter } from "../../src/core/system-one/adapter.ts";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";
import { SemanticPlaneHealthRecorder } from "../../src/core/system-one/semantic-plane-health.ts";

const REQUEST_BUDGET = 24 * 1024;

function modelPool(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		id: `provider/model-${index}`,
		description: `Model ${index}; ${"catalog fact; ".repeat(30)}`,
	}));
}

function fixture(reply?: (input: EvaluationInput, index: number) => Record<string, unknown>) {
	const requests: EvaluationInput[] = [];
	const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
		const input = JSON.parse(String(init?.body)) as EvaluationInput;
		requests.push(input);
		const answers =
			reply?.(input, requests.length - 1) ??
			Object.fromEntries(
				Object.keys(input.questions)
					.reverse()
					.map((id) => [id, { type: "noul", noul: Number(id.split("_").at(-1)) % 2 ? 0.04 : 0.96 }]),
			);
		return new Response(
			JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 10, output_tokens: 0 } }),
		);
	});
	const recorder = new SemanticPlaneHealthRecorder();
	const store = new ExecutionStore({
		run_id: "model-classification",
		objective: { request: "Choose a model", normalized_goal: "Choose a model", acceptance_criteria: [] },
		repo: { root: "/repo", baseline_revision: "base" },
	});
	const reviewer = new SystemOneReviewer({ getApiKey: async () => "fixture-key", fetch: fetchMock });
	const adapter = new SystemOneJevAdapter(reviewer, undefined, { getApiKey: () => "fixture-key" });
	return {
		requests,
		fetchMock,
		recorder,
		store,
		controller: new SystemOneController({ store, adapter, evaluationObserver: recorder }),
	};
}

describe("bounded model classification", () => {
	it("classifies a large uneven pool exactly once with global answer identities and bounded complete evidence", async () => {
		const models = modelPool(461);
		const { controller, requests, store, recorder } = fixture();
		const answers = await controller.evaluateLightweightModels({ models });
		expect(requests.length).toBeGreaterThan(1);
		const asked: string[] = [];
		for (const request of requests) {
			expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(REQUEST_BUDGET);
			const state = request.state as { models: Record<string, string> };
			expect(Object.keys(state)).toEqual(["models"]);
			expect(Object.keys(state.models)).toHaveLength(Object.keys(request.questions).length);
			for (const [id, question] of Object.entries(request.questions)) {
				const index = Number(id.split("_").at(-1));
				expect(state.models[`m${index}`]).toBe(models[index]?.description);
				expect(question.instructions).toContain(`models.m${index}`);
				asked.push(id);
			}
		}
		expect(asked).toEqual(models.map((_, index) => lightweightQuestionId(index)));
		expect(Object.keys(answers)).toHaveLength(models.length);
		models.forEach((_, index) => {
			expect(answers[lightweightQuestionId(index)]).toEqual({ type: "noul", noul: index % 2 ? 0.04 : 0.96 });
		});
		expect(store.snapshot().decisions).toHaveLength(requests.length);
		expect(recorder.getRecentEvaluations().every((record) => record.outcome === "ok")).toBe(true);
	});

	it("keeps a small independent pool in one request and skips empty pools (negative controls)", async () => {
		const { controller, requests } = fixture();
		expect(await controller.evaluateLightweightModels({ models: [] })).toEqual({});
		expect(requests).toHaveLength(0);
		await controller.evaluateLightweightModels({ models: modelPool(2) });
		expect(requests).toHaveLength(1);
	});

	it("retains every comparison model when superseded questions cross request boundaries", async () => {
		const models = Array.from({ length: 100 }, (_, index) => ({
			id: `family/${index}`,
			description: `Family version ${index}`,
		}));
		const { controller, requests } = fixture((input) => {
			const state = input.state as { models: Record<string, string> };
			expect(state.models.m99).toBe(models[99]?.description);
			return Object.fromEntries(
				Object.keys(input.questions).map((id) => [
					id,
					{ type: "noul", noul: id === supersededQuestionId(0) ? 0.99 : 0.01 },
				]),
			);
		});
		const answers = await controller.evaluateSupersededModels({ models });
		expect(requests.length).toBeGreaterThan(1);
		for (const request of requests) {
			expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(REQUEST_BUDGET);
			expect(Object.keys((request.state as { models: object }).models)).toHaveLength(models.length);
		}
		expect(answers[supersededQuestionId(0)]).toEqual({ type: "noul", noul: 0.99 });
		expect(Object.keys(answers)).toHaveLength(models.length);
	});

	it("rejects oversized individual or comparison evidence before issuing any request, without truncation", async () => {
		for (const mode of ["individual", "comparison"] as const) {
			const { controller, requests, recorder } = fixture();
			const run =
				mode === "individual"
					? controller.evaluateLightweightModels({
							models: [...modelPool(2), { id: "large", description: "界".repeat(REQUEST_BUDGET) }],
						})
					: controller.evaluateSupersededModels({ models: modelPool(100) });
			await expect(run).rejects.toMatchObject({ kind: "invalid_request" });
			expect(requests).toHaveLength(0);
			expect(recorder.getRecentEvaluations()).toMatchObject([
				{ outcome: "failed", reasons: expect.arrayContaining(["failure kind=invalid_request"]) },
			]);
		}
	});

	it("stops on cancellation between batches and never publishes partial answers", async () => {
		const abort = new AbortController();
		const { controller, requests } = fixture((input) => {
			abort.abort();
			return Object.fromEntries(Object.keys(input.questions).map((id) => [id, { type: "noul", noul: 0.99 }]));
		});
		await expect(
			controller.evaluateLightweightModels({ models: modelPool(100) }, abort.signal),
		).rejects.toBeDefined();
		expect(requests).toHaveLength(1);
		const alreadyAborted = fixture();
		await expect(
			alreadyAborted.controller.evaluateLightweightModels({ models: modelPool(2) }, abort.signal),
		).rejects.toBeDefined();
		expect(alreadyAborted.requests).toHaveLength(0);
	});

	it.each(["missing", "malformed", "stale", "transport"])(
		"rejects a %s later batch without returning earlier answers",
		async (failure) => {
			const { controller, requests, recorder } = fixture((input, index) => {
				if (index === 1 && failure === "transport") throw new Error("Provider request rejected");
				const answers = Object.fromEntries(
					Object.keys(input.questions).map((id) => [id, { type: "noul", noul: 0.99 }]),
				);
				if (index === 1) {
					const id = Object.keys(input.questions)[0]!;
					if (failure === "missing") delete answers[id];
					if (failure === "malformed") answers[id].noul = 2;
					if (failure === "stale") return { [lightweightQuestionId(0)]: { type: "noul", noul: 0.99 } };
				}
				return answers;
			});
			await expect(controller.evaluateLightweightModels({ models: modelPool(100) })).rejects.toBeDefined();
			expect(requests).toHaveLength(2);
			expect(recorder.getRecentEvaluations()).toMatchObject([{ outcome: "ok" }, { outcome: "failed" }]);
		},
	);
});
