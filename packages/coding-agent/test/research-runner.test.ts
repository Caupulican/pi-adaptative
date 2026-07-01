import { describe, expect, it, vi } from "vitest";
import type { CapabilityEnvelope } from "../src/core/autonomy/contracts.ts";
import {
	buildResearchUserPrompt,
	parseResearchFindings,
	RESEARCH_LANE_SYSTEM_PROMPT,
	type ResearchCompletion,
	type ResearchRunnerOptions,
	runResearch,
} from "../src/core/research/research-runner.ts";

function researchEnvelope(overrides: Partial<CapabilityEnvelope> = {}): CapabilityEnvelope {
	return {
		id: "research-env-1",
		capabilities: ["research", "read_files", "memory_read"],
		maxEstimatedUsd: 0.25,
		createdAt: "2026-07-01T00:00:00.000Z",
		...overrides,
	};
}

function completionOf(text: string, costUsd = 0.01, stopReason = "stop"): ResearchCompletion {
	return { text, costUsd, stopReason };
}

function runnerOptions(overrides: Partial<ResearchRunnerOptions> = {}): ResearchRunnerOptions {
	return {
		query: "goal:g1 requirements:req-1",
		context: "Goal: ship the feature\nOpen requirements:\n- req one",
		envelope: researchEnvelope(),
		maxUsd: 0.25,
		maxSources: 8,
		maxFindings: 10,
		maxWallClockMs: 0,
		complete: async () => completionOf('{"findings":[{"summary":"Use the existing helper","confidence":0.8}]}'),
		...overrides,
	};
}

describe("parseResearchFindings", () => {
	it("parses strict JSON, fenced JSON, and embedded JSON", () => {
		const strict = parseResearchFindings('{"findings":[{"summary":"A","confidence":0.5}]}', 10);
		expect(strict?.findings).toEqual([{ summary: "A", confidence: 0.5 }]);

		const fenced = parseResearchFindings('Here you go:\n```json\n{"findings":[{"summary":"B"}]}\n```', 10);
		expect(fenced?.findings).toEqual([{ summary: "B", confidence: undefined }]);

		const embedded = parseResearchFindings('noise before {"findings":[{"summary":"C"}]} noise after', 10);
		expect(embedded?.findings).toEqual([{ summary: "C", confidence: undefined }]);
	});

	it("caps findings, clamps confidence, and skips malformed items", () => {
		const parsed = parseResearchFindings(
			JSON.stringify({
				findings: [
					{ summary: "one", confidence: 7 },
					{ summary: "two", confidence: -1 },
					{ summary: "   " },
					{ notSummary: true },
					{ summary: "three" },
				],
			}),
			2,
		);
		expect(parsed?.findings).toHaveLength(2);
		expect(parsed?.findings[0]).toEqual({ summary: "one", confidence: 1 });
		expect(parsed?.findings[1]).toEqual({ summary: "two", confidence: 0 });
	});

	it("accepts an explicitly empty findings array", () => {
		expect(parseResearchFindings('{"findings":[]}', 10)?.findings).toEqual([]);
	});

	it("returns undefined for prose, invalid JSON, and JSON without a findings array", () => {
		expect(parseResearchFindings("I could not find anything useful.", 10)).toBeUndefined();
		expect(parseResearchFindings('{"findings":"none"}', 10)).toBeUndefined();
		expect(parseResearchFindings('{"findings":[{"summary":42}]}', 10)).toBeUndefined();
	});
});

describe("buildResearchUserPrompt", () => {
	it("includes query, context, and the findings cap", () => {
		const prompt = buildResearchUserPrompt({ query: "q1", context: "ctx", maxFindings: 3 });
		expect(prompt).toContain("q1");
		expect(prompt).toContain("ctx");
		expect(prompt).toContain("3");
	});
});

