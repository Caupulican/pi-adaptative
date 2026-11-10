/**
 * The active interface language and the catalogue that goes with it. Render code reads the text it shows through
 * `interfaceText()` at the moment it draws, never through a constant captured at import time, so a language change
 * reaches the next frame.
 */

import type { Language } from "./language.ts";
import { EN } from "./text-en/index.ts";
import { PT_BR } from "./text-pt-br/index.ts";

/** The English catalogue's shape: the same keys in every language, with a string or a formatting function per leaf. */
export type InterfaceText = typeof EN;

const CATALOGUES: Record<Language, InterfaceText> = { en: EN, "pt-BR": PT_BR };

const listeners = new Set<() => void>();

let active: Language = "en";

/** Set the language the interface draws in. Listeners run only when the language actually changes. */
export function setInterfaceLanguage(language: Language): void {
	if (language === active) return;
	active = language;
	for (const listener of [...listeners]) listener();
}

/** The language the interface draws in now. */
export function interfaceLanguage(): Language {
	return active;
}

/** The catalogue of the active language. */
export function interfaceText(): InterfaceText {
	return CATALOGUES[active];
}

/** Listen for a language change. The returned function removes the listener. */
export function onInterfaceLanguageChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
