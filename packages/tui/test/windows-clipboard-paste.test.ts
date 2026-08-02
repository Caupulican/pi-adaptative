import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { StdinBuffer } from "../src/stdin-buffer.ts";
import { TUI } from "../src/tui.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("unframed Windows clipboard input", () => {
	it("inserts multiline text atomically and renders a compact character-count marker", () => {
		const editor = new Editor(new TUI(new VirtualTerminal(80, 24)), defaultEditorTheme);
		const buffer = new StdinBuffer({ timeout: 10, detectUnframedPaste: true });
		let submitted: string | undefined;
		editor.onSubmit = (value) => {
			submitted = value;
		};
		buffer.on("data", (sequence) => editor.handleInput(sequence));
		buffer.on("paste", (content) => editor.handleInput(`\x1b[200~${content}\x1b[201~`));
		const pastedText = Array.from({ length: 5 }, (_, index) => `${index}:${"x".repeat(260)}`).join("\r\n");

		buffer.process(pastedText);

		assert.strictEqual(submitted, undefined);
		assert.match(editor.getText(), /^\[paste #1 \d+ chars\]$/);
		assert.strictEqual(editor.getExpandedText(), pastedText.replace(/\r\n/g, "\n"));
	});
});
