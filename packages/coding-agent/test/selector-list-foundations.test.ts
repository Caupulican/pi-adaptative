import { Container, setKeybindings } from "@caupulican/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { replaceResourceFilterPattern } from "../src/modes/interactive/components/config-selector.ts";
import {
	advanceSelectorIndex,
	BorderedSelectListComponent,
	getCenteredVisibleRange,
	getSelectorScrollText,
	SearchableListSurface,
	SelectorListState,
	SelectorNavigationFooter,
} from "../src/modes/interactive/components/selector-list.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("selector list foundations", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("computes a bounded centered window without scanning items", () => {
		expect(getCenteredVisibleRange(2, 20, 8)).toEqual({ startIndex: 0, endIndex: 8 });
		expect(getCenteredVisibleRange(10, 20, 8)).toEqual({ startIndex: 6, endIndex: 14 });
		expect(getCenteredVisibleRange(19, 20, 8)).toEqual({ startIndex: 12, endIndex: 20 });
		expect(getCenteredVisibleRange(0, 0, 8)).toEqual({ startIndex: 0, endIndex: 0 });
	});

	it("supports wrap and clamp navigation with an empty-list negative control", () => {
		expect(advanceSelectorIndex(0, 3, -1, "wrap")).toBe(2);
		expect(advanceSelectorIndex(2, 3, 1, "wrap")).toBe(0);
		expect(advanceSelectorIndex(0, 3, -1, "clamp")).toBe(0);
		expect(advanceSelectorIndex(2, 3, 1, "clamp")).toBe(2);
		expect(advanceSelectorIndex(7, 0, 1, "wrap")).toBe(0);
	});

	it("only projects scroll text for a partial window", () => {
		expect(getSelectorScrollText(5, 20, { startIndex: 2, endIndex: 10 })).toBe("  (6/20)");
		expect(getSelectorScrollText(0, 3, { startIndex: 0, endIndex: 3 })).toBeUndefined();
	});

	it("keeps filtering, clamping, and navigation in one bounded state owner", () => {
		const onNavigation = vi.fn();
		const state = new SelectorListState<string>(onNavigation);
		state.selectedIndex = 9;
		state.refresh(["alpha", "beta", "gamma"], "ga", (item) => item);

		expect(state.items).toEqual(["gamma"]);
		expect(state.selectedIndex).toBe(0);
		expect(state.navigateInput("\x1b[B", "wrap")).toBe(true);
		expect(state.selectedIndex).toBe(0);
		expect(state.navigateInput("x", "wrap")).toBeUndefined();
		expect(state.handleNavigation("\x1b[B", "wrap")).toBe(true);
		expect(onNavigation).toHaveBeenCalledOnce();
		expect(state.handleNavigation("x", "wrap")).toBe(false);

		state.refresh([], "", (item) => item);
		expect(state.navigateInput("\x1b[A", "wrap")).toBe(false);
		expect(state.handleNavigation("\x1b[A", "wrap")).toBe(true);
		expect(onNavigation).toHaveBeenCalledOnce();
	});

	it("does not format or copy large item text when no filter is active", () => {
		const state = new SelectorListState<{ text: string }>();
		const items = [{ text: "x".repeat(2 * 1024 * 1024) }];
		const getText = vi.fn((item: { text: string }) => item.text);

		state.refresh(items, "", getText);

		expect(state.items).toBe(items);
		expect(getText).not.toHaveBeenCalled();
	});

	it("propagates focus through the searchable list surface", () => {
		const parent = new Container();
		const surface = SearchableListSurface.mount(parent, "needle");
		surface.focused = true;

		expect(parent.children).toContain(surface);
		expect(surface.focused).toBe(true);
		expect(surface.searchInput.focused).toBe(true);
		expect(surface.searchInput.getValue()).toBe("needle");
	});

	it("owns bordered select-list selection and callbacks", () => {
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const onSelectionChange = vi.fn();
		const selector = new BorderedSelectListComponent({
			items: [
				{ value: "one", label: "One" },
				{ value: "two", label: "Two" },
			],
			maxVisible: 2,
			currentValue: "two",
			onSelect,
			onCancel,
			onSelectionChange,
		});

		selector.getSelectList().handleInput("\r");
		selector.getSelectList().handleInput("\x1b[A");
		selector.getSelectList().handleInput("\x1b");

		expect(onSelect).toHaveBeenCalledWith("two");
		expect(onSelectionChange).toHaveBeenCalledWith("one");
		expect(onCancel).toHaveBeenCalledOnce();
		expect(stripAnsi(selector.render(80).join("\n"))).toContain("→ One");
	});

	it("keeps empty bordered selectors inert", () => {
		const onSelect = vi.fn();
		const selector = new BorderedSelectListComponent({
			items: [],
			maxVisible: 5,
			onSelect,
			onCancel: vi.fn(),
		});

		selector.handleInput("\r");

		expect(onSelect).not.toHaveBeenCalled();
		expect(stripAnsi(selector.render(80).join("\n"))).toContain("No matching commands");
	});

	it("renders one configurable navigation footer owner", () => {
		const output = stripAnsi(new SelectorNavigationFooter("save").render(80).join("\n"));
		expect(output).toContain("navigate");
		expect(output).toContain("save");
		expect(output).toContain("cancel");
	});
});

describe("resource filter pattern ownership", () => {
	it("replaces either marker in one pass and retains unrelated order", () => {
		const original = ["+a", "!target", "target", "-b"];
		expect(replaceResourceFilterPattern(original, "target", true)).toEqual(["+a", "-b", "+target"]);
		expect(original).toEqual(["+a", "!target", "target", "-b"]);
		expect(replaceResourceFilterPattern(["target", "+a"], "target", false)).toEqual(["+a", "-target"]);
	});
});
