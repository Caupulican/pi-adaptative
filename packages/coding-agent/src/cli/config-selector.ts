/**
 * TUI config selector for `pi config` command
 */

import { ProcessTerminal, TUI } from "@caupulican/pi-tui";
import type { ResolvedPaths } from "../core/package-manager.ts";
import type { PackageSource, Settings } from "../core/settings/settings-schema.ts";
import { ConfigSelectorComponent } from "../modes/interactive/components/config-selector.ts";
import { initTheme, stopThemeWatcher } from "../presentation/theme/theme.ts";

/** The settings this module reads, declared by the module itself; the composition root passes the SettingsManager. */
export interface ConfigSelectorSettingsSource {
	getGlobalSettings(): Settings;
	getProjectSettings(): Settings;
	getTheme(): string | undefined;
	setExtensionPaths(paths: string[]): void;
	setPackages(packages: PackageSource[]): void;
	setProjectExtensionPaths(paths: string[]): void;
	setProjectPackages(packages: PackageSource[]): void;
	setProjectPromptTemplatePaths(paths: string[]): void;
	setProjectSkillPaths(paths: string[]): void;
	setProjectThemePaths(paths: string[]): void;
	setPromptTemplatePaths(paths: string[]): void;
	setSkillPaths(paths: string[]): void;
	setThemePaths(paths: string[]): void;
}

export interface ConfigSelectorOptions {
	resolvedPaths: ResolvedPaths;
	settingsManager: ConfigSelectorSettingsSource;
	cwd: string;
	agentDir: string;
}

/** Show TUI config selector and return when closed */
export async function selectConfig(options: ConfigSelectorOptions): Promise<void> {
	// Initialize theme before showing TUI
	initTheme(options.settingsManager.getTheme(), true);

	return new Promise((resolve) => {
		const ui = new TUI(new ProcessTerminal());
		let resolved = false;

		const selector = new ConfigSelectorComponent(
			options.resolvedPaths,
			options.settingsManager,
			options.cwd,
			options.agentDir,
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					stopThemeWatcher();
					resolve();
				}
			},
			() => {
				ui.stop();
				stopThemeWatcher();
				process.exit(0);
			},
			() => ui.requestRender(),
			ui.terminal.rows,
		);

		ui.addChild(selector);
		ui.setFocus(selector.getResourceList());
		ui.start();
	});
}
