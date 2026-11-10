/**
 * The active interface language and the catalogue that goes with it. Render code reads the text it shows through
 * `interfaceText()` at the moment it draws, never through a constant captured at import time, so a language change
 * reaches the next frame.
 */

import { EN, PT_BR } from "./catalogue.ts";
import type { Language } from "./language.ts";
import type { CHAT } from "./text-en/chat.ts";
import type { COMMANDS } from "./text-en/commands.ts";
import type { COMMON } from "./text-en/common.ts";
import type { FRAME } from "./text-en/frame.ts";
import type { GRAPH } from "./text-en/graph.ts";
import type { INSPECTOR } from "./text-en/inspector.ts";
import type { KEYS } from "./text-en/keys.ts";
import type { PANES } from "./text-en/panes.ts";
import type { SETTINGS } from "./text-en/settings.ts";
import type { STATUS } from "./text-en/status.ts";

/**
 * The English catalogue's shape: the same areas in every language, each with a string or a formatting function per
 * leaf. Every area file of either language is held to it, so a missing entry, an extra entry or a different argument
 * list is a compile error rather than a window that falls back to English.
 */
export interface InterfaceText {
	chat: typeof CHAT;
	commands: typeof COMMANDS;
	common: typeof COMMON;
	frame: typeof FRAME;
	graph: typeof GRAPH;
	inspector: typeof INSPECTOR;
	keys: typeof KEYS;
	panes: typeof PANES;
	settings: typeof SETTINGS;
	status: typeof STATUS;
}

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
