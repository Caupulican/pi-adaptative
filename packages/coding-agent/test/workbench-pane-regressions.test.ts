import { Container, CURSOR_MARKER, Editor, Text, TUI } from "@caupulican/pi-tui";
import xterm from "@xterm/headless";
import { beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { WorkbenchComponent } from "../src/modes/interactive/components/workbench.ts";
import { WorkbenchPane } from "../src/modes/interactive/components/workbench-pane.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { WorkbenchController } from "../src/modes/interactive/workbench-controller.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function setup(columns = 60, rows = 20) {
	const terminal = new VirtualTerminal(columns, rows);
	const ui = new TUI(terminal, true);
	const editor = new Editor(ui, getEditorTheme());
	const dock = new Container();
	dock.addChild(editor);
	const chat = new Container();
	const view = new WorkbenchComponent({
		conversation: chat,
		editor: dock,
		dock: [new Text("status", 0, 0)],
		brand: "pi",
		viewportRows: () => terminal.rows,
	});
	const controller = new WorkbenchController(view, {
		keybindings: new KeybindingsManager(),
		isInteractive: () => true,
		requestRender() {},
		messages: () => [],
		copy: async () => {},
		notice() {},
	});
	ui.addChild(view);
	ui.setFocus(editor);
	return { terminal, ui, editor, chat, view, controller };
}

describe("Workbench review regressions", () => {
	beforeAll(() => initTheme("dark"));
	it.each(["short", "0123456789"])("contains pane styles when rendering %s content", async (content) => {
		const terminal = new xterm.Terminal({ cols: 40, rows: 3, allowProposedApi: true });
		try {
			const left = new WorkbenchPane().render("left", "", [`\x1b[1;7;31m${content}\x1b[0m`], 0, 0, 10, 2)[1]!;
			const right = new WorkbenchPane().render("right", "", ["RIGHT"], 12, 0, 10, 2)[1]!;
			await new Promise<void>((resolve) => terminal.write(`${left}  ${right}`, resolve));
			const row = terminal.buffer.active.getLine(0)!;
			expect(row.getCell(1)!.isInverse()).not.toBe(0);
			const neighbor = row.getCell(13)!;
			expect(neighbor.getChars()).toBe("R");
			expect(neighbor.isInverse()).toBe(0);
			expect(neighbor.isBold()).toBe(0);
			expect(neighbor.isFgDefault()).toBe(true);
		} finally {
			terminal.dispose();
		}
	});
	it("keeps all inspector evidence reachable in a combined narrow pane", () => {
		const { view, controller } = setup();
		view.setInspector([{ title: "Work plan", body: ["failed verifier", "active step"] }]);
		controller.record(new Text("execution result", 0, 0), false);
		const seen: string[] = [];
		for (let i = 0; i < 10; i++) {
			seen.push(
				stripAnsi(
					view
						.render(60)
						.slice(view.upperTop, view.upperTop + view.upperHeight)
						.join("\n"),
				),
			);
			view.scrollUpper(1, view.upperTop + 1, 1);
		}
		expect(seen.join("\n")).toContain("failed verifier");
		expect(seen.join("\n")).toContain("active step");
		expect(seen.join("\n")).toContain("execution result");
		controller.dispose();
	});
	it("prioritizes a folded failure receipt over the work heading in a one-row combined pane", () => {
		const { view, controller } = setup(60, 30);
		view.setInspector([{ title: "Work plan", body: ["active step"] }]);
		controller.record(new Text("failed output", 0, 0), true);
		controller.complete();
		expect(
			stripAnsi(
				view
					.render(60)
					.slice(view.upperTop, view.upperTop + view.upperHeight)
					.join("\n"),
			),
		).toContain("1 failure receipts");
		controller.dispose();
	});
	it("never skips evidence rows when wheel increments exceed a one-row viewport", () => {
		const pane = new WorkbenchPane();
		const lines = Array.from({ length: 5 }, (_, i) => `work${i}`);
		const seen = new Set<string>();
		for (let i = 0; i < 5; i++) {
			seen.add(stripAnsi(pane.render("Work plan", "", lines, 0, 0, 30, 2)[1]!).trim());
			pane.scrollAt(1, 1, 3);
		}
		for (const line of lines) expect([...seen].join("\n")).toContain(line);
	});
	it("keeps the same evidence scroll position across unrelated receipts, resets for new evidence", () => {
		const { view, controller } = setup(100, 40);
		controller.record(new Text(Array.from({ length: 20 }, (_, i) => `diff${i}`).join("\n"), 0, 0), false);
		view.render(100);
		view.scrollUpper(50, view.upperTop + 1, -3);
		view.scrollUpper(50, view.upperTop + 1, -3);
		const before = view
			.render(100)
			.map(stripAnsi)
			.slice(view.upperTop + 1, view.upperTop + view.upperHeight);
		expect(before.join("\n")).not.toContain("diff19");
		controller.record(undefined, false);
		const after = view
			.render(100)
			.map(stripAnsi)
			.slice(view.upperTop + 1, view.upperTop + view.upperHeight);
		expect(after).toEqual(before);
		controller.record(new Text("new evidence", 0, 0), false);
		expect(stripAnsi(view.render(100).join("\n"))).toContain("new evidence");
		controller.dispose();
	});
	it("shows every preview of the cycle in order and follows the newest until the operator scrolls up", () => {
		const { view, controller } = setup(100, 40);
		for (const name of ["first", "second", "third"]) controller.record(new Text(`${name} result`, 0, 0), false);
		let text = stripAnsi(
			view
				.render(100)
				.slice(view.upperTop, view.upperTop + view.upperHeight)
				.join("\n"),
		);
		expect(text).toMatch(/first result[\s\S]*second result[\s\S]*third result/);
		expect(text).toContain("3 actions");
		controller.record(new Text(Array.from({ length: 30 }, (_, i) => `tail ${i}`).join("\n"), 0, 0), false);
		text = stripAnsi(
			view
				.render(100)
				.slice(view.upperTop, view.upperTop + view.upperHeight)
				.join("\n"),
		);
		expect(text).toContain("tail 29");
		expect(text).not.toContain("first result");
		view.scrollUpper(50, view.upperTop + 1, -3);
		text = stripAnsi(
			view
				.render(100)
				.slice(view.upperTop, view.upperTop + view.upperHeight)
				.join("\n"),
		);
		expect(text).not.toContain("tail 29");
		// New evidence re-follows: the newest result is always the first thing to see.
		controller.record(new Text("newest", 0, 0), false);
		text = stripAnsi(
			view
				.render(100)
				.slice(view.upperTop, view.upperTop + view.upperHeight)
				.join("\n"),
		);
		expect(text).toContain("newest");
		controller.dispose();
	});
	it("opens a replacement shell at its own command instead of an earlier shell's offset", () => {
		const { view, chat, ui, controller } = setup(100, 40);
		for (const command of ["FIRST", "SECOND"]) {
			const shell = new BashExecutionComponent(command, ui);
			shell.appendOutput(Array.from({ length: 12 }, (_, i) => `output${i}`).join("\n"));
			shell.setComplete(0, false);
			chat.addChild(shell);
			const frame = stripAnsi(view.render(100).join("\n"));
			expect(frame).toContain(command);
			view.scrollUpper(1, view.upperTop + 1, 3);
			view.scrollUpper(1, view.upperTop + 1, 3);
		}
		controller.dispose();
	});
	it.each([
		[80, 8, "p"],
		[40, 12, "one\ntwo\nthree\nfour\nfive"],
		[2, 24, "p"],
		[3, 24, "p"],
	] as const)("keeps native input anchored and cursor marked at %i×%i", async (columns, rows, text) => {
		const { view, editor, terminal, ui, controller } = setup(columns, rows);
		editor.setText(text);
		const frame = view.render(columns);
		expect(frame).toHaveLength(rows);
		expect(frame.join("\n")).toContain(CURSOR_MARKER);
		const inputRow = frame.findIndex((line) => line.includes(CURSOR_MARKER));
		expect(inputRow).toBe(rows - 2);
		if (columns >= 40) expect(stripAnsi(frame.join("\n"))).toContain("status");
		ui.start();
		try {
			await terminal.waitForRender();
			expect(terminal.getCursorPosition().y).toBe(inputRow);
		} finally {
			ui.stop();
			controller.dispose();
		}
	});
});
