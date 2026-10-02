import { describe, expect, it, vi } from "vitest";
import {
	ALL_ROUTE_CATEGORIES,
	chooseRouteCategory,
	ROUTE_CHOICE_QUESTION_ID,
	type RouteChoiceJudge,
} from "../../src/core/expert-routing/system-one-choice.ts";
import type { JevEvaluationRequest } from "../../src/core/system-one/adapter.ts";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";

function choice(pick: string, confidence: number, probabilities: Record<string, number>) {
	return { type: "choice", choice: pick, confidence, probabilities };
}

/** A judge that leans strong_medium at 0.85 first, and settles strong_medium over flash_deep at 0.95. */
function judge(options: { batch: boolean }) {
	const single = vi.fn(async (input: { options: readonly { id: string }[] }) => {
		const ids = input.options.map((option) => option.id);
		return {
			[ROUTE_CHOICE_QUESTION_ID]:
				ids.length === 4
					? choice("strong_medium", 0.85, {
							strong_medium: 0.6,
							flash_deep: 0.3,
							flash_light: 0.05,
							strong_deep: 0.05,
						})
					: choice("strong_medium", 0.95, { strong_medium: 0.95, flash_deep: 0.05 }),
		};
	});
	const batch = vi.fn(async (input: { optionSets: readonly (readonly { id: string }[])[] }) =>
		Promise.all(input.optionSets.map((options) => single({ options }))),
	);
	const fake: RouteChoiceJudge = {
		evaluateRouteChoice: single as RouteChoiceJudge["evaluateRouteChoice"],
		...(options.batch ? { evaluateRouteChoiceSet: batch as RouteChoiceJudge["evaluateRouteChoiceSet"] } : {}),
	};
	return { fake, single, batch };
}

describe("route category choice", () => {
	it("settles an ambiguous first pass from the same request, asking every follow-up pair up front", async () => {
		const { fake, single, batch } = judge({ batch: true });
		const outcome = await chooseRouteCategory(fake, {
			request: "Refactor the parser",
			available: ALL_ROUTE_CATEGORIES,
		});
		expect(outcome).toMatchObject({ kind: "chosen", category: "strong_medium", stage: "followed_up" });
		expect(batch).toHaveBeenCalledTimes(1);
		const sets = batch.mock.calls[0]?.[0].optionSets ?? [];
		expect(sets).toHaveLength(1 + 6);
		expect(sets[0]).toHaveLength(4);
		expect(sets.slice(1).every((set) => set.length === 2)).toBe(true);
		// The seven are the batch's own questions (this fake answers a set by asking each one); the
		// follow-up between the two leaders was served from them, not asked in a second round trip.
		expect(single).toHaveBeenCalledTimes(7);
	});

	it("reaches the same decision without a batching judge, one round trip per question (negative control)", async () => {
		const { fake, single } = judge({ batch: false });
		const outcome = await chooseRouteCategory(fake, {
			request: "Refactor the parser",
			available: ALL_ROUTE_CATEGORIES,
		});
		expect(outcome).toMatchObject({ kind: "chosen", category: "strong_medium", stage: "followed_up" });
		expect(single).toHaveBeenCalledTimes(2);
	});

	it("falls back, without a second attempt, when the batched request fails", async () => {
		const single = vi.fn();
		const batch = vi.fn(async () => {
			throw new Error("engine down");
		});
		const outcome = await chooseRouteCategory(
			{ evaluateRouteChoice: single, evaluateRouteChoiceSet: batch },
			{ request: "x", available: ALL_ROUTE_CATEGORIES },
		);
		expect(outcome).toMatchObject({ kind: "fallback", reason: expect.stringContaining("engine down") });
		expect(batch).toHaveBeenCalledTimes(1);
		expect(single).not.toHaveBeenCalled();
	});

	it("does not batch two categories: there is nothing narrower to ask", async () => {
		const { fake, batch, single } = judge({ batch: true });
		await chooseRouteCategory(fake, { request: "x", available: ["flash_light", "strong_deep"] });
		expect(batch).not.toHaveBeenCalled();
		expect(single).toHaveBeenCalled();
	});
});

describe("route choice set on the controller", () => {
	it("asks every option set in one System One request and shapes each answer like a single route choice", async () => {
		const evaluate = vi.fn(async (_input: JevEvaluationRequest) => ({
			model: "fixture",
			answers: {
				[ROUTE_CHOICE_QUESTION_ID]: choice("a", 0.9, { a: 0.9, b: 0.1 }),
				[`${ROUTE_CHOICE_QUESTION_ID}_set_1`]: choice("b", 0.97, { b: 0.97, a: 0.03 }),
			},
			latency_ms: 1,
		}));
		const store = new ExecutionStore({
			run_id: "route-set",
			objective: { request: "x", normalized_goal: "x", acceptance_criteria: [] },
			repo: { root: "/repo", baseline_revision: "base" },
		});
		const controller = new SystemOneController({ store, adapter: { evaluate } });
		const sets = [
			[
				{ id: "a", description: "A" },
				{ id: "b", description: "B" },
			],
			[{ id: "b", description: "B" }],
		];
		const results = await controller.evaluateRouteChoiceSet({ request: "pick", optionSets: sets });
		expect(evaluate).toHaveBeenCalledTimes(1);
		const questions = evaluate.mock.calls[0]?.[0].questions as Record<string, { criteria: Record<string, string> }>;
		expect(Object.keys(questions)).toEqual([ROUTE_CHOICE_QUESTION_ID, `${ROUTE_CHOICE_QUESTION_ID}_set_1`]);
		expect(Object.keys(questions[`${ROUTE_CHOICE_QUESTION_ID}_set_1`]!.criteria)).toEqual(["b"]);
		expect(results).toEqual([
			{ [ROUTE_CHOICE_QUESTION_ID]: choice("a", 0.9, { a: 0.9, b: 0.1 }) },
			{ [ROUTE_CHOICE_QUESTION_ID]: choice("b", 0.97, { b: 0.97, a: 0.03 }) },
		]);
	});
});
