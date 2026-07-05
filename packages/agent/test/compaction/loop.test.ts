import type { Model } from "@caupulican/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CompactionCycleParams, type CompactionResult, runCompactionLoop } from "../../src/compaction/index.ts";
import type { SessionEntry, SessionMessageEntry } from "../../src/session/session-manager.ts";

function createModel(): Model<"anthropic-messages"> {
	return {
		id: "test-model",
		name: "test-model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.openai.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 120000,
		maxTokens: 2048,
	};
}

function createBranch(): SessionEntry[] {
	const entry: SessionMessageEntry = {
		type: "message",
		id: "entry-1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: "x", timestamp: Date.now() },
	};
	return [entry];
}

function createResult(summary = "checkpoint"): CompactionResult {
	return {
		summary,
		firstKeptEntryId: "entry-1",
		tokensBefore: 100,
		details: {
			readFiles: [],
			modifiedFiles: ["a"],
		},
	};
}

function scriptedMeasure(values: number[]) {
	let index = 0;
	return vi.fn(() => values[Math.min(index++, values.length - 1)] ?? 0);
}

function expectSuccess(outcome: Awaited<ReturnType<typeof runCompactionLoop>>) {
	expect(outcome.kind).toBe("success");
	if (outcome.kind !== "success") throw new Error("expected success");
	return outcome;
}

