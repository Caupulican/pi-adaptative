import type { TUI } from "@caupulican/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { ArminComponent } from "../src/modes/interactive/components/armin.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("Armin position-reveal effects", () => {
	beforeAll(() => initTheme("dark", false));

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test.each([
		["fade", 0.5],
		["dissolve", 0.99],
	])("completes the %s animation through the shared reveal owner", (_name, randomValue) => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(randomValue);
		const requestRender = vi.fn();
		const component = new ArminComponent({ requestRender } as unknown as TUI);

		vi.advanceTimersByTime(10_000);

		expect(requestRender).toHaveBeenCalled();
		expect(component.render(40)).toHaveLength(19);
		expect(component.render(40).at(-1)).toContain("ARMIN SAYS HI");
		component.dispose();
	});
});
