/**
 * The English words of the settings screen this build translates: the language row and the names it offers. The other
 * rows keep their text until their own slice moves it.
 */

import type { LanguageSetting } from "../language.ts";

export const SETTINGS = {
	language: {
		label: "Language",
		description: "Language of the interface",
		values: {
			auto: "Automatic (system)",
			en: "English",
			"pt-BR": "Português (Brasil)",
		} satisfies Record<LanguageSetting, string>,
	},
};
