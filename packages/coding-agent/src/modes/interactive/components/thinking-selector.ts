import type { ThinkingLevel } from "@caupulican/pi-agent-core";
import type { SelectItem } from "@caupulican/pi-tui";
import { THINKING_LEVEL_DESCRIPTIONS } from "../thinking-level-descriptions.ts";
import { BorderedSelectListComponent } from "./selector-list.ts";

/**
 * Component that renders a thinking level selector with borders
 */
export class ThinkingSelectorComponent extends BorderedSelectListComponent {
	constructor(
		currentLevel: ThinkingLevel,
		availableLevels: ThinkingLevel[],
		onSelect: (level: ThinkingLevel) => void,
		onCancel: () => void,
	) {
		const thinkingLevels: SelectItem[] = availableLevels.map((level) => ({
			value: level,
			label: level,
			description: THINKING_LEVEL_DESCRIPTIONS[level],
		}));
		super({
			items: thinkingLevels,
			maxVisible: thinkingLevels.length,
			currentValue: currentLevel,
			onSelect: (value) => onSelect(value as ThinkingLevel),
			onCancel,
		});
	}
}
