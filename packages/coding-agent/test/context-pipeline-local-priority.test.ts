import type { Model } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { ContextPipeline, type ContextPipelineDeps } from "../src/core/context-pipeline.ts";

function model(provider: string, baseUrl: string): Model<"openai-completions"> {
	return {
		provider,
		id: "qwen3:1.7b",
		name: "qwen3:1.7b",
		api: "openai-completions",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function localModel(): Model<"openai-completions"> {
	return model("ollama", "http://127.0.0.1:11434/v1");
}

function cloudModel(): Model<"openai-completions"> {
	return model("openai", "https://api.openai.com/v1");
}

describe("ContextPipeline local foreground priority", () => {
	it("keeps curator work queued instead of competing with a managed-local foreground turn", async () => {
		const model = localModel();
		let foregroundModel: Model<"openai-completions"> | undefined = model;
		const runIsolatedCompletion = vi.fn<ContextPipelineDeps["runIsolatedCompletion"]>();
		const pipeline = new ContextPipeline({
			getTurnIndex: () => 1,
			getSessionManager: () =>
				({ getSessionId: () => "session", getBranch: () => [], getEntries: () => [] }) as unknown as ReturnType<
					ContextPipelineDeps["getSessionManager"]
				>,
			getSettingsManager: () =>
				({ getContextCurationSettings: () => ({ enabled: true, maxJobsPerTurn: 1 }) }) as ReturnType<
					ContextPipelineDeps["getSettingsManager"]
				>,
			getModelRegistry: () => ({}) as ReturnType<ContextPipelineDeps["getModelRegistry"]>,
			getModel: () => foregroundModel,
			getAgentDir: () => process.cwd(),
			getCwd: () => process.cwd(),
			getActiveToolNames: () => [],
			isDisposed: () => false,
			getMemoryManager: () => ({}) as ReturnType<ContextPipelineDeps["getMemoryManager"]>,
			addSpawnedUsage: () => undefined,
			runIsolatedCompletion,
		});
		const internals = pipeline as unknown as {
			_brainCurator: { enqueue(job: { kind: "stub_digest"; key: string; content: string }): void };
			resolveCurationModelIfFit(): Model<"openai-completions"> | undefined;
		};
		internals._brainCurator.enqueue({ kind: "stub_digest", key: "queued", content: "large tool output" });
		internals.resolveCurationModelIfFit = () => model;

		pipeline.maybeDrainBrainCuration();

		expect(runIsolatedCompletion).not.toHaveBeenCalled();
		expect(pipeline.getContextCurationStatus()).toMatchObject({
			lastSkipReason: "curation_deferred_for_local_foreground",
			telemetry: { queued: 1, jobsRun: 0 },
		});

		foregroundModel = cloudModel();
		runIsolatedCompletion.mockResolvedValue({
			text: '{"digest":"kept"}',
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
		});

		pipeline.maybeDrainBrainCuration();
		await vi.waitFor(() => expect(runIsolatedCompletion).toHaveBeenCalledTimes(1));
		expect(pipeline.getContextCurationStatus().telemetry).toMatchObject({ queued: 0, jobsRun: 1 });
	});
});
