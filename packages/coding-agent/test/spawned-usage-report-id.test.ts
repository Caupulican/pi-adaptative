import type { Api, Model, Usage } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "../src/core/agent-session.ts";
import { BackgroundLaneController } from "../src/core/background-lane-controller.ts";
import { ContextPipeline, type ContextPipelineDeps } from "../src/core/context-pipeline.ts";

/**
 * Shared mock signatures for `addSpawnedUsage`/`runIsolatedCompletion` across every describe block
 * below. Explicit generics (never the bare `vi.fn(...)`/`ReturnType<typeof vi.fn>` shorthand) so
 * `.mock.calls[i]` is a properly-typed tuple instead of inferring an empty-tuple `[]` from a
 * zero-arg implementation — the empty tuple's element type collapses to `never`, which is what broke
 * the tsc gate here (the same failure class that breaks captured-calls arrays typed this way elsewhere).
 */
type AddSpawnedUsageOpts = { label?: string; sourceSessionId?: string; reportId: string };
type AddSpawnedUsageFn = (usage: Usage, opts: AddSpawnedUsageOpts) => string | undefined;
type RunIsolatedCompletionFn = (opts: IsolatedCompletionOptions) => Promise<IsolatedCompletionResult>;

/**
 * `addSpawnedUsage` reportId is required at the type level on every one of these controllers'
 * local `Deps` interfaces, and the previously-omitting call sites (model-router's executor-brain
 * warmup, background-lane's fitness probe, runtime-builder's toolkit-brain reflex, context-pipeline's
 * curation drain) now derive a STABLE id from the work unit's own identity — never `Date.now`/random
 * — so a retry of the same logical work unit reports the same id (the session-level dedupe in
 * `addSpawnedUsage`, covered by test/cost-aggregation.test.ts, then counts it once) while genuinely
 * different work gets a distinct id. (The retired LLM route-judge lane's own reportId/laneKind
 * wiring, once exercised here, was removed with the lane — routing is now judged by System One.)
 *
 * (runtime-builder's toolkit-brain reflex is a closure defined inline inside `buildRuntime`, not a
 * separately callable method — exercising it would require constructing a full tool registry via
 * `RuntimeBuilder`. Its reportId derivation is byte-identical to model-router's executor-brain
 * warmup (same `deriveSpawnedUsageReportId("toolkit-brain", sessionId, request)` shape), which this
 * file already exercises for the sibling site, so it is covered by review rather than duplicated
 * here as a heavy integration test.)
 *
 * The fitness probe is the one site with two distinct identity sources (see the two nested describes
 * below): the `model_fitness` LLM tool always supplies a `toolCallId`, which is the idempotency
 * token used directly — so two deliberately separate tool calls on the same (model, trials) get
 * DISTINCT ids (both count) while a retry of the SAME tool call is deduped. Callers with no
 * toolCallId (the manual `/fitness` command, the auto-probe-on-model-add flows in
 * local-model-commands.ts) fall back to the (model, trials) identity.
 */

function testModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		provider,
		api: "messages",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8192,
	} as Model<Api>;
}

function usageWithCost(total: number): Usage {
	return {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: total / 2, output: total / 2, cacheRead: 0, cacheWrite: 0, total },
	};
}

