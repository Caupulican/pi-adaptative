import { Container, type SelectItem, SelectList, type SelectListLayoutOptions, Text } from "@caupulican/pi-tui";
import { interfaceText } from "../../../core/language/interface-text.ts";
import type { ModelSuggestion } from "../../../core/models/default-model-suggestions.ts";
import { getSelectListTheme } from "../../../presentation/theme-model.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const MODEL_SUGGESTION_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 22,
	maxPrimaryColumnWidth: 40,
};

/**
 * Picker over the local-model suggestions: the user chooses a suggestion instead of retyping a
 * ref, and the caller then installs it, probes it on THIS host, and lands its candidate role
 * pre-selected. Known non-tool-callers and unverified candidates have distinct labels.
 */
export class ModelSuggestionSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(
		suggestions: readonly ModelSuggestion[],
		onSelect: (suggestion: ModelSuggestion) => void,
		onCancel: () => void,
	) {
		super();

		const text = interfaceText().selectors.modelSuggestion;
		const items: SelectItem[] = suggestions.map((suggestion, index) => ({
			value: String(index),
			label: `${suggestion.name}${
				suggestion.toolCalling === false
					? text.noToolCalling
					: suggestion.toolCalling === "unverified"
						? text.unverifiedToolCalling
						: ""
			}`,
			// Surface the note (quant/RAM caveats) here so a caveat is seen BEFORE the pull, not as a
			// confusing failure after picking.
			description: text.description(suggestion.role, suggestion.rationale, suggestion.note),
		}));

		this.addChild(new DynamicBorder());
		this.addChild(new Text(text.prompt, 1, 0));
		this.selectList = new SelectList(items, 8, getSelectListTheme(), MODEL_SUGGESTION_SELECT_LIST_LAYOUT);
		this.selectList.onSelect = (item) => {
			const suggestion = suggestions[Number(item.value)];
			if (suggestion) onSelect(suggestion);
		};
		this.selectList.onCancel = () => onCancel();
		this.addChild(this.selectList);
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}
