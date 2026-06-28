import type { ResourceProfileKind, ResourceProfileSettings } from "./settings-manager.ts";

const RESOURCE_PROFILE_KINDS: ResourceProfileKind[] = ["extensions", "skills", "prompts", "themes", "agents", "tools"];

function stringListsEqual(a: string[] | undefined, b: string[] | undefined): boolean {
	if ((a?.length ?? 0) !== (b?.length ?? 0)) return false;
	const aValues = a ?? [];
	const bValues = b ?? [];
	return aValues.every((value, index) => value === bValues[index]);
}

export function resourceProfileKindFilterEqual(
	a: ResourceProfileSettings[ResourceProfileKind] | undefined,
	b: ResourceProfileSettings[ResourceProfileKind] | undefined,
): boolean {
	return stringListsEqual(a?.allow, b?.allow) && stringListsEqual(a?.block, b?.block);
}

export function resourceProfileSettingsEqual(a: ResourceProfileSettings, b: ResourceProfileSettings): boolean {
	return RESOURCE_PROFILE_KINDS.every((kind) => resourceProfileKindFilterEqual(a[kind], b[kind]));
}

export function resourceProfileSettingsChangedKinds(
	a: ResourceProfileSettings,
	b: ResourceProfileSettings,
): Set<ResourceProfileKind> {
	return new Set(RESOURCE_PROFILE_KINDS.filter((kind) => !resourceProfileKindFilterEqual(a[kind], b[kind])));
}
