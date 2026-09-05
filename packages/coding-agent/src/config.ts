import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { normalizePath } from "./utils/paths.ts";
import { getProcessWorkRun } from "./utils/work-directory.ts";

// =============================================================================
// Package Detection
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const PI_ADAPTATIVE_RELEASES_URL = "https://github.com/Caupulican/pi-adaptative/releases/latest";
export const PI_ADAPTATIVE_LINUX_INSTALLER_URL = `${PI_ADAPTATIVE_RELEASES_URL}/download/install.sh`;
export const PI_ADAPTATIVE_WINDOWS_INSTALLER_URL = `${PI_ADAPTATIVE_RELEASES_URL}/download/install.ps1`;

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Detect if Bun is the runtime (compiled binary or bun run) */
export const isBunRuntime = !!process.versions.bun;

// =============================================================================
// Install Method Detection
// =============================================================================

export type InstallMethod = "bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export interface StandaloneInstallerCommand {
	command: string;
	args: string[];
	url: string;
}

export function getStandaloneInstallerCommand(
	platform: NodeJS.Platform = process.platform,
): StandaloneInstallerCommand | undefined {
	if (platform === "win32") {
		return {
			command: "powershell.exe",
			args: [
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				`irm ${PI_ADAPTATIVE_WINDOWS_INSTALLER_URL} | iex`,
			],
			url: PI_ADAPTATIVE_WINDOWS_INSTALLER_URL,
		};
	}
	if (platform === "linux") {
		return {
			command: "sh",
			args: ["-c", `curl -fsSL ${PI_ADAPTATIVE_LINUX_INSTALLER_URL} | sh`],
			url: PI_ADAPTATIVE_LINUX_INSTALLER_URL,
		};
	}
	return undefined;
}

export function getStandaloneInstallInstruction(platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") {
		return `Install the standalone release with: irm ${PI_ADAPTATIVE_WINDOWS_INSTALLER_URL} | iex`;
	}
	if (platform === "linux") {
		return `Install the standalone release with: curl -fsSL ${PI_ADAPTATIVE_LINUX_INSTALLER_URL} | sh`;
	}
	return `Standalone installers support Linux and Windows only. Download a supported release from: ${PI_ADAPTATIVE_RELEASES_URL}`;
}

export function isLegacyPackageInstall(method = detectInstallMethod()): boolean {
	return method === "npm" || method === "pnpm" || method === "yarn" || method === "bun";
}

export function detectInstallMethod(): InstallMethod {
	if (isBunBinary) {
		return "bun-binary";
	}

	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase().replace(/\\/g, "/");

	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/")) {
		return "yarn";
	}
	if (isBunRuntime || resolvedPath.includes("/install/global/node_modules/")) {
		return "bun";
	}
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/")) {
		return "npm";
	}

	return "unknown";
}

export function getSelfUpdateUnavailableInstruction(
	_packageName: string,
	_npmCommand?: string[],
	_updatePackageName = _packageName,
): string {
	const method = detectInstallMethod();
	if (method === "bun-binary" || isLegacyPackageInstall(method)) {
		return getStandaloneInstallInstruction();
	}
	return `Update ${_updatePackageName} using the package manager, wrapper, or source checkout that provides this installation.`;
}

export function getUpdateInstruction(packageName: string): string {
	return getSelfUpdateUnavailableInstruction(packageName);
}

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js (dist/): returns __dirname (the dist/ directory)
 * - For tsx (src/): returns parent directory (the package root)
 */
export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
	const envDir = process.env.PI_PACKAGE_DIR;
	if (envDir) {
		return normalizePath(envDir);
	}

	if (isBunBinary) {
		// Bun binary: process.execPath points to the compiled executable
		return dirname(process.execPath);
	}
	// Node.js: walk up from __dirname until we find package.json
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	// Fallback (shouldn't happen)
	return __dirname;
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For tsx (src/): src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "theme");
	}
	// Theme is in modes/interactive/theme/ relative to src/ or dist/
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For tsx (src/): src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** Get path to package.json */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** Get path to README.md */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** Get path to docs directory */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to examples directory */
export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

/** Get path to CHANGELOG.md */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

/**
 * Get path to built-in interactive assets directory.
 * - For Bun binary: assets/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/assets/
 * - For tsx (src/): src/modes/interactive/assets/
 */
export function getInteractiveAssetsDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "assets");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "assets");
}

/** Get path to a bundled interactive asset */
export function getBundledInteractiveAssetPath(name: string): string {
	return join(getInteractiveAssetsDir(), name);
}

