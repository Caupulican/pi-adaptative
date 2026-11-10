/**
 * The active interface language and the catalogue that goes with it. Render code reads the text it shows through
 * `interfaceText()` at the moment it draws, never through a constant captured at import time, so a language change
 * reaches the next frame.
 */

import { EN, PT_BR } from "./catalogue.ts";
import type { Language } from "./language.ts";
import type { AGENTS_OVERLAY } from "./text-en/agents-overlay.ts";
import type { AUTO_LEARN } from "./text-en/auto-learn.ts";
import type { AUTONOMY_COMMANDS } from "./text-en/autonomy-commands.ts";
import type { CHAT } from "./text-en/chat.ts";
import type { COMMAND_CONTROLLER } from "./text-en/command-controller.ts";
import type { COMMANDS } from "./text-en/commands.ts";
import type { COMMON } from "./text-en/common.ts";
import type { CONFIG_SCREEN } from "./text-en/config-screen.ts";
import type { CONVERSATION } from "./text-en/conversation.ts";
import type { DIALOGS } from "./text-en/dialogs.ts";
import type { FRAME } from "./text-en/frame.ts";
import type { GRAPH } from "./text-en/graph.ts";
import type { INSPECTOR } from "./text-en/inspector.ts";
import type { INTERACTIVE } from "./text-en/interactive.ts";
import type { KEYS } from "./text-en/keys.ts";
import type { KNOWLEDGE_COMMANDS } from "./text-en/knowledge-commands.ts";
import type { LOCAL_MODELS } from "./text-en/local-models.ts";
import type { MACHINES } from "./text-en/machines.ts";
import type { NOTICES } from "./text-en/notices.ts";
import type { PANES } from "./text-en/panes.ts";
import type { PROFILES_SCREEN } from "./text-en/profiles-screen.ts";
import type { QUEUE } from "./text-en/queue.ts";
import type { REPORTS } from "./text-en/reports.ts";
import type { RESOURCES } from "./text-en/resources.ts";
import type { SECRETS_SCREEN } from "./text-en/secrets-screen.ts";
import type { SELECTORS } from "./text-en/selectors.ts";
import type { SESSIONS } from "./text-en/sessions.ts";
import type { SETTINGS } from "./text-en/settings.ts";
import type { SETTINGS_SCREEN } from "./text-en/settings-screen.ts";
import type { SMALL_COMMANDS } from "./text-en/small-commands.ts";
import type { STATUS } from "./text-en/status.ts";

/**
 * The English catalogue's shape: the same areas in every language, each with a string or a formatting function per
 * leaf. Every area file of either language is held to it, so a missing entry, an extra entry or a different argument
 * list is a compile error rather than a window that falls back to English.
 */
export interface InterfaceText {
	agentsOverlay: typeof AGENTS_OVERLAY;
	autoLearn: typeof AUTO_LEARN;
	autonomyCommands: typeof AUTONOMY_COMMANDS;
	chat: typeof CHAT;
	commandController: typeof COMMAND_CONTROLLER;
	commands: typeof COMMANDS;
	common: typeof COMMON;
	configScreen: typeof CONFIG_SCREEN;
	conversation: typeof CONVERSATION;
	dialogs: typeof DIALOGS;
	frame: typeof FRAME;
	graph: typeof GRAPH;
	inspector: typeof INSPECTOR;
	interactive: typeof INTERACTIVE;
	keys: typeof KEYS;
	knowledgeCommands: typeof KNOWLEDGE_COMMANDS;
	localModels: typeof LOCAL_MODELS;
	machines: typeof MACHINES;
	notices: typeof NOTICES;
	panes: typeof PANES;
	profilesScreen: typeof PROFILES_SCREEN;
	queue: typeof QUEUE;
	reports: typeof REPORTS;
	resources: typeof RESOURCES;
	secretsScreen: typeof SECRETS_SCREEN;
	selectors: typeof SELECTORS;
	sessions: typeof SESSIONS;
	settings: typeof SETTINGS;
	settingsScreen: typeof SETTINGS_SCREEN;
	smallCommands: typeof SMALL_COMMANDS;
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
