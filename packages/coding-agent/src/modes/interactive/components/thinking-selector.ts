import type { ThinkingLevel } from "@caupulican/pi-agent-core";
import {
	Container,
	type Focusable,
	getKeybindings,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
} from "@caupulican/pi-tui";
import { getSelectListTheme } from "../theme/theme.ts";
import { THINKING_LEVEL_DESCRIPTIONS } from "../thinking-level-descriptions.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { formatSelectorActionHints } from "./keybinding-hints.ts";

/**
 * Component that renders a thinking level selector with borders and default-setting support
 */
export class ThinkingSelectorComponent extends Container implements Focusable {
	private selectList: SelectList;
	private onSelectAsDefaultCallback?: (level: ThinkingLevel) => void;
	focused: boolean = false;

	getSelectList(): SelectList {
		return this.selectList;
	}

	constructor(
		currentLevel: ThinkingLevel,
		availableLevels: ThinkingLevel[],
		onSelect: (level: ThinkingLevel) => void,
		onCancel: () => void,
		onSelectAsDefault?: (level: ThinkingLevel) => void,
	) {
		super();
		this.onSelectAsDefaultCallback = onSelectAsDefault;
		const items: SelectItem[] = availableLevels.map((level) => ({
			value: level,
			label: level,
			description: THINKING_LEVEL_DESCRIPTIONS[level],
		}));

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.selectList = new SelectList(items, items.length, getSelectListTheme());
		const selectedIndex = items.findIndex((item) => item.value === currentLevel);
		if (selectedIndex !== -1) this.selectList.setSelectedIndex(selectedIndex);
		this.selectList.onSelect = (item) => onSelect(item.value as ThinkingLevel);
		this.selectList.onCancel = onCancel;
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(formatSelectorActionHints(Boolean(onSelectAsDefault)), 1, 0));
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.onSelectAsDefaultCallback && kb.matches(data, "app.models.save")) {
			const selectedItem = this.selectList.getSelectedItem();
			if (selectedItem) {
				this.onSelectAsDefaultCallback(selectedItem.value as ThinkingLevel);
				return;
			}
		}
		this.selectList.handleInput(data);
	}
}
