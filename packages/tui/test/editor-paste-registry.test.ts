import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TUI } from "../src/tui.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createEditor(): Editor {
	return new Editor(new TUI(new VirtualTerminal(80, 24)), defaultEditorTheme);
}

function largePaste(tag: string): string {
	return Array.from({ length: 12 }, (_, index) => `${tag}${index}`).join("\n");
}

function paste(editor: Editor, text: string): void {
	editor.handleInput(`\x1b[200~${text}\x1b[201~`);
}

function submit(editor: Editor): string {
	let submitted = "";
	editor.onSubmit = (text) => {
		submitted = text;
	};
	editor.handleInput("\r");
	return submitted;
}

describe("editor paste registry", () => {
	it("restores paste content when undo restores a deleted marker", () => {
		const editor = createEditor();
		const content = largePaste("alpha");
		paste(editor, content);
		editor.handleInput("\x7f");
		editor.handleInput("\x1b[45;5u");

		assert.equal(submit(editor), content);
	});

	it("keeps content bound to its marker when deleting an earlier out-of-order marker", () => {
		const editor = createEditor();
		const alpha = largePaste("alpha");
		const beta = largePaste("beta");
		const gamma = largePaste("gamma");
		paste(editor, alpha);
		editor.handleInput("\x01");
		paste(editor, beta);
		editor.handleInput("\x01");
		paste(editor, gamma);
		editor.handleInput("\x05");
		editor.handleInput("\x7f");

		assert.equal(submit(editor), gamma + beta);
	});

	it("restores both text and paste content when undoing setText", () => {
		const editor = createEditor();
		const content = largePaste("alpha");
		paste(editor, content);
		editor.setText("replacement");
		editor.handleInput("\x1b[45;5u");

		assert.equal(submit(editor), content);
	});
});
