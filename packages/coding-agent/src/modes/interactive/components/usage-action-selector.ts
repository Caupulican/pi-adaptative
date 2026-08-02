import { Container, type SelectItem, SelectList, type SelectListLayoutOptions, Spacer, Text } from "@caupulican/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { SelectorNavigationFooter } from "./selector-list.ts";

const USAGE_ACTION_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 20,
	maxPrimaryColumnWidth: 36,
};

export interface UsageActionSelectorOptions {
	title: string;
	subtitle?: string;
	items: SelectItem[];
	initialSelectedIndex?: number;
	onSelect: (value: string) => void;
	onCancel: () => void;
}

export class UsageActionSelectorComponent extends Container {
	private readonly selectList: SelectList;

	constructor(options: UsageActionSelectorOptions) {
		super();
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(options.title)), 1, 0));
		if (options.subtitle) this.addChild(new Text(theme.fg("muted", options.subtitle), 1, 0));
		this.addChild(new Spacer(1));

		this.selectList = new SelectList(
			options.items,
			Math.min(8, Math.max(2, options.items.length)),
			{
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("muted", text),
			},
			USAGE_ACTION_LAYOUT,
		);
		this.selectList.setSelectedIndex(options.initialSelectedIndex ?? 0);
		this.selectList.onSelect = (item) => options.onSelect(item.value);
		this.selectList.onCancel = options.onCancel;
		this.addChild(this.selectList);
		this.addChild(new SelectorNavigationFooter("select"));
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
