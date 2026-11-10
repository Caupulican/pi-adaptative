/**
 * The thinking-level picker that follows a router role: one entry per level the routed model supports, plus the entry
 * that leaves the tier on the session's own default. The levels are identifiers and their descriptions come from the
 * catalogue.
 */

import { Container, type SelectItem, SelectList, type SelectListLayoutOptions } from "@caupulican/pi-tui";
import { interfaceText } from "../../../core/language/interface-text.ts";
import type { ThinkingLevel } from "../../../kernel/index.ts";
import { getSelectListTheme } from "../../../presentation/theme-model.ts";
import { THINKING_LEVEL_DESCRIPTIONS } from "../thinking-level-descriptions.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

/** The value that means "inherit the session's level for this tier"; never a thinking level of its own. */
export const MODEL_ROUTER_THINKING_INHERIT_VALUE = "__inherit_model_router_thinking__";

export type RouterThinkingLevel = ThinkingLevel | typeof MODEL_ROUTER_THINKING_INHERIT_VALUE;

export class ModelRouterThinkingSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(
		currentLevel: RouterThinkingLevel,
		availableLevels: ThinkingLevel[],
		onSelect: (level: RouterThinkingLevel) => void,
		onCancel: () => void,
	) {
		super();

		const words = interfaceText().localModels.models;
		const thinkingOptions: SelectItem[] = [
			{
				value: MODEL_ROUTER_THINKING_INHERIT_VALUE,
				label: words.thinkingInheritLabel,
				description: words.thinkingInheritDescription,
			},
			...availableLevels.map((level) => ({
				value: level,
				label: level,
				description: THINKING_LEVEL_DESCRIPTIONS[level],
			})),
		];

		this.addChild(new DynamicBorder());

		this.selectList = new SelectList(
			thinkingOptions,
			thinkingOptions.length,
			getSelectListTheme(),
			SELECT_LIST_LAYOUT,
		);

		const index = thinkingOptions.findIndex((item) => item.value === currentLevel);
		if (index !== -1) {
			this.selectList.setSelectedIndex(index);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value as RouterThinkingLevel);
		};
		this.selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.selectList);
		this.addChild(new DynamicBorder());
	}
}
