import { Container, type SelectItem, SelectList, type SelectListLayoutOptions, Text } from "@caupulican/pi-tui";
import { interfaceText } from "../../../core/language/interface-text.ts";
import type { NormalizedProfile } from "../../../core/profile-registry.ts";
import { getSelectListTheme, theme } from "../../../presentation/theme-model.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const PROFILE_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

/** Where a profile is read from, in the owner's words; the source's own id never reaches the screen. */
export function profileSourceLabel(profile: NormalizedProfile): string {
	const sources = interfaceText().selectors.profile.sources;
	switch (profile.source) {
		case "global-settings":
			return sources["global-settings"];
		case "project-settings":
			return sources["project-settings"];
		case "external-settings":
			return sources["external-settings"];
		case "directory-overlay":
			return sources["directory-overlay"];
		case "profile-file":
			return sources["profile-file"];
		case "inline":
			return sources.inline;
		case "embedded":
			return sources.embedded;
		case "bundle":
			return sources.bundle;
	}
}

export class ProfileSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(
		profiles: NormalizedProfile[],
		activeProfileNames: string[],
		onSelect: (profileName: string) => void,
		onCancel: () => void,
	) {
		super();

		const text = interfaceText().selectors.profile;
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", theme.bold(text.title)), 1, 0));

		const active = new Set(activeProfileNames);
		const items: SelectItem[] = [
			{
				value: "(none)",
				label: text.noneLabel,
				description: active.size === 0 ? text.active : text.useConfigured,
			},
			...profiles.map((profile) => ({
				value: profile.name,
				label: profile.name,
				description: [
					active.has(profile.name) ? text.active : undefined,
					profileSourceLabel(profile),
					profile.description,
				]
					.filter((part): part is string => Boolean(part))
					.join(" · "),
			})),
		];

		if (profiles.length === 0) {
			items.push({
				value: "",
				label: text.empty,
				description: text.emptyHint,
			});
		}

		this.selectList = new SelectList(items, 10, getSelectListTheme(), PROFILE_SELECT_LIST_LAYOUT);
		const activeIndex = items.findIndex((item) => item.value && active.has(item.value));
		const selectedIndex = activeIndex >= 0 ? activeIndex : items.length > 0 && items[0].value === "(none)" ? 0 : -1;
		if (selectedIndex >= 0) {
			this.selectList.setSelectedIndex(selectedIndex);
		}
		this.selectList.onSelect = (item) => {
			if (!item.value) return;
			onSelect(item.value);
		};
		this.selectList.onCancel = onCancel;
		this.addChild(this.selectList);
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
