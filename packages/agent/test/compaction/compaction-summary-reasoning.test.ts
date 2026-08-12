import type { AssistantMessage, Model } from "@caupulican/pi-ai/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CompactionPreparation, compact, generateSummary } from "../../src/compaction/index.ts";
import type { AgentMessage } from "../../src/types.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@caupulican/pi-ai/stream", () => ({ completeSimple: completeSimpleMock }));

function createModel(reasoning: boolean, maxTokens = 8192): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens,
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [
		{
			type: "text",
			text: `## Active Task
(none)

### Mandatory Rules
(none)

## Working Set
(none)

## Files
(none)

## Open Problems
(none)

## Done
(none)

## Key Decisions
(none)

## Constraints & Preferences
(none)

## Critical Context
Test summary`,
		},
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

describe("generateSummary reasoning options", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it.each(["medium", "max", "ultra"] as const)(
		"uses the provided %s thinking level for reasoning-capable models",
		async (thinkingLevel) => {
			await generateSummary(
				messages,
				createModel(true),
				2000,
				"test-key",
				undefined,
				undefined,
				undefined,
				undefined,
				thinkingLevel,
			);

			expect(completeSimpleMock).toHaveBeenCalledTimes(1);
			expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
				reasoning: thinkingLevel,
				apiKey: "test-key",
			});
		},
	);

	it("does not set reasoning when thinking is off", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("does not set reasoning for non-reasoning models", async () => {
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("disables caching and isolates each standalone summary request", async () => {
		await generateSummary(messages, createModel(false), 2000, "test-key");
		await generateSummary(messages, createModel(false), 2000, "test-key");

		const options = completeSimpleMock.mock.calls.map((call) => call[2]);
		expect(options.map((entry) => entry?.cacheRetention)).toEqual(["none", "none"]);
		expect(options[0]?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(options[1]?.sessionId).not.toBe(options[0]?.sessionId);
	});

	it("clamps compaction summary maxTokens to the model output cap", async () => {
		const originalRequest =
			"Work for up to one hour, but stop and report immediately if the harness loops or loses worker state.";
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: [{ role: "user", content: originalRequest, timestamp: Date.now() }],
			isSplitTurn: true,
			tokensBefore: 600000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
		};

		const result = await compact(preparation, createModel(false, 128000), "test-key");

		expect(completeSimpleMock.mock.calls.map((call) => call[2]?.maxTokens)).toEqual([1500]);
		expect(result.summary).toContain(`## Original Request\n${originalRequest}`);
	});

	it("copies split-turn text blocks in order without a second model rewrite", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Keep the task exact. " },
						{ type: "text", text: "Stop only if worker state is lost." },
					],
					timestamp: Date.now(),
				},
			],
			isSplitTurn: true,
			tokensBefore: 20_000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 4_000, keepRecentTokens: 100 },
		};

		const result = await compact(preparation, createModel(false), "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(result.summary).toContain("## Original Request\nKeep the task exact. Stop only if worker state is lost.");
	});
});
