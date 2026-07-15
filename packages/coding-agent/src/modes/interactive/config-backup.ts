/**
 * Config backup/restore commands extracted from interactive-mode.
 *
 * `handleConfigBackupCommand` snapshots the reusable-file profiles and the
 * resource-relevant settings to a JSON bundle; `handleConfigRestoreCommand`
 * reads such a bundle back, confirming with the user before clobbering local
 * state. Both operate through a narrow `host` seam (settings manager + the
 * status/error/selector callbacks) so the file IO and validation live outside
 * the god file while interactive-mode keeps only thin delegating wrappers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Component } from "@caupulican/pi-tui";
import { getAgentDir } from "../../config.ts";
import type {
	GlobalResourceProfileConfiguration,
	ModelRouterSettings,
	ProfileDefinitionInput,
	ResourceProfileSettings,
	Settings,
	SettingsManager,
	ThinkingLevel,
} from "../../core/settings-manager.ts";
import { SelectSubmenu } from "./components/settings-selector.ts";

export interface ConfigBackupHost {
	readonly settingsManager: SettingsManager;
	showStatus(message: string): void;
	showError(errorMessage: string): void;
}

export interface ConfigRestoreHost extends ConfigBackupHost {
	showSelector(
		create: (done: () => void) => { component: Component; focus: Component; onSuperseded?: () => void },
	): void;
	handleReloadCommand(): Promise<boolean>;
}

const PROFILE_THINKING_LEVELS = new Set<ThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decodeBackupProfile(name: string, value: unknown): ProfileDefinitionInput | undefined {
	if (!isRecord(value)) return undefined;
	const isWrapper = Object.hasOwn(value, "resources");
	const resources = isWrapper ? value.resources : value;
	if (!isRecord(resources)) return undefined;
	const thinking =
		typeof value.thinking === "string" && PROFILE_THINKING_LEVELS.has(value.thinking as ThinkingLevel)
			? (value.thinking as ThinkingLevel)
			: undefined;
	return {
		name,
		description: typeof value.description === "string" ? value.description : undefined,
		model: typeof value.model === "string" ? value.model : undefined,
		thinking,
		modelRouter: isRecord(value.modelRouter) ? (value.modelRouter as ModelRouterSettings) : undefined,
		soul: typeof value.soul === "string" ? value.soul : undefined,
		resources: resources as ResourceProfileSettings,
	};
}

export interface ProfileFilesSnapshot {
	directoryExisted: boolean;
	files: Map<string, string>;
}

function canonicalActiveResourceProfiles(settings: Settings): string[] {
	const values = settings.activeResourceProfiles ?? settings.activeResourceProfile ?? [];
	const entries = Array.isArray(values) ? values : [values];
	return [...new Set(entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

function decodeStringArray(label: string, value: unknown): string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new Error(`Invalid backup file: ${label} must be an array of strings`);
	}
	return [...new Set(value.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

function decodeActiveResourceProfiles(settings: Record<string, unknown>): string[] {
	if (Object.hasOwn(settings, "activeResourceProfiles")) {
		return decodeStringArray("settings.activeResourceProfiles", settings.activeResourceProfiles);
	}
	const legacy = settings.activeResourceProfile;
	if (legacy === undefined) return [];
	if (typeof legacy === "string") return legacy.trim() ? [legacy.trim()] : [];
	return decodeStringArray("settings.activeResourceProfile", legacy);
}

function decodeResourceProfiles(value: unknown): Record<string, ProfileDefinitionInput> {
	if (value === undefined) return {};
	if (!isRecord(value)) {
		throw new Error("Invalid backup file: settings.resourceProfiles must be an object");
	}
	const profiles: Record<string, ProfileDefinitionInput> = {};
	for (const [name, definition] of Object.entries(value)) {
		const decoded = decodeBackupProfile(name, definition);
		if (!decoded) throw new Error(`Invalid backup file: malformed resource profile "${name}"`);
		profiles[name] = decoded;
	}
	return profiles;
}

function decodeProfileFiles(value: unknown): Record<string, unknown> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error("Invalid backup file: profiles must be an object");
	for (const filename of Object.keys(value)) {
		if (path.basename(filename) !== filename || !filename.endsWith(".json")) {
			throw new Error(`Invalid backup file: unsafe profile filename "${filename}"`);
		}
	}
	return value;
}

export function captureProfileFiles(profilesDir: string): ProfileFilesSnapshot {
	const files = new Map<string, string>();
	if (!fs.existsSync(profilesDir)) return { directoryExisted: false, files };
	for (const filename of fs.readdirSync(profilesDir)) {
		if (!filename.endsWith(".json")) continue;
		const profilePath = path.join(profilesDir, filename);
		if (!fs.lstatSync(profilePath).isFile()) continue;
		files.set(filename, fs.readFileSync(profilePath, "utf-8"));
	}
	return { directoryExisted: true, files };
}

function clearProfileFiles(profilesDir: string): void {
	if (!fs.existsSync(profilesDir)) return;
	for (const filename of fs.readdirSync(profilesDir)) {
		if (!filename.endsWith(".json")) continue;
		const profilePath = path.join(profilesDir, filename);
		const stat = fs.lstatSync(profilePath);
		if (stat.isFile() || stat.isSymbolicLink()) fs.rmSync(profilePath, { force: true });
	}
}

function replaceProfileFiles(profilesDir: string, profiles: Record<string, unknown>): void {
	fs.mkdirSync(profilesDir, { recursive: true });
	clearProfileFiles(profilesDir);
	for (const [filename, content] of Object.entries(profiles)) {
		const serialized = JSON.stringify(content, null, 2);
		if (serialized === undefined) throw new Error(`Invalid backup file: profile "${filename}" is not serializable`);
		fs.writeFileSync(path.join(profilesDir, filename), serialized, "utf-8");
	}
}

export function restoreProfileFiles(profilesDir: string, snapshot: ProfileFilesSnapshot): void {
	clearProfileFiles(profilesDir);
	if (snapshot.files.size > 0) fs.mkdirSync(profilesDir, { recursive: true });
	for (const [filename, content] of snapshot.files) {
		fs.writeFileSync(path.join(profilesDir, filename), content, "utf-8");
	}
	if (!snapshot.directoryExisted && fs.existsSync(profilesDir) && fs.readdirSync(profilesDir).length === 0) {
		fs.rmdirSync(profilesDir);
	}
}

function profileConfigurationFromSettings(settings: Settings): GlobalResourceProfileConfiguration {
	return {
		resourceProfiles: settings.resourceProfiles,
		activeResourceProfile: settings.activeResourceProfile,
		activeResourceProfiles: settings.activeResourceProfiles,
		externalResourceRoots: settings.externalResourceRoots,
		trustedResourceRoots: settings.trustedResourceRoots,
	};
}

export async function handleConfigBackupCommand(host: ConfigBackupHost, fileArg?: string): Promise<void> {
	try {
		const profilesDir = path.join(getAgentDir(), "profiles");
		const profiles: Record<string, unknown> = {};
		if (fs.existsSync(profilesDir)) {
			const entries = fs.readdirSync(profilesDir);
			for (const entry of entries) {
				if (entry.endsWith(".json")) {
					const pPath = path.join(profilesDir, entry);
					try {
						if (!fs.lstatSync(pPath).isFile()) continue;
						const content = fs.readFileSync(pPath, "utf-8");
						profiles[entry] = JSON.parse(content);
					} catch {
						// skip
					}
				}
			}
		}

		const globalSettings = host.settingsManager.getGlobalSettings();
		const backupData = {
			version: 2,
			profiles,
			settings: {
				resourceProfiles: globalSettings.resourceProfiles ?? {},
				activeResourceProfiles: canonicalActiveResourceProfiles(globalSettings),
				externalResourceRoots: globalSettings.externalResourceRoots ?? [],
				trustedResourceRoots: globalSettings.trustedResourceRoots ?? [],
			},
		};

		let targetFile = fileArg;
		if (!targetFile) {
			const backupsDir = path.join(getAgentDir(), "backups");
			fs.mkdirSync(backupsDir, { recursive: true });
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			targetFile = path.join(backupsDir, `config-${timestamp}.json`);
		} else {
			const resolved = host.settingsManager.canonicalizePath(targetFile);
			if (resolved) {
				targetFile = resolved;
			}
		}

		fs.mkdirSync(path.dirname(targetFile), { recursive: true });
		fs.writeFileSync(targetFile, JSON.stringify(backupData, null, 2), "utf-8");
		host.showStatus(`Configuration backup saved to ${targetFile}`);
	} catch (error) {
		host.showError(error instanceof Error ? error.message : String(error));
	}
}

export async function handleConfigRestoreCommand(host: ConfigRestoreHost, fileArg: string): Promise<void> {
	try {
		const trimmed = fileArg.trim();
		if (!trimmed) {
			host.showError("Usage: /config-restore <file>");
			return;
		}

		const resolved = host.settingsManager.canonicalizePath(trimmed);
		if (!resolved || !fs.existsSync(resolved)) {
			host.showError(`Backup file does not exist: ${trimmed}`);
			return;
		}

		let bundle: unknown;
		try {
			const content = fs.readFileSync(resolved, "utf-8");
			bundle = JSON.parse(content);
		} catch (error) {
			host.showError(`Failed to parse backup file: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		if (!isRecord(bundle)) {
			host.showError("Invalid backup file: must be a JSON object");
			return;
		}

		let profileFiles: Record<string, unknown>;
		let restoredResourceProfiles: Record<string, ProfileDefinitionInput>;
		let restoredActiveProfiles: string[];
		let restoredExternalRoots: string[];
		try {
			profileFiles = decodeProfileFiles(bundle.profiles);
			const backupSettings = isRecord(bundle.settings) ? bundle.settings : {};
			restoredResourceProfiles = decodeResourceProfiles(backupSettings.resourceProfiles);
			restoredActiveProfiles = decodeActiveResourceProfiles(backupSettings);
			restoredExternalRoots = decodeStringArray(
				"settings.externalResourceRoots",
				backupSettings.externalResourceRoots ?? [],
			);
		} catch (error) {
			host.showError(error instanceof Error ? error.message : String(error));
			return;
		}

		// Confirm before clobbering
		const confirm = await new Promise<boolean>((resolve) => {
			host.showSelector((done) => {
				let settled = false;
				const settle = (value: boolean) => {
					if (settled) return;
					settled = true;
					resolve(value);
				};
				const submenu = new SelectSubmenu(
					"Restore configuration?",
					"This will overwrite existing local profiles and settings with the backup values. Do you want to continue?",
					[
						{ value: "yes", label: "Yes", description: "Proceed with restoration." },
						{ value: "no", label: "No", description: "Cancel and abort." },
					],
					"no",
					(value) => {
						done();
						settle(value === "yes");
					},
					() => {
						done();
						settle(false);
					},
				);
				return {
					component: submenu,
					focus: submenu.getSelectList(),
					onSuperseded: () => settle(false),
				};
			});
		});

		if (!confirm) {
			host.showStatus("Restore aborted.");
			return;
		}

		const profilesDir = path.join(getAgentDir(), "profiles");
		const profileFilesSnapshot = captureProfileFiles(profilesDir);
		const settingsSnapshot = host.settingsManager.createReloadSnapshot();
		let restoreStarted = false;
		try {
			restoreStarted = true;
			replaceProfileFiles(profilesDir, profileFiles);
			const currentTrusted = settingsSnapshot.globalSettings.trustedResourceRoots ?? [];
			host.settingsManager.replaceGlobalResourceProfileConfiguration({
				resourceProfiles: Object.keys(restoredResourceProfiles).length > 0 ? restoredResourceProfiles : undefined,
				activeResourceProfiles: restoredActiveProfiles,
				externalResourceRoots: restoredExternalRoots,
				// Security boundary: roots named by a backup never become trusted through restore.
				trustedResourceRoots: currentTrusted.filter((root) => !restoredExternalRoots.includes(root)),
			});
			await host.settingsManager.flush();
			if (!(await host.handleReloadCommand())) {
				throw new Error("restored configuration failed runtime validation");
			}
			host.showStatus("Configuration restored successfully.");
		} catch (error) {
			let rollbackError: unknown;
			if (restoreStarted) {
				try {
					restoreProfileFiles(profilesDir, profileFilesSnapshot);
					host.settingsManager.replaceGlobalResourceProfileConfiguration(
						profileConfigurationFromSettings(settingsSnapshot.globalSettings),
					);
					await host.settingsManager.flush();
					host.settingsManager.restoreReloadSnapshot(settingsSnapshot);
				} catch (restoreError) {
					rollbackError = restoreError;
				}
			}
			const message = error instanceof Error ? error.message : String(error);
			host.showError(
				rollbackError
					? `Configuration restore failed: ${message}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
					: `Configuration restore failed: ${message}; previous configuration restored`,
			);
		}
	} catch (error) {
		host.showError(error instanceof Error ? error.message : String(error));
	}
}
