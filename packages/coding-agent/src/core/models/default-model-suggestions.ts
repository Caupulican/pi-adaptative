import type { FitnessRole } from "../../modes/interactive/components/fitness-role-selector.ts";

/**
 * Curated local-model suggestions: a starting roster validated during pi-adaptative's own
 * small-model research so a user does not have to know WHICH model fits WHICH role. Each entry is
 * a pull ref (accepted by /models add) plus the role it was validated for and whether it can call
 * tools (Ternary-Bonsai GGUFs ship without a tool-calling template, so they are lane/brain models,
 * never executors).
 *
 * Honesty: these are SUGGESTIONS, not guarantees. Fitness is a property of the model AND the host
 * hardware, so no per-model score is baked in here — `/models add` auto-probes on the actual
 * machine, and the roster only encodes what role each model was SHAPED for. `assignRole` is the
 * /fitness role the suggestion maps to (undefined = no single-setting slot yet; use it as a
 * research/worker lane model).
 */

export interface ModelSuggestion {
	/** Display name in the suggestions list. */
	name: string;
	/** Ref accepted by /models add and the source normalizer. */
	pullRef: string;
	/** Role this model was validated/shaped for. */
	role: string;
	/** True if the model has native tool-calling (required for the executor role). */
	toolCalling: boolean;
	/** The /fitness assignment target this suggestion maps to, when there is a single-setting slot. */
	assignRole?: FitnessRole;
	/** One-line rationale from the validation work; never a fabricated numeric score. */
	rationale: string;
	/** Optional caveat (quant selection, RAM needs). */
	note?: string;
}

export const DEFAULT_MODEL_SUGGESTIONS: readonly ModelSuggestion[] = [
	{
		name: "qwen3:1.7b",
		pullRef: "qwen3:1.7b",
		role: "Toolkit executor / reflex muscle",
		toolCalling: true,
		assignRole: "executor",
		rationale:
			"Validated as the executor: reliable native tool-calling and low latency, so direct toolkit commands run without retries.",
	},
	{
		name: "qwen3:0.6b",
		pullRef: "qwen3:0.6b",
		role: "Minimal executor (fastest)",
		toolCalling: true,
		assignRole: "executor",
		rationale:
			"Fastest local option; on harder requests it can narrate without executing, so prefer it only when speed dominates and requests are simple.",
	},
	{
		name: "Ternary-Bonsai-1.7B",
		pullRef: "hf.co/prism-ml/Ternary-Bonsai-1.7B-gguf",
		role: "Search scout (heavy-lifter)",
		toolCalling: false,
		rationale:
			"Ternary weights, very fast; strong at structured search plans. No tool-calling template — use it as a research/worker lane model, never an executor.",
		note: "Pick a GGUF quant the runtime accepts (e.g. :Q8_0). The ternary Q2_0 build needs prism-ml's patched llama.cpp.",
	},
	{
		name: "Ternary-Bonsai-4B",
		pullRef: "hf.co/prism-ml/Ternary-Bonsai-4B-gguf",
		role: "Context curator / reflex brain / lane analyst",
		toolCalling: false,
		assignRole: "curator",
		rationale:
			"Validated as the 'brain': strict-JSON interpretation and faithful digests. Drives context curation and the toolkit reflex interpreter. Not a tool-caller.",
		note: "Pick a GGUF quant the runtime accepts (e.g. :Q8_0).",
	},
	{
		name: "Ternary-Bonsai-8B",
		pullRef: "hf.co/prism-ml/Ternary-Bonsai-8B-gguf",
		role: "Routing judge (larger machines)",
		toolCalling: false,
		assignRole: "judge",
		rationale:
			"A judge candidate for machines with more headroom — too slow on ~16GB-class hardware in this research, kept for a bigger box.",
		note: "Heavy: confirm tok/s with /fitness before committing. Ternary quant may need prism-ml's patched llama.cpp.",
	},
];

/** Bounded plain-text roster for `/models suggest` and the empty-store hint. */
export function formatModelSuggestions(suggestions: readonly ModelSuggestion[] = DEFAULT_MODEL_SUGGESTIONS): string[] {
	const lines = [
		"Suggested local models (validated roles from pi's own small-model research; probe on YOUR hardware with /fitness):",
	];
	for (const suggestion of suggestions) {
		lines.push(
			`  - ${suggestion.name} → ${suggestion.role}${suggestion.toolCalling ? "" : " [no tool-calling]"}`,
			`      /models add ${suggestion.pullRef}`,
			`      ${suggestion.rationale}`,
		);
		if (suggestion.note) lines.push(`      note: ${suggestion.note}`);
	}
	lines.push("Add one with /models add <ref> — pi pulls it, probes it, and offers a role in one step.");
	return lines;
}
