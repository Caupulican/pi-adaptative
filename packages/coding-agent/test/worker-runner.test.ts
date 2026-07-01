import { describe, expect, it, vi } from "vitest";
import type { WorkerRequest } from "../src/core/autonomy/contracts.ts";
import {
	buildWorkerUserPrompt,
	parseWorkerOutput,
	runWorker,
	WORKER_LANE_SYSTEM_PROMPT,
	type WorkerCompletion,
	type WorkerRunnerOptions,
} from "../src/core/delegation/worker-runner.ts";

function workerRequest(overrides: Partial<WorkerRequest> = {}): WorkerRequest {
	return {
		id: "worker-1",
		instructions: "Scout the delegation module and summarize its validation rules",
		route: {
			tier: "cheap",
			risk: "read-only",
			confidence: 1,
			reasonCode: "scout_worker",
			reasons: ["Read-only scout delegation"],
		},
		envelope: {
			id: "worker-env-1",
			capabilities: ["read_files"],
			maxEstimatedUsd: 0.5,
			createdAt: "2026-07-01T00:00:00.000Z",
		},
		maxEstimatedUsd: 0.5,
		createdAt: "2026-07-01T00:00:00.000Z",
		...overrides,
	};
}

function completionOf(text: string, costUsd = 0.01, stopReason = "stop"): WorkerCompletion {
	return { text, costUsd, stopReason };
}

function runnerOptions(overrides: Partial<WorkerRunnerOptions> = {}): WorkerRunnerOptions {
	return {
		request: workerRequest(),
		maxUsd: 0.5,
		maxWallClockMs: 0,
		usageReportId: "worker:session-1:worker-1",
		now: () => "2026-07-01T00:00:01.000Z",
		complete: async () => completionOf('{"summary":"Validation blocks out-of-scope file changes."}'),
		...overrides,
	};
}

describe("parseWorkerOutput", () => {
	it("parses summary-only, blocked, and findings-bearing outputs", () => {
		expect(parseWorkerOutput('{"summary":"All good"}')).toEqual({
			summary: "All good",
			status: "completed",
			blockers: [],
			findings: [],
		});

		const blocked = parseWorkerOutput('{"summary":"Cannot proceed","status":"blocked","blockers":["Missing spec"]}');
		expect(blocked?.status).toBe("blocked");
		expect(blocked?.blockers).toEqual(["Missing spec"]);

		const withFindings = parseWorkerOutput(
			'```json\n{"summary":"Done","findings":[{"summary":"Rule A","confidence":0.7},{"summary":"Rule B"}]}\n```',
		);
		expect(withFindings?.findings).toHaveLength(2);
		expect(withFindings?.findings[0]).toEqual({ summary: "Rule A", confidence: 0.7 });
	});

	it("returns undefined for prose or missing summary", () => {
		expect(parseWorkerOutput("no JSON here")).toBeUndefined();
		expect(parseWorkerOutput('{"status":"completed"}')).toBeUndefined();
		expect(parseWorkerOutput('{"summary":""}')).toBeUndefined();
	});
});

describe("buildWorkerUserPrompt", () => {
	it("includes instructions and the expected output contract", () => {
		const prompt = buildWorkerUserPrompt(workerRequest());
		expect(prompt).toContain("Scout the delegation module");
	});
});

describe("runWorker", () => {
	it("completes a scout worker and passes parent validation", async () => {
		const outcome = await runWorker(runnerOptions());

		expect(outcome.result.requestId).toBe("worker-1");
		expect(outcome.result.status).toBe("completed");
		expect(outcome.result.summary).toBe("Validation blocks out-of-scope file changes.");
		expect(outcome.result.changedFiles).toEqual([]);
		expect(outcome.result.usageReportId).toBe("worker:session-1:worker-1");
		expect(outcome.result.createdAt).toBe("2026-07-01T00:00:01.000Z");
		expect(outcome.acceptance.outcome).toBe("allow");
		expect(outcome.accepted).toBe(true);
		expect(outcome.laneStatus).toBe("succeeded");
		expect(outcome.reasonCode).toBe("worker_completed");
		expect(outcome.costUsd).toBe(0.01);
	});

	it("maps findings into an untrusted evidence bundle", async () => {
		const outcome = await runWorker(
			runnerOptions({
				complete: async () =>
					completionOf('{"summary":"Done","findings":[{"summary":"validateWorkerResult blocks scope escapes"}]}'),
			}),
		);
		expect(outcome.result.evidence?.findings).toHaveLength(1);
		expect(outcome.result.evidence?.sources.some((source) => source.kind === "tool" && !source.trusted)).toBe(true);
	});

	it("returns a blocked result that requires parent review", async () => {
		const outcome = await runWorker(
			runnerOptions({
				complete: async () =>
					completionOf('{"summary":"Stuck","status":"blocked","blockers":["Needs credentials"]}'),
			}),
		);
		expect(outcome.result.status).toBe("blocked");
		expect(outcome.accepted).toBe(false);
		expect(outcome.acceptance.outcome).toBe("block");
		expect(outcome.laneStatus).toBe("failed");
		expect(outcome.reasonCode).toBe("worker_blocked");
	});

	it("fails on unparseable output while preserving spend", async () => {
		const outcome = await runWorker(runnerOptions({ complete: async () => completionOf("plain prose", 0.03) }));
		expect(outcome.result.status).toBe("failed");
		expect(outcome.accepted).toBe(false);
		expect(outcome.laneStatus).toBe("failed");
		expect(outcome.reasonCode).toBe("unparseable_output");
		expect(outcome.costUsd).toBe(0.03);
	});

	it("fails on a model error stop reason", async () => {
		const outcome = await runWorker(
			runnerOptions({ complete: async () => completionOf("irrelevant", 0.002, "error") }),
		);
		expect(outcome.result.status).toBe("failed");
		expect(outcome.laneStatus).toBe("failed");
		expect(outcome.reasonCode).toBe("model_error");
	});

	it("marks the lane budget_exhausted when spend exceeds maxUsd but keeps the result", async () => {
		const outcome = await runWorker(
			runnerOptions({ complete: async () => completionOf('{"summary":"pricey"}', 1.5) }),
		);
		expect(outcome.result.status).toBe("completed");
		expect(outcome.laneStatus).toBe("budget_exhausted");
		expect(outcome.reasonCode).toBe("cost_budget_exceeded");
	});

	it("cancels on external abort and times out on wall clock breach", async () => {
		const controller = new AbortController();
		const pendingCancel = runWorker(
			runnerOptions({
				signal: controller.signal,
				complete: ({ signal }) =>
					new Promise((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(new Error("aborted")));
					}),
			}),
		);
		controller.abort();
		const canceled = await pendingCancel;
		expect(canceled.result.status).toBe("cancelled");
		expect(canceled.laneStatus).toBe("canceled");

		const timedOut = await runWorker(
			runnerOptions({
				maxWallClockMs: 10,
				complete: ({ signal }) =>
					new Promise((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(new Error("aborted")));
					}),
			}),
		);
		expect(timedOut.result.status).toBe("cancelled");
		expect(timedOut.laneStatus).toBe("timeout");
		expect(timedOut.reasonCode).toBe("wall_clock_exceeded");
	});

	it("keeps the worker system prompt static for provider prompt caching", async () => {
		const complete = vi.fn(async ({ systemPrompt }: { systemPrompt: string }) => {
			expect(systemPrompt).toBe(WORKER_LANE_SYSTEM_PROMPT);
			return completionOf('{"summary":"ok"}');
		});
		await runWorker(runnerOptions({ complete }));
		expect(complete).toHaveBeenCalledOnce();
	});
});
