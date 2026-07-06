import { describe, expect, it } from "vitest";
import {
	buildChunkSummarizationPrompt,
	estimateStringTokens,
	getChunkSummarizationTokenBudget,
} from "../../src/compaction/compaction.ts";

describe("compaction chunk sizing", () => {
	it("keeps the full per-chunk prompt within the summarizer input bound", () => {
		const inputBound = 8_000;
		const chunkTokenBudget = getChunkSummarizationTokenBudget(inputBound);
		const chunk = "x".repeat(chunkTokenBudget * 4);
		const prompt = buildChunkSummarizationPrompt(chunk, 1, 1);

		expect(estimateStringTokens(prompt)).toBeLessThanOrEqual(inputBound);
	});
});