describe("background-lane-controller: model-fitness reportId + laneKind", () => {
	function fitnessDeps(
		sessionId: string,
		isolated: ReturnType<typeof vi.fn<RunIsolatedCompletionFn>>,
		addSpawnedUsage: ReturnType<typeof vi.fn<AddSpawnedUsageFn>>,
	) {
		const model = testModel("test-provider", "test-model");
		return {
			isDisposed: () => false,
			getSessionId: () => sessionId,
			getAgentDir: () => "/tmp/pi-b6-fitness-test-agent-dir",
			getModelRegistry: () => ({
				getAll: () => [model],
				hasConfiguredAuth: () => true,
				getAvailable: () => [],
			}),
			getSettingsManager: () => ({ getModelCapabilitySettings: () => ({ mode: "auto" }) }),
			runIsolatedCompletion: isolated,
			addSpawnedUsage,
		} as unknown as ConstructorParameters<typeof BackgroundLaneController>[0];
	}

	// Content doesn't need to parse for any given surface — usage is accumulated unconditionally
	// before parsing, and this test only asserts reportId/laneKind wiring, never probe results.
	function scriptedCompletion(): ReturnType<typeof vi.fn<RunIsolatedCompletionFn>> {
		return vi.fn<RunIsolatedCompletionFn>(async () => ({
			text: "unparsed",
			usage: usageWithCost(0.02),
			stopReason: "stop",
		}));
	}

	describe("no toolCallId (manual /fitness command, auto-probe-on-model-add)", () => {
		it("same (model, trials) reports the same reportId across a simulated retry", async () => {
			const addSpawnedUsage = vi.fn<AddSpawnedUsageFn>(() => "entry-id");
			const controller = new BackgroundLaneController(
				fitnessDeps("session-a", scriptedCompletion(), addSpawnedUsage),
			);

			await controller.runModelFitness({ model: "test-provider/test-model", trials: 1 });
			await controller.runModelFitness({ model: "test-provider/test-model", trials: 1 });

			expect(addSpawnedUsage).toHaveBeenCalledTimes(2);
			const firstOpts = addSpawnedUsage.mock.calls[0][1];
			const secondOpts = addSpawnedUsage.mock.calls[1][1];
			expect(firstOpts.reportId).toBeTruthy();
			expect(firstOpts.reportId).toBe(secondOpts.reportId);
		});

		it("a different trial count reports a distinct reportId", async () => {
			const addSpawnedUsage = vi.fn<AddSpawnedUsageFn>(() => "entry-id");
			const controller = new BackgroundLaneController(
				fitnessDeps("session-a", scriptedCompletion(), addSpawnedUsage),
			);

			await controller.runModelFitness({ model: "test-provider/test-model", trials: 1 });
			await controller.runModelFitness({ model: "test-provider/test-model", trials: 2 });

			const firstOpts = addSpawnedUsage.mock.calls[0][1];
			const secondOpts = addSpawnedUsage.mock.calls[1][1];
			expect(firstOpts.reportId).not.toBe(secondOpts.reportId);
		});
	});

	describe("toolCallId present (the model_fitness tool path)", () => {
		it("a retry of the same tool call (same toolCallId) keeps the same reportId (deduped)", async () => {
			const addSpawnedUsage = vi.fn<AddSpawnedUsageFn>(() => "entry-id");
			const controller = new BackgroundLaneController(
				fitnessDeps("session-a", scriptedCompletion(), addSpawnedUsage),
			);

			await controller.runModelFitness({ model: "test-provider/test-model", trials: 1, toolCallId: "call-1" });
			await controller.runModelFitness({ model: "test-provider/test-model", trials: 1, toolCallId: "call-1" });

			const firstOpts = addSpawnedUsage.mock.calls[0][1];
			const secondOpts = addSpawnedUsage.mock.calls[1][1];
			expect(firstOpts.reportId).toBeTruthy();
			expect(firstOpts.reportId).toBe(secondOpts.reportId);
		});

		it("two deliberately separate tool calls on the same (model, trials) get DISTINCT reportIds (both count)", async () => {
			const addSpawnedUsage = vi.fn<AddSpawnedUsageFn>(() => "entry-id");
			const controller = new BackgroundLaneController(
				fitnessDeps("session-a", scriptedCompletion(), addSpawnedUsage),
			);

			await controller.runModelFitness({ model: "test-provider/test-model", trials: 1, toolCallId: "call-1" });
			await controller.runModelFitness({ model: "test-provider/test-model", trials: 1, toolCallId: "call-2" });

			const firstOpts = addSpawnedUsage.mock.calls[0][1];
			const secondOpts = addSpawnedUsage.mock.calls[1][1];
			expect(firstOpts.reportId).not.toBe(secondOpts.reportId);
		});
	});

	it('carries laneKind "fitness" on every probe call (verified unchanged)', async () => {
		const addSpawnedUsage = vi.fn<AddSpawnedUsageFn>(() => "entry-id");
		const isolated = scriptedCompletion();
		const controller = new BackgroundLaneController(fitnessDeps("session-a", isolated, addSpawnedUsage));

		await controller.runModelFitness({ model: "test-provider/test-model", trials: 1 });

		expect(isolated.mock.calls.length).toBeGreaterThan(0);
		for (const call of isolated.mock.calls) {
			expect(call[0]).toMatchObject({ laneKind: "fitness" });
		}
	});
});

