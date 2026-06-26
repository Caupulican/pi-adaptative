import { Container, type SelectItem, SelectList, type SelectListLayoutOptions, Text } from "@caupulican/pi-tui";
import type { NormalizedProfile } from "../../../core/profile-registry.ts";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const PROFILE_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

function profileSourceLabel(profile: NormalizedProfile): string {
	switch (profile.source) {
		case "global-settings":
			return "global settings";
		case "project-settings":
			return "project settings";
		case "directory-overlay":
			return "directory overlay";
		case "profile-file":
			return "profile file";
		case "inline":
			return "runtime";
		case "embedded":
			return "embedded";
		case "bundle":
			return "bundle";
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

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", theme.bold("Profiles")), 1, 0));

		const active = new Set(activeProfileNames);
		const items: SelectItem[] = [
			{
				value: "(none)",
				label: "(none)",
				description: active.size === 0 ? "active" : "Use configured profile selection (session default)",
			},
			...profiles.map((profile) => ({
				value: profile.name,
				label: profile.name,
				description: [
					active.has(profile.name) ? "active" : undefined,
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
				label: "No profiles found",
				description: "Create profiles under ~/.pi/agent/profiles/ or settings.resourceProfiles",
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
