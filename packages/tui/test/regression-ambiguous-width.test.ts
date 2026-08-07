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

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

class MutableLine implements Component {
	text = "one";

	render(): string[] {
		return [this.text];
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
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TUI(terminal);
		const recorder = new InputRecorder();
		tui.addChild(recorder);
		tui.setFocus(recorder);
		tui.start();
		try {
			await terminal.waitForRender();
			const redrawsBefore = tui.fullRedraws;
			terminal.writes.length = 0;

			// CPR: cursor ended at column 3 after the probe glyph => the glyph took 2 cells.
			terminal.sendInput("\x1b[1;3R");
			assert.strictEqual(getAmbiguousWidthMode(), true);
			assert.deepStrictEqual(recorder.received, [], "probe response must not reach components");

			await terminal.waitForRender();
			assert.ok(tui.fullRedraws > redrawsBefore, "mode flip must force a full repaint");
			assert.ok(
				terminal.writes.every((write) => !write.includes("\x1b[3J")),
				"width correction must preserve saved scrollback",
			);

			// The probe is answered exactly once; later CPR-shaped input is normal key input.
			terminal.sendInput("\x1b[1;3R");
			assert.deepStrictEqual(recorder.received, ["\x1b[1;3R"]);
		} finally {
			tui.stop();
		}
	});

	it("applies a narrow cursor position report after a previous wide result and repaints", async () => {
		setAmbiguousWidthMode(true);
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new InputRecorder());
		tui.start();
		try {
			await terminal.waitForRender();
			const redrawsBefore = tui.fullRedraws;
			terminal.writes.length = 0;

			terminal.sendInput("\x1b[1;2R");
			assert.strictEqual(getAmbiguousWidthMode(), false);
			await terminal.waitForRender();
			assert.ok(tui.fullRedraws > redrawsBefore, "mode flip must force a full repaint");
			assert.ok(
				terminal.writes.every((write) => !write.includes("\x1b[3J")),
				"width correction must preserve saved scrollback",
			);
		} finally {
			tui.stop();
		}
	});

	it("keeps public forced redraws destructive to saved scrollback", async () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new InputRecorder());
		tui.start();
		try {
			terminal.sendInput("\x1b[1;2R");
			await terminal.waitForRender();
			terminal.writes.length = 0;

			tui.requestRender(true);
			await terminal.waitForRender();
			assert.ok(
				terminal.writes.some((write) => write.includes("\x1b[3J")),
				"the public force-redraw contract must still clear saved scrollback",
			);
		} finally {
			tui.stop();
		}
	});

	it("consumes probe responses before public input listeners", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const observed: string[] = [];
		tui.addInputListener((data) => {
			observed.push(data);
			return { consume: true };
		});
		tui.start();
		try {
			terminal.sendInput("\x1b[1;3R");
			assert.strictEqual(getAmbiguousWidthMode(), true);
			assert.deepStrictEqual(observed, []);
		} finally {
			tui.stop();
		}
	});

	it("removes a batched probe response while preserving unrelated input", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const recorder = new InputRecorder();
		tui.addChild(recorder);
		tui.setFocus(recorder);
		tui.start();
		try {
			terminal.sendInput(`a\x1b[1;3Rb`);
			assert.strictEqual(getAmbiguousWidthMode(), true);
			assert.deepStrictEqual(recorder.received, ["ab"]);
		} finally {
			tui.stop();
		}
	});

	it("preserves CPR-shaped bytes inside bracketed paste while consuming a genuine response", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const recorder = new InputRecorder();
		tui.addChild(recorder);
		tui.setFocus(recorder);
		tui.start();
		try {
			const paste = "\x1b[200~x\x1b[1;2Ry\x1b[201~";
			terminal.sendInput(`a${paste}b\x1b[1;3Rc`);

			assert.strictEqual(getAmbiguousWidthMode(), true);
			assert.deepStrictEqual(recorder.received, [`a${paste}bc`]);
		} finally {
			tui.stop();
		}
	});

	it("skips many protected CPR ranges without altering framed paste", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const recorder = new InputRecorder();
		tui.addChild(recorder);
		tui.setFocus(recorder);
		tui.start();
		try {
			const pasteFrames = Array.from({ length: 512 }, (_, index) => `\x1b[200~${index}:\x1b[1;2R\x1b[201~`).join("");
			terminal.sendInput(`${pasteFrames}\x1b[1;3R`);

			assert.strictEqual(getAmbiguousWidthMode(), true);
			assert.deepStrictEqual(recorder.received, [pasteFrames]);
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

	it("repaints when an override changes the mode on restart", async () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new InputRecorder());
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[1;3R");
			await terminal.waitForRender();
			tui.stop();

			process.env.PI_AMBIGUOUS_WIDTH = "narrow";
			const redrawsBefore = tui.fullRedraws;
			terminal.writes.length = 0;
			tui.start();
			await terminal.waitForRender();

			assert.strictEqual(getAmbiguousWidthMode(), false);
			assert.ok(tui.fullRedraws > redrawsBefore, "override changes must force a full repaint");
			assert.ok(terminal.writes.every((write) => !write.includes("\x1b[3J")));
		} finally {
			tui.stop();
			delete process.env.PI_AMBIGUOUS_WIDTH;
		}
	});

	it("performs a clean viewport-only repaint on a same-mode restart", async () => {
		process.env.PI_AMBIGUOUS_WIDTH = "narrow";
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TUI(terminal);
		const line = new MutableLine();
		tui.addChild(line);
		tui.start();
		try {
			await terminal.waitForRender();
			tui.stop();

			terminal.writes.length = 0;
			tui.start();
			await terminal.waitForRender();

			assert.ok(terminal.writes.some((write) => write.includes("\x1b[2J\x1b[H")));
			assert.ok(terminal.writes.every((write) => !write.includes("\x1b[3J")));

			line.text = "two";
			tui.requestRender();
			await terminal.waitForRender();
			assert.strictEqual(terminal.getViewport()[0], "two");
		} finally {
			tui.stop();
			delete process.env.PI_AMBIGUOUS_WIDTH;
		}
	});

	it("restarts after stop cancels a queued render", async () => {
		process.env.PI_AMBIGUOUS_WIDTH = "narrow";
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TUI(terminal);
		const line = new MutableLine();
		tui.addChild(line);
		tui.start();
		try {
			await terminal.waitForRender();
			line.text = "two";
			tui.requestRender();
			tui.stop();
			await new Promise<void>((resolve) => process.nextTick(resolve));

			terminal.writes.length = 0;
			tui.start();
			await terminal.waitForRender();

			assert.ok(terminal.writes.some((write) => write.includes("\x1b[?2026h")));
			assert.ok(terminal.writes.every((write) => !write.includes("\x1b[3J")));
			assert.strictEqual(terminal.getViewport()[0], "two");
		} finally {
			tui.stop();
			delete process.env.PI_AMBIGUOUS_WIDTH;
		}
	});

	it("drops a canceled destructive redraw before a width-correction restart", async () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new InputRecorder());
		tui.start();
		try {
			await terminal.waitForRender();
			tui.requestRender(true);
			tui.stop();
			await new Promise<void>((resolve) => process.nextTick(resolve));

			process.env.PI_AMBIGUOUS_WIDTH = "wide";
			terminal.writes.length = 0;
			tui.start();
			await terminal.waitForRender();

			assert.strictEqual(getAmbiguousWidthMode(), true);
			assert.ok(terminal.writes.some((write) => write.includes("\x1b[2J\x1b[H")));
			assert.ok(terminal.writes.every((write) => !write.includes("\x1b[3J")));
		} finally {
			tui.stop();
			delete process.env.PI_AMBIGUOUS_WIDTH;
		}
	});
});
