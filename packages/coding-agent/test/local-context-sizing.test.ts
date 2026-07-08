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

	it("renders a managed Ollama Modelfile with the selected num_ctx", () => {
		expect(renderOllamaContextModelfile({ from: "qwen3:1.7b", numCtx: 8_192 })).toBe(
			"FROM qwen3:1.7b\nPARAMETER num_ctx 8192\n",
		);
		expect(sizedLocalModelRef("hf.co/org/model:Q4_K_M", 8_192)).toBe("pi-hf.co-org-model-Q4_K_M:ctx8192");
	});
});
