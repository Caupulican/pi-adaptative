import type { Api, Model } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { ExpertAdmissionPolicy } from "../../src/core/expert-routing/admission.ts";

import { ExpertCapacityService } from "../../src/core/expert-routing/capacity.ts";
import { ExpertCatalog } from "../../src/core/expert-routing/catalog.ts";
import { ExpertFeatureBuilder } from "../../src/core/expert-routing/features.ts";
import { ExpertRankingPolicy } from "../../src/core/expert-routing/ranking.ts";
import { buildWorkerCapabilityRequest } from "../../src/core/expert-routing/request-builder.ts";
import { ExpertSelectionService } from "../../src/core/expert-routing/service.ts";
import {
	chooseHostRouteProfile,
	chooseRouteCategory,
	classifyLightweightModels,
	MAX_ROUTE_CHOICE_REQUEST_CHARACTERS,
	type RouteChoiceJudge,
} from "../../src/core/expert-routing/system-one-choice.ts";

function model(
	id: string,
	facts: { reasoning?: boolean; image?: boolean; input?: number; context?: number },
): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "p",
		baseUrl: "https://example.test",
		reasoning: facts.reasoning ?? true,
		input: facts.image ? ["text", "image"] : ["text"],
		cost: {
			input: (facts.input ?? 1) / 1_000_000,
			output: (facts.input ?? 1) / 1_000_000,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: facts.context ?? 200_000,
		maxTokens: 32_000,
	} as Model<Api>;
}

const flashA = model("flash-a", { input: 0.1, image: true });
const flashB = model("flash-b", { input: 0.2 });
const strong = model("strong", { input: 5, context: 1_000_000, image: true });
const textOnly = model("text-only", { input: 3, context: 400_000 });
const speed: Record<string, number> = { "flash-a": 300, "flash-b": 250, strong: 60, "text-only": 80 };

/** Scripted System One: route answers in order, and `flash-*` models judged lightweight. */
function judge(...answers: { choice: string; confidence: number; probabilities?: Record<string, number> }[]) {
	const asked: string[][] = [];
	const value: RouteChoiceJudge = {
		evaluateRouteChoice: async ({ options }) => {
			asked.push(options.map((option) => option.id));
			return { route_choice: { type: "choice", ...answers[asked.length - 1] } };
		},
		evaluateLightweightModels: async ({ models }) =>
			Object.fromEntries(
				models.map((m, index) => [`lightweight_${index}`, { noul: m.id.includes("/flash-") ? 0.97 : 0.03 }]),
			),
	};
	return { judge: value, asked };
}

