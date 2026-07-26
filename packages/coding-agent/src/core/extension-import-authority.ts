import type { SettingsManager } from "./settings-manager.ts";

export type ExtensionImportAuthority = "explicit" | "profile";

export function hasProfileExtensionImportAuthority(settingsManager: SettingsManager): boolean {
	return settingsManager.getActiveResourceProfileNames().length > 0;
}

/** Single import-boundary policy shared by startup discovery, reconciliation, and live loading. */
export function isExtensionPathAllowedForImport(
	settingsManager: SettingsManager,
	extensionPath: string,
	authority: ExtensionImportAuthority,
	baseDir = "",
): boolean {
	if (authority === "profile" && !hasProfileExtensionImportAuthority(settingsManager)) return false;
	return settingsManager.isResourceAllowedByProfile("extensions", extensionPath, baseDir);
}
