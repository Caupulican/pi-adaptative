/**
 * The words the terminal library draws itself, which its host sets the way it sets the keybindings. The library cannot
 * read the harness's catalogue, so it keeps this one table: English until a host hands over another language, so the
 * library alone, and every test that leaves it alone, draws exactly the words it always drew.
 */

/** The kinds of markdown alert a quote can open with; the source marker (`[!NOTE]`) keeps its own spelling. */
export type AlertKind = "note" | "tip" | "important" | "warning" | "caution";

export interface LibraryText {
	/** A settings list with nothing to list. */
	noSettingsAvailable: string;
	/** A settings list whose search matches nothing. */
	noMatchingSettings: string;
	/** A select list whose search matches nothing. */
	noMatchingCommands: string;
	/** The hint under a settings list: the keys that change a setting, and whether typing searches first. */
	settingsHint: (searchable: boolean) => string;
	/** The loader's message when its owner gives none. */
	loading: string;
	/** The border a scrolled edit frame draws above (`↑`) or below (`↓`) the lines it hides. */
	scrollBorder: (direction: "↑" | "↓", hiddenLines: number) => string;
	/** The title each markdown alert's kind draws. */
	alert: Readonly<Record<AlertKind, string>>;
	/** The line an image falls back to when the terminal cannot draw it, given its file name, type and size. */
	imageFallback: (details: string) => string;
}

/** The words the library draws until a host sets another language, and the English words a host hands back. */
export const ENGLISH_LIBRARY_TEXT: LibraryText = {
	noSettingsAvailable: "No settings available",
	noMatchingSettings: "No matching settings",
	noMatchingCommands: "No matching commands",
	settingsHint: (searchable) =>
		searchable ? "Type to search · Enter/Space to change · Esc to cancel" : "Enter/Space to change · Esc to cancel",
	loading: "Loading...",
	scrollBorder: (direction, hiddenLines) => `─── ${direction} ${hiddenLines} more `,
	alert: {
		note: "Note",
		tip: "Tip",
		important: "Important",
		warning: "Warning",
		caution: "Caution",
	},
	imageFallback: (details) => `[Image: ${details}]`,
};

let current: LibraryText = ENGLISH_LIBRARY_TEXT;

/** Set the words the library draws from the next frame on. */
export function setLibraryText(text: LibraryText): void {
	current = text;
}

/** The words the library draws now. */
export function libraryText(): LibraryText {
	return current;
}
