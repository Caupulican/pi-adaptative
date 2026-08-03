import { describe, expect, it } from "vitest";
import { ORNITH_9B_OLLAMA_REF, planManagedOllamaModel } from "../src/core/models/managed-ollama-model.ts";

const QWEN35_MODEL_INFO = {
	"general.architecture": "qwen35",
};

describe("managed Ollama model profiles", () => {
	it("makes the required Ornith Qwen 3.5 runtime profile part of the managed model", () => {
		const plan = planManagedOllamaModel({
			sourceRef: ORNITH_9B_OLLAMA_REF,
			modelInfo: QWEN35_MODEL_INFO,
			numCtx: 4_096,
		});

		expect(plan).toEqual({
			name: "pi-hf.co-deepreinforce-ai-Ornith-1.0-9B-GGUF-Q4_K_M:ctx4096",
			create: {
				from: ORNITH_9B_OLLAMA_REF,
				template: "{{ .Prompt }}",
				renderer: "qwen3.5",
				parser: "qwen3.5",
				parameters: {
					temperature: 0.6,
					top_p: 0.95,
					top_k: 20,
					num_ctx: 4_096,
				},
			},
			profileId: "qwen3.5-ornith",
		});
	});

	it("profiles another Ornith quant even when context sizing is unavailable", () => {
		const plan = planManagedOllamaModel({
			sourceRef: "hf.co/DEEPREINFORCE-AI/ornith-1.0-9b-gguf:IQ4_XS",
			modelInfo: {},
		});

		expect(plan?.name).toBe("pi-hf.co-DEEPREINFORCE-AI-ornith-1.0-9b-gguf-IQ4_XS:managed");
		expect(plan?.profileId).toBe("qwen3.5-ornith");
		expect(plan?.create.renderer).toBe("qwen3.5");
		expect(plan?.create.parser).toBe("qwen3.5");
		expect(plan?.create.parameters).toEqual({ temperature: 0.6, top_p: 0.95, top_k: 20 });
		expect(plan?.create.parameters).not.toHaveProperty("num_ctx");
	});

	it("uses the architecture renderer for other Qwen 3.5 models without Ornith sampling", () => {
		const plan = planManagedOllamaModel({
			sourceRef: "example-qwen35:latest",
			modelInfo: QWEN35_MODEL_INFO,
			numCtx: 8_192,
		});

		expect(plan?.profileId).toBe("qwen3.5");
		expect(plan?.create.renderer).toBe("qwen3.5");
		expect(plan?.create.parser).toBe("qwen3.5");
		expect(plan?.create.parameters).toEqual({ num_ctx: 8_192 });
	});

	it("does not profile a misleading Ornith-like name with a different architecture", () => {
		const plan = planManagedOllamaModel({
			sourceRef: "hf.co/unrelated/Ornith-1.0-9B-GGUF:Q4_K_M",
			modelInfo: { "general.architecture": "qwen3" },
			numCtx: 8_192,
		});

		expect(plan).toEqual({
			name: "pi-hf.co-unrelated-Ornith-1.0-9B-GGUF-Q4_K_M:ctx8192",
			create: {
				from: "hf.co/unrelated/Ornith-1.0-9B-GGUF:Q4_K_M",
				parameters: { num_ctx: 8_192 },
			},
		});
	});

	it("does not derive an ordinary model when neither a profile nor context sizing is needed", () => {
		expect(
			planManagedOllamaModel({
				sourceRef: "qwen3:1.7b",
				modelInfo: { "general.architecture": "qwen3" },
			}),
		).toBeUndefined();
	});
});
