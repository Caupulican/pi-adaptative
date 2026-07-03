import { setKeybindings } from "@caupulican/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	FITNESS_ROLE_ORDER,
	FitnessRoleSelectorComponent,
} from "../src/modes/interactive/components/fitness-role-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("FitnessRoleSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("defaults to the first role when no role is pre-selected", () => {
		const onSelect = vi.fn();
		const selector = new FitnessRoleSelectorComponent("ollama/qwen3:1.7b", onSelect, () => {});
		selector.handleInput("\n");
		expect(onSelect).toHaveBeenCalledWith(FITNESS_ROLE_ORDER[0]);
	});

	it("pre-selects a suggestion's shaped role so one keypress confirms it", () => {
		// The whole point of the suggestion flow: a model shaped as the routing judge lands on
		// "judge" already highlighted, not on the index-0 default — Enter confirms without navigation.
		const onSelect = vi.fn();
		const selector = new FitnessRoleSelectorComponent("ollama/some-judge", onSelect, () => {}, "judge");
		selector.handleInput("\n");
		expect(onSelect).toHaveBeenCalledWith("judge");
	});

	it("ignores an unknown pre-selected role and falls back to the default", () => {
		const onSelect = vi.fn();
		const selector = new FitnessRoleSelectorComponent("ollama/x", onSelect, () => {}, "not-a-role" as never);
		selector.handleInput("\n");
		expect(onSelect).toHaveBeenCalledWith(FITNESS_ROLE_ORDER[0]);
	});
});
