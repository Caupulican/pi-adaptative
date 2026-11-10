/**
 * Gives the interface the language of the settings. Only a process that draws a screen for a person calls this: the
 * interactive mode binds it, and a screen drawn before a session exists applies it once. Print, JSON and RPC modes, and
 * the workers they run, never do, so every catalogue text they produce is English, like everything a model reads.
 *
 * Binding sets the language the moment it runs, so the first frame is already drawn in it, and sets it again on every
 * settings change, so a running interface follows the setting at once. The words the terminal library draws itself come
 * from its own table, so the same moment hands it the active language's words as well.
 */

import { setLibraryText } from "@caupulican/pi-tui";
import type { SettingsManager } from "../settings-manager.ts";
import { interfaceText, setInterfaceLanguage } from "./interface-text.ts";
import { resolveLanguage } from "./language.ts";

/** Sets the interface language from the settings once, for a screen that does not outlive a settings change. */
export function applyInterfaceLanguage(
	settings: Pick<SettingsManager, "getPlain">,
	env: Readonly<Record<string, string | undefined>>,
): void {
	setInterfaceLanguage(resolveLanguage(settings.getPlain("language"), env));
	setLibraryText(interfaceText().library);
}

/** Sets the language and follows the setting. The caller keeps the returned function and calls it to stop following. */
export function bindInterfaceLanguage(
	settingsManager: SettingsManager,
	env: Readonly<Record<string, string | undefined>>,
): () => void {
	const apply = (): void => applyInterfaceLanguage(settingsManager, env);
	apply();
	return settingsManager.subscribeChanges(apply);
}
