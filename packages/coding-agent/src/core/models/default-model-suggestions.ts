import type { FitnessRole } from "../../modes/interactive/components/fitness-role-selector.ts";

/**
 * Curated local-model suggestions: a starting roster validated during pi-adaptative's own
 * small-model research so a user does not have to know WHICH model fits WHICH role. Each entry is
 * an install ref (accepted by /models add) plus the role it was validated for and whether it can use
 * tools. Native tool-calling remains preferred when it works; text-protocol models are listed only
 * when their runtime is pi-managed and the fitness/probe path can calibrate that fallback.
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
	/** True if the model can use tools after host-local probing/calibration (required for executor). */
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
		name: "MiniCPM5-1B (full-base)",
		pullRef: "hf.co/openbmb/MiniCPM5-1B",
		role: "Full-base Transformers executor / tiny local muscle",
		toolCalling: true,
		assignRole: "executor",
		rationale:
			"Full-base Hugging Face MiniCPM5-1B target: pi installs an isolated Transformers runtime and probes native tool-calling first, then calibrates the text protocol only if native tool calls do not work.",
		note: "Not GGUF/quantized: weights and Python deps land under pi-owned runtime/cache directories, separate from Ollama and system Python.",
	},
	{
		name: "FastContext-1.0-4B",
		pullRef: "hf.co/KikoCis/FastContext-1.0-4B-longctx-imatrix-GGUF:fastcontext4b.Q4_K_M.imx.gguf",
		role: "Repository scout (context_scout)",
		toolCalling: true,
		assignRole: "scout",
		rationale:
			"The model the context_scout lane is built around (Plan 9): 4B Qwen3, 256K context, trained for read-only repo exploration returning file:line citations. /fitness must pass the tool-calls + research lanes before assignment.",
		note: "Q4 ≈ 2.5 GB; ~5-6 GB peak with 32-64K KV. Qwen3 template caveat: if tool calls fail the probe, use the Modelfile recipe in docs/scout.md.",
	},
	{
		name: "Ornith-1.0-9B",
		pullRef: "hf.co/deepreinforce-ai/Ornith-1.0-9B-GGUF:Q4_K_M",
		role: "Agentic-coding worker / router cheap tier",
		toolCalling: true,
		assignRole: "router-cheap",
		rationale:
			"External candidate (not from pi's own validation research): MIT, Qwen 3.5 base, RL-trained for agentic coding with native tool-calling — the strongest local worker SHAPE in the roster. /fitness on your hardware is the validator.",
		note: "Q4_K_M ≈ 5.6 GB weights, ~7-8 GB peak with KV — on a 10 GB box run it as the ONLY local model. Qwen 3.5 arch: confirm pi's pinned Ollama supports it and probe tool-calls with /fitness before assigning (template derives from the GGUF). Larger boxes: consider router-medium after a passed worker lane.",
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
