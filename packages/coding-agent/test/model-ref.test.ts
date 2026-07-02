import { describe, expect, it } from "vitest";
import { normalizeModelSource } from "../src/core/models/model-ref.ts";

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

	it("normalizes full HuggingFace URLs to hf.co refs", () => {
		expect(normalizeModelSource("https://huggingface.co/prism-ml/Ternary-Bonsai-1.7B-gguf/tree/main")).toEqual({
			type: "local",
			pullRef: "hf.co/prism-ml/Ternary-Bonsai-1.7B-gguf",
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