/**
 * Get path to bundled resources directory (shipped with package).
 * - For Bun binary: bundled-resources/ next to executable
 * - For Node.js (dist/): dist/bundled-resources/
 * - For tsx (src/): src/bundled-resources/
 */
export function getBundledResourcesDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "bundled-resources");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "bundled-resources");
}

/**
 * Get path to bundled skills directory.
 */
export function getBundledSkillsDir(): string {
	return join(getBundledResourcesDir(), "skills");
}

/**
 * Get path to bundled prompts directory.
 */
export function getBundledPromptsDir(): string {
	return join(getBundledResourcesDir(), "prompts");
}

/**
 * Get path to bundled extensions directory.
 */
export function getBundledExtensionsDir(): string {
	return join(getBundledResourcesDir(), "extensions");
}

// =============================================================================
// App Config (from package.json piConfig)
// =============================================================================

interface PackageJson {
	name?: string;
	version?: string;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	piConfig?: {
		name?: string;
		configDir?: string;
	};
}

let pkg: PackageJson = {};
try {
	pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8")) as PackageJson;
} catch (e: unknown) {
	const err = e as NodeJS.ErrnoException;
	if (err.code !== "ENOENT") throw e;
}

const piConfigName: string | undefined = pkg.piConfig?.name;
export const PACKAGE_NAME: string = pkg.name || "@caupulican/pi-adaptative";
export const APP_NAME: string = piConfigName || "pi";
export const APP_TITLE: string = piConfigName ? APP_NAME : "π";
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".pi";
/** True only when installed package metadata supplied the runtime identity. */
export const VERSION_SOURCE_AVAILABLE: boolean = typeof pkg.version === "string" && pkg.version.trim().length > 0;
export const VERSION: string = VERSION_SOURCE_AVAILABLE ? (pkg.version as string) : "0.0.0";

/** Managed npm tooling uses the exact dependency selected by this packaged installation. */
export function getPackageDependencyVersion(name: string): string {
	const version = pkg.optionalDependencies?.[name] ?? pkg.dependencies?.[name];
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
		throw new Error(`Pi package metadata must pin '${name}' to an exact version.`);
	}
	return version;
}

/**
 * Build a POSIX-valid environment-variable name from an app name and a suffix.
 *
 * APP_NAME comes from `piConfig.name`, which may contain characters that are invalid in a shell
 * env-var name — notably the hyphen in "pi-adaptative". A hyphenated name cannot be exported from
 * a shell (`export PI-ADAPTATIVE_CODING_AGENT_DIR=…` is a parse error), which silently made the
 * documented config-dir override unusable. Uppercase, collapse every character outside [A-Z0-9_]
 * to "_", and prefix "_" if the result would start with a digit (names may not begin with one).
 * e.g. "pi" -> PI_CODING_AGENT_DIR, "pi-adaptative" -> PI_ADAPTATIVE_CODING_AGENT_DIR.
 */
export function toEnvVarName(appName: string, suffix: string): string {
	const prefix = appName.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
	const safePrefix = /^[0-9]/.test(prefix) ? `_${prefix}` : prefix;
	return `${safePrefix}_${suffix}`;
}

export const ENV_AGENT_DIR = toEnvVarName(APP_NAME, "CODING_AGENT_DIR");
export const ENV_SESSION_DIR = toEnvVarName(APP_NAME, "CODING_AGENT_SESSION_DIR");

export function expandTildePath(path: string): string {
	return normalizePath(path);
}

const DEFAULT_SHARE_VIEWER_URL = "https://gist.github.com/";

/** Get the share viewer URL for a gist ID */
export function getShareViewerUrl(gistId: string): string {
	const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
	return `${baseUrl}${gistId}`;
}

// =============================================================================
// User Config Paths (~/.pi/agent/*)
// =============================================================================

/** Get the agent config directory (e.g., ~/.pi/agent/) */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		return expandTildePath(envDir);
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** Get path to models.json */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Get path to auth.json */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** Get path to settings.json */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Get path to tools directory */
export function getToolsDir(): string {
	return join(getAgentDir(), "tools");
}

/** Get path to managed binaries directory (fd, rg, jq, uv) */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** Get path to prompt templates directory */
export function getPromptsDir(): string {
	return join(getAgentDir(), "prompts");
}

/** Get path to reusable profile definitions directory */
export function getProfilesDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, "profiles");
}

/** Get path to sessions directory */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/** Get the process-scoped debug log under the disposable work hierarchy. */
export function getDebugLogPath(): string {
	return join(getProcessWorkRun(getAgentDir(), "logs", "debug").path, `${APP_NAME}-debug.log`);
}
