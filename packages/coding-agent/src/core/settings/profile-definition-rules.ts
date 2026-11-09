/**
 * Stored resource-profile definitions: profile name validation, the sanitized resource filter, and the edits that write
 * a profile into a settings layer (encode, decode, rename and the active-profile selection). Each function is pure over
 * the settings object it is given; the manager chooses the scope and persists the result.
 */

import { validateSkillName } from "../skills.ts";
import { normalizeResourceProfileNames } from "./settings-rules.ts";
import type { ProfileDefinitionInput, ResourceProfileSettings, Settings } from "./settings-schema.ts";

export function normalizeProfileName(profileName: string): string {
	const trimmed = profileName.trim();
	if (!trimmed) {
		throw new Error("Profile name is required");
	}
	const errors = validateSkillName(trimmed);
	if (errors.length > 0) {
		throw new Error(`Invalid profile name "${trimmed}": ${errors.join(", ")}`);
	}
	return trimmed;
}

export function normalizeProfileSelection(profileName: string): string {
	const trimmed = profileName.trim();
	if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
		return trimmed;
	}
	return normalizeProfileName(trimmed);
}

export function sanitizeProfileResources(resources: ResourceProfileSettings): ResourceProfileSettings {
	const result: ResourceProfileSettings = {};
	for (const kind of ["extensions", "skills", "prompts", "themes", "agents", "tools"] as const) {
		const filter = resources[kind];
		if (!filter) {
			continue;
		}
		result[kind] = {
			allow: filter.allow ? [...filter.allow] : undefined,
			block: filter.block ? [...filter.block] : undefined,
		};
	}
	return result;
}

export function decodeStoredProfileDefinition(
	name: string,
	stored: ResourceProfileSettings | ProfileDefinitionInput | undefined,
): ProfileDefinitionInput {
	if (stored && Object.hasOwn(stored, "resources")) {
		const definition = stored as ProfileDefinitionInput;
		return { ...definition, name, resources: sanitizeProfileResources(definition.resources) };
	}
	return {
		name,
		resources: sanitizeProfileResources((stored as ResourceProfileSettings | undefined) ?? {}),
	};
}

export function mergeProfileDefinition(
	name: string,
	definition: ProfileDefinitionInput,
	resources: ResourceProfileSettings,
	existing?: ResourceProfileSettings | ProfileDefinitionInput,
): ProfileDefinitionInput {
	const previous = decodeStoredProfileDefinition(name, existing);
	return {
		...previous,
		name,
		resources,
		description: definition.description ?? previous.description,
		model: Object.hasOwn(definition, "model") ? definition.model : previous.model,
		thinking: definition.thinking ?? previous.thinking,
		modelRouter: definition.modelRouter ?? previous.modelRouter,
		soul: definition.soul ?? previous.soul,
	};
}

export function encodeStoredProfileDefinition(
	definition: ProfileDefinitionInput,
): ResourceProfileSettings | ProfileDefinitionInput | undefined {
	const hasMetadata = Boolean(
		definition.description || definition.model || definition.thinking || definition.modelRouter || definition.soul,
	);
	if (hasMetadata) return definition;
	return Object.keys(definition.resources).length > 0 ? definition.resources : undefined;
}

export function updateStoredProfileDefinition(
	settings: Settings,
	name: string,
	definition: ProfileDefinitionInput,
	resources: ResourceProfileSettings,
): void {
	const definitions = { ...(settings.resourceProfiles ?? {}) };
	const stored = encodeStoredProfileDefinition(mergeProfileDefinition(name, definition, resources, definitions[name]));
	if (stored) definitions[name] = stored;
	else delete definitions[name];
	if (Object.keys(definitions).length > 0) settings.resourceProfiles = definitions;
	else delete settings.resourceProfiles;
}

export function renameStoredProfileDefinition(settings: Settings, oldName: string, newName: string): void {
	const definitions = { ...(settings.resourceProfiles ?? {}) };
	if (!definitions[oldName]) throw new Error(`Profile not found: ${oldName}`);
	if (definitions[newName]) throw new Error(`Profile already exists: ${newName}`);
	definitions[newName] = definitions[oldName];
	delete definitions[oldName];
	settings.resourceProfiles = definitions;
	if (settings.activeResourceProfile === oldName) settings.activeResourceProfile = newName;
	if (settings.activeResourceProfiles) {
		settings.activeResourceProfiles = settings.activeResourceProfiles.map((name) =>
			name === oldName ? newName : name,
		);
	}
}

export function setActiveProfileInSettings(settings: Settings, profileName: string | undefined): void {
	if (profileName) {
		settings.activeResourceProfile = profileName;
		settings.activeResourceProfiles = [profileName];
		return;
	}
	settings.activeResourceProfiles = [];
	delete settings.activeResourceProfile;
}

export function rewriteActiveProfileReference(
	settings: Settings,
	oldName: string,
	newName: string | undefined,
): boolean {
	let changed = false;
	const rewrite = (values: string[]): string[] => {
		const next = values.flatMap((value) => {
			if (value !== oldName) return [value];
			changed = true;
			return newName ? [newName] : [];
		});
		return [...new Set(next)];
	};

	if (settings.activeResourceProfiles !== undefined) {
		const next = rewrite(normalizeResourceProfileNames(settings.activeResourceProfiles));
		if (next.length > 0) settings.activeResourceProfiles = next;
		else delete settings.activeResourceProfiles;
	}
	if (settings.activeResourceProfile !== undefined) {
		const next = rewrite(normalizeResourceProfileNames(settings.activeResourceProfile));
		if (next.length === 0) delete settings.activeResourceProfile;
		else
			settings.activeResourceProfile =
				Array.isArray(settings.activeResourceProfile) || next.length > 1 ? next : next[0];
	}
	return changed;
}
