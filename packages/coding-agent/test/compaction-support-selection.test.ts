import type { Model } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { CompactionSupport, type CompactionSupportDeps } from "../src/core/compaction-support.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * W10.2 (2026-07-06 incident): the compaction summarizer selection must treat candidate window
 * capacity as a hard constraint. A router-cheap local model whose context window cannot hold the
 * actual summarization input produces recall-empty checkpoints (local servers silently truncate
 * over-window prompts), and the verification gate then fails deterministically.
 */

function makeModel(provider: string, id: string, contextWindow: number): Model<any> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "http://127.0.0.1:11434/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 2048,
	};
}

function createSupport(opts: {
	estimatedInputTokens: number;
	warnings: string[];
	explicitModel?: string;
	cheapContextWindow?: number;
	servedContextWindow?: number;
}): {
	support: CompactionSupport;
	cheap: Model<any>;
	session: Model<any>;
} {
	const cheap = makeModel("ollama", "tiny", opts.cheapContextWindow ?? 8192);
	const session = makeModel("anthropic", "big", 200000);
	const registry = {
		getAll: () => [cheap, session],
		hasConfiguredAuth: () => true,
	} as unknown as ModelRegistry;
	const settings = {
		getCompactionModel: () => opts.explicitModel ?? "auto",
		getModelRouterSettings: () => ({ enabled: true, cheapModel: "ollama/tiny" }),
	} as unknown as SettingsManager;
	const deps: CompactionSupportDeps = {
		getModel: () => session,
		getSettingsManager: () => settings,
		getModelRegistry: () => registry,
		isRawStream: () => false,
		getRequiredRequestAuth: async () => ({}),
		isModelExhausted: () => false,
		getStoredFitnessReport: () =>
			opts.servedContextWindow === undefined
				? undefined
				: {
						trials: 1,
						capacity: {
							registeredContextWindow: opts.cheapContextWindow ?? 8192,
							servedContextWindow: opts.servedContextWindow,
							outcomes: [],
							meanMs: 0,
						},
						research: { succeeded: 0, total: 0, outcomes: [], meanMs: 0 },
						worker: { succeeded: 0, total: 0, outcomes: [], meanMs: 0 },
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
						search: { succeeded: 0, total: 0, outcomes: [], meanMs: 0 },
						toolCall: { succeeded: 0, total: 0, outcomes: [], meanMs: 0 },
						digest: { succeeded: 1, total: 1, outcomes: ["ok"], meanMs: 0 },
						totalCostUsd: 0,
					},
		estimateSummarizationInputTokens: () => opts.estimatedInputTokens,
		emitWarning: (message) => opts.warnings.push(message),
		ensureModelReady: async () => {},
	};
	return { support: new CompactionSupport(deps), cheap, session };
}

describe("compaction summarizer capacity selection", () => {
	it("falls back to the session model when the cheap model's window cannot hold the span", () => {
		const warnings: string[] = [];
		const { support, session } = createSupport({ estimatedInputTokens: 60_000, warnings });

		const resolved = support.resolveModel(session);

		expect(resolved).toBe(session);
		expect(warnings.some((message) => message.includes("window_too_small"))).toBe(true);
	});

	it("keeps the cheap model for spans that fit its window", () => {
		const warnings: string[] = [];
		const { support, cheap, session } = createSupport({ estimatedInputTokens: 1_000, warnings });

		const resolved = support.resolveModel(session);

		expect(resolved).toBe(cheap);
		expect(warnings).toEqual([]);
	});

	it("honors an explicit compaction.model setting but warns when it cannot ingest the span", () => {
		const warnings: string[] = [];
		const { support, cheap, session } = createSupport({
			estimatedInputTokens: 60_000,
			warnings,
			explicitModel: "ollama/tiny",
		});

		const resolved = support.resolveModel(session);

		expect(resolved).toBe(cheap);
		expect(warnings.some((message) => message.includes("cannot ingest"))).toBe(true);
	});

	it("uses the served local-model window from fitness capacity evidence instead of the registered guess", () => {
		const warnings: string[] = [];
		const { support, session } = createSupport({
			estimatedInputTokens: 60_000,
			warnings,
			cheapContextWindow: 200_000,
			servedContextWindow: 8_192,
		});

		const resolved = support.resolveModel(session);

		expect(resolved).toBe(session);
		expect(warnings.some((message) => message.includes("window_too_small") && message.includes("8192"))).toBe(true);
	});
});
