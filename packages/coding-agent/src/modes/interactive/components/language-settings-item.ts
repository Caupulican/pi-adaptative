/**
 * The language row of the settings screen. The row is one plain choice list, so it owns nothing but the values it offers
 * and the words it shows: the current setting, the automatic option that follows the system locale, and each language
 * named in itself.
 */

import type { SettingItem } from "@caupulican/pi-tui";
import { interfaceText } from "../../../core/language/interface-text.ts";
import { LANGUAGES, type LanguageSetting } from "../../../core/language/language.ts";

/** The values the row cycles through: the explicit languages, and `auto` for the system locale. */
export function languageSettingValues(): LanguageSetting[] {
	return ["auto", ...LANGUAGES];
}

/** The main settings list's row for the interface language. */
export function languageSettingsItem(language: LanguageSetting): SettingItem {
	const text = interfaceText().settings.language;
	return {
		id: "language",
		label: text.label,
		description: text.description,
		currentValue: language,
		values: languageSettingValues(),
		valueLabels: text.values,
	};
}
