import { describe, expect, it } from "vitest";
import { formatOpenAICompletionsProviderError } from "../src/providers/openai-completions.ts";
import type { Model } from "../src/types.ts";

function ollamaModel(): Model<"openai-completions"> {
	return {
		api: "openai-completions",
		provider: "ollama",
		id: "qwen3:1.7b",
		name: "Qwen 3 1.7B",
		baseUrl: "http://localhost:11434/v1",
		input: ["text"],
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 16_384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

describe("openai-completions provider errors", () => {
	it("adds an actionable Ollama context-size hint", () => {
		const error = new Error("400 status code (no body)") as Error & {
			status: number;
			error: { error: { message: string; type: string } };
		};
		error.status = 400;
		error.error = {
			error: {
				message: "prompt exceeds model context window",
				type: "exceed_context_size_error",
			},
		};

		const formatted = formatOpenAICompletionsProviderError(error, ollamaModel());

		expect(formatted).toContain("exceed_context_size_error");
		expect(formatted).toContain("ollama/qwen3:1.7b");
		expect(formatted).toContain("OLLAMA_CONTEXT_LENGTH");
		expect(formatted).toContain("num_ctx");
		expect(formatted).toContain("re-derives num_ctx");
		expect(formatted).toContain("Do not lower pi's models.json contextWindow");
	});
});
