import { basename, dirname, extname } from "node:path";
import type { SettingsManager } from "./settings-manager.ts";

export type ExtensionImportAuthority = "explicit" | "profile" | "default-on";

const DEFAULT_ON_BUNDLED_EXTENSION_NAMES = new Set(["tps"]);

function extensionName(extensionPath: string): string {
	const file = basename(extensionPath);
	if (/^index\.[cm]?[jt]sx?$/.test(file)) return basename(dirname(extensionPath));
	return basename(file, extname(file));
}

/** Passive bundled extensions that carry no tools/providers and are safe as UI defaults. */
export function isDefaultOnBundledExtension(extensionPath: string, source: string): boolean {
	return source === "bundled" && DEFAULT_ON_BUNDLED_EXTENSION_NAMES.has(extensionName(extensionPath));
}

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
	if (authority === "default-on") {
		return !settingsManager.isResourceExplicitlyDisabled("extensions", extensionPath, baseDir);
	}
	if (authority === "profile" && !hasProfileExtensionImportAuthority(settingsManager)) return false;
	return settingsManager.isResourceAllowedByProfile("extensions", extensionPath, baseDir);
}
