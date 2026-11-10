/**
 * Binds the language setting to the interface language. It sets the language the moment it runs, so the first frame is
 * already drawn in it, and sets it again on every settings change, so a running interface follows the setting at once.
 * The words the terminal library draws itself come from its own table, so the same moment hands it the active language's
 * words as well. The caller keeps the returned function and calls it to stop following the setting.
 */

import { setLibraryText } from "@caupulican/pi-tui";
import type { SettingsManager } from "../settings-manager.ts";
import { interfaceText, setInterfaceLanguage } from "./interface-text.ts";
import { resolveLanguage } from "./language.ts";

export function bindInterfaceLanguage(
	settingsManager: SettingsManager,
	env: Readonly<Record<string, string | undefined>>,
): () => void {
	const apply = (): void => {
		setInterfaceLanguage(resolveLanguage(settingsManager.getPlain("language"), env));
		setLibraryText(interfaceText().library);
	};
	apply();
	return settingsManager.subscribeChanges(apply);
}
