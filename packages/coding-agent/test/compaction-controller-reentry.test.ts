import type { Agent, AgentMessage } from "@caupulican/pi-agent-core";
import { type CompactionResult, SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, AssistantMessage, Model } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { CompactionController, type CompactionControllerDeps } from "../src/core/compaction-controller.ts";
import type { ExtensionRunner } from "../src/core/extensions/index.ts";
import type { FailureCorpusRecorder } from "../src/core/failure-corpus.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";

function createModel(): Model<"openai-completions"> {
	return {
		id: "compaction-test",
		name: "compaction-test",
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4_000,
		maxTokens: 1_000,
	};
}

function scriptedMeasure(values: number[]): () => number {
	let index = 0;
	return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

function assistantWithUsage(tokens: number, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "continued" }],
		api: "openai-completions",
		provider: "test",
		model: "compaction-test",
		usage: {
			input: tokens - 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function createFixture(options: {
	measureLiveContextTokens: () => number;
	createResult(attempt: number, entryIds: string[]): Promise<CompactionResult>;
}) {
	const sessionManager = SessionManager.inMemory();
	const messages: AgentMessage[] = [];
	const entryIds: string[] = [];
	const timestamp = Date.now();
	for (let index = 0; index < 8; index++) {
		const message: AgentMessage = {
			role: "user",
			content:
				index === 7
					? [
							{ type: "text", text: "inspect this image" },
							{ type: "image", data: "image-data", mimeType: "image/png" },
						]
					: [{ type: "text", text: `${"long context ".repeat(120)} ${index}` }],
			timestamp: timestamp + index,
		};
		messages.push(message);
		entryIds.push(sessionManager.appendMessage(message));
	}

	const model = createModel();
	const events: Array<Record<string, unknown>> = [];
	let compactionAttempt = 0;
	const compactWithRetry = vi.fn(async (): Promise<CompactionResult> => {
		const attempt = compactionAttempt++;
		return options.createResult(attempt, entryIds);
	});
	const extensionRunner = {
		hasHandlers: () => false,
		emit: vi.fn(async () => undefined),
	} as unknown as ExtensionRunner;
	const agent = {
		state: { messages, systemPrompt: "", tools: [] },
		streamFn: undefined,
		hasQueuedMessages: () => false,
	} as unknown as Agent;
	let controller: CompactionController;
	const runAutoCompaction = vi.fn((reason: "overflow" | "threshold", willRetry: boolean) =>
		controller.runAuto(reason, willRetry),
	);

	const deps: CompactionControllerDeps = {
		agent,
		sessionManager,
		settingsManager: {} as SettingsManager,
		getModel: () => model as Model<Api>,
		getAdaptedSettings: () => ({
			enabled: true,
			reserveTokens: 3_000,
			keepRecentTokens: 1_200,
			triggerPercent: 0,
		}),
		getRequestAuth: async () => ({}),
		resolveModelAndAuth: async () => ({ model: model as Model<Api> }),
		resolveModel: () => model as Model<Api>,
		getSelectionReason: () => "test",
		resolveThinkingLevel: () => undefined,
		describeSummarizer: () => "test",
		getExtensionRunner: () => extensionRunner,
		isRawStream: () => false,
		disconnectAgent: () => {},
		reconnectAgent: () => {},
		abortForeground: async () => {},
		emit: (event) => events.push(event as unknown as Record<string, unknown>),
		estimateCurrentContextTokens: () => 3_000,
		buildPreDigest: () => undefined,
		getMemoryPreCompressInsight: async () => "",
		refreshAfterCompaction: () => {},
		getFailureCorpus: () => ({}) as FailureCorpusRecorder,
		measureLiveContextTokens: options.measureLiveContextTokens,
		runAutoCompaction,
		compactWithRetry,
	};
	controller = new CompactionController(deps);

	return {
		controller,
		compactWithRetry,
		entryIds,
		events,
		runAutoCompaction,
		sessionManager,
	};
}

function checkpoint(attempt: number, entryIds: string[]): CompactionResult {
	return {
		summary: `checkpoint-${attempt + 1}`,
		firstKeptEntryId: entryIds[attempt === 0 ? 4 : 6]!,
		tokensBefore: attempt === 0 ? 3_000 : 2_500,
		details: { readFiles: [], modifiedFiles: [] },
	};
}

describe("CompactionController auto-compaction re-entry", () => {
	it("uses one paid summary then deterministic progress when an image turn remains above the threshold", async () => {
		const { compactWithRetry, controller, events, sessionManager } = createFixture({
			measureLiveContextTokens: scriptedMeasure([3_000, 2_500, 2_500, 2_500, 2_500, 2_500]),
			createResult: async (attempt, entryIds) => checkpoint(attempt, entryIds),
		});
		await controller.runAuto("threshold", false);

		expect(compactWithRetry).toHaveBeenCalledTimes(1);
		expect(sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(2);
		const terminalEvent = events.at(-1);
		expect(terminalEvent).toMatchObject({
			type: "compaction_end",
			aborted: false,
			result: expect.objectContaining({ summary: expect.any(String) }),
		});
		expect(terminalEvent).not.toHaveProperty("errorMessage");
		expect(events.filter((event) => event.type === "warning")).toEqual([
			expect.objectContaining({ message: expect.stringContaining("cycle 2: effect-not-restored") }),
		]);
	});

	it("does not re-enter an ineffective threshold frontier after one small message", async () => {
		const { compactWithRetry, controller, events, runAutoCompaction, sessionManager } = createFixture({
			measureLiveContextTokens: scriptedMeasure([3_000, 2_500, 2_500, 2_500, 2_501]),
			createResult: async (attempt, entryIds) => checkpoint(attempt, entryIds),
		});
		await controller.runAuto("threshold", false);
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "small follow-up" }],
			timestamp: Date.now() + 100,
		});

		await controller.check(assistantWithUsage(2_501, Date.now() + 1_000));

		expect(runAutoCompaction).not.toHaveBeenCalled();
		expect(compactWithRetry).toHaveBeenCalledTimes(1);
		expect(sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(2);
		expect(events.at(-1)).toMatchObject({
			type: "compaction_end",
			result: undefined,
			skipReason: expect.stringContaining("waiting for materially new compactable history"),
		});
	});

	it("retries threshold compaction after material context growth", async () => {
		const { compactWithRetry, controller, runAutoCompaction, sessionManager } = createFixture({
			measureLiveContextTokens: scriptedMeasure([3_000, 2_500, 2_500, 2_500, 3_101, 900, 900]),
			createResult: async (attempt, entryIds) => checkpoint(attempt, entryIds),
		});
		await controller.runAuto("threshold", false);
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "material follow-up" }],
			timestamp: Date.now() + 100,
		});

		await controller.check(assistantWithUsage(3_101, Date.now() + 1_000));

		expect(runAutoCompaction).toHaveBeenCalledWith("threshold", false);
		expect(compactWithRetry).toHaveBeenCalledTimes(2);
		expect(sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(3);
	});

	it("coalesces concurrent threshold checks into one compaction run", async () => {
		let released = false;
		let release: (() => void) | undefined;
		const barrier = new Promise<void>((resolve) => {
			release = () => {
				released = true;
				resolve();
			};
		});
		const { compactWithRetry, controller, events, sessionManager } = createFixture({
			measureLiveContextTokens: () => (released ? 900 : 3_000),
			createResult: async (attempt, entryIds) => {
				await barrier;
				return checkpoint(attempt, entryIds);
			},
		});

		const first = controller.runAuto("threshold", false);
		await vi.waitFor(() => expect(compactWithRetry).toHaveBeenCalledTimes(1));
		const second = controller.runAuto("threshold", false);
		await new Promise<void>((resolve) => setImmediate(resolve));
		release?.();

		await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
		expect(compactWithRetry).toHaveBeenCalledTimes(1);
		expect(sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(events.filter((event) => event.type === "compaction_start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "compaction_end")).toHaveLength(1);
	});
});
