import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TUI } from "../src/tui.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createEditor(): Editor {
	return new Editor(new TUI(new VirtualTerminal(80, 24)), defaultEditorTheme, { privateContent: true });
}

describe("Editor private-content mode", () => {
	it("keeps a large multiline paste visible and submits it without trimming or tab expansion", () => {
		const editor = createEditor();
		const document = `  API_TOKEN=value\n${Array.from({ length: 11 }, (_, index) => `LINE_${index}=x\t${index}`).join("\n")}\n`;
		let submitted: string | undefined;
		editor.onSubmit = (text) => {
			submitted = text;
		};

		editor.handleInput(`\x1b[200~${document}\x1b[201~`);
		assert.strictEqual(editor.getText(), document);
		assert.ok(editor.render(80).join("\n").includes("LINE_9=x"));
		assert.ok(!editor.getText().includes("[paste #"));

		editor.handleInput("\r");
		assert.strictEqual(submitted, document);
		assert.strictEqual(editor.getText(), "");
	});

	it("does not retain private content in undo, kill-ring, or prompt history", () => {
		const editor = createEditor();
		editor.addToHistory("history-secret");
		editor.handleInput("private-secret");
		editor.handleInput("\x15"); // Ctrl+U
		assert.strictEqual(editor.getText(), "");

		editor.handleInput("\x19"); // Ctrl+Y
		editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
		editor.handleInput("\x1b[A"); // Up (history)
		assert.strictEqual(editor.getText(), "");
	});
});