describe("runCompactionLoop", () => {
	let branch: SessionEntry[];
	let summarizeCalls: number;

	beforeEach(() => {
		branch = createBranch();
		summarizeCalls = 0;
	});

	it("succeeds on first cycle", async () => {
		const measureLiveTokens = scriptedMeasure([1200, 100]);
		const outcome = expectSuccess(
			await runCompactionLoop({
				getBranch: () => branch,
				measureLiveTokens,
				getTriggerThreshold: () => 1000,
				getMargin: () => 10,
				getBaseKeepRecentTokens: () => 800,
				resolveModelAndAuth: vi.fn(async () => ({ model: createModel() })),
				summarizeAndVerify: vi.fn(async () => ({ result: createResult("primary") })),
				buildDeterministicCheckpoint: vi.fn(async () => ({ result: createResult("deterministic") })),
				apply: vi.fn(async () => {}),
				onTransition: vi.fn(),
			}),
		);

		expect(outcome.cycles).toBe(1);
		expect(outcome.result.summary).toBe("primary");
		expect(measureLiveTokens).toHaveBeenCalledTimes(2);
	});

	it("retries with session model after gate failure", async () => {
		const measureLiveTokens = scriptedMeasure([1200, 1200, 100]);
		const resolveModelAndAuth = vi.fn(async (modelTier: CompactionCycleParams["modelTier"]) => ({
			model: modelTier === "cheap" ? createModel() : createModel(),
		}));
		const summarizeAndVerify = vi.fn(async (_params: CompactionCycleParams) => {
			summarizeCalls += 1;
			if (summarizeCalls === 1) {
				throw new Error("gate-failed: missing mandatory rule");
			}
			return { result: createResult(`retry-${summarizeCalls}`) };
		});

		const outcome = expectSuccess(
			await runCompactionLoop({
				getBranch: () => branch,
				measureLiveTokens,
				getTriggerThreshold: () => 1000,
				getMargin: () => 10,
				getBaseKeepRecentTokens: () => 800,
				resolveModelAndAuth,
				summarizeAndVerify,
				buildDeterministicCheckpoint: async () => ({ result: createResult("deterministic") }),
				apply: async () => {},
				onTransition: () => {},
			}),
		);

		expect(resolveModelAndAuth.mock.calls).toEqual([["cheap"], ["session"]]);
		expect(summarizeAndVerify).toHaveBeenCalledTimes(2);
		expect(summarizeAndVerify.mock.calls[1]?.[0]?.modelTier).toBe("session");
		expect(outcome.cycles).toBe(2);
	});

	it("retries with chunked on input overflow", async () => {
		const measureLiveTokens = scriptedMeasure([1200, 1200, 100]);
		const summarizeAndVerify = vi.fn(async (params: CompactionCycleParams) => {
			summarizeCalls += 1;
			if (summarizeCalls === 1) {
				expect(params.chunked).toBe(false);
				throw new Error("input-overflow");
			}
			expect(params.chunked).toBe(true);
			return { result: createResult("chunked") };
		});

		const outcome = expectSuccess(
			await runCompactionLoop({
				getBranch: () => branch,
				measureLiveTokens,
				getTriggerThreshold: () => 1000,
				getMargin: () => 10,
				getBaseKeepRecentTokens: () => 800,
				resolveModelAndAuth: async () => ({ model: createModel() }),
				summarizeAndVerify,
				buildDeterministicCheckpoint: async () => ({ result: createResult("det") }),
				apply: async () => {},
				onTransition: () => {},
			}),
		);

		expect(summarizeAndVerify).toHaveBeenCalledTimes(2);
		expect(outcome.cycles).toBe(2);
	});

	it("retries with chunked on effect-not-restored and decreasing keepRecent", async () => {
		const measureLiveTokens = scriptedMeasure([1400, 1300, 1300, 1300, 1300, 800]);
		const summarizeAndVerify = vi.fn(async (params: CompactionCycleParams) => {
			summarizeCalls += 1;
			if (summarizeCalls === 1) {
				expect(params.chunked).toBe(false);
				expect(params.keepRecentTokens).toBe(1200);
			}
			if (summarizeCalls === 2) {
				expect(params.chunked).toBe(true);
				expect(params.keepRecentTokens).toBe(600);
			}
			if (summarizeCalls === 3) {
				expect(params.chunked).toBe(true);
				expect(params.keepRecentTokens).toBe(300);
			}
			return { result: createResult(`result-${summarizeCalls}`) };
		});

		const outcome = expectSuccess(
			await runCompactionLoop({
				getBranch: () => branch,
				measureLiveTokens,
				getTriggerThreshold: () => 1000,
				getMargin: () => 10,
				getBaseKeepRecentTokens: () => 1200,
				resolveModelAndAuth: async () => ({ model: createModel() }),
				summarizeAndVerify,
				buildDeterministicCheckpoint: async () => ({ result: createResult("det") }),
				apply: async () => {},
				onTransition: () => {},
			}),
		);

		expect(summarizeAndVerify).toHaveBeenCalledTimes(3);
		expect(outcome.cycles).toBe(3);
	});

	it("forces progress when failure causes an identical retry plan", async () => {
		const measureLiveTokens = scriptedMeasure([1200, 1200, 1200, 900]);
		const summarizeAndVerify = vi.fn(async (params: CompactionCycleParams) => {
			summarizeCalls += 1;
			if (summarizeCalls < 3) {
				expect(params.chunked).toBe(summarizeCalls === 2);
				throw new Error("unexpected provider error");
			}
			return { result: createResult(`pass-${summarizeCalls}`) };
		});

		const outcome = expectSuccess(
			await runCompactionLoop({
				getBranch: () => branch,
				measureLiveTokens,
				getTriggerThreshold: () => 1000,
				getMargin: () => 10,
				getBaseKeepRecentTokens: () => 800,
				resolveModelAndAuth: async () => ({ model: createModel() }),
				summarizeAndVerify,
				buildDeterministicCheckpoint: async () => ({ result: createResult("det") }),
				apply: async () => {},
				onTransition: () => {},
			}),
		);

		expect(summarizeAndVerify).toHaveBeenCalledTimes(3);
		expect(summarizeAndVerify.mock.calls[1]?.[0]?.chunked).toBe(true);
		expect(outcome.cycles).toBe(3);
	});

	it("falls back to deterministic checkpoint on full retry exhaustion", async () => {
		const measureLiveTokens = scriptedMeasure([1500, 1400, 1300, 1200]);
		const summarizeAndVerify = vi.fn(async () => {
			summarizeCalls += 1;
			throw new Error("input-overflow");
		});
		const buildDeterministicCheckpoint = vi.fn(async () => ({ result: createResult("deterministic") }));

		const outcome = expectSuccess(
			await runCompactionLoop({
				getBranch: () => branch,
				measureLiveTokens,
				getTriggerThreshold: () => 1000,
				getMargin: () => 10,
				getBaseKeepRecentTokens: () => 1000,
				resolveModelAndAuth: async () => ({ model: createModel() }),
				summarizeAndVerify,
				buildDeterministicCheckpoint,
				apply: async () => {},
				onTransition: () => {},
			}),
		);

		expect(summarizeAndVerify).toHaveBeenCalledTimes(3);
		expect(buildDeterministicCheckpoint).toHaveBeenCalledTimes(1);
		expect(outcome.cycles).toBe(4);
		expect(outcome.result.summary).toBe("deterministic");
	});

	it("aborts cleanly when signal is raised between cycles", async () => {
		const controller = new AbortController();
		const measureLiveTokens = vi.fn(() => {
			const tokenReads = [1200, 1200, 100];
			const index = measureLiveTokens.mock.calls.length;
			if (index === 1) {
				controller.abort("stop");
			}
			return tokenReads[index] ?? 0;
		});
		const summarizeAndVerify = vi.fn(async () => {
			summarizeCalls += 1;
			throw new Error("input-overflow");
		});

		const outcome = await runCompactionLoop({
			getBranch: () => branch,
			measureLiveTokens,
			getTriggerThreshold: () => 1000,
			getMargin: () => 10,
			getBaseKeepRecentTokens: () => 1000,
			resolveModelAndAuth: async () => ({ model: createModel() }),
			summarizeAndVerify,
			buildDeterministicCheckpoint: async () => ({ result: createResult("deterministic") }),
			apply: async () => {},
			onTransition: () => {},
			signal: controller.signal,
		});

		expect(outcome.kind).toBe("failed");
		if (outcome.kind === "failed") {
			expect(outcome.reason).toBe("aborted");
			expect(outcome.cycles).toBe(1);
		}
	});

	it("skips without attempting retries when already within threshold", async () => {
		const outcome = await runCompactionLoop({
			getBranch: () => branch,
			measureLiveTokens: () => 900,
			getTriggerThreshold: () => 1000,
			getMargin: () => 10,
			resolveModelAndAuth: vi.fn(),
			summarizeAndVerify: vi.fn(),
			buildDeterministicCheckpoint: vi.fn(),
			apply: vi.fn(),
			onTransition: vi.fn(),
		});

		expect(outcome).toEqual({ kind: "skip", reason: "within threshold" });
	});
});
