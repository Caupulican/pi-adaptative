import type { SelectItem } from "@caupulican/pi-tui";
import { interfaceText } from "../../../core/language/interface-text.ts";
import { BorderedSelectListComponent } from "./selector-list.ts";

/**
 * Component that renders a show images selector with borders
 */
export class ShowImagesSelectorComponent extends BorderedSelectListComponent {
	constructor(currentValue: boolean, onSelect: (show: boolean) => void, onCancel: () => void) {
		const text = interfaceText().settingsScreen;
		const items: SelectItem[] = [
			{ value: "yes", label: text.values.yes, description: text.dialogs.showImagesInline },
			{ value: "no", label: text.values.no, description: text.dialogs.showImagesPlaceholder },
		];
		super({
			items,
			maxVisible: 5,
			currentValue: currentValue ? "yes" : "no",
			onSelect: (value) => onSelect(value === "yes"),
			onCancel,
		});
	}
}
