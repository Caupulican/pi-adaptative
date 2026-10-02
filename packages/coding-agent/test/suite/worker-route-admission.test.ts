import { describe, expect, it, vi } from "vitest";
import { WorkerDirectoryAdmission } from "../../src/core/delegation/worker-directory-admission.ts";
import { ROUTE_CHOICE_QUESTION_ID } from "../../src/core/expert-routing/system-one-choice.ts";
import type { JevEvaluationRequest } from "../../src/core/system-one/adapter.ts";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";
import { createReuseHarness } from "../fixtures/specialist-reuse-harness.ts";

async function fixture(answer: "high" | "uncertain" | "forged" | "outage" = "high") {
	const evaluate = vi.fn(async (input: JevEvaluationRequest) => {
		if (answer === "outage") throw new Error("judge unavailable");
		const question = input.questions[ROUTE_CHOICE_QUESTION_ID] as { criteria?: Record<string, string> } | undefined;
		const choice = Object.entries(question?.criteria ?? {}).find(([, description]) =>
			description.includes("effort=high"),
		)?.[0];
		return {
			model: "fixture",
			latency_ms: 1,
			answers: {
				[ROUTE_CHOICE_QUESTION_ID]: {
					type: "choice",
					choice: answer === "forged" ? "unapproved" : choice,
					confidence: answer === "uncertain" ? 0.6 : 0.98,
				},
			},
		};
	});
	const controller = new SystemOneController({
		store: new ExecutionStore({
			run_id: "worker-route",
			objective: { request: "Delegate", normalized_goal: "Delegate", acceptance_criteria: [] },
			repo: { root: "/repo", baseline_revision: "base" },
		}),
		adapter: { evaluate },
	});
	const originalJudge = controller.evaluateRouteChoice.bind(controller);
	const judge = vi.spyOn(controller, "evaluateRouteChoice");
	const context = await createReuseHarness({
		models: [{ id: "reasoning-worker", reasoning: true, contextWindow: 200_000, maxTokens: 32_000 }],
		systemOneController: controller,
		settings: {
			modelFavorites: [{ provider: "faux", modelId: "reasoning-worker" }],
			workerDelegation: { enabled: true, orchestrationProfile: undefined },
		},
	});
	context.harness.session.setThinkingLevel("medium");
	return { context, judge, originalJudge };
}

