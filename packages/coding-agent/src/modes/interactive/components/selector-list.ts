import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Spacer,
	Text,
} from "@caupulican/pi-tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export const COMPACT_SELECTOR_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

export interface SelectorVisibleRange {
	startIndex: number;
	endIndex: number;
}

type SelectorKeybindings = ReturnType<typeof getKeybindings>;

export function getCenteredVisibleRange(
	selectedIndex: number,
	itemCount: number,
	maxVisible: number,
): SelectorVisibleRange {
	const boundedCount = Math.max(0, itemCount);
	const boundedVisible = Math.max(0, maxVisible);
	if (boundedCount === 0 || boundedVisible === 0) return { startIndex: 0, endIndex: 0 };

	const boundedIndex = Math.max(0, Math.min(selectedIndex, boundedCount - 1));
	const startIndex = Math.max(
		0,
		Math.min(boundedIndex - Math.floor(boundedVisible / 2), boundedCount - boundedVisible),
	);
	return {
		startIndex,
		endIndex: Math.min(startIndex + boundedVisible, boundedCount),
	};
}

export function advanceSelectorIndex(
	selectedIndex: number,
	itemCount: number,
	direction: -1 | 1,
	mode: "wrap" | "clamp",
): number {
	if (itemCount <= 0) return 0;
	const boundedIndex = Math.max(0, Math.min(selectedIndex, itemCount - 1));
	if (mode === "wrap") return (boundedIndex + direction + itemCount) % itemCount;
	return Math.max(0, Math.min(boundedIndex + direction, itemCount - 1));
}

export function clampSelectorIndex(selectedIndex: number, itemCount: number): number {
	return itemCount <= 0 ? 0 : Math.max(0, Math.min(selectedIndex, itemCount - 1));
}

export function filterSelectorItems<T>(items: T[], query: string, getText: (item: T) => string): T[] {
	return query ? fuzzyFilter(items, query, getText) : items;
}

export function getSelectorScrollText(
	selectedIndex: number,
	itemCount: number,
	range: SelectorVisibleRange,
): string | undefined {
	return range.startIndex > 0 || range.endIndex < itemCount ? `  (${selectedIndex + 1}/${itemCount})` : undefined;
}

export function clearSelectorSearchOrCancel(input: Input, onClear: () => void, onCancel: () => void): void {
	if (input.getValue()) {
		input.setValue("");
		onClear();
		return;
	}
	onCancel();
}

export class SelectorListState<T> {
	items: T[] = [];
	selectedIndex = 0;
	private readonly onNavigation: (() => void) | undefined;

	constructor(onNavigation?: () => void) {
		this.onNavigation = onNavigation;
	}

	refresh(items: T[], query: string, getText: (item: T) => string): void {
		this.items = filterSelectorItems(items, query, getText);
		this.selectedIndex = clampSelectorIndex(this.selectedIndex, this.items.length);
	}

	navigateInput(
		data: string,
		mode: "wrap" | "clamp",
		keybindings: SelectorKeybindings = getKeybindings(),
	): boolean | undefined {
		const direction = keybindings.matches(data, "tui.select.up")
			? -1
			: keybindings.matches(data, "tui.select.down")
				? 1
				: undefined;
		if (direction === undefined) return undefined;
		if (this.items.length === 0) return false;
		this.selectedIndex = advanceSelectorIndex(this.selectedIndex, this.items.length, direction, mode);
		return true;
	}

	handleNavigation(data: string, mode: "wrap" | "clamp", keybindings?: SelectorKeybindings): boolean {
		const navigation = this.navigateInput(data, mode, keybindings);
		if (navigation === undefined) return false;
		if (navigation) this.onNavigation?.();
		return true;
	}

	visitVisible(maxVisible: number, visit: (item: T, index: number, selected: boolean) => void): SelectorVisibleRange {
		const range = getCenteredVisibleRange(this.selectedIndex, this.items.length, maxVisible);
		for (let index = range.startIndex; index < range.endIndex; index++) {
			visit(this.items[index]!, index, index === this.selectedIndex);
		}
		return range;
	}

	getScrollText(range: SelectorVisibleRange): string | undefined {
		return getSelectorScrollText(this.selectedIndex, this.items.length, range);
	}

	appendScrollInfo(container: Container, range: SelectorVisibleRange): void {
		const scrollText = this.getScrollText(range);
		if (scrollText) container.addChild(new Text(theme.fg("muted", scrollText), 0, 0));
	}
}

export function formatDirtySelectorFooter(parts: string[], dirty: boolean): string {
	const text = parts.join(" · ");
	return dirty ? theme.fg("dim", `  ${text} `) + theme.fg("warning", "(unsaved)") : theme.fg("dim", `  ${text}`);
}

export class SearchableListSurface extends Container implements Focusable {
	readonly searchInput: Input;
	readonly listContainer: Container;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	static mount(parent: Container, initialValue?: string): SearchableListSurface {
		const surface = new SearchableListSurface(initialValue);
		parent.addChild(surface);
		return surface;
	}

	constructor(initialValue?: string) {
		super();
		this.searchInput = new Input();
		if (initialValue) this.searchInput.setValue(initialValue);
		this.listContainer = new Container();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
	}
}

export interface BorderedSelectListOptions {
	items: SelectItem[];
	maxVisible: number;
	currentValue?: string;
	initialSelectedIndex?: number;
	layout?: SelectListLayoutOptions;
	onSelect: (value: string) => void;
	onCancel: () => void;
	onSelectionChange?: (value: string) => void;
}

export class BorderedSelectListComponent extends Container {
	private readonly selectList: SelectList;

	constructor(options: BorderedSelectListOptions) {
		super();
		this.addChild(new DynamicBorder());
		this.selectList = new SelectList(
			options.items,
			options.maxVisible,
			getSelectListTheme(),
			options.layout ?? COMPACT_SELECTOR_LIST_LAYOUT,
		);
		const selectedIndex =
			options.initialSelectedIndex ??
			(options.currentValue === undefined
				? -1
				: options.items.findIndex((item) => item.value === options.currentValue));
		if (selectedIndex !== -1) this.selectList.setSelectedIndex(selectedIndex);
		this.selectList.onSelect = (item) => options.onSelect(item.value);
		this.selectList.onCancel = options.onCancel;
		const onSelectionChange = options.onSelectionChange;
		if (onSelectionChange) {
			this.selectList.onSelectionChange = (item) => onSelectionChange(item.value);
		}
		this.addChild(this.selectList);
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}

export class SelectorHeading extends Container {
	constructor(title: string, description: string) {
		super();
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}
		this.addChild(new Spacer(1));
	}
}

export class SelectorNavigationFooter extends Container {
	constructor(confirmLabel: string) {
		super();
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", confirmLabel) +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}
}

export class SelectorStatusFooter extends Container {
	readonly footerText: Text;

	constructor(initialText: string, descriptionText?: Text) {
		super();
		if (descriptionText) {
			this.addChild(new Spacer(1));
			this.addChild(descriptionText);
		}
		this.addChild(new Spacer(1));
		this.footerText = new Text(initialText, 0, 0);
		this.addChild(this.footerText);
		this.addChild(new DynamicBorder());
	}
}
