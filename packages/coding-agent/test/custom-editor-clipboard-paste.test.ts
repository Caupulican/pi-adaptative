import type { TUI } from "@caupulican/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme } from "../src/modes/interactive/theme/theme.ts";

function createEditor(): CustomEditor {
	const tui = { requestRender: vi.fn() } as unknown as TUI;
	const keybindings = new KeybindingsManager({ "app.clipboard.pasteImage": "ctrl+v" });
	return new CustomEditor(tui, getEditorTheme(), keybindings);
}

describe("CustomEditor clipboard image paste", () => {
	it("dispatches Ctrl+V directly to the clipboard-image handler", () => {
		const editor = createEditor();
		const onPasteImage = vi.fn();
		editor.onPasteImage = onPasteImage;

		editor.handleInput("\x16");

		expect(onPasteImage).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");
	});

	it("treats an empty bracketed paste as a clipboard-image paste", () => {
		const editor = createEditor();
		const onPasteImage = vi.fn();
		editor.onPasteImage = onPasteImage;

		editor.handleInput("\x1b[200~\x1b[201~");

		expect(onPasteImage).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");
	});

	it("preserves ordinary pasted image-path text", () => {
		const editor = createEditor();
		const onPasteImage = vi.fn();
		editor.onPasteImage = onPasteImage;

		editor.handleInput("\x1b[200~file:///tmp/image.png\x1b[201~");

		expect(onPasteImage).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("file:///tmp/image.png");
	});
});
