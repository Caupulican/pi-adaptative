import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { pasteIntoEditor, wrapBracketedPaste } from "../src/bracketed-paste.ts";
import { Editor } from "../src/components/editor.ts";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { TUI } from "../src/tui.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createEditor(): Editor {
	return new Editor(new TUI(new VirtualTerminal(80, 24)), defaultEditorTheme);
}

describe("direct editor paste", () => {
	const originalKeybindings = getKeybindings();
	afterEach(() => setKeybindings(originalKeybindings));

	for (const jumpKey of ["\x1d", "\x1b\x1d", "\x07", "\x1b\x07"]) {
		for (const direct of [false, true]) {
			it(`cancels pending jump ${JSON.stringify(jumpKey)} on ${direct ? "direct" : "terminal"} paste`, () => {
				if (jumpKey.includes("\x07")) {
					setKeybindings(
						new KeybindingsManager(TUI_KEYBINDINGS, {
							"tui.editor.jumpForward": "ctrl+g",
							"tui.editor.jumpBackward": "ctrl+alt+g",
						}),
					);
				}
				const editor = createEditor();
				editor.setText("abc");
				editor.handleInput(jumpKey);
				if (direct) pasteIntoEditor(editor, "XYZ");
				else editor.handleInput(wrapBracketedPaste("XYZ"));
				editor.handleInput("q");
				assert.equal(editor.getText(), "abcXYZq");
			});
		}
	}

	it("ends jump mode even when the paste callback consumes an empty payload", () => {
		const editor = createEditor();
		editor.setText("abc");
		editor.handleInput("\x1d");
		let pasted: string | undefined;
		editor.onPaste = (text) => {
			pasted = text;
			return true;
		};
		pasteIntoEditor(editor, "");
		editor.handleInput("q");
		assert.equal(pasted, "");
		assert.equal(editor.getText(), "abcq");
	});

	it("preserves normalization, change notification, large-paste expansion and atomic undo", () => {
		const editor = createEditor();
		editor.setText("prefix");
		const changes: string[] = [];
		editor.onChange = (text) => changes.push(text);
		const payload = "\tline\r\n".repeat(12);
		pasteIntoEditor(editor, payload);
		assert.equal(changes.length, 1);
		assert.match(editor.getText(), /\[paste #1 /);
		assert.equal(editor.getExpandedText(), `prefix${"    line\n".repeat(12)}`);
		editor.handleInput("\x1b[45;5u");
		assert.equal(editor.getText(), "prefix");
		editor.handleInput("q");
		assert.equal(editor.getText(), "prefixq");
	});

	it("keeps terminal framing at the adapter for targets without direct paste", () => {
		const inputs: string[] = [];
		pasteIntoEditor({ handleInput: (data) => inputs.push(data) }, "line\nnext");
		assert.deepEqual(inputs, ["\x1b[200~line\nnext\x1b[201~"]);
	});
});
