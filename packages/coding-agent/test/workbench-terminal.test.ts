import { type Component, Container, CURSOR_MARKER, Text, TUI, visibleWidth } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { WorkbenchComponent } from "../src/modes/interactive/components/workbench.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("Workbench terminal rendering", () => {
	beforeAll(() => initTheme("dark"));
	it("keeps pane boundaries and hardware cursor through completion, resize and overlay focus restoration", async () => {
		const terminal = new VirtualTerminal(110, 30);
		terminal.write("\x1b[?1049h\x1b[H");
		const ui = new TUI(terminal, true);
		const chat = new Container();
		chat.addChild(new Text("conversation remains visible", 0, 0));
		let input = "prompt";
		const editor: Component = {
			render: () => [`> ${input}${CURSOR_MARKER}`],
			handleInput: (data) => {
				input += data;
				ui.requestRender();
			},
			invalidate() {},
		};
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const view = new WorkbenchComponent({
			conversation: chat,
			editor: editorContainer,
			dock: [new Text("status at bottom", 0, 0)],
			viewportRows: () => terminal.rows,
		});
		view.setInspector(["Work", "current step", "Team", "running verifier"]);
		view.setExecution(new Text("Edit file.ts\n-old\n+new", 0, 0));
		ui.addChild(view);
		ui.setFocus(editor);
		ui.start();
		try {
			await terminal.waitForRender();
			expect(terminal.getViewport().at(-2)).toContain("> prompt");
			expect(terminal.getCursorPosition()).toEqual({ x: 9, y: 28 });
			const start = view.conversationTop;
			view.setExecution(new Text(Array.from({ length: 200 }, (_, i) => `tool output ${i}`).join("\n"), 0, 0));
			ui.requestRender();
			await terminal.waitForRender();
			expect(view.conversationTop).toBe(start);
			expect(terminal.getViewport()[0]).toMatch(/^┌.*┐┌.*┐$/);
			expect(terminal.getViewport()[start - 1]).toMatch(/^┌.*Conversation.*┐$/);
			expect(terminal.getViewport()[start + view.conversationHeight]).toMatch(/^└─+┘$/);
			expect(terminal.getViewport().at(-1)).toMatch(/^└─+┘$/);
			view.setInspector(["Work complete"]);
			view.setExecution(undefined);
			ui.requestRender();
			await terminal.waitForRender();
			expect(terminal.getViewport()[1]).toContain("Work complete");
			expect(terminal.getViewport()[3]).toContain("Conversation");
			const overlay = ui.showOverlay(new Text("question dialog", 0, 0));
			await terminal.waitForRender();
			overlay.hide();
			terminal.sendInput("x");
			await terminal.waitForRender();
			expect(terminal.getViewport().at(-2)).toContain("> promptx");
			for (const [columns, rows] of [
				[60, 20],
				[140, 45],
				[80, 24],
			]) {
				terminal.resize(columns!, rows!);
				await terminal.waitForRender();
				expect(terminal.getViewport().at(-2)).toContain("> promptx");
				expect(terminal.getViewport().at(-1)).toMatch(/^└─+┘$/);
				expect(terminal.getCursorPosition()).toEqual({ x: 10, y: rows! - 2 });
				for (const line of terminal.getViewport()) expect(visibleWidth(line)).toBeLessThanOrEqual(columns!);
			}
		} finally {
			ui.stop();
		}
	});
});
