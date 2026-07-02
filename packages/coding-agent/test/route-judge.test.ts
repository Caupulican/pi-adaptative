import { describe, expect, it, vi } from "vitest";
import type { RouteDecision } from "../src/core/autonomy/contracts.ts";
import { classifyModelRouterRoute } from "../src/core/model-router/intent-classifier.ts";
import {
	applyRouteJudgeVerdict,
	parseRouteJudgeVerdict,
	ROUTE_JUDGE_SYSTEM_PROMPT,
	runRouteJudge,
} from "../src/core/model-router/route-judge.ts";

function baseline(overrides: Partial<RouteDecision> = {}): RouteDecision {
	return {
		tier: "cheap",
		risk: "read-only",
		confidence: 0.5,
		reasonCode: "default_read_only",
		reasons: ["baseline"],
		...overrides,
	};
}

describe("planning floor (regex baseline)", () => {
	it("routes planning-shaped prompts to at least medium, even phrased as questions", () => {
		expect(classifyModelRouterRoute("how should we plan the migration?").tier).toBe("medium");
		expect(classifyModelRouterRoute("what is the best design for the cache layer?").tier).toBe("medium");
		expect(classifyModelRouterRoute("draft a roadmap for Q3").tier).toBe("medium");
		expect(classifyModelRouterRoute("plan the approach for the refactor").tier).toBe("medium");
		expect(classifyModelRouterRoute("how should we plan this?").reasonCode).toBe("planning_min_medium");
	});

	it("keeps plain lookups cheap and architecture rewrites expensive", () => {
		expect(classifyModelRouterRoute("what does this function return?").tier).toBe("cheap");
		expect(classifyModelRouterRoute("rewrite the architecture of the session layer").tier).toBe("expensive");
	});
});

describe("parseRouteJudgeVerdict", () => {
	it("parses strict, fenced, and embedded JSON verdicts", () => {
		expect(
			parseRouteJudgeVerdict('{"tier":"medium","risk":"read-only","trivial":false,"reason":"planning"}'),
		).toEqual({
			tier: "medium",
			risk: "read-only",
			trivial: false,
			reason: "planning",
		});
		expect(
			parseRouteJudgeVerdict('```json\n{"tier":"cheap","risk":"read-only","trivial":true,"reason":"t"}\n```')
				?.trivial,
		).toBe(true);
		expect(
			parseRouteJudgeVerdict('verdict: {"tier":"expensive","risk":"high-impact","trivial":false,"reason":"r"} done')
				?.tier,
		).toBe("expensive");
	});

	it("rejects the learning tier, unknown tiers, and malformed output", () => {
		expect(
			parseRouteJudgeVerdict('{"tier":"learning","risk":"read-only","trivial":false,"reason":"no"}'),
		).toBeUndefined();
		expect(
			parseRouteJudgeVerdict('{"tier":"free","risk":"read-only","trivial":false,"reason":"no"}'),
		).toBeUndefined();
		expect(parseRouteJudgeVerdict('{"tier":"cheap","risk":"nonsense","trivial":true,"reason":"no"}')).toBeUndefined();
		expect(parseRouteJudgeVerdict("no json at all")).toBeUndefined();
	});
});

describe("applyRouteJudgeVerdict", () => {
	it("overrides tier/risk and appends the judge reason", () => {
		const decision = applyRouteJudgeVerdict(baseline(), {
			tier: "medium",
			risk: "read-only",
			trivial: false,
			reason: "non-trivial planning",
		});
		expect(decision.tier).toBe("medium");
		expect(decision.reasonCode).toBe("judge_medium");
		expect(decision.reasons.at(-1)).toContain("non-trivial planning");
	});

	it("marks trivial downgrades distinctly", () => {
		const decision = applyRouteJudgeVerdict(baseline({ tier: "medium" }), {
			tier: "cheap",
			risk: "read-only",
			trivial: true,
			reason: "single trivial lookup",
		});
		expect(decision.tier).toBe("cheap");
		expect(decision.reasonCode).toBe("judge_cheap_trivial");
	});
});

describe("runRouteJudge", () => {
	it("applies a parsed verdict and reports spend", async () => {
		const result = await runRouteJudge({
			prompt: "how should we structure the cache?",
			baseline: baseline(),
			complete: async ({ systemPrompt }) => {
				expect(systemPrompt).toBe(ROUTE_JUDGE_SYSTEM_PROMPT);
				return {
					text: '{"tier":"medium","risk":"read-only","trivial":false,"reason":"planning"}',
					costUsd: 0.001,
					stopReason: "stop",
				};
			},
		});
		expect(result.decision.tier).toBe("medium");
		expect(result.verdict?.trivial).toBe(false);
		expect(result.fallbackReason).toBeUndefined();
		expect(result.costUsd).toBe(0.001);
	});

	it("falls back to the baseline on unparseable output, errors, and timeouts", async () => {
		const unparseable = await runRouteJudge({
			prompt: "p",
			baseline: baseline(),
			complete: async () => ({ text: "I think medium is fine", costUsd: 0.001, stopReason: "stop" }),
		});
		expect(unparseable.decision.tier).toBe("cheap");
		expect(unparseable.fallbackReason).toBe("judge_unparseable_fallback");

		const errored = await runRouteJudge({
			prompt: "p",
			baseline: baseline(),
			complete: async () => ({ text: "", costUsd: 0, stopReason: "error" }),
		});
		expect(errored.fallbackReason).toBe("judge_model_error");

		const timedOut = await runRouteJudge({
			prompt: "p",
			baseline: baseline(),
			maxWallClockMs: 10,
			complete: ({ signal }) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		});
		expect(timedOut.fallbackReason).toBe("judge_wall_clock_exceeded");
		expect(timedOut.decision.tier).toBe("cheap");
	});

	it("never calls the executor with tools or non-static prompts", async () => {
		const complete = vi.fn(async () => ({
			text: '{"tier":"cheap","risk":"read-only","trivial":true,"reason":"t"}',
			costUsd: 0,
			stopReason: "stop",
		}));
		await runRouteJudge({ prompt: "p", baseline: baseline(), complete });
		expect(complete).toHaveBeenCalledOnce();
	});
});