describe("native fresh worker route admission", () => {
	it("refuses an empty favorite pool before judgment even with an owner model pin", async () => {
		const { context, judge } = await fixture();
		context.harness.settingsManager.toggleModelFavorite("faux", "reasoning-worker");
		context.harness.settingsManager.setWorkerDelegationSettings({
			modelPins: { default: { provider: "faux", modelId: "reasoning-worker", thinkingLevel: "medium" } },
		});
		const result = await context.lanes().startWorkerDelegation({ instructions: "Pinned work" });
		expect(result.started).toBe(false);
		expect(context.attempts()).toHaveLength(0);
		expect(judge).not.toHaveBeenCalled();
	});

	it("rejects a favorite removed while the worker judgment is pending", async () => {
		const { context, judge, originalJudge } = await fixture();
		judge.mockImplementation(async (...args) => {
			const answer = await originalJudge(...args);
			context.harness.settingsManager.toggleModelFavorite("faux", "reasoning-worker");
			return answer;
		});
		const result = await context.lanes().startWorkerDelegation({ instructions: "Complex reasoning." });
		expect(result.started).toBe(false);
		expect(context.attempts()).toHaveLength(0);
	});

	it("cancels a queued contract when its model is no longer a favorite", async () => {
		const { context } = await fixture();
		const result = await context.lanes().startWorkerDelegation({ instructions: "Queued reasoning." });
		expect(result.started).toBe(true);
		context.harness.settingsManager.toggleModelFavorite("faux", "reasoning-worker");
		context.lanes().drainQueuedWorkerDelegations();
		expect(context.attempts()[0]?.status).toBe("cancelled");
	});

	it("preserves explicit worker configuration when automatic model routing is disabled", async () => {
		const { context, judge } = await fixture();
		context.harness.settingsManager.setModelRouterSettings({ enabled: false });
		context.harness.settingsManager.toggleModelFavorite("faux", "reasoning-worker");
		const result = await context
			.lanes()
			.startWorkerDelegation({ instructions: "Manual worker", authority: { thinkingLevel: "medium" } });
		expect(result.started).toBe(true);
		expect(judge).not.toHaveBeenCalled();
	});
	it("does not judge an unpinned worker when automatic model routing is disabled", async () => {
		const { context, judge } = await fixture();
		context.harness.settingsManager.setModelRouterSettings({ enabled: false });
		context.harness.settingsManager.toggleModelFavorite("faux", "reasoning-worker");
		const result = await context.lanes().startWorkerDelegation({ instructions: "Unpinned manual worker" });
		expect(result.started).toBe(true);
		expect(judge).not.toHaveBeenCalled();
	});

	it("asks the host judge once and persists its approved model and effort before start", async () => {
		const { context, judge } = await fixture();
		const result = await context
			.lanes()
			.startWorkerDelegation({ instructions: "Reason through a complex strict JSON schema." });
		expect(result.started).toBe(true);
		expect(judge).toHaveBeenCalledTimes(1);
		const worker = context.attempts()[0]?.dispatch.executionContract?.worker;
		expect(worker?.modelBinding).toMatchObject({ modelId: "reasoning-worker", thinkingLevel: "high" });
		expect(worker?.profile.modelPolicy.mode).toBe("fixed");
		expect(worker?.authority.toolNames).not.toContain("delegate");
		expect(worker?.authority.capabilities).not.toContain("workflow.delegate");
	});

	it.each(["uncertain", "forged", "outage"] as const)("retains the host default for a %s answer", async (answer) => {
		const { context, judge } = await fixture(answer);
		const result = await context.lanes().startWorkerDelegation({ instructions: "Implement a small fix." });
		expect(result.started).toBe(true);
		expect(judge).toHaveBeenCalledTimes(1);
		expect(context.attempts()[0]?.dispatch.executionContract?.worker.modelBinding.thinkingLevel).toBe("low");
	});

	it("leaves explicit authority untouched and skips another judgment when reusing the persistent worker", async () => {
		const { context, judge } = await fixture();
		const first = await context.harness.session.runWorkerDelegationOnce({
			instructions: "First task",
			authority: { thinkingLevel: "medium", readOnly: true },
		});
		expect(first.started).toBe(true);
		const agentId = context.attempts()[0]?.agentId;
		expect(agentId).toBeDefined();
		const second = await context.lanes().startWorkerDelegation({
			instructions: "Follow-up",
			reuseAgentId: agentId,
			authority: { thinkingLevel: "medium", readOnly: true },
		});
		expect(second.started).toBe(true);
		expect(judge).not.toHaveBeenCalled();
		expect(
			context
				.attempts()
				.every((attempt) => attempt.dispatch.executionContract?.worker.modelBinding.thinkingLevel === "medium"),
		).toBe(true);
	});

	it("selects effort through runOnce while retaining a read-only task grant", async () => {
		const { context, judge } = await fixture();
		const result = await context.harness.session.runWorkerDelegationOnce({
			instructions: "Review strict JSON parsing independently.",
			authority: { readOnly: true, toolNames: ["read"] },
		});
		expect(result.started).toBe(true);
		expect(judge).toHaveBeenCalledTimes(1);
		const worker = context.attempts()[0]?.dispatch.executionContract?.worker;
		expect(worker?.modelBinding.thinkingLevel).toBe("high");
		expect(worker?.authority.writePaths).toEqual([]);
		expect(worker?.authority.toolNames).not.toContain("write");
		expect(worker?.authority.toolNames).not.toContain("delegate");
	});

	it("returns the admitted receipt on replay without repeating the route judgment", async () => {
		const { context, judge } = await fixture();
		const request = { instructions: "Reason through strict JSON.", messageReplayKey: "route-replay" };
		const first = await context.lanes().startWorkerDelegation(request);
		const replay = await context.lanes().startWorkerDelegation(request);
		expect(first.started).toBe(true);
		expect(replay.started).toBe(true);
		if (first.started && replay.started) expect(replay.record.laneId).toBe(first.record.laneId);
		expect(context.attempts()).toHaveLength(1);
		expect(judge).toHaveBeenCalledTimes(1);
	});

	it("keeps the selected high effort when explicitly reusing the persistent worker", async () => {
		const { context, judge } = await fixture();
		const first = await context.harness.session.runWorkerDelegationOnce({ instructions: "Complex JSON reasoning." });
		expect(first.started).toBe(true);
		const agentId = context.attempts()[0]?.agentId;
		expect(agentId).toBeDefined();
		const second = await context.harness.session.runWorkerDelegationOnce({
			instructions: "Continue reasoning.",
			reuseAgentId: agentId,
		});
		expect(second.started).toBe(true);
		expect(context.attempts()).toHaveLength(2);
		expect(
			context
				.attempts()
				.every(
					(attempt) =>
						attempt.agentId === agentId &&
						attempt.dispatch.executionContract?.worker.modelBinding.thinkingLevel === "high",
				),
		).toBe(true);
		expect(judge).toHaveBeenCalledTimes(1);
	});

	it("keeps owner model pins ahead of the judge", async () => {
		const { context, judge } = await fixture();
		context.harness.settingsManager.setWorkerDelegationSettings({
			modelPins: {
				roles: { implementer: { provider: "faux", modelId: "reasoning-worker", thinkingLevel: "medium" } },
			},
		});
		const result = await context.lanes().startWorkerDelegation({ instructions: "Complex reasoning." });
		expect(result.started).toBe(true);
		expect(judge).not.toHaveBeenCalled();
		expect(context.attempts()[0]?.dispatch.executionContract?.worker.modelBinding.thinkingLevel).toBe("medium");
	});

	it("does not publish a stale judgment after the host thinking policy changes", async () => {
		const { context, judge, originalJudge } = await fixture();
		judge.mockImplementation(async (...args) => {
			const answer = await originalJudge(...args);
			context.harness.session.setThinkingLevel("high");
			return answer;
		});
		const result = await context.lanes().startWorkerDelegation({ instructions: "Complex reasoning." });
		expect(result.started).toBe(true);
		expect(judge).toHaveBeenCalledTimes(1);
		expect(context.attempts()[0]?.dispatch.executionContract?.worker.modelBinding.thinkingLevel).toBe("medium");
	});

	it("cancels admission after a judgment returns against an aborted start", async () => {
		const { context, judge, originalJudge } = await fixture();
		const abort = new AbortController();
		judge.mockImplementation(async (...args) => {
			const answer = await originalJudge(...args);
			abort.abort();
			return answer;
		});
		const result = await context.lanes().startWorkerDelegation({ instructions: "Complex reasoning." }, abort.signal);
		expect(result).toEqual({ started: false, skipReason: "worker_start_aborted" });
		expect(context.attempts()).toHaveLength(0);
	});

	it("rejects a selected route if an owner pin changes during the final namespace check", async () => {
		const { context, judge } = await fixture();
		const namespaceKey = WorkerDirectoryAdmission.prototype.namespaceKey;
		const namespace = vi.spyOn(WorkerDirectoryAdmission.prototype, "namespaceKey").mockImplementation(async function (
			this: WorkerDirectoryAdmission,
			...args
		) {
			const key = await namespaceKey.apply(this, args);
			if (judge.mock.calls.length > 0)
				context.harness.settingsManager.setWorkerDelegationSettings({
					modelPins: {
						roles: { implementer: { provider: "faux", modelId: "reasoning-worker", thinkingLevel: "medium" } },
					},
				});
			return key;
		});
		try {
			const result = await context.lanes().startWorkerDelegation({ instructions: "Complex reasoning." });
			expect(result).toEqual({ started: false, skipReason: "worker_route_selection_stale" });
			expect(context.attempts()).toHaveLength(0);
			expect(judge).toHaveBeenCalledTimes(1);
		} finally {
			namespace.mockRestore();
		}
	});

	it("rejects model metadata mutated during the final namespace check", async () => {
		const { context, judge } = await fixture();
		const model = context.harness.session.modelRegistry.find("faux", "reasoning-worker")!;
		const namespaceKey = WorkerDirectoryAdmission.prototype.namespaceKey;
		const namespace = vi.spyOn(WorkerDirectoryAdmission.prototype, "namespaceKey").mockImplementation(async function (
			this: WorkerDirectoryAdmission,
			...args
		) {
			const key = await namespaceKey.apply(this, args);
			if (judge.mock.calls.length > 0) model.baseUrl = "http://127.0.0.1/changed-worker-endpoint";
			return key;
		});
		try {
			const result = await context.lanes().startWorkerDelegation({ instructions: "Complex reasoning." });
			expect(result).toEqual({ started: false, skipReason: "worker_route_selection_stale" });
			expect(context.attempts()).toHaveLength(0);
		} finally {
			namespace.mockRestore();
		}
	});
});