describe("System One allocation", () => {
	it("worker classification and ranking see only live router candidates even without a request allowlist", async () => {
		let favorites = [strong];
		const systemOne: RouteChoiceJudge = {
			evaluateRouteChoice: async () => ({
				route_choice: { type: "choice", choice: "strong_medium", confidence: 0.99 },
			}),
			evaluateLightweightModels: vi.fn(async () => {
				return { lightweight_0: { noul: 0.03 } };
			}),
		};
		const catalog = new ExpertCatalog({
			modelRegistry: { getAll: () => [flashA, strong], hasConfiguredAuth: () => true } as never,
			getCandidateModels: () => favorites,
		});
		const capacity = new ExpertCapacityService();
		const reserve = vi.spyOn(capacity, "reserve");
		const service = new ExpertSelectionService(
			catalog,
			new ExpertAdmissionPolicy(),
			new ExpertFeatureBuilder(),
			new ExpertRankingPolicy(),
			capacity,
			undefined,
			() => systemOne,
		);
		const request = buildWorkerCapabilityRequest({ objectiveId: "o", taskId: "t", workClass: "implement" });
		const plan = await service.select(request, { requestText: "work" });
		expect(plan.primary.model_id).toBe("strong");
		expect(vi.mocked(systemOne.evaluateLightweightModels!).mock.calls[0][0].models.map((m) => m.id)).toEqual([
			"p/strong",
		]);
		service.release(plan);
		reserve.mockClear();
		favorites = [];
		await expect(service.select(request)).rejects.toThrow("No eligible");
		expect(reserve).not.toHaveBeenCalled();
		expect(systemOne.evaluateLightweightModels).toHaveBeenCalledOnce();
	});
	it.each(["removal", "cancellation"] as const)("rolls back only its own lease after late %s", async (change) => {
		let favorites = [strong];
		const catalog = new ExpertCatalog({
			modelRegistry: { hasConfiguredAuth: () => true } as never,
			getCandidateModels: () => favorites,
		});
		const capacity = new ExpertCapacityService();
		const service = new ExpertSelectionService(
			catalog,
			new ExpertAdmissionPolicy(),
			new ExpertFeatureBuilder(),
			new ExpertRankingPolicy(),
			capacity,
		);
		const request = buildWorkerCapabilityRequest({ objectiveId: "o", taskId: "t", workClass: "implement" });
		await service.select(request);
		const existing = capacity.getAllActiveLeases();
		expect(existing).toHaveLength(1);
		const abort = new AbortController();
		const reserve = capacity.reserve.bind(capacity);
		vi.spyOn(capacity, "reserve").mockImplementation(async (...args) => {
			const leases = await reserve(...args);
			if (change === "removal") favorites = [];
			else abort.abort(new Error("cancelled after reservation"));
			return leases;
		});
		await expect(service.select(request, { signal: abort.signal })).rejects.toThrow(
			change === "removal" ? "No eligible" : "cancelled after reservation",
		);
		expect(capacity.getAllActiveLeases()).toEqual(existing);
		capacity.release(existing);
		expect(capacity.getAllActiveLeases()).toEqual([]);
	});

	it("a favorite removed during judgment cannot acquire a worker reservation", async () => {
		let favorites = [strong];
		const catalog = new ExpertCatalog({
			modelRegistry: { getAll: () => [strong], hasConfiguredAuth: () => true } as never,
			getCandidateModels: () => favorites,
		});
		const capacity = new ExpertCapacityService();
		const reserve = vi.spyOn(capacity, "reserve");
		const service = new ExpertSelectionService(
			catalog,
			new ExpertAdmissionPolicy(),
			new ExpertFeatureBuilder(),
			new ExpertRankingPolicy(),
			capacity,
			undefined,
			() => ({
				evaluateRouteChoice: async () => {
					favorites = [];
					return { route_choice: { type: "choice", choice: "strong_medium", confidence: 0.99 } };
				},
			}),
		);
		await expect(
			service.select(buildWorkerCapabilityRequest({ objectiveId: "o", taskId: "t", workClass: "implement" }), {
				requestText: "work",
			}),
		).rejects.toThrow("No eligible");
		expect(reserve).not.toHaveBeenCalled();
	});
	it("selects an approved model and effort profile with exactly one judgment, or keeps the host default", async () => {
		const options = [
			{ id: "ordinary", description: "Host model A at medium effort" },
			{ id: "complex", description: "Host model B at high effort" },
		];
		for (const confidence of [0.85, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const scripted = judge({ choice: "complex", confidence, probabilities: { ordinary: 0.1 } });
			expect(await chooseHostRouteProfile(scripted.judge, { request: "task", options })).toHaveProperty("fallback");
			expect(scripted.asked).toHaveLength(1);
		}
		const valid = judge({ choice: "complex", confidence: 0.95 });
		expect(await chooseHostRouteProfile(valid.judge, { request: "task", options })).toMatchObject({
			choice: "complex",
			stage: "decided",
		});
		const forged = judge({ choice: "unapproved", confidence: 0.99 });
		expect(await chooseHostRouteProfile(forged.judge, { request: "task", options })).toHaveProperty("fallback");
		for (const type of ["noul", undefined]) {
			const malformed = {
				evaluateRouteChoice: async () => ({ route_choice: { type, choice: "complex", confidence: 0.99 } }),
			};
			expect(await chooseHostRouteProfile(malformed, { request: "task", options })).toHaveProperty("fallback");
		}
	});

	it("does not accept a model category excluded from the narrowed host options", async () => {
		const scripted = judge(
			{ choice: "flash_deep", confidence: 0.85, probabilities: { strong_medium: 0.1 } },
			{ choice: "strong_deep", confidence: 0.95 },
		);
		expect(
			await chooseRouteCategory(scripted.judge, {
				request: "task",
				available: ["flash_deep", "strong_medium", "strong_deep"],
			}),
		).toMatchObject({ category: "flash_deep", stage: "provisional" });
	});

	it("preserves host authority on outage, cancellation, duplicate profiles and oversized evidence", async () => {
		const options = [{ id: "host", description: "Host-approved model at medium effort" }];
		const evaluateRouteChoice = vi.fn(async () => {
			throw new Error("transport failed");
		});
		const systemOne = { evaluateRouteChoice };
		expect(await chooseHostRouteProfile(systemOne, { request: "task", options })).toEqual({
			fallback: "System One unavailable: transport failed",
		});
		expect(evaluateRouteChoice).toHaveBeenCalledTimes(1);
		evaluateRouteChoice.mockClear();
		for (const input of [
			{ request: "task", options: [...options, ...options] },
			{ request: "x".repeat(MAX_ROUTE_CHOICE_REQUEST_CHARACTERS + 1), options },
		])
			expect(await chooseHostRouteProfile(systemOne, input)).toHaveProperty("fallback");
		expect(evaluateRouteChoice).not.toHaveBeenCalled();
		const controller = new AbortController();
		controller.abort(new Error("canceled"));
		await expect(
			chooseHostRouteProfile(systemOne, { request: "task", options, signal: controller.signal }),
		).rejects.toThrow("canceled");
		expect(evaluateRouteChoice).not.toHaveBeenCalled();
		const late = new AbortController();
		const during = {
			evaluateRouteChoice: async () => {
				late.abort(new Error("canceled during judgment"));
				return { route_choice: { type: "choice", choice: "host", confidence: 0.99 } };
			},
		};
		await expect(chooseHostRouteProfile(during, { request: "task", options, signal: late.signal })).rejects.toThrow(
			"canceled during judgment",
		);
	});
	it("flash is System One's judgment of each model, never a name rule in code, and nothing without it", async () => {
		const models = [flashA, flashB, strong].map((m) => ({ id: `p/${m.id}`, description: m.id }));
		expect([...(await classifyLightweightModels(judge().judge, models))]).toEqual(["p/flash-a", "p/flash-b"]);
		expect((await classifyLightweightModels(undefined, models)).size).toBe(0);
	});

	it("decides at 0.90, asks the top two between 0.80 and 0.90, and falls back below 0.80", async () => {
		const available = ["flash_light", "flash_deep", "strong_medium", "strong_deep"] as const;
		const sure = judge({ choice: "strong_deep", confidence: 0.95 });
		expect(await chooseRouteCategory(sure.judge, { request: "r", available })).toMatchObject({
			kind: "chosen",
			category: "strong_deep",
			stage: "decided",
		});
		const narrowed = judge(
			{ choice: "flash_deep", confidence: 0.85, probabilities: { flash_deep: 0.85, strong_medium: 0.1 } },
			{ choice: "strong_medium", confidence: 0.93 },
		);
		expect(await chooseRouteCategory(narrowed.judge, { request: "r", available })).toMatchObject({
			category: "strong_medium",
			stage: "followed_up",
		});
		expect(narrowed.asked[1]).toEqual(["flash_deep", "strong_medium"]);
		const unsure = judge({ choice: "flash_deep", confidence: 0.6 });
		expect((await chooseRouteCategory(unsure.judge, { request: "r", available })).kind).toBe("fallback");
	});

	it("picks inside the chosen category from facts, and an image requirement removes text-only models", async () => {
		const registry = {
			getAll: () => [flashA, flashB, strong, textOnly],
			hasConfiguredAuth: () => true,
			isUsingSubscription: () => false,
		};
		const adaptationStore = { get: (ref: string) => ({ perf: { decodeTokensPerSecond: speed[ref.slice(2)] } }) };
		const select = async (choice: string, required?: string[]) => {
			const { judge: systemOne } = judge({ choice, confidence: 0.97 });
			const service = new ExpertSelectionService(
				new ExpertCatalog({
					modelRegistry: registry as never,
					getCandidateModels: registry.getAll,
					adaptationStore: adaptationStore as never,
				}),
				new ExpertAdmissionPolicy(),
				new ExpertFeatureBuilder(),
				new ExpertRankingPolicy(),
				new ExpertCapacityService(),
				undefined,
				() => systemOne,
			);
			const request = buildWorkerCapabilityRequest({
				objectiveId: "o",
				taskId: "t",
				workClass: "implement",
				...(required ? { requiredCapabilities: required } : {}),
			});
			const plan = await service.select(request, { requestText: "do the work" });
			service.release(plan);
			return plan;
		};
		const deep = await select("strong_deep");
		expect(deep.primary).toMatchObject({ model_id: "strong", thinking_level: "high" });
		expect(deep.decidedBy?.kind).toBe("system_one");
		const light = await select("flash_light");
		expect(light.primary).toMatchObject({ model_id: "flash-a", thinking_level: "low" });
		const vision = await select("strong_medium", ["image_input"]);
		expect(vision.primary.model_id).toBe("strong");
	});
});
