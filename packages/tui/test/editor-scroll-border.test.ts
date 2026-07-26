import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Editor } from "../src/components/editor.ts";
import { TUI } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("editor scroll borders", () => {
	it("keeps both indicators styled and within a narrow terminal", () => {
		const width = 10;
		const borderColor = (text: string) => `\x1b[35m${text}\x1b[39m`;
		const editor = new Editor(new TUI(new VirtualTerminal(width, 24)), {
			...defaultEditorTheme,
			borderColor,
		});
		editor.setText(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));
		editor.render(width);
		for (let index = 0; index < 10; index++) editor.handleInput("\x1b[A");

		const lines = editor.render(width);
		const topBorder = lines[0]!;
		const bottomBorder = lines.at(-1)!;
		assert.match(stripVTControlCharacters(topBorder), /^─── ↑/);
		assert.match(stripVTControlCharacters(bottomBorder), /^─── ↓/);
		assert.equal(topBorder, borderColor(stripVTControlCharacters(topBorder)));
		assert.equal(bottomBorder, borderColor(stripVTControlCharacters(bottomBorder)));
		for (const line of lines) assert.equal(visibleWidth(line), width);
	});
});
