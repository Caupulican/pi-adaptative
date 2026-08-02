import type { SelectItem } from "@caupulican/pi-tui";
import { getAvailableThemes } from "../theme/theme.ts";
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
			description: name === currentTheme ? "(current)" : undefined,
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
