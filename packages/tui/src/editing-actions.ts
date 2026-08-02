import { getKeybindings } from "./keybindings.ts";

export const DELETE_CHARACTER_BACKWARD = Symbol("deleteCharacterBackward");
export const DELETE_CHARACTER_FORWARD = Symbol("deleteCharacterForward");
export const DELETE_WORD_BACKWARD = Symbol("deleteWordBackward");
export const DELETE_WORD_FORWARD = Symbol("deleteWordForward");
export const DELETE_TO_LINE_START = Symbol("deleteToLineStart");
export const DELETE_TO_LINE_END = Symbol("deleteToLineEnd");

export interface DeletionActionTarget {
	[DELETE_CHARACTER_BACKWARD](): void;
	[DELETE_CHARACTER_FORWARD](): void;
	[DELETE_WORD_BACKWARD](): void;
	[DELETE_WORD_FORWARD](): void;
	[DELETE_TO_LINE_START](): void;
	[DELETE_TO_LINE_END](): void;
}

/** Resolve and execute the shared configurable editor deletion intents. */
export function dispatchDeletionInput(data: string, target: DeletionActionTarget): boolean {
	const keybindings = getKeybindings();
	if (keybindings.matches(data, "tui.editor.deleteToLineEnd")) {
		target[DELETE_TO_LINE_END]();
	} else if (keybindings.matches(data, "tui.editor.deleteToLineStart")) {
		target[DELETE_TO_LINE_START]();
	} else if (keybindings.matches(data, "tui.editor.deleteWordBackward")) {
		target[DELETE_WORD_BACKWARD]();
	} else if (keybindings.matches(data, "tui.editor.deleteWordForward")) {
		target[DELETE_WORD_FORWARD]();
	} else if (keybindings.matches(data, "tui.editor.deleteCharBackward")) {
		target[DELETE_CHARACTER_BACKWARD]();
	} else if (keybindings.matches(data, "tui.editor.deleteCharForward")) {
		target[DELETE_CHARACTER_FORWARD]();
	} else {
		return false;
	}
	return true;
}
