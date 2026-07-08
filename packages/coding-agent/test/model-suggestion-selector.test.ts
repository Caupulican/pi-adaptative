import { setKeybindings } from "@caupulican/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { DEFAULT_MODEL_SUGGESTIONS } from "../src/core/models/default-model-suggestions.ts";
import { ModelSuggestionSelectorComponent } from "../src/modes/interactive/components/model-suggestion-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("ModelSuggestionSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("lists every suggestion by name and marks the non-tool-callers", () => {
		const selector = new ModelSuggestionSelectorComponent(
			DEFAULT_MODEL_SUGGESTIONS,
			() => {},
			() => {},
		);
		const renderedPages: string[] = [];
		for (let index = 0; index < DEFAULT_MODEL_SUGGESTIONS.length; index++) {
			renderedPages.push(stripAnsi(selector.render(120).join("\n")));
			selector.handleInput("\x1b[B");
		}
		const output = renderedPages.join("\n");

		for (const suggestion of DEFAULT_MODEL_SUGGESTIONS) {
			expect(output).toContain(suggestion.name);
		}
		// The Bonsai models cannot call tools; the picker must say so where an executor role is a footgun.
		expect(output).toContain("no tool-calling");
		expect(output).toContain("FastContext-1.0-4B");
		expect(output).toContain("Repository scout");
		expect(output).toContain("Ornith-1.0-9B");
		expect(output).toContain("Agentic-coding worker");
		expect(output).toContain("Bonsai-4B (GGUF Q1_0)");
	});

	it("selecting an entry returns the whole suggestion (ref + shaped role), not just a string", () => {
		const onSelect = vi.fn();
		const selector = new ModelSuggestionSelectorComponent(DEFAULT_MODEL_SUGGESTIONS, onSelect, () => {});
		selector.handleInput("\n");
		expect(onSelect).toHaveBeenCalledWith(DEFAULT_MODEL_SUGGESTIONS[0]);
	});

	it("invokes onCancel on escape", () => {
		const onCancel = vi.fn();
		const selector = new ModelSuggestionSelectorComponent(DEFAULT_MODEL_SUGGESTIONS, () => {}, onCancel);
		selector.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalled();
	});
});
