import { Container, type SelectItem, SelectList, type SelectListLayoutOptions, Text } from "@caupulican/pi-tui";
import { getSelectListTheme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const FITNESS_ROLE_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 18,
	maxPrimaryColumnWidth: 34,
};

/** Roles a freshly probed model can be assigned to, mapped to their settings by the caller. */
export type FitnessRole =
	| "curator"
	| "executor"
	| "router-cheap"
	| "router-medium"
	| "router-expensive"
	| "judge"
	| "learning"
	| "none";

/**
 * Post-probe role assignment: after /fitness measures a model, this selector turns the result
 * into configuration in one step instead of sending the user to hand-edit settings JSON.
 */
export class FitnessRoleSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(modelRef: string, onSelect: (role: FitnessRole) => void, onCancel: () => void) {
		super();

		const items: SelectItem[] = [
			{
				value: "curator",
				label: "Context curator",
				description: "Local brain: digests GC-packed stubs, scores stale-chunk relevance (enables curation)",
			},
			{
				value: "executor",
				label: "Toolkit executor",
				description:
					"Owns direct toolkit commands end-to-end (Level-0 exact hits route here; needs tool-call fitness)",
			},
			{
				value: "router-cheap",
				label: "Router: cheap tier",
				description: "Handles trivial/read-only routed turns (model router settings)",
			},
			{
				value: "router-medium",
				label: "Router: medium tier",
				description: "Handles normal implementation turns (model router settings)",
			},
			{
				value: "router-expensive",
				label: "Router: expensive tier",
				description: "Handles high-impact/architecture turns (model router settings)",
			},
			{
				value: "judge",
				label: "Routing judge",
				description: "Routing-only tier verdicts; needs strong instruction following",
			},
			{
				value: "learning",
				label: "Learning / reflection",
				description: "Background reflection and learning passes",
			},
			{
				value: "none",
				label: "No role for now",
				description: "Keep the result in the fitness store only (assign later from /settings)",
			},
		];

		this.addChild(new DynamicBorder());
		this.addChild(new Text(`Assign a role for ${modelRef}:`, 1, 0));
		this.selectList = new SelectList(items, 8, getSelectListTheme(), FITNESS_ROLE_SELECT_LIST_LAYOUT);
		this.selectList.onSelect = (item) => onSelect(item.value as FitnessRole);
		this.selectList.onCancel = () => onCancel();
		this.addChild(this.selectList);
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}
