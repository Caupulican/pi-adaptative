import { describe, expect, it } from "vitest";
import type { JevEvaluationRequest } from "../../src/core/system-one/adapter.ts";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";
import { SemanticPlaneHealthRecorder } from "../../src/core/system-one/semantic-plane-health.ts";

function fixture(
	evaluate: (input: JevEvaluationRequest) => Promise<{
		model: string;
		answers: Record<string, unknown>;
		latency_ms: number;
	}>,
) {
	const observer = new SemanticPlaneHealthRecorder(() => 10);
	const store = new ExecutionStore({
		run_id: "model-pool-doubts",
		objective: { request: "Change model policy", normalized_goal: "Change model policy", acceptance_criteria: [] },
		repo: { root: "/repo", baseline_revision: "base" },
	});
	const controller = new SystemOneController({ store, adapter: { evaluate }, evaluationObserver: observer });
	return { controller, observer };
}

function allPools(subscription: unknown = { choice: "unchanged", confidence: 0.99 }) {
	return {
		model_pool_subscription: subscription,
		model_pool_metered: { choice: "unchanged", confidence: 0.99 },
		model_pool_local: { choice: "unchanged", confidence: 0.99 },
	};
}

describe("model-pool semantic doubts", () => {
	it("keeps an ask-more result live through an ambiguous follow-up, then clears only on a decisive same-question answer", async () => {
		let call = 0;
		const { controller, observer } = fixture(async () => {
			call++;
			if (call === 1)
				return { model: "fixture", answers: allPools({ choice: "enable", confidence: 0.85 }), latency_ms: 1 };
			if (call === 2)
				return { model: "fixture", answers: { model_pool_subscription: { noul: 0.5 } }, latency_ms: 1 };
			if (call === 3)
				return {
					model: "fixture",
					answers: { model_pool_metered: { choice: "enable", confidence: 0.99 } },
					latency_ms: 1,
				};
			return {
				model: "fixture",
				answers: { model_pool_subscription: { choice: "unchanged", confidence: 0.99 } },
				latency_ms: 1,
			};
		});

		const first = await controller.evaluateModelPools("Maybe allow subscriptions");
		expect(first.change.subscription).toBeUndefined();
		expect(first.doubts).toHaveLength(1);
		expect(observer.getHealth(true).unresolvedDoubts).toHaveLength(1);
		expect(observer.getHealth(true).unresolvedDoubts?.[0]?.question).toBe("model_pool_subscription");

		await controller.evaluateModelPools("Use metered API models");
		expect(observer.getHealth(true).unresolvedDoubts).toHaveLength(1);
		expect(observer.getHealth(true).unresolvedDoubts?.[0]?.question).toBe("model_pool_subscription");

		const resolved = await controller.evaluateModelPools("Keep subscription models unchanged");
		expect(resolved.change.subscription).toBeUndefined();
		expect(observer.getHealth(true).unresolvedDoubts).toHaveLength(0);
	});

	it("keeps the first-stage doubt active if the follow-up evaluator fails", async () => {
		let call = 0;
		const { controller, observer } = fixture(async () => {
			call++;
			if (call === 1)
				return { model: "fixture", answers: allPools({ choice: "disable", confidence: 0.85 }), latency_ms: 1 };
			throw new Error("reviewer unavailable");
		});

		await expect(controller.evaluateModelPools("Maybe disable subscriptions")).rejects.toThrow(
			"reviewer unavailable",
		);
		expect(observer.getHealth(true).unresolvedDoubts).toHaveLength(1);
		expect(observer.getHealth(true).unresolvedDoubts?.[0]?.question).toBe("model_pool_subscription");
	});

	it("resolves the same question when the follow-up decisively authorizes the requested change", async () => {
		let call = 0;
		const { controller, observer } = fixture(async () => {
			call++;
			if (call === 1)
				return { model: "fixture", answers: allPools({ choice: "enable", confidence: 0.85 }), latency_ms: 1 };
			return { model: "fixture", answers: { model_pool_subscription: { noul: 0.99 } }, latency_ms: 1 };
		});

		const result = await controller.evaluateModelPools("Enable subscription models");
		expect(result.change.subscription).toBe(true);
		expect(result.doubts).toHaveLength(0);
		expect(observer.getHealth(true).unresolvedDoubts).toHaveLength(0);
	});

	it("resolves but does not apply a decisive negative explicit-band follow-up", async () => {
		let call = 0;
		const { controller, observer } = fixture(async () => {
			call++;
			if (call === 1)
				return { model: "fixture", answers: allPools({ choice: "enable", confidence: 0.85 }), latency_ms: 1 };
			return {
				model: "fixture",
				answers: { model_pool_subscription: { band: "hard_fail", direction: "required_true" } },
				latency_ms: 1,
			};
		});

		const result = await controller.evaluateModelPools("Enable subscription models");
		expect(result.change.subscription).toBeUndefined();
		expect(result.doubts).toHaveLength(0);
		expect(observer.getHealth(true).unresolvedDoubts).toHaveLength(0);
	});
});
