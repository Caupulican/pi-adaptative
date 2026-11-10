/**
 * Binds the language setting to the interface language. It sets the language the moment it runs, so the first frame is
 * already drawn in it, and sets it again on every settings change, so a running interface follows the setting at once.
 * The caller keeps the returned function and calls it to stop following the setting.
 */

import type { SettingsManager } from "../settings-manager.ts";
import { setInterfaceLanguage } from "./interface-text.ts";
import { resolveLanguage } from "./language.ts";

export function bindInterfaceLanguage(
	settingsManager: SettingsManager,
	env: Readonly<Record<string, string | undefined>>,
): () => void {
	const apply = (): void => {
		setInterfaceLanguage(resolveLanguage(settingsManager.getPlain("language"), env));
	};
	apply();
	return settingsManager.subscribeChanges(apply);
}
