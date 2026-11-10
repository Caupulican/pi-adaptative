/**
 * The Brazilian Portuguese words of the settings screen this build translates. The language names read the same in
 * every catalogue, because an owner looking for their own language looks for it written in that language.
 */

import type { InterfaceText } from "../interface-text.ts";

export const SETTINGS = {
	language: {
		label: "Idioma",
		description: "Idioma da interface",
		values: {
			auto: "Automático (sistema)",
			en: "English",
			"pt-BR": "Português (Brasil)",
		},
	},
} satisfies InterfaceText["settings"];
