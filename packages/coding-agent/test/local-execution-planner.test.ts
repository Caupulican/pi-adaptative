import { describe, expect, it } from "vitest";
import {
	PRISM_LLAMACPP_DESCRIPTORS,
	planPrismSpeculation,
	resolvePrismLocalModelDescriptor,
} from "../src/core/models/local-execution-planner.ts";

const BONSAI_MODEL_IDS = [
	"prism-ml/Bonsai-1.7B-gguf",
	"prism-ml/Bonsai-4B-gguf",
	"prism-ml/Bonsai-8B-gguf",
	"prism-ml/Bonsai-27B-gguf",
	"prism-ml/Ternary-Bonsai-1.7B-gguf",
	"prism-ml/Ternary-Bonsai-4B-gguf",
	"prism-ml/Ternary-Bonsai-8B-gguf",
	"prism-ml/Ternary-Bonsai-27B-gguf",
] as const;

describe("Pi local execution planner", () => {
	it("routes the complete Bonsai family through one managed Prism llama.cpp catalog", () => {
		expect(Object.keys(PRISM_LLAMACPP_DESCRIPTORS).sort()).toEqual([...BONSAI_MODEL_IDS].sort());
		for (const modelId of BONSAI_MODEL_IDS) {
			expect(resolvePrismLocalModelDescriptor(modelId.toLowerCase())).toMatchObject({
				repo: modelId,
				architecture: "dense",
				runtime: "prism-llamacpp",
			});
		}
	});

	it("does not select Colibri for dense Bonsai checkpoints", () => {
		for (const descriptor of Object.values(PRISM_LLAMACPP_DESCRIPTORS)) {
			expect(descriptor.runtime).not.toBe("colibri");
			expect(descriptor.architecture).toBe("dense");
		}
	});

	it("enables only a matched 27B DSpark drafter on CUDA", () => {
		const descriptor = resolvePrismLocalModelDescriptor("prism-ml/Ternary-Bonsai-27B-gguf");
		expect(descriptor).toBeDefined();
		expect(planPrismSpeculation(descriptor!, { requested: true, backend: "cuda" })).toEqual({
			enabled: true,
			kind: "dspark",
			drafterFile: "Ternary-Bonsai-27B-dspark-Q4_1.gguf",
			draftMax: 4,
			minimumContext: 16_384,
		});
	});

	it("never substitutes MTP or an unrelated drafter", () => {
		const small = resolvePrismLocalModelDescriptor("prism-ml/Bonsai-4B-gguf");
		const large = resolvePrismLocalModelDescriptor("prism-ml/Bonsai-27B-gguf");
		expect(planPrismSpeculation(small!, { requested: true, backend: "cuda" })).toEqual({
			enabled: false,
			reason: "model-has-no-matched-drafter",
		});
		expect(planPrismSpeculation(large!, { requested: true, backend: "cpu" })).toEqual({
			enabled: false,
			reason: "backend-not-validated",
		});
	});
});
