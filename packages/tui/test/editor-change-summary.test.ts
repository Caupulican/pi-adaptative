import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import type { EditorChangeSummary } from "../src/editor-component.ts";
import { TUI } from "../src/tui.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createEditor(): Editor {
	return new Editor(new TUI(new VirtualTerminal(80, 24)), defaultEditorTheme);
}

describe("editor structural change summaries", () => {
	it("notifies a summary-only observer without flattening the document", () => {
		const editor = createEditor();
		editor.setText(`  !command\n${"large line\n".repeat(10_000)}`);
		const originalGetText = editor.getText.bind(editor);
		let getTextCalls = 0;
		editor.getText = () => {
			getTextCalls += 1;
			return originalGetText();
		};
		let summary: EditorChangeSummary | undefined;
		editor.onChangeSummary = (value) => {
			summary = value;
		};

		editor.handleInput("x");

		assert.deepStrictEqual(summary, { firstNonWhitespace: "!" });
		assert.strictEqual(getTextCalls, 0);
	});

	it("preserves the legacy full-text callback when a consumer requests it", () => {
		const editor = createEditor();
		let changed = "";
		editor.onChange = (text) => {
			changed = text;
		};

		editor.setText("alpha\nbeta");
		editor.handleInput("!");

		assert.strictEqual(changed, "alpha\nbeta!");
	});

	it("tracks the first non-whitespace character across set, clear, and undo", () => {
		const editor = createEditor();
		const seen: Array<string | undefined> = [];
		editor.onChangeSummary = (summary) => seen.push(summary.firstNonWhitespace);

		editor.setText(" \n\t !command");
		editor.clear();
		editor.handleInput("x");
		editor.handleInput("\x1b[45;5u");

		assert.deepStrictEqual(seen, ["!", undefined, "x", undefined]);
	});
});
