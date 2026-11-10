import { Container, type SelectItem, SelectList, type SelectListLayoutOptions, Text } from "@caupulican/pi-tui";
import { interfaceText } from "../../../core/language/interface-text.ts";
import type { FitnessRole } from "../../../core/models/fitness-role.ts";
import { getSelectListTheme } from "../../../presentation/theme-model.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const FITNESS_ROLE_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 18,
	maxPrimaryColumnWidth: 34,
};

/** The assignable roles in the order the selector presents them (index 0 is the default landing). */
export const FITNESS_ROLE_ORDER: readonly FitnessRole[] = [
	"curator",
	"executor",
	"scout",
	"router-cheap",
	"router-medium",
	"router-expensive",
	"learning",
	"none",
];

/**
 * Post-probe role assignment: after /fitness measures a model, this selector turns the result
 * into configuration in one step instead of sending the user to hand-edit settings JSON. When a
 * model arrives from a validated suggestion, `preselectRole` lands the shaped role already
 * highlighted so a single keypress confirms it (an unknown/absent role falls back to the default).
 */
export class FitnessRoleSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(
		modelRef: string,
		onSelect: (role: FitnessRole) => void,
		onCancel: () => void,
		preselectRole?: FitnessRole,
	) {
		super();

		this.addChild(new DynamicBorder());
		const text = interfaceText().selectors.fitnessRole;
		this.addChild(new Text(text.prompt(modelRef), 1, 0));
		const items: SelectItem[] = FITNESS_ROLE_ORDER.map((role) => ({
			value: role,
			label: text.roles[role].label,
			description: text.roles[role].description,
		}));
		this.selectList = new SelectList(items, 8, getSelectListTheme(), FITNESS_ROLE_SELECT_LIST_LAYOUT);
		this.selectList.onSelect = (item) => onSelect(item.value as FitnessRole);
		this.selectList.onCancel = () => onCancel();
		if (preselectRole) {
			const index = FITNESS_ROLE_ORDER.indexOf(preselectRole);
			if (index >= 0) this.selectList.setSelectedIndex(index);
		}
		this.addChild(this.selectList);
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}
