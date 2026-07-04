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
import type { SettingsManager } from "../../core/settings-manager.ts";
import { SelectSubmenu } from "./components/settings-selector.ts";

export interface ConfigBackupHost {
	readonly settingsManager: SettingsManager;
	showStatus(message: string): void;
	showError(errorMessage: string): void;
}

export interface ConfigRestoreHost extends ConfigBackupHost {
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void;
	handleReloadCommand(): Promise<void>;
}

export async function handleConfigBackupCommand(host: ConfigBackupHost, fileArg?: string): Promise<void> {
	try {
		const profilesDir = path.join(getAgentDir(), "profiles");
		const profiles: Record<string, any> = {};
		if (fs.existsSync(profilesDir)) {
			const entries = fs.readdirSync(profilesDir);
			for (const entry of entries) {
				if (entry.endsWith(".json")) {
					const pPath = path.join(profilesDir, entry);
					try {
						const content = fs.readFileSync(pPath, "utf-8");
						profiles[entry] = JSON.parse(content);
					} catch {
						// skip
					}
				}
			}
		}

		const backupData = {
			profiles,
			settings: {
				resourceProfiles: host.settingsManager.settings.resourceProfiles,
				activeResourceProfile: host.settingsManager.settings.activeResourceProfile,
				externalResourceRoots: host.settingsManager.settings.externalResourceRoots,
				trustedResourceRoots: host.settingsManager.settings.trustedResourceRoots,
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

		let bundle: any;
		try {
			const content = fs.readFileSync(resolved, "utf-8");
			bundle = JSON.parse(content);
		} catch (error) {
			host.showError(`Failed to parse backup file: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		if (!bundle || typeof bundle !== "object") {
			host.showError("Invalid backup file: must be a JSON object");
			return;
		}

		// Confirm before clobbering
		const confirm = await new Promise<boolean>((resolve) => {
			host.showSelector((done) => {
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
						resolve(value === "yes");
					},
					() => {
						done();
						resolve(false);
					},
				);
				return { component: submenu, focus: submenu.getSelectList() };
			});
		});

		if (!confirm) {
			host.showStatus("Restore aborted.");
			return;
		}

		// 1. Restore profile files (reusable-file scope)
		if (bundle.profiles && typeof bundle.profiles === "object") {
			const profilesDir = path.join(getAgentDir(), "profiles");
			fs.mkdirSync(profilesDir, { recursive: true });
			for (const [filename, content] of Object.entries(bundle.profiles)) {
				const targetPath = path.join(profilesDir, filename);
				fs.writeFileSync(targetPath, JSON.stringify(content, null, 2), "utf-8");
			}
		}

		// 2. Restore settings
		if (bundle.settings && typeof bundle.settings === "object") {
			const bs = bundle.settings;

			// Global profiles definitions
			if (bs.resourceProfiles && typeof bs.resourceProfiles === "object") {
				for (const [name, definition] of Object.entries(bs.resourceProfiles)) {
					host.settingsManager.setProfileDefinition(name, definition as any, "global");
				}
			}

			// Active profile selection
			if (bs.activeResourceProfile) {
				host.settingsManager.setActiveProfile(bs.activeResourceProfile, "global");
			}

			// External roots (trustedRoots are NOT restored, as per SECURITY requirement)
			if (Array.isArray(bs.externalResourceRoots)) {
				host.settingsManager.setExternalResourceRoots(bs.externalResourceRoots, "global");

				const currentTrusted = host.settingsManager.getTrustedResourceRoots();
				const newTrusted = currentTrusted.filter((r) => !bs.externalResourceRoots.includes(r));
				host.settingsManager.setTrustedResourceRoots(newTrusted, "global");
			}
		}

		host.showStatus("Configuration restored successfully.");
		await host.handleReloadCommand();
	} catch (error) {
		host.showError(error instanceof Error ? error.message : String(error));
	}
}
