import { describe, expect, it } from "vitest";
import { matchesInstalledLocalModel, normalizeModelSource } from "../src/core/models/model-ref.ts";

describe("normalizeModelSource", () => {
	it("normalizes ollama tags", () => {
		expect(normalizeModelSource("qwen3:1.7b")).toEqual({ type: "local", pullRef: "qwen3:1.7b" });
		expect(normalizeModelSource("llama3")).toEqual({ type: "local", pullRef: "llama3" });
	});

	it("normalizes hf.co refs with and without quant tags", () => {
		expect(normalizeModelSource("hf.co/prism-ml/Ternary-Bonsai-4B-gguf:Q8_0")).toEqual({
			type: "local",
			pullRef: "hf.co/prism-ml/Ternary-Bonsai-4B-gguf:Q8_0",
		});
		expect(normalizeModelSource("hf.co/org/repo")).toEqual({ type: "local", pullRef: "hf.co/org/repo" });
	});

	it("routes curated full-base Hugging Face models to the pi-managed Transformers runtime", () => {
		expect(normalizeModelSource("hf.co/openbmb/MiniCPM5-1B")).toEqual({
			type: "transformers",
			modelId: "openbmb/MiniCPM5-1B",
			ref: "hf.co/openbmb/MiniCPM5-1B",
		});
		expect(normalizeModelSource("hf.co/openbmb/MiniCPM5-1B:Q8_0")).toEqual({
			type: "local",
			pullRef: "hf.co/openbmb/MiniCPM5-1B:Q8_0",
		});
	});

	it("normalizes full HuggingFace URLs to the matching local runtime ref", () => {
		expect(normalizeModelSource("https://huggingface.co/prism-ml/Ternary-Bonsai-1.7B-gguf/tree/main")).toEqual({
			type: "local",
			pullRef: "hf.co/prism-ml/Ternary-Bonsai-1.7B-gguf",
		});
		expect(normalizeModelSource("https://huggingface.co/openbmb/MiniCPM5-1B/tree/main")).toEqual({
			type: "transformers",
			modelId: "openbmb/MiniCPM5-1B",
			ref: "hf.co/openbmb/MiniCPM5-1B",
		});
	});

	it("parses pasted install commands WITHOUT executing them", () => {
		expect(normalizeModelSource("ollama pull qwen3:0.6b")).toEqual({ type: "local", pullRef: "qwen3:0.6b" });
		expect(normalizeModelSource("ollama run hf.co/org/repo:Q4_K_M")).toEqual({
			type: "local",
			pullRef: "hf.co/org/repo:Q4_K_M",
		});
	});

	it("rejects shell-metacharacter smuggling in install commands", () => {
		expect(normalizeModelSource("ollama pull qwen3; rm -rf /").type).toBe("rejected");
		expect(normalizeModelSource("ollama pull $(evil)").type).toBe("rejected");
		expect(normalizeModelSource("qwen3`x`").type).toBe("rejected");
	});

	it("classifies provider/model names as API sources", () => {
		expect(normalizeModelSource("anthropic/claude-haiku-4-5")).toEqual({
			type: "api",
			ref: "anthropic/claude-haiku-4-5",
		});
	});

	it("rejects unknown URLs and garbage with a reason", () => {
		expect(normalizeModelSource("https://example.com/model.bin").type).toBe("rejected");
		expect(normalizeModelSource("").type).toBe("rejected");
		expect(normalizeModelSource("a/b/c").type).toBe("rejected");
	});
});

describe("matchesInstalledLocalModel", () => {
	it("matches identical refs exactly", () => {
		expect(matchesInstalledLocalModel("llama3:latest", "llama3:latest")).toBe(true);
	});

	it("matches a bare ref against Ollama's implicit :latest listing", () => {
		expect(matchesInstalledLocalModel("llama3", "llama3:latest")).toBe(true);
	});

	it("matches a ref pinned to :latest against a bare listing", () => {
		expect(matchesInstalledLocalModel("llama3:latest", "llama3")).toBe(true);
	});

	it("does not match a bare ref against a different, non-:latest tag", () => {
		expect(matchesInstalledLocalModel("llama3", "llama3:8b")).toBe(false);
	});

	it("does not match unrelated models", () => {
		expect(matchesInstalledLocalModel("llama3", "qwen3:latest")).toBe(false);
	});

	it("does not match a ref pinned to a specific non-latest tag against a bare listing", () => {
		expect(matchesInstalledLocalModel("llama3:8b", "llama3")).toBe(false);
	});
});
