import { Container, type SelectItem, SelectList, type SelectListLayoutOptions, Text } from "@caupulican/pi-tui";
import type { ModelSuggestion } from "../../../core/models/default-model-suggestions.ts";
import { getSelectListTheme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const MODEL_SUGGESTION_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 22,
	maxPrimaryColumnWidth: 40,
};

/**
 * Picker over the validated local-model roster: the user chooses a suggestion instead of retyping
 * a ref, and the caller then installs it, probes it on THIS host, and lands its shaped role
 * pre-selected. Non-tool-callers are marked so the executor role reads as the footgun it is.
 */
export class ModelSuggestionSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(
		suggestions: readonly ModelSuggestion[],
		onSelect: (suggestion: ModelSuggestion) => void,
		onCancel: () => void,
	) {
		super();

		const items: SelectItem[] = suggestions.map((suggestion, index) => ({
			value: String(index),
			label: `${suggestion.name}${suggestion.toolCalling ? "" : "  [no tool-calling]"}`,
			// Surface the note (quant/RAM caveats) here so a caveat is seen BEFORE the pull, not as a
			// confusing failure after picking.
			description: `${suggestion.role} — ${suggestion.rationale}${suggestion.note ? `  (note: ${suggestion.note})` : ""}`,
		}));

		this.addChild(new DynamicBorder());
		this.addChild(new Text("Pick a validated local model to install and set up (probed on your hardware):", 1, 0));
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
