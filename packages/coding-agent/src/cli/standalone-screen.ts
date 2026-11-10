/**
 * What a screen drawn before a session exists takes from the settings: the owner's theme and the interface language.
 * The session picker, a startup question and the config screen all start here, so none of them is left unthemed or in
 * English when the settings say otherwise.
 */

import { applyInterfaceLanguage } from "../core/language/language-binding.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { initTheme, stopThemeWatcher } from "../presentation/theme/theme.ts";

/** The settings a standalone screen reads: its theme and its language. */
export type StandaloneScreenSettings = Pick<SettingsManager, "getTheme" | "getPlain">;

/**
 * Applies the theme and the language. With `watchTheme` the theme file is watched while the screen is open; the
 * returned function stops that watch.
 */
export function prepareStandaloneScreen(settings: StandaloneScreenSettings, watchTheme = false): () => void {
	initTheme(settings.getTheme(), watchTheme);
	applyInterfaceLanguage(settings, process.env);
	return stopThemeWatcher;
}
