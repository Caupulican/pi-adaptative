import { describe, expect, it } from "vitest";
import {
	deriveLocalContextSizing,
	renderOllamaContextModelfile,
	sizedLocalModelRef,
} from "../src/core/models/context-sizing.ts";

const MODEL_INFO = {
	"llama.block_count": 32,
	"llama.attention.head_count_kv": 8,
	"llama.attention.key_length": 128,
	"llama.attention.value_length": 128,
};

const QWEN3_MODEL_INFO = {
	"general.architecture": "qwen3",
	"qwen3.block_count": 28,
	"qwen3.attention.head_count_kv": 4,
	"qwen3.attention.key_length": 128,
	"qwen3.attention.value_length": 128,
};

const MINICPM_MODEL_INFO = {
	"minicpm3.block_count": 40,
	"minicpm3.embedding_length": 2_304,
};

describe("local context sizing", () => {
	it("chooses the largest context rung that fits host RAM after weights", () => {
		const decision = deriveLocalContextSizing({
			host: { totalMemBytes: 14 * 1024 ** 3, headroomFraction: 0.8 },
			model: { modelInfo: MODEL_INFO, weightsBytes: 6 * 1024 ** 3 },
		});

		expect(decision?.numCtx).toBe(32_768);
		expect(decision?.kvCacheType).toBeUndefined();
	});

	it("uses q8 KV cache sizing when the runtime exposes it and f16 does not fit", () => {
		const decision = deriveLocalContextSizing({
			host: { totalMemBytes: 7 * 1024 ** 3, headroomFraction: 0.8 },
			model: { modelInfo: MODEL_INFO, weightsBytes: 5 * 1024 ** 3 },
			runtime: { supportsKvQuantization: true },
		});

		expect(decision?.numCtx).toBe(8_192);
		expect(decision?.kvCacheType).toBe("q8_0");
	});

	it("derives KV shape from the declared GGUF architecture prefix", () => {
		const decision = deriveLocalContextSizing({
			host: { totalMemBytes: 6 * 1024 ** 3, headroomFraction: 0.8 },
			model: { modelInfo: QWEN3_MODEL_INFO, weightsBytes: 1 * 1024 ** 3 },
		});

		expect(decision?.numCtx).toBe(32_768);
		expect(decision?.kvBytesPerToken).toBe(28 * 4 * (128 + 128) * 2);
	});

	it("falls back to suffix-based metadata when the architecture prefix is absent", () => {
		const decision = deriveLocalContextSizing({
			host: { totalMemBytes: 8 * 1024 ** 3, headroomFraction: 0.8 },
			model: { modelInfo: MINICPM_MODEL_INFO, weightsBytes: 2 * 1024 ** 3 },
		});

		expect(decision?.numCtx).toBe(8_192);
		expect(decision?.kvBytesPerToken).toBe(40 * 2_304 * 2 * 2);
	});

	it("renders a managed Ollama Modelfile with the selected num_ctx", () => {
		expect(renderOllamaContextModelfile({ from: "qwen3:1.7b", numCtx: 8_192 })).toBe(
			"FROM qwen3:1.7b\nPARAMETER num_ctx 8192\n",
		);
		expect(sizedLocalModelRef("hf.co/org/model:Q4_K_M", 8_192)).toBe("pi-hf.co-org-model-Q4_K_M:ctx8192");
	});
});
