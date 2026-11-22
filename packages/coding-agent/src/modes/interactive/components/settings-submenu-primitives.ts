/**
 * Shared terminal settings submenu primitives (`SelectSubmenu`, `TextInputSubmenu`, `ModelSelectionSubmenu`,
 * `SettingsListSubmenu`) reused by `/settings` and its extracted submenu modules.
 */

import {
	Container,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@caupulican/pi-tui";
import { interfaceText } from "../../../core/language/interface-text.ts";
import { DEFAULT_AUTO_LEARN_SETTINGS } from "../../../core/learning/auto-learn-settings.ts";
import { getSelectListTheme, getSettingsListTheme, theme } from "../../../presentation/theme-model.ts";
import { COMPACT_SELECTOR_LIST_LAYOUT, SelectorHeading } from "./selector-list.ts";
import { normalizeOptionalString } from "./settings-value-text.ts";

export const AUTO_LEARN_CUSTOM_MODEL_VALUE = "__custom_auto_learn_model__";

/**
 * The settings screen's words. A row stores and saves a machine value and reads the label for it here when
 * the row is drawn, so a change of language needs no restart.
 */
export function screenText() {
	return interfaceText().settingsScreen;
}

export class TextInputSubmenu extends Container {
	private input: Input;

	constructor(
		title: string,
		description: string,
		currentValue: string,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		emptyHint = screenText().hints.emptyClearsSetting,
	) {
		super();

		this.addChild(new SelectorHeading(title, description));

		this.input = new Input();
		this.input.setValue(currentValue);
		this.input.focused = true;
		this.input.onSubmit = onSubmit;
		this.input.onEscape = onCancel;
		this.addChild(this.input);

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", `  ${screenText().hints.textInput(emptyHint)}`), 0, 0));
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}
}

export class ModelSelectionSubmenu extends Container {
	private searchInput: Input;
	private selectList: SelectList;
	private customInput: TextInputSubmenu | null = null;

	constructor(
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		labels: {
			title: string;
			description: string;
			customTitle: string;
			customDescription: string;
			customEmptyHint: string;
			customEmptyValue: string | undefined;
		} = {
			title: screenText().modelPicker.autoLearn.title,
			description: screenText().modelPicker.autoLearn.description,
			customTitle: screenText().modelPicker.autoLearn.customTitle,
			customDescription: screenText().modelPicker.autoLearn.customDescription,
			customEmptyHint: screenText().modelPicker.autoLearn.customEmptyHint,
			customEmptyValue: DEFAULT_AUTO_LEARN_SETTINGS.model,
		},
	) {
		super();

		this.addChild(new SelectorHeading(labels.title, labels.description));

		this.searchInput = new Input();
		this.searchInput.focused = true;
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.selectList = new SelectList(
			options,
			Math.min(options.length, 10),
			getSelectListTheme(),
			COMPACT_SELECTOR_LIST_LAYOUT,
		);

		const currentIndex = options.findIndex((option) => option.value === currentValue);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			if (item.value === AUTO_LEARN_CUSTOM_MODEL_VALUE) {
				this.customInput = new TextInputSubmenu(
					labels.customTitle,
					labels.customDescription,
					currentValue === labels.customEmptyValue ? "" : currentValue,
					(value) => {
						onSelect(normalizeOptionalString(value) ?? labels.customEmptyValue ?? "");
					},
					() => {
						this.customInput = null;
					},
					labels.customEmptyHint,
				);
				return;
			}
			onSelect(item.value);
		};
		this.selectList.onCancel = onCancel;
		this.addChild(this.selectList);

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", `  ${screenText().hints.filterAndSelect}`), 0, 0));
	}

	handleInput(data: string): void {
		if (this.customInput) {
			this.customInput.handleInput(data);
			return;
		}

		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
			this.selectList.handleInput(data);
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.select.cancel")) {
			this.selectList.handleInput(data);
			return;
		}

		this.searchInput.handleInput(data);
		this.selectList.setFilter(this.searchInput.getValue());
	}

	render(width: number): string[] {
		return this.customInput ? this.customInput.render(width) : super.render(width);
	}

	invalidate(): void {
		super.invalidate();
		this.customInput?.invalidate?.();
	}
}

export class SettingsListSubmenu extends Container {
	private settingsList!: SettingsList;

	protected mountSettingsList(
		items: SettingItem[],
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
	): void {
		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			onChange,
			onCancel,
		);
		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

export class SelectSubmenu extends Container {
	private selectList: SelectList;

	getSelectList(): SelectList {
		return this.selectList;
	}

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void,
	) {
		super();

		this.addChild(new SelectorHeading(title, description));

		// Select list
		this.selectList = new SelectList(
			options,
			Math.min(options.length, 10),
			getSelectListTheme(),
			COMPACT_SELECTOR_LIST_LAYOUT,
		);

		// Pre-select current value
		const currentIndex = options.findIndex((o) => o.value === currentValue);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value);
		};

		this.selectList.onCancel = onCancel;

		if (onSelectionChange) {
			this.selectList.onSelectionChange = (item) => {
				onSelectionChange(item.value);
			};
		}

		this.addChild(this.selectList);

		// Hint
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", `  ${screenText().hints.select}`), 0, 0));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "app.interrupt") || kb.matches(data, "app.clear")) {
			this.selectList.onCancel?.();
			return;
		}
		this.selectList.handleInput(data);
	}
}
