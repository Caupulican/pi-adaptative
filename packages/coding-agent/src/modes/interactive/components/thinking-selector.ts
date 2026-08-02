import type { ThinkingLevel } from "@caupulican/pi-agent-core";
import type { SelectItem } from "@caupulican/pi-tui";
import { BorderedSelectListComponent } from "./selector-list.ts";

const LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Maximum reasoning (~32k tokens)",
	max: "Maximum reasoning depth for the hardest problems",
	ultra: "Maximum reasoning with reinforced proactive delegation",
};

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
			description: LEVEL_DESCRIPTIONS[level],
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
