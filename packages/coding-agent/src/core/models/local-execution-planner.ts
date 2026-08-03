import { BONSAI_27B, type PrismBackend, type PrismModelDescriptor } from "./llamacpp-runtime.ts";

function descriptor(args: PrismModelDescriptor): PrismModelDescriptor {
	return args;
}

const BONSAI_1_7B = descriptor({
	repo: "prism-ml/Bonsai-1.7B-gguf",
	file: "Bonsai-1.7B-Q1_0.gguf",
	displayName: "Bonsai-1.7B (1-bit Q1_0)",
	architecture: "dense",
	runtime: "prism-llamacpp",
	family: "bonsai",
	parameterScale: "1.7B",
	weightFormat: "q1_0",
});

const BONSAI_4B = descriptor({
	repo: "prism-ml/Bonsai-4B-gguf",
	file: "Bonsai-4B-Q1_0.gguf",
	displayName: "Bonsai-4B (1-bit Q1_0)",
	architecture: "dense",
	runtime: "prism-llamacpp",
	family: "bonsai",
	parameterScale: "4B",
	weightFormat: "q1_0",
});

const BONSAI_8B = descriptor({
	repo: "prism-ml/Bonsai-8B-gguf",
	file: "Bonsai-8B-Q1_0.gguf",
	displayName: "Bonsai-8B (1-bit Q1_0)",
	architecture: "dense",
	runtime: "prism-llamacpp",
	family: "bonsai",
	parameterScale: "8B",
	weightFormat: "q1_0",
});

const TERNARY_BONSAI_1_7B = descriptor({
	repo: "prism-ml/Ternary-Bonsai-1.7B-gguf",
	file: "Ternary-Bonsai-1.7B-Q2_0.gguf",
	displayName: "Ternary-Bonsai-1.7B (Q2_0)",
	architecture: "dense",
	runtime: "prism-llamacpp",
	family: "ternary-bonsai",
	parameterScale: "1.7B",
	weightFormat: "q2_0",
});

const TERNARY_BONSAI_4B = descriptor({
	repo: "prism-ml/Ternary-Bonsai-4B-gguf",
	file: "Ternary-Bonsai-4B-Q2_0.gguf",
	displayName: "Ternary-Bonsai-4B (Q2_0)",
	architecture: "dense",
	runtime: "prism-llamacpp",
	family: "ternary-bonsai",
	parameterScale: "4B",
	weightFormat: "q2_0",
});

const TERNARY_BONSAI_8B = descriptor({
	repo: "prism-ml/Ternary-Bonsai-8B-gguf",
	file: "Ternary-Bonsai-8B-Q2_0.gguf",
	displayName: "Ternary-Bonsai-8B (Q2_0)",
	architecture: "dense",
	runtime: "prism-llamacpp",
	family: "ternary-bonsai",
	parameterScale: "8B",
	weightFormat: "q2_0",
});

const TERNARY_BONSAI_27B = descriptor({
	repo: "prism-ml/Ternary-Bonsai-27B-gguf",
	file: "Ternary-Bonsai-27B-Q2_0.gguf",
	mmprojFile: "Ternary-Bonsai-27B-mmproj-Q8_0.gguf",
	displayName: "Ternary-Bonsai-27B (Q2_0 + vision)",
	architecture: "dense",
	runtime: "prism-llamacpp",
	family: "ternary-bonsai",
	parameterScale: "27B",
	weightFormat: "q2_0",
	matchedDrafter: {
		kind: "dspark",
		file: "Ternary-Bonsai-27B-dspark-Q4_1.gguf",
		draftMax: 4,
		minimumContext: 16_384,
		validatedBackend: "cuda",
	},
});

/**
 * The complete model set Pi may manage through its pinned Prism llama.cpp adapter. Unknown models
 * never enter this path. Every descriptor pins the exact GGUF artifact so user-provided quant
 * suffixes cannot silently select a different format or runtime.
 */
export const PRISM_LLAMACPP_DESCRIPTORS: Readonly<Record<string, PrismModelDescriptor>> = Object.freeze({
	[BONSAI_1_7B.repo]: BONSAI_1_7B,
	[BONSAI_4B.repo]: BONSAI_4B,
	[BONSAI_8B.repo]: BONSAI_8B,
	[BONSAI_27B.repo]: BONSAI_27B,
	[TERNARY_BONSAI_1_7B.repo]: TERNARY_BONSAI_1_7B,
	[TERNARY_BONSAI_4B.repo]: TERNARY_BONSAI_4B,
	[TERNARY_BONSAI_8B.repo]: TERNARY_BONSAI_8B,
	[TERNARY_BONSAI_27B.repo]: TERNARY_BONSAI_27B,
});

const DESCRIPTORS_BY_LOWERCASE_ID = new Map(
	Object.values(PRISM_LLAMACPP_DESCRIPTORS).map((entry) => [entry.repo.toLowerCase(), entry]),
);

export function resolvePrismLocalModelDescriptor(modelId: string): PrismModelDescriptor | undefined {
	return DESCRIPTORS_BY_LOWERCASE_ID.get(modelId.toLowerCase());
}

export type PrismSpeculationPlan =
	| {
			enabled: true;
			kind: "dspark";
			drafterFile: string;
			draftMax: 4;
			minimumContext: 16_384;
	  }
	| { enabled: false; reason: "not-requested" | "model-has-no-matched-drafter" | "backend-not-validated" };

/** MTP is deliberately absent: Bonsai acceleration uses only the model's exact paired drafter. */
export function planPrismSpeculation(
	descriptor: PrismModelDescriptor,
	args: { requested: boolean; backend: PrismBackend },
): PrismSpeculationPlan {
	if (!args.requested) return { enabled: false, reason: "not-requested" };
	if (!descriptor.matchedDrafter) return { enabled: false, reason: "model-has-no-matched-drafter" };
	if (args.backend !== descriptor.matchedDrafter.validatedBackend) {
		return { enabled: false, reason: "backend-not-validated" };
	}
	return {
		enabled: true,
		kind: descriptor.matchedDrafter.kind,
		drafterFile: descriptor.matchedDrafter.file,
		draftMax: descriptor.matchedDrafter.draftMax,
		minimumContext: descriptor.matchedDrafter.minimumContext,
	};
}
