import { describe, expect, it } from "vitest";
import { WORKER_LANE_SYSTEM_PROMPT } from "../src/core/delegation/worker-runner.ts";
import { ROUTE_JUDGE_SYSTEM_PROMPT } from "../src/core/model-router/route-judge.ts";
import {
	DEFAULT_JUDGE_FITNESS_PROMPTS,
	DIGEST_PROBE_SYSTEM_PROMPT,
	formatModelFitnessReport,
	isProbeAllFailed,
	type ModelFitnessReport,
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
	digest?: (userPrompt: string) => string;
}) {
	return async ({ systemPrompt, userPrompt }: { systemPrompt: string; userPrompt: string }) => {
		let text = "not json";
		if (systemPrompt === RESEARCH_LANE_SYSTEM_PROMPT) text = behavior.research ?? "not json";
		else if (systemPrompt === WORKER_LANE_SYSTEM_PROMPT) text = behavior.worker ?? "not json";
		else if (systemPrompt === ROUTE_JUDGE_SYSTEM_PROMPT) text = behavior.judge?.(userPrompt) ?? "not json";
		else if (systemPrompt === SEARCH_PROBE_SYSTEM_PROMPT) text = behavior.search ?? "not json";
		else if (systemPrompt === TOOL_CALL_PROBE_SYSTEM_PROMPT) text = behavior.toolCall ?? "not json";
		else if (systemPrompt === DIGEST_PROBE_SYSTEM_PROMPT) text = behavior.digest?.(userPrompt) ?? "not json";
		return { text, costUsd: 0.001, stopReason: "stop" };
	};
}

/**
 * A faithful digest echoes the probe chunk's nonce back verbatim. Each probe chunk is short enough to
 * fit the digest cap, so echoing the whole chunk guarantees the nonce is retained.
 */
function faithfulDigest(chunk: string): string {
	return JSON.stringify({ digest: chunk });
}

describe("runModelFitnessProbe", () => {
	it("scores a fully-capable model across all six surfaces", async () => {
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
				digest: faithfulDigest,
			}),
		});

		expect(report.research.succeeded).toBe(2);
		expect(report.worker.succeeded).toBe(2);
		expect(report.search.succeeded).toBe(3);
		expect(report.toolCall.succeeded).toBe(3);
		expect(report.digest.succeeded).toBe(report.digest.total);
		expect(report.digest.total).toBeGreaterThan(0);
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

	it("digest surface: accepts only bounded strict-JSON digests that retain the chunk nonce", async () => {
		const replies = [
			'{"digest":"retryWithJitter_zx41 in src/http/client.ts does capped exponential backoff."}',
			'{"digest":"A migration failed because a column is missing."}', // nonce dropped -> unfaithful
			"The version is v3.9.2-hotfix.1 in package.json", // no JSON -> unparseable
		];
		let digestCall = 0;
		const report = await runModelFitnessProbe({
			trials: 1,
			judgePrompts: [],
			complete: async ({ systemPrompt }) => {
				const text = systemPrompt.includes("context curator") ? (replies[digestCall++] ?? "{}") : "{}";
				return { text, costUsd: 0, stopReason: "stop" };
			},
		});
		expect(report.digest.total).toBe(3);
		expect(report.digest.succeeded).toBe(1);
		expect(report.digest.outcomes).toEqual(["ok", "unparseable_output", "unparseable_output"]);
	});

	it("handles an empty judge prompt set without NaN", async () => {
		const report = await runModelFitnessProbe({
			trials: 1,
			now: () => 0,
			judgePrompts: [],
			complete: scriptedComplete({}),
		});
		expect(report.judge.meanMs).toBe(0);
		expect(Number.isNaN(report.judge.meanMs)).toBe(false);
	});

	it("bounds the search/toolCall surfaces with the wall clock (hung model cannot hang the probe)", async () => {
		const report = await runModelFitnessProbe({
			trials: 1,
			maxWallClockMs: 10,
			complete: ({ signal }) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		});
		expect(report.search.outcomes).toEqual(["timeout", "timeout", "timeout"]);
		expect(report.toolCall.outcomes).toEqual(["timeout", "timeout", "timeout"]);
	}, 20_000);

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

describe("isProbeAllFailed", () => {
	it("flags a real all-lanes-failed probe (the reported bug: 0/3 on every surface)", async () => {
		const report = await runModelFitnessProbe({ trials: 3, now: () => 0, complete: scriptedComplete({}) });
		expect(isProbeAllFailed(report)).toBe(true);
	});

	it("does not flag a fully-capable probe", async () => {
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
				digest: faithfulDigest,
			}),
		});
		expect(isProbeAllFailed(report)).toBe(false);
	});

	it("does not flag a partial pass (e.g. only the digest surface succeeds)", async () => {
		const report = await runModelFitnessProbe({
			trials: 1,
			judgePrompts: [],
			complete: async ({ systemPrompt }) => {
				// Echoes the FIRST digest task's nonce verbatim; that task's reply parses and is
				// faithful, the other two digest tasks (different nonces) do not match -> partial pass.
				const text = systemPrompt.includes("context curator")
					? '{"digest":"retryWithJitter_zx41 in src/http/client.ts does capped exponential backoff."}'
					: "{}";
				return { text, costUsd: 0, stopReason: "stop" };
			},
		});
		expect(report.digest.succeeded).toBeGreaterThan(0);
		expect(isProbeAllFailed(report)).toBe(false);
	});

	it("does not flag a degenerate/empty report as failed (no lane was ever graded)", () => {
		const emptyLane = { succeeded: 0, total: 0, outcomes: [], meanMs: 0 };
		const report: ModelFitnessReport = {
			trials: 0,
			research: { ...emptyLane },
			worker: { ...emptyLane },
			judge: {
				parsed: 0,
				planningElevated: 0,
				planningTotal: 0,
				trivialCheap: 0,
				trivialTotal: 0,
				total: 0,
				outcomes: [],
				meanMs: 0,
			},
			search: { ...emptyLane },
			toolCall: { ...emptyLane },
			digest: { ...emptyLane },
			totalCostUsd: 0,
		};
		expect(isProbeAllFailed(report)).toBe(false);
	});
});
