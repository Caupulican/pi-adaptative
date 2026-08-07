import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { getAmbiguousWidthMode, setAmbiguousWidthMode, truncateToWidth, visibleWidth } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/**
 * Regression coverage for CJK-context consoles (e.g. cmd.exe with a CJK codepage/font)
 * where East Asian ambiguous characters render as two columns. Counting them as one
 * column made status lines auto-wrap, which desynced differential rendering and left
 * stale frames on screen.
 */

class InputRecorder implements Component {
	received: string[] = [];
	render(): string[] {
		return ["recorder"];
	}
	handleInput(data: string): void {
		this.received.push(data);
	}
	invalidate(): void {}
}

describe("ambiguous width mode", () => {
	afterEach(() => {
		setAmbiguousWidthMode(false);
	});

	it("counts ambiguous characters as narrow by default", () => {
		assert.strictEqual(getAmbiguousWidthMode(), false);
		assert.strictEqual(visibleWidth("·"), 1);
		assert.strictEqual(visibleWidth("…"), 1);
		assert.strictEqual(visibleWidth("●"), 1);
	});

	it("counts ambiguous characters as wide in wide mode, including cached strings", () => {
		// Prime the width cache in narrow mode, then flip: the cache must be invalidated.
		assert.strictEqual(visibleWidth("· tool-task-5 ·"), 15);
		setAmbiguousWidthMode(true);
		assert.strictEqual(visibleWidth("· tool-task-5 ·"), 17);
		assert.strictEqual(visibleWidth("·"), 2);
		assert.strictEqual(visibleWidth("…"), 2);
		assert.strictEqual(visibleWidth("●"), 2);
	});

	it("leaves ASCII and unambiguous CJK widths unchanged in wide mode", () => {
		const ascii = "python tool-task-5";
		const cjk = "漢字";
		assert.strictEqual(visibleWidth(cjk), 4);
		const asciiNarrow = visibleWidth(ascii);
		setAmbiguousWidthMode(true);
		assert.strictEqual(visibleWidth(ascii), asciiNarrow);
		assert.strictEqual(visibleWidth(cjk), 4);
	});

	it("truncates with wide ellipsis widths in wide mode", () => {
		setAmbiguousWidthMode(true);
		const truncated = truncateToWidth("● python · tool-task-5 · running", 10, "…");
		assert.ok(visibleWidth(truncated) <= 10);
	});

	it("enables wide mode from a wide cursor position report and repaints", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const recorder = new InputRecorder();
		tui.addChild(recorder);
		tui.setFocus(recorder);
		tui.start();
		try {
			await terminal.waitForRender();
			const redrawsBefore = tui.fullRedraws;

			// CPR: cursor ended at column 3 after the probe glyph => the glyph took 2 cells.
			terminal.sendInput("\x1b[1;3R");
			assert.strictEqual(getAmbiguousWidthMode(), true);
			assert.deepStrictEqual(recorder.received, [], "probe response must not reach components");

			await terminal.waitForRender();
			assert.ok(tui.fullRedraws > redrawsBefore, "mode flip must force a full repaint");

			// The probe is answered exactly once; later CPR-shaped input is normal key input.
			terminal.sendInput("\x1b[1;3R");
			assert.deepStrictEqual(recorder.received, ["\x1b[1;3R"]);
		} finally {
			tui.stop();
		}
	});

	it("keeps narrow mode on a narrow cursor position report", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const recorder = new InputRecorder();
		tui.addChild(recorder);
		tui.setFocus(recorder);
		tui.start();
		try {
			await terminal.waitForRender();

			// CPR: cursor ended at column 2 => the probe glyph took 1 cell.
			terminal.sendInput("\x1b[1;2R");
			assert.strictEqual(getAmbiguousWidthMode(), false);
			assert.deepStrictEqual(recorder.received, [], "probe response must not reach components");
		} finally {
			tui.stop();
		}
	});

	it("honors the PI_AMBIGUOUS_WIDTH override without probing", async () => {
		process.env.PI_AMBIGUOUS_WIDTH = "wide";
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const recorder = new InputRecorder();
		tui.addChild(recorder);
		tui.setFocus(recorder);
		tui.start();
		try {
			await terminal.waitForRender();
			assert.strictEqual(getAmbiguousWidthMode(), true);

			// No probe was sent, so CPR-shaped input goes straight to the component.
			terminal.sendInput("\x1b[1;3R");
			assert.deepStrictEqual(recorder.received, ["\x1b[1;3R"]);
		} finally {
			tui.stop();
			delete process.env.PI_AMBIGUOUS_WIDTH;
		}
	});
});
