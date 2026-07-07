import type { AssistantMessage, Model } from "@caupulican/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSummary } from "../../src/compaction/index.ts";
import type { AgentMessage } from "../../src/types.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@caupulican/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@caupulican/pi-ai")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(contextWindow: number, maxTokens = 2048): Model<"anthropic-messages"> {
	return {
		id: "test-model",
		name: "test-model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
}

function response(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function messages(chars: number): AgentMessage[] {
	return [{ role: "user", content: "x".repeat(chars), timestamp: Date.now() }];
}

function firstPromptText(call: unknown[]): string {
	const request = call[1] as { messages: Array<{ content: Array<{ text: string }> }> };
	return request.messages[0]?.content[0]?.text ?? "";
}

describe("compaction bounds", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(response("## Active Task\nok"));
	});

	it("throws input-overflow when a non-chunked summarization request exceeds the summarizer bound", async () => {
		await expect(generateSummary(messages(9000), createModel(3000), 100, "test-key")).rejects.toThrow(
			"input-overflow",
		);
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("summarizes bounded chunks then merges them when chunked is selected", async () => {
		completeSimpleMock.mockResolvedValue(response("chunk summary"));

		await generateSummary(
			messages(9000),
			createModel(5500),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"files:\nactions:\nprohibitions:",
			true,
		);

		// Chunking is map-reduce: every chunk is summarized before the final checkpoint merge.
		expect(completeSimpleMock).toHaveBeenCalledTimes(4);
		expect(completeSimpleMock.mock.calls[0]?.[1].messages[0]?.content[0]?.text).toContain("conversation-chunk");
		expect(completeSimpleMock.mock.calls[2]?.[1].messages[0]?.content[0]?.text).toContain("conversation-chunk");
		expect(completeSimpleMock.mock.calls[3]?.[1].messages[0]?.content[0]?.text).toContain(
			"Checkpoint the conversation",
		);
	});

	it("truncates oversized output by dropping lower-priority sections", async () => {
		const oversized = [
			"## Active Task",
			"Keep this active task",
			"",
			"### Mandatory Rules",
			"- DO NOT drop this rule",
			"",
			"## Files",
			"- src/a.ts — modified",
			"",
			"## Done",
			"1. EDIT src/a.ts — done",
			"",
			"## Constraints & Preferences",
			"keep concise",
			"",
			"## Key Decisions",
			"- decided",
			"",
			"## Blocked / Open",
			"- blocked",
			"",
			"## Critical Context",
			"z".repeat(12000),
		].join("\n");
		completeSimpleMock.mockResolvedValue(response(oversized));

		const summary = await generateSummary(messages(10), createModel(200000), 1000, "test-key");

		expect(summary).toContain("## Active Task");
		expect(summary).toContain("### Mandatory Rules");
		expect(summary).not.toContain("## Critical Context");
	});

	it("never drops the gate-checked Files/Done sections when truncating oversized output", async () => {
		const oversized = [
			"## Active Task",
			"Keep this active task",
			"",
			"## Files",
			"- src/a.ts — modified",
			"",
			"## Done",
			"1. EDIT src/a.ts — done",
			"",
			"## Key Decisions",
			"z".repeat(12000),
			"",
			"## Critical Context",
			"z".repeat(12000),
		].join("\n");
		completeSimpleMock.mockResolvedValue(response(oversized));

		const summary = await generateSummary(messages(10), createModel(200000), 1000, "test-key");

		expect(summary).toContain("## Files");
		expect(summary).toContain("## Done");
		expect(summary).not.toContain("## Key Decisions");
		expect(summary).not.toContain("## Critical Context");
	});

	it("throws summary-length-stop when the summarizer hits its output cap", async () => {
		completeSimpleMock.mockResolvedValue(response("## Active Task\ntruncated mid-", "length"));

		await expect(generateSummary(messages(10), createModel(200000), 16384, "test-key")).rejects.toThrow(
			"summary-length-stop",
		);
	});

	it("scales the summary output budget with the facts block instead of length-stopping on it", async () => {
		completeSimpleMock.mockResolvedValue(response("## Active Task\nok"));
		const smallFacts = "files:\nactions:\nprohibitions:";
		const bigFacts = `files:\n${Array.from({ length: 60 }, (_, i) => `modified: src/dir/file-${i}.ts — EDIT`).join("\n")}\nactions:\n${Array.from({ length: 80 }, (_, i) => `EDIT src/dir/file-${i % 60}.ts — ok`).join("\n")}\nprohibitions:`;

		await generateSummary(
			messages(10),
			createModel(200000),
			16384,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			smallFacts,
		);
		const smallBudget = completeSimpleMock.mock.calls[0]?.[2]?.maxTokens as number;

		completeSimpleMock.mockClear();
		completeSimpleMock.mockResolvedValue(response("## Active Task\nok"));
		await generateSummary(
			messages(10),
			createModel(200000),
			16384,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			bigFacts,
		);
		const bigBudget = completeSimpleMock.mock.calls[0]?.[2]?.maxTokens as number;

		expect(smallBudget).toBe(1500);
		expect(bigBudget).toBeGreaterThan(smallBudget);
		expect(bigBudget).toBeGreaterThanOrEqual(Math.ceil(bigFacts.length / 4) + 500);
	});

	it("clamps the base summary budget to tiny model maxTokens", async () => {
		completeSimpleMock.mockResolvedValue(response("## Active Task\nok"));

		await generateSummary(messages(10), createModel(200000, 1000), 16384, "test-key");

		expect(completeSimpleMock.mock.calls[0]?.[2]?.maxTokens).toBe(1000);
	});

	it("runs another reduce pass when merged chunk summaries still exceed the input bound", async () => {
		let chunkCalls = 0;
		completeSimpleMock.mockImplementation(
			(_model, request: { messages: Array<{ content: Array<{ text: string }> }> }) => {
				const prompt = request.messages[0]?.content[0]?.text ?? "";
				if (prompt.includes("conversation-chunk")) {
					chunkCalls += 1;
					return Promise.resolve(response(chunkCalls <= 21 ? "s".repeat(4000) : "reduced chunk"));
				}
				return Promise.resolve(response("## Active Task\nfinal"));
			},
		);

		await generateSummary(
			messages(80_000),
			createModel(5000, 1000),
			4000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"files:\nactions:\nprohibitions:",
			true,
		);

		const prompts = completeSimpleMock.mock.calls.map(firstPromptText);
		expect(chunkCalls).toBeGreaterThan(21);
		expect(prompts[21]).toContain("conversation-chunk");
		expect(prompts[prompts.length - 1]).toContain("Checkpoint the conversation");
	});

	it("throws input-overflow instead of sending an over-window prompt after bounded reduce passes", async () => {
		completeSimpleMock.mockImplementation(
			(_model, request: { messages: Array<{ content: Array<{ text: string }> }> }) => {
				const prompt = request.messages[0]?.content[0]?.text ?? "";
				if (prompt.includes("conversation-chunk")) {
					return Promise.resolve(response("s".repeat(4000)));
				}
				return Promise.resolve(response("## Active Task\nshould not send"));
			},
		);

		await expect(
			generateSummary(
				messages(80_000),
				createModel(5000, 1000),
				4000,
				"test-key",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				"files:\nactions:\nprohibitions:",
				true,
			),
		).rejects.toThrow("input-overflow");

		const prompts = completeSimpleMock.mock.calls.map(firstPromptText);
		expect(prompts.some((prompt) => prompt.includes("Checkpoint the conversation"))).toBe(false);
	});

	it("throws for deterministic compaction when bounded gate demand cannot fit reserve", async () => {
		const hugeFacts = `files:\n${"modified: src/a.ts — EDIT\n".repeat(1000)}actions:\n${"EDIT src/a.ts\n".repeat(1000)}prohibitions:`;

		await expect(
			generateSummary(
				messages(10),
				createModel(200000, 20000),
				1000,
				"test-key",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				hugeFacts,
			),
		).rejects.toThrow("summary-demand-exceeds-reserve");
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});
});
