import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TUI } from "../src/tui.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createEditor(): Editor {
	return new Editor(new TUI(new VirtualTerminal(80, 24)), defaultEditorTheme);
}

function submit(editor: Editor, text: string): void {
	editor.setText(text);
	editor.handleInput("\r");
}

describe("Editor submitted prompt history", () => {
	it("preserves earlier accepted prompts across later submissions", () => {
		const editor = createEditor();
		editor.onSubmit = (text) => editor.addToHistory(text);

		submit(editor, "first prompt");
		submit(editor, "second prompt");

		editor.handleInput("\x1b[A");
		assert.strictEqual(editor.getText(), "second prompt");
		editor.handleInput("\x1b[A");
		assert.strictEqual(editor.getText(), "first prompt");
	});

	it("keeps multiline submissions navigable and restores the empty draft", () => {
		const editor = createEditor();
		editor.onSubmit = (text) => editor.addToHistory(text);

		submit(editor, "first line\nsecond line");
		submit(editor, "latest");

		editor.handleInput("\x1b[A");
		assert.strictEqual(editor.getText(), "latest");
		editor.handleInput("\x1b[A");
		assert.strictEqual(editor.getText(), "first line\nsecond line");
		editor.handleInput("\x1b[B");
		editor.handleInput("\x1b[B");
		editor.handleInput("\x1b[B");
		editor.handleInput("\x1b[B");
		assert.strictEqual(editor.getText(), "");
	});
});
