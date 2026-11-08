import type { FitnessRole } from "./fitness-role.ts";
import { ORNITH_9B_OLLAMA_REF } from "./managed-ollama-model.ts";

/**
 * Curated local-model suggestions: a starting roster from pi-adaptative's small-model research and
 * current external candidates. Each entry is an install ref (accepted by /models add) plus a
 * validated role or a candidate role to evaluate, and whether tool use is established. Native
 * tool-calling remains preferred when it works; text-protocol models are listed only when their
 * runtime is pi-managed and the fitness/probe path can calibrate that fallback.
 *
 * Honesty: these are SUGGESTIONS, not guarantees. Fitness is a property of the model AND the host
 * hardware, so no per-model score is baked in here — `/models add` auto-probes on the actual
 * machine, and the roster only encodes each model's validated role or candidate use. `assignRole` is the
 * /fitness role the suggestion maps to (undefined = no single-setting slot yet; use it as a
 * research/worker lane model).
 */

export interface ModelSuggestion {
	/** Display name in the suggestions list. */
	name: string;
	/** Ref accepted by /models add and the source normalizer. */
	pullRef: string;
	/** Validated role or candidate role to evaluate. */
	role: string;
	/** Established capability, known absence, or a candidate whose tool use is not yet verified. */
	toolCalling: boolean | "unverified";
	/** The /fitness assignment target this suggestion maps to, when there is a single-setting slot. */
	assignRole?: FitnessRole;
	/** One-line validation rationale or candidate description; never a fabricated numeric score. */
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
		role: "Repository scout",
		toolCalling: true,
		assignRole: "scout",
		rationale:
			"The model the repository scout is built around: 4B Qwen3, 256K context, trained for read-only repo exploration returning file:line citations. /fitness must pass its tool-call and research checks before assignment.",
		note: "Q4 ≈ 2.5 GB; ~5-6 GB peak with 32-64K KV. Qwen3 template caveat: if tool calls fail the probe, use the Modelfile recipe in the repository's scout guide.",
	},
	{
		name: "Ornith-1.0-9B",
		pullRef: ORNITH_9B_OLLAMA_REF,
		role: "Agentic-coding worker / router cheap tier",
		toolCalling: true,
		assignRole: "router-cheap",
		rationale:
			"External candidate (not from pi's own validation research): MIT, Qwen 3.5 base, RL-trained for agentic coding with native tool-calling — the strongest local worker SHAPE in the roster. /fitness on your hardware is the validator.",
		note: "Q4_K_M ≈ 5.6 GB weights, ~7-8 GB peak with KV — on a 10 GB box run it as the ONLY local model. Pi creates a managed Qwen 3.5 renderer/parser profile with the model's recommended sampling before probing. Larger boxes: consider router-medium after a passed worker lane.",
	},
	{
		name: "LFM2.5-8B-A1B",
		pullRef: "lfm2.5:8b-a1b-q4_K_M",
		role: "Native-tool MoE worker / router cheap tier",
		toolCalling: true,
		assignRole: "router-cheap",
		rationale:
			"Liquid AI's sparse MoE candidate is designed for agentic workflows. Pi probes native tool-calling first and only calibrates the phone protocol after native failure; /fitness must pass the task-scale tool lane on this host before assignment.",
		note: "Q4_K_M ≈ 5.2 GB, 8.3B total / 1.5B active parameters, with a 128K-class model context. On a 10 GB host run it as the only large local resident; Pi still applies its bounded host profile and context budget.",
	},
	{
		name: "LFM3-1.7B",
		pullRef: "lfm3:1.7b-q4_K_M",
		role: "Local text and tool-use candidate",
		toolCalling: "unverified",
		rationale:
			"Liquid AI's current 1.7B text model is trained for local agent workflows. Native tool-calling and task fitness still need to be established on this host before assigning an executor or router role.",
		note: "Ollama advertises a 256K context window for this tag. Pi's host profile and actual runtime response determine the usable budget.",
	},
	{
		name: "LFM3-VL-2B",
		pullRef: "lfm3-vl:2b-q4_K_M",
		role: "Local image understanding candidate",
		toolCalling: "unverified",
		rationale:
			"Liquid AI describes text, image, and video inputs upstream; Pi's media path currently exposes image input only. Treat it as a modality-specific candidate; /fitness on this host must establish its supported tasks before use in a lane.",
		note: "Ollama advertises a 125K context window for this tag; actual runtime capacity can be lower.",
	},
	{
		name: "LFM3-Audio-2B",
		pullRef: "lfm3-audio:2b-q4_K_M",
		role: "Local audio understanding and speech candidate",
		toolCalling: "unverified",
		rationale:
			"Liquid AI's audio model accepts text or audio and can return text, speech, or both. Audio input/output fitness remains to be established on this host.",
		note: "Ollama advertises a 125K context window for this tag; the model card separately describes a 32K native context. Treat advertised runtime capacity as metadata, not a guaranteed budget.",
	},
	{
		name: "LFM3-Omni-2B",
		pullRef: "lfm3-omni:2b-q4_K_M",
		role: "Local image, audio, and speech candidate",
		toolCalling: "unverified",
		rationale:
			"Liquid AI describes text, image, video, and audio inputs upstream and text or speech outputs. Pi's media path currently exposes image and audio only; combined modality fitness and tool use remain to be established on this host.",
		note: "Ollama advertises a 125K context window for this tag; actual runtime capacity can be lower.",
	},
	{
		name: "Bonsai-4B (GGUF Q1_0)",
		pullRef: "hf.co/prism-ml/Bonsai-4B-gguf:Q1_0",
		role: "Context curator / reflex brain / lighter lane analyst",
		toolCalling: false,
		assignRole: "curator",
		rationale:
			"Lighter Bonsai lane model for context curation and structured local analysis; the exact Q1_0 artifact keeps /models suggest one-step.",
		note: "Recommended when Bonsai-8B is too heavy. Pi serves the exact Q1_0 GGUF through its bounded Prism llama.cpp adapter, probes /fitness on the host, then offers the curator role.",
	},
	{
		name: "Bonsai-27B (1-bit + vision)",
		pullRef: "hf.co/prism-ml/Bonsai-27B-gguf:Q1_0",
		role: "Context curator / reflex brain / vision-capable lane analyst",
		toolCalling: false,
		assignRole: "curator",
		rationale:
			"External 1-bit 27B, binary weights, 262K-class context, vision via mmproj; served through Pi's pinned Prism llama.cpp adapter so runtime, artifact, and projector stay one validated unit. /fitness on your hardware is the validator — never pre-claim tool-calling.",
		note: "~3.8 GB weights + 629 MB vision projector + a one-time llama-server runtime download; CPU-served on GPU-less hosts. Pi installs the pinned prism llama.cpp runtime, downloads both files, starts llama-server, and registers the model in one step. Provider-recommended sampling is temp 0.7 / top-p 0.95 / top-k 20; models.json has no per-model default-sampling field yet, so pi cannot wire this — set it per-request/session if your workflow needs it.",
	},
	{
		name: "Ternary-Bonsai-1.7B",
		pullRef: "hf.co/prism-ml/Ternary-Bonsai-1.7B-gguf:Q2_0",
		role: "Search scout (heavy-lifter)",
		toolCalling: false,
		rationale:
			"Ternary weights, very fast; strong at structured search plans. No tool-calling template — use it as a research/worker lane model, never an executor.",
		note: "Pi pins the provider's group-128 Q2_0 artifact and its matched Prism llama.cpp runtime; no ambiguous quant selection is left to Ollama.",
	},
	{
		name: "Ternary-Bonsai-4B",
		pullRef: "hf.co/prism-ml/Ternary-Bonsai-4B-gguf:Q2_0",
		role: "Context curator / reflex brain / lane analyst",
		toolCalling: false,
		assignRole: "curator",
		rationale:
			"Validated as the 'brain': strict-JSON interpretation and faithful digests. Drives context curation and the toolkit reflex interpreter. Not a tool-caller.",
		note: "Pi pins the provider's group-128 Q2_0 artifact and its matched Prism llama.cpp runtime.",
	},
	{
		name: "needle (function-call tester, 26M)",
		pullRef: "hf.co/Cactus-Compute/needle",
		role: "Standalone function-call test bench (not a chat/lane model)",
		toolCalling: false,
		rationale:
			"NOT a pi chat model, executor, or lane model — needle is a 26M-parameter single-shot function-call SPECIALIST invoked one query at a time through its own `needle run` CLI, useful only as a standalone bench for probing tool-call behavior in isolation. No OpenAI-compatible endpoint, no chat lanes, no models.json registration, and no /fitness probe: use /models needle <query> [tools-json] to test it directly instead.",
		note: "Upstream weights (needle.pkl) are pickle-only — arbitrary code execution on load by construction, not something pi's pinned-sha256 verification makes safe in the abstract, only tamper-evident.",
	},
];

/** Bounded plain-text roster for `/models suggest` and the empty-store hint. */
export function formatModelSuggestions(suggestions: readonly ModelSuggestion[] = DEFAULT_MODEL_SUGGESTIONS): string[] {
	const lines = ["Suggested local models and candidates (probe on YOUR hardware with /fitness):"];
	for (const suggestion of suggestions) {
		lines.push(
			`  - ${suggestion.name} → ${suggestion.role}${suggestion.toolCalling === false ? " [no tool-calling]" : suggestion.toolCalling === "unverified" ? " [tool-calling unverified]" : ""}`,
			`      /models add ${suggestion.pullRef}`,
			`      ${suggestion.rationale}`,
		);
		if (suggestion.note) lines.push(`      note: ${suggestion.note}`);
	}
	lines.push("Add one with /models add <ref> — pi pulls it, probes it, and offers a role in one step.");
	return lines;
}
