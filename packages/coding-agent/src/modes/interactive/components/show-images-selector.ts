import type { SelectItem } from "@caupulican/pi-tui";
import { BorderedSelectListComponent } from "./selector-list.ts";

/**
 * Component that renders a show images selector with borders
 */
export class ShowImagesSelectorComponent extends BorderedSelectListComponent {
	constructor(currentValue: boolean, onSelect: (show: boolean) => void, onCancel: () => void) {
		const items: SelectItem[] = [
			{ value: "yes", label: "Yes", description: "Show images inline in terminal" },
			{ value: "no", label: "No", description: "Show text placeholder instead" },
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
