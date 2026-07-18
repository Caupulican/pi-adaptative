import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_SUGGESTIONS, formatModelSuggestions } from "../src/core/models/default-model-suggestions.ts";
import { normalizeModelSource } from "../src/core/models/model-ref.ts";
import { FITNESS_ROLE_ORDER } from "../src/modes/interactive/components/fitness-role-selector.ts";

describe("default model suggestions", () => {
	it("every suggested pullRef normalizes to an installable local source (/models add accepts it)", () => {
		for (const suggestion of DEFAULT_MODEL_SUGGESTIONS) {
			const source = normalizeModelSource(suggestion.pullRef);
			expect(
				["local", "transformers", "prism-llamacpp", "needle"],
				`${suggestion.name}: ${suggestion.pullRef}`,
			).toContain(source.type);
		}
	});

	it("only tool-calling models are ever suggested for the executor role", () => {
		for (const suggestion of DEFAULT_MODEL_SUGGESTIONS) {
			if (suggestion.assignRole === "executor") {
				expect(suggestion.toolCalling, `${suggestion.name} assigned executor but no tool-calling`).toBe(true);
			}
		}
		// The validated executor and the validated brain are both present.
		expect(DEFAULT_MODEL_SUGGESTIONS.some((s) => s.pullRef === "qwen3:1.7b" && s.assignRole === "executor")).toBe(
			true,
		);
		expect(
			DEFAULT_MODEL_SUGGESTIONS.some(
				(s) => s.pullRef === "hf.co/prism-ml/Bonsai-4B-gguf:Q1_0" && s.assignRole === "curator",
			),
		).toBe(true);
	});

	it("keeps FastContext and Ornith immediately after the executor entries", () => {
		const fastContextIndex = DEFAULT_MODEL_SUGGESTIONS.findIndex((s) => s.name === "FastContext-1.0-4B");
		const firstNonExecutorIndex = DEFAULT_MODEL_SUGGESTIONS.findIndex((s) => s.assignRole !== "executor");
		expect(fastContextIndex).toBe(firstNonExecutorIndex);
		expect(DEFAULT_MODEL_SUGGESTIONS[fastContextIndex]).toMatchObject({
			pullRef: "hf.co/KikoCis/FastContext-1.0-4B-longctx-imatrix-GGUF:fastcontext4b.Q4_K_M.imx.gguf",
			assignRole: "scout",
			toolCalling: true,
		});
		expect(DEFAULT_MODEL_SUGGESTIONS[fastContextIndex + 1]).toMatchObject({
			name: "Ornith-1.0-9B",
			pullRef: "hf.co/deepreinforce-ai/Ornith-1.0-9B-GGUF:Q4_K_M",
			assignRole: "router-cheap",
			toolCalling: true,
		});
	});

	it("Bonsai models are marked as non-tool-calling (lane/brain only, never executor)", () => {
		for (const suggestion of DEFAULT_MODEL_SUGGESTIONS.filter((s) => s.name.includes("Bonsai"))) {
			expect(suggestion.toolCalling).toBe(false);
			expect(suggestion.assignRole).not.toBe("executor");
		}
	});

	it("pins the recommended Bonsai-4B artifact so the suggestion flow is one-step", () => {
		expect(DEFAULT_MODEL_SUGGESTIONS).toContainEqual(
			expect.objectContaining({
				name: "Bonsai-4B (GGUF Q1_0)",
				pullRef: "hf.co/prism-ml/Bonsai-4B-gguf:Q1_0",
				assignRole: "curator",
				toolCalling: false,
			}),
		);
	});

	it("routes the Bonsai-27B suggestion to the curated prism-llamacpp source, never Ollama", () => {
		const suggestion = DEFAULT_MODEL_SUGGESTIONS.find((s) => s.name === "Bonsai-27B (1-bit + vision)");
		expect(suggestion).toBeDefined();
		expect(suggestion).toMatchObject({
			pullRef: "hf.co/prism-ml/Bonsai-27B-gguf:Q1_0",
			assignRole: "curator",
			toolCalling: false,
		});
		expect(normalizeModelSource(suggestion?.pullRef ?? "")).toEqual({
			type: "prism-llamacpp",
			modelId: "prism-ml/Bonsai-27B-gguf",
			ref: "hf.co/prism-ml/Bonsai-27B-gguf",
		});
	});

	it("routes the needle suggestion to the curated needle source, never Ollama, and carries no fitness role", () => {
		const suggestion = DEFAULT_MODEL_SUGGESTIONS.find((s) => s.name === "needle (function-call tester, 26M)");
		expect(suggestion).toBeDefined();
		expect(suggestion).toMatchObject({
			pullRef: "hf.co/Cactus-Compute/needle",
			toolCalling: false,
		});
		expect(suggestion?.assignRole).toBeUndefined(); // not a chat/lane model — no fitness role applies
		expect(normalizeModelSource(suggestion?.pullRef ?? "")).toEqual({
			type: "needle",
			ref: "hf.co/Cactus-Compute/needle",
		});
	});

	it("every shaped assignRole is a role the post-probe selector can actually pre-select (not dead data)", () => {
		// The suggestion flow feeds assignRole into FitnessRoleSelectorComponent as the pre-selected
		// role; a value the selector doesn't offer would silently fall back to the default, quietly
		// dropping the whole point of the shaped role. Keep the roster and the selector in lockstep.
		for (const suggestion of DEFAULT_MODEL_SUGGESTIONS) {
			if (suggestion.assignRole !== undefined) {
				expect(FITNESS_ROLE_ORDER, `${suggestion.name} → ${suggestion.assignRole}`).toContain(
					suggestion.assignRole,
				);
			}
		}
	});

	it("renders a bounded roster naming each model, its role, and its add command", () => {
		const text = formatModelSuggestions().join("\n");
		expect(text).toContain("qwen3:1.7b → Toolkit executor");
		expect(text).toContain("FastContext-1.0-4B → Repository scout");
		expect(text).toContain("Ornith-1.0-9B → Agentic-coding worker");
		expect(text).toContain("MiniCPM5-1B (full-base) → Full-base Transformers executor");
		expect(text).toContain("/models add hf.co/openbmb/MiniCPM5-1B");
		expect(text).toContain("/models add hf.co/prism-ml/Bonsai-4B-gguf:Q1_0");
		expect(text).toContain("/models add hf.co/prism-ml/Bonsai-27B-gguf:Q1_0");
		expect(text).toContain("Bonsai-27B (1-bit + vision)");
		expect(text).toContain("/models add hf.co/prism-ml/Ternary-Bonsai-4B-gguf");
		expect(text).toContain("/models add hf.co/Cactus-Compute/needle");
		expect(text).toContain("needle (function-call tester, 26M)");
		expect(text).toContain("[no tool-calling]");
		expect(text).toContain("probe on YOUR hardware with /fitness");
	});
});
