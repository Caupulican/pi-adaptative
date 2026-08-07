import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { getCellDimensions, resetCapabilitiesCache, setCellDimensions } from "../src/terminal-image.ts";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class InputRecorder implements Component {
	readonly inputs: string[] = [];

	render(): string[] {
		return [""];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

function withImageTerminal<T>(fn: () => T): T {
	const prevTermProgram = process.env.TERM_PROGRAM;
	const prevTerm = process.env.TERM;
	const prevGhosttyResourcesDir = process.env.GHOSTTY_RESOURCES_DIR;

	process.env.TERM_PROGRAM = "ghostty";
	delete process.env.TERM;
	delete process.env.GHOSTTY_RESOURCES_DIR;
	resetCapabilitiesCache();

	try {
		return fn();
	} finally {
		if (prevTermProgram === undefined) delete process.env.TERM_PROGRAM;
		else process.env.TERM_PROGRAM = prevTermProgram;
		if (prevTerm === undefined) delete process.env.TERM;
		else process.env.TERM = prevTerm;
		if (prevGhosttyResourcesDir === undefined) delete process.env.GHOSTTY_RESOURCES_DIR;
		else process.env.GHOSTTY_RESOURCES_DIR = prevGhosttyResourcesDir;
		resetCapabilitiesCache();
	}
}

describe("TUI cell size responses", () => {
	it("forwards bare escape even when a cell size query was sent at startup", () => {
		withImageTerminal(() => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const recorder = new InputRecorder();

			tui.setFocus(recorder);
			tui.start();

			terminal.sendInput("\x1b");

			assert.deepStrictEqual(recorder.inputs, ["\x1b"]);
			tui.stop();
		});
	});

	it("consumes cell size responses and still forwards later user input", () => {
		withImageTerminal(() => {
			setCellDimensions({ widthPx: 9, heightPx: 18 });

			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const recorder = new InputRecorder();

			tui.setFocus(recorder);
			tui.start();

			terminal.sendInput("\x1b[6;20;10t");
			assert.deepStrictEqual(recorder.inputs, []);
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 10, heightPx: 20 });

			terminal.sendInput("q");
			assert.deepStrictEqual(recorder.inputs, ["q"]);
			tui.stop();
		});
	});

	it("removes a batched cell size response while preserving unrelated input", () => {
		withImageTerminal(() => {
			setCellDimensions({ widthPx: 9, heightPx: 18 });

			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const recorder = new InputRecorder();

			tui.setFocus(recorder);
			tui.start();

			terminal.sendInput("a\x1b[6;20;10tb");
			assert.deepStrictEqual(recorder.inputs, ["ab"]);
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 10, heightPx: 20 });
			tui.stop();
		});
	});

	it("consumes cell size responses before public input listeners", () => {
		withImageTerminal(() => {
			setCellDimensions({ widthPx: 9, heightPx: 18 });

			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const observed: string[] = [];
			tui.addInputListener((data) => {
				observed.push(data);
				return { consume: true };
			});
			tui.start();

			terminal.sendInput("\x1b[6;20;10t");
			assert.deepStrictEqual(observed, []);
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 10, heightPx: 20 });
			tui.stop();
		});
	});

	it("preserves cell-size-shaped bytes inside bracketed paste while consuming a genuine response", () => {
		withImageTerminal(() => {
			setCellDimensions({ widthPx: 9, heightPx: 18 });

			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const recorder = new InputRecorder();
			tui.setFocus(recorder);
			tui.start();
			try {
				const paste = "\x1b[200~x\x1b[6;30;15ty\x1b[201~";
				terminal.sendInput(`a${paste}b\x1b[6;20;10tc`);

				assert.deepStrictEqual(recorder.inputs, [`a${paste}bc`]);
				assert.deepStrictEqual(getCellDimensions(), { widthPx: 10, heightPx: 20 });
			} finally {
				tui.stop();
			}
		});
	});

	it("stops intercepting cell size responses after the startup timeout", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			withImageTerminal(() => {
				setCellDimensions({ widthPx: 9, heightPx: 18 });

				const terminal = new VirtualTerminal(80, 24);
				const tui = new TUI(terminal);
				const recorder = new InputRecorder();
				tui.setFocus(recorder);
				tui.start();
				try {
					mock.timers.tick(2000);
					terminal.sendInput("\x1b[6;20;10t");

					assert.deepStrictEqual(recorder.inputs, ["\x1b[6;20;10t"]);
					assert.deepStrictEqual(getCellDimensions(), { widthPx: 9, heightPx: 18 });
				} finally {
					tui.stop();
				}
			});
		} finally {
			mock.timers.reset();
		}
	});

	it("cancels the previous cell size timeout before restarting the query", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			withImageTerminal(() => {
				setCellDimensions({ widthPx: 9, heightPx: 18 });

				const terminal = new VirtualTerminal(80, 24);
				const tui = new TUI(terminal);
				const recorder = new InputRecorder();
				tui.setFocus(recorder);
				tui.start();
				try {
					mock.timers.tick(1000);
					tui.stop();
					tui.start();
					mock.timers.tick(1000);

					terminal.sendInput("\x1b[6;20;10t");
					assert.deepStrictEqual(recorder.inputs, []);
					assert.deepStrictEqual(getCellDimensions(), { widthPx: 10, heightPx: 20 });
				} finally {
					tui.stop();
				}
			});
		} finally {
			mock.timers.reset();
		}
	});
});
