import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_SUGGESTIONS, formatModelSuggestions } from "../src/core/models/default-model-suggestions.ts";
import { normalizeModelSource } from "../src/core/models/model-ref.ts";
import { FITNESS_ROLE_ORDER } from "../src/modes/interactive/components/fitness-role-selector.ts";

describe("default model suggestions", () => {
	it("every suggested pullRef normalizes to a usable local source (/models add accepts it)", () => {
		for (const suggestion of DEFAULT_MODEL_SUGGESTIONS) {
			const source = normalizeModelSource(suggestion.pullRef);
			expect(source.type, `${suggestion.name}: ${suggestion.pullRef}`).toBe("local");
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
		expect(DEFAULT_MODEL_SUGGESTIONS.some((s) => s.name.includes("Bonsai-4B") && s.assignRole === "curator")).toBe(
			true,
		);
	});

	it("Ternary-Bonsai models are marked as non-tool-calling (lane/brain only, never executor)", () => {
		for (const suggestion of DEFAULT_MODEL_SUGGESTIONS.filter((s) => s.name.includes("Bonsai"))) {
			expect(suggestion.toolCalling).toBe(false);
			expect(suggestion.assignRole).not.toBe("executor");
		}
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
		expect(text).toContain("/models add hf.co/prism-ml/Ternary-Bonsai-4B-gguf");
		expect(text).toContain("[no tool-calling]");
		expect(text).toContain("probe on YOUR hardware with /fitness");
	});
});
