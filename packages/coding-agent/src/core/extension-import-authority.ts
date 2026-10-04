import { basename, dirname, extname } from "node:path";
import { getBundledExtensionsDir } from "../config.ts";
import { canonicalizePath } from "../utils/paths.ts";
import { isResourcePathWithin } from "./resource-traversal.ts";
import type { SettingsManager } from "./settings-manager.ts";

export type ExtensionImportAuthority = "explicit" | "profile" | "default-on";

const DEFAULT_ON_BUNDLED_EXTENSION_NAMES = new Set(["tps"]);

/**
 * The only extensions a worker-role process may import: bundled and passive (no tools, commands, providers,
 * sockets or state of their own). A worker's ceiling is enforced here, at the import boundary, by role, so a
 * new authority-bearing extension is refused for workers by default instead of needing its own guard.
 */
const WORKER_SAFE_BUNDLED_EXTENSION_NAMES = new Set(["tps"]);

function extensionName(extensionPath: string): string {
	const file = basename(extensionPath);
	if (/^index\.[cm]?[jt]sx?$/.test(file)) return basename(dirname(extensionPath));
	return basename(file, extname(file));
}

/** Passive bundled extensions that carry no tools/providers and are safe as UI defaults. */
export function isDefaultOnBundledExtension(extensionPath: string, source: string): boolean {
	return source === "bundled" && DEFAULT_ON_BUNDLED_EXTENSION_NAMES.has(extensionName(extensionPath));
}

/** True for a bundled, passive extension a worker-role process may import; every other path is refused for workers. */
export function isWorkerSafeExtensionPath(extensionPath: string): boolean {
	return (
		isResourcePathWithin(extensionPath, getBundledExtensionsDir()) &&
		WORKER_SAFE_BUNDLED_EXTENSION_NAMES.has(extensionName(extensionPath))
	);
}

/**
 * A worker-role process imports a passive bundled extension, or exactly the extension files its launch
 * profile explicitly granted a tool from (`worker-extension-grants.ts`). The grant names a file, never a
 * directory or a pattern, and a granted file loads tool-only (`extensions/tool-only-api.ts`).
 */
export function isWorkerAdmittedExtensionPath(
	extensionPath: string,
	grantedExtensionPaths: readonly string[],
): boolean {
	if (isWorkerSafeExtensionPath(extensionPath)) return true;
	if (grantedExtensionPaths.length === 0) return false;
	const canonical = canonicalizePath(extensionPath);
	return grantedExtensionPaths.some((granted) => canonicalizePath(granted) === canonical);
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
