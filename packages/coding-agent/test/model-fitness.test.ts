import { describe, expect, it } from "vitest";
import { WORKER_LANE_SYSTEM_PROMPT } from "../src/core/delegation/worker-runner.ts";
import { ROUTE_JUDGE_SYSTEM_PROMPT } from "../src/core/model-router/route-judge.ts";
import {
	DEFAULT_JUDGE_FITNESS_PROMPTS,
	formatModelFitnessReport,
	runModelFitnessProbe,
	SEARCH_PROBE_SYSTEM_PROMPT,
	TOOL_CALL_PROBE_SYSTEM_PROMPT,
} from "../src/core/research/model-fitness.ts";
import { RESEARCH_LANE_SYSTEM_PROMPT } from "../src/core/research/research-runner.ts";

/** Scripted completer that answers each probe surface by its system prompt. */
function scriptedComplete(behavior: {
	research?: string;
	worker?: string;
	judge?: (userPrompt: string) => string;
	search?: string;
	toolCall?: string;
}) {
	return async ({ systemPrompt, userPrompt }: { systemPrompt: string; userPrompt: string }) => {
		let text = "not json";
		if (systemPrompt === RESEARCH_LANE_SYSTEM_PROMPT) text = behavior.research ?? "not json";
		else if (systemPrompt === WORKER_LANE_SYSTEM_PROMPT) text = behavior.worker ?? "not json";
		else if (systemPrompt === ROUTE_JUDGE_SYSTEM_PROMPT) text = behavior.judge?.(userPrompt) ?? "not json";
		else if (systemPrompt === SEARCH_PROBE_SYSTEM_PROMPT) text = behavior.search ?? "not json";
		else if (systemPrompt === TOOL_CALL_PROBE_SYSTEM_PROMPT) text = behavior.toolCall ?? "not json";
		return { text, costUsd: 0.001, stopReason: "stop" };
	};
}

describe("runModelFitnessProbe", () => {
	it("scores a fully-capable model across all five surfaces", async () => {
		const report = await runModelFitnessProbe({
			trials: 2,
			now: () => 0,
			complete: scriptedComplete({
				research: '{"findings":[{"summary":"finding","confidence":0.8}]}',
				worker: '{"summary":"done"}',
				judge: (prompt) =>
					/plan|design|roadmap/i.test(prompt)
						? '{"tier":"medium","risk":"read-only","trivial":false,"reason":"planning"}'
						: '{"tier":"cheap","risk":"read-only","trivial":true,"reason":"trivial"}',
				search: '{"queries":[{"pattern":"retry","glob":"**/*.ts"}]}',
				toolCall: '{"tool":"grep","arguments":{"pattern":"resolveCliModel","path":"src/"}}',
			}),
		});

		expect(report.research.succeeded).toBe(2);
		expect(report.worker.succeeded).toBe(2);
		expect(report.search.succeeded).toBe(3);
		expect(report.toolCall.succeeded).toBe(3);
		expect(report.judge.parsed).toBe(DEFAULT_JUDGE_FITNESS_PROMPTS.length);
		expect(report.judge.planningElevated).toBe(3);
		expect(report.judge.trivialCheap).toBe(3);
		expect(report.totalCostUsd).toBeGreaterThan(0);
	});

	it("scores an all-medium judge as safe but non-discriminating", async () => {
		const report = await runModelFitnessProbe({
			trials: 1,
			now: () => 0,
			complete: scriptedComplete({
				judge: () => '{"tier":"medium","risk":"read-only","trivial":false,"reason":"always medium"}',
			}),
		});
		expect(report.judge.planningElevated).toBe(3);
		expect(report.judge.trivialCheap).toBe(0);
	});

	it("records unparseable output honestly on every surface", async () => {
		const report = await runModelFitnessProbe({ trials: 1, now: () => 0, complete: scriptedComplete({}) });
		expect(report.research.succeeded).toBe(0);
		expect(report.worker.succeeded).toBe(0);
		expect(report.search.succeeded).toBe(0);
		expect(report.toolCall.succeeded).toBe(0);
		expect(report.judge.parsed).toBe(0);
		expect(report.search.outcomes).toEqual(["unparseable_output", "unparseable_output", "unparseable_output"]);
	});

	it("rejects malformed search plans and tool calls", async () => {
		const report = await runModelFitnessProbe({
			trials: 1,
			now: () => 0,
			complete: scriptedComplete({
				search: '{"queries":[]}',
				toolCall: '{"tool":"bash","arguments":{"pattern":"x","path":"y"}}',
			}),
		});
		expect(report.search.succeeded).toBe(0);
		expect(report.toolCall.succeeded).toBe(0);
	});

	it("formats a bounded human-readable report", async () => {
		const report = await runModelFitnessProbe({
			trials: 1,
			now: () => 0,
			complete: scriptedComplete({ search: '{"queries":[{"pattern":"a"}]}' }),
		});
		const text = formatModelFitnessReport("test/model", report);
		expect(text).toContain("Model fitness: test/model");
		expect(text).toContain("search plans:  3/3");
		expect(text).toContain("route judge:");
	});
});
