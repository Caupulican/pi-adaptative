import type { SelectItem } from "@caupulican/pi-tui";
import { interfaceText } from "../../../core/language/interface-text.ts";
import { getAvailableThemes } from "../../../presentation/theme/theme.ts";
import { BorderedSelectListComponent } from "./selector-list.ts";

/**
 * Component that renders a theme selector
 */
export class ThemeSelectorComponent extends BorderedSelectListComponent {
	constructor(
		currentTheme: string,
		onSelect: (themeName: string) => void,
		onCancel: () => void,
		onPreview: (themeName: string) => void,
	) {
		const themes = getAvailableThemes();
		const themeItems: SelectItem[] = themes.map((name) => ({
			value: name,
			label: name,
			description: name === currentTheme ? interfaceText().settingsScreen.dialogs.themeCurrent : undefined,
		}));
		super({
			items: themeItems,
			maxVisible: 10,
			currentValue: currentTheme,
			onSelect,
			onCancel,
			onSelectionChange: onPreview,
		});
	}
}
