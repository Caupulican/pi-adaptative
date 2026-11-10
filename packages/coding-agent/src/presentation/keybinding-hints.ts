/**
 * Utilities for formatting keybinding hints in the UI.
 */

import { getKeybindings, type Keybinding, type KeyId } from "@caupulican/pi-tui";
import { interfaceText } from "../core/language/interface-text.ts";
import { theme } from "./theme-model.ts";

export interface KeyTextFormatOptions {
	capitalize?: boolean;
}

function formatKeyPart(part: string, options: KeyTextFormatOptions): string {
	const displayPart = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
	return options.capitalize ? displayPart.charAt(0).toUpperCase() + displayPart.slice(1) : displayPart;
}

export function formatKeyText(key: string, options: KeyTextFormatOptions = {}): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => formatKeyPart(part, options))
				.join("+"),
		)
		.join("/");
}

function formatKeys(keys: KeyId[], options: KeyTextFormatOptions = {}): string {
	if (keys.length === 0) return "";
	return formatKeyText(keys.join("/"), options);
}

export function keyText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding));
}

export function keyDisplayText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding), { capitalize: true });
}

/**
 * A key and what it does. A site with wording of its own passes it; a site that shows the binding the way the owner
 * finds it in their settings leaves it out and gets the binding's own description in the active language.
 */
export function keyHint(keybinding: Keybinding, description?: string): string {
	const wording = description ?? interfaceText().keys.bindings[keybinding];
	return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${wording}`);
}

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);
}

/** The three actions every selector offers, in the active language, in one hint line. */
export function formatSelectorActionHints(hasDefault: boolean): string {
	const text = interfaceText().selectors.shared;
	const parts = [keyHint("tui.select.confirm", text.select)];
	if (hasDefault) {
		parts.push(keyHint("app.models.save", text.setAsDefault));
	}
	parts.push(keyHint("tui.select.cancel", text.cancel));
	return parts.join("  ");
}