describe("context-pipeline: brain-curation drain reportId + laneKind", () => {
	function pipelineDeps(
		sessionId: string,
		runIsolatedCompletion: ContextPipelineDeps["runIsolatedCompletion"],
		addSpawnedUsage: ReturnType<typeof vi.fn<AddSpawnedUsageFn>>,
	): ContextPipelineDeps {
		return {
			getTurnIndex: () => 1,
			getSessionManager: () =>
				({ getSessionId: () => sessionId, getBranch: () => [], getEntries: () => [] }) as unknown as ReturnType<
					ContextPipelineDeps["getSessionManager"]
				>,
			getSettingsManager: () =>
				({ getContextCurationSettings: () => ({ enabled: true, maxJobsPerTurn: 5 }) }) as ReturnType<
					ContextPipelineDeps["getSettingsManager"]
				>,
			getModelRegistry: () => ({}) as ReturnType<ContextPipelineDeps["getModelRegistry"]>,
			// A cloud model as foreground avoids the local-foreground-priority deferral (see
			// test/context-pipeline-local-priority.test.ts) so the drain always runs immediately.
			getModel: () => testModel("openai", "foreground-model"),
			getAgentDir: () => process.cwd(),
			getCwd: () => process.cwd(),
			getActiveToolNames: () => [],
			isDisposed: () => false,
			getMemoryManager: () => ({}) as ReturnType<ContextPipelineDeps["getMemoryManager"]>,
			addSpawnedUsage,
			runIsolatedCompletion,
		};
	}

	function buildPipeline(sessionId: string) {
		const addSpawnedUsage = vi.fn<AddSpawnedUsageFn>(() => "entry-id");
		const runIsolatedCompletion = vi.fn<ContextPipelineDeps["runIsolatedCompletion"]>().mockResolvedValue({
			text: '{"digest":"kept"}',
			usage: usageWithCost(0.03),
			stopReason: "stop",
		});
		const pipeline = new ContextPipeline(pipelineDeps(sessionId, runIsolatedCompletion, addSpawnedUsage));
		const internals = pipeline as unknown as {
			_brainCurator: { enqueue(job: { kind: "stub_digest"; key: string; content: string }): void };
			resolveCurationModelIfFit(): Model<Api> | undefined;
		};
		internals.resolveCurationModelIfFit = () => testModel("openai", "curator-model");
		return { pipeline, internals, addSpawnedUsage, runIsolatedCompletion };
	}

	async function drainOnce(
		pipeline: ContextPipeline,
		addSpawnedUsage: ReturnType<typeof vi.fn<AddSpawnedUsageFn>>,
		expectedCalls: number,
	) {
		pipeline.maybeDrainBrainCuration();
		await vi.waitFor(() => expect(addSpawnedUsage).toHaveBeenCalledTimes(expectedCalls));
	}

	it("draining the same job key from a simulated retry (a fresh pipeline instance reprocessing the identical batch) reports the same reportId", async () => {
		// BrainCurator's own idempotency cache treats a re-enqueue of an already-resolved key on the
		// SAME instance as free (no new job dispatched) — so a retry is simulated the way it would
		// actually recur in production: a fresh ContextPipeline (e.g. a new turn) draining the
		// identical job-key batch. The reportId is a pure function of (sessionId, drained keys), so
		// it must come out identical across the two independent instances/invocations.
		const first = buildPipeline("session-a");
		first.internals._brainCurator.enqueue({ kind: "stub_digest", key: "job-key-A", content: "large tool output" });
		await drainOnce(first.pipeline, first.addSpawnedUsage, 1);

		const second = buildPipeline("session-a");
		second.internals._brainCurator.enqueue({ kind: "stub_digest", key: "job-key-A", content: "large tool output" });
		await drainOnce(second.pipeline, second.addSpawnedUsage, 1);

		const firstOpts = first.addSpawnedUsage.mock.calls[0][1];
		const secondOpts = second.addSpawnedUsage.mock.calls[0][1];
		expect(firstOpts.reportId).toBeTruthy();
		expect(firstOpts.reportId).toBe(secondOpts.reportId);
	});

	it("draining a genuinely different job batch reports a distinct reportId", async () => {
		const { pipeline, internals, addSpawnedUsage } = buildPipeline("session-a");

		internals._brainCurator.enqueue({ kind: "stub_digest", key: "job-key-A", content: "large tool output" });
		await drainOnce(pipeline, addSpawnedUsage, 1);

		internals._brainCurator.enqueue({ kind: "stub_digest", key: "job-key-B", content: "other tool output" });
		await drainOnce(pipeline, addSpawnedUsage, 2);

		const firstOpts = addSpawnedUsage.mock.calls[0][1];
		const secondOpts = addSpawnedUsage.mock.calls[1][1];
		expect(firstOpts.reportId).not.toBe(secondOpts.reportId);
	});

	it('runIsolatedCompletion carries laneKind "curation" for a drain job', async () => {
		const { pipeline, internals, addSpawnedUsage, runIsolatedCompletion } = buildPipeline("session-a");

		internals._brainCurator.enqueue({ kind: "stub_digest", key: "job-key-A", content: "large tool output" });
		await drainOnce(pipeline, addSpawnedUsage, 1);

		expect(runIsolatedCompletion.mock.calls[0][0]).toMatchObject({ laneKind: "curation" });
	});
});