describe("runResearch", () => {
	it("succeeds and builds a provenance-tagged bundle", async () => {
		const result = await runResearch(runnerOptions());

		expect(result.status).toBe("succeeded");
		expect(result.reasonCode).toBe("research_completed");
		expect(result.costUsd).toBe(0.01);
		expect(result.gateOutcome.outcome).toBe("allow");

		const bundle = result.bundle;
		expect(bundle).toBeDefined();
		expect(bundle?.query).toBe("goal:g1 requirements:req-1");
		expect(bundle?.sources).toHaveLength(2);
		const context = bundle?.sources.find((source) => source.id === "src-context");
		const synthesis = bundle?.sources.find((source) => source.id === "src-synthesis");
		expect(context?.kind).toBe("user");
		expect(context?.trusted).toBe(true);
		expect(synthesis?.kind).toBe("tool");
		expect(synthesis?.trusted).toBe(false);
		expect(bundle?.findings).toHaveLength(1);
		expect(bundle?.findings[0]?.summary).toBe("Use the existing helper");
		expect(bundle?.findings[0]?.evidenceIds).toEqual(["src-synthesis"]);
	});

	it("succeeds with no_findings when the model reports an empty findings array", async () => {
		const result = await runResearch(runnerOptions({ complete: async () => completionOf('{"findings":[]}') }));
		expect(result.status).toBe("succeeded");
		expect(result.reasonCode).toBe("no_findings");
		expect(result.bundle?.findings).toEqual([]);
	});

	it("fails with unparseable_output while preserving spend", async () => {
		const result = await runResearch(
			runnerOptions({ complete: async () => completionOf("no JSON here at all", 0.02) }),
		);
		expect(result.status).toBe("failed");
		expect(result.reasonCode).toBe("unparseable_output");
		expect(result.bundle).toBeUndefined();
		expect(result.costUsd).toBe(0.02);
	});

	it("blocks on a missing capability without calling the model", async () => {
		const complete = vi.fn(async () => completionOf("{}"));
		const result = await runResearch(
			runnerOptions({ envelope: researchEnvelope({ capabilities: ["memory_read"] }), complete }),
		);
		expect(result.status).toBe("failed");
		expect(result.reasonCode).toBe("missing_capability");
		expect(complete).not.toHaveBeenCalled();
	});

	it("marks budget_exhausted when the envelope ceiling is below the requested budget, without calling the model", async () => {
		const complete = vi.fn(async () => completionOf("{}"));
		const result = await runResearch(
			runnerOptions({ envelope: researchEnvelope({ maxEstimatedUsd: 0.1 }), maxUsd: 0.25, complete }),
		);
		expect(result.status).toBe("budget_exhausted");
		expect(result.reasonCode).toBe("over_budget");
		expect(complete).not.toHaveBeenCalled();
	});

	it("marks budget_exhausted post-hoc when real spend exceeds maxUsd but keeps the bundle", async () => {
		const result = await runResearch(
			runnerOptions({
				complete: async () => completionOf('{"findings":[{"summary":"pricey"}]}', 0.5),
			}),
		);
		expect(result.status).toBe("budget_exhausted");
		expect(result.reasonCode).toBe("cost_budget_exceeded");
		expect(result.bundle?.findings[0]?.summary).toBe("pricey");
		expect(result.costUsd).toBe(0.5);
	});

	it("times out when the completion outlives the wall clock budget", async () => {
		const result = await runResearch(
			runnerOptions({
				maxWallClockMs: 10,
				complete: ({ signal }) =>
					new Promise((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(new Error("aborted")));
					}),
			}),
		);
		expect(result.status).toBe("timeout");
		expect(result.reasonCode).toBe("wall_clock_exceeded");
	});

	it("cancels when the external signal aborts", async () => {
		const controller = new AbortController();
		const pending = runResearch(
			runnerOptions({
				signal: controller.signal,
				complete: ({ signal }) =>
					new Promise((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(new Error("aborted")));
					}),
			}),
		);
		controller.abort();
		const result = await pending;
		expect(result.status).toBe("canceled");
		expect(result.reasonCode).toBe("external_abort");
	});

	it("fails with model_error on an error stop reason", async () => {
		const result = await runResearch(
			runnerOptions({ complete: async () => completionOf("irrelevant", 0.005, "error") }),
		);
		expect(result.status).toBe("failed");
		expect(result.reasonCode).toBe("model_error");
		expect(result.costUsd).toBe(0.005);
	});

	it("fails with completion_error when the executor throws without any abort", async () => {
		const result = await runResearch(
			runnerOptions({
				complete: async () => {
					throw new Error("boom");
				},
			}),
		);
		expect(result.status).toBe("failed");
		expect(result.reasonCode).toBe("completion_error");
	});

	it("keeps the system prompt static for provider prompt caching", async () => {
		let seenSystemPrompt: string | undefined;
		await runResearch(
			runnerOptions({
				complete: async ({ systemPrompt }) => {
					seenSystemPrompt = systemPrompt;
					return completionOf('{"findings":[]}');
				},
			}),
		);
		expect(seenSystemPrompt).toBe(RESEARCH_LANE_SYSTEM_PROMPT);
	});
});
