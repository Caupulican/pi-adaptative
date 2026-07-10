import { setKeybindings } from "@caupulican/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("thinking selector", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("labels and selects max and ultra levels", () => {
		const onSelect = vi.fn();
		const selector = new ThinkingSelectorComponent("xhigh", ["xhigh", "max", "ultra"], onSelect, vi.fn());
		const output = selector.render(180).join("\n");

		expect(output).toContain("Maximum reasoning depth for the hardest problems");
		expect(output).toContain("Maximum reasoning with reinforced proactive delegation");

		selector.getSelectList().handleInput("\x1b[A");
		selector.getSelectList().handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith("ultra");
	});
});
