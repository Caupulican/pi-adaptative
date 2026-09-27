import assert from "node:assert";
import { describe, it } from "node:test";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("TUI input listener generations", () => {
	it("admits listeners added during input on the next event", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const observed: string[] = [];
		const late = (data: string) => {
			observed.push(`late:${data}`);
			return { data: `${data}:late` };
		};
		tui.addInputListener((data) => {
			observed.push(`first:${data}`);
			tui.addInputListener(late);
			return { data: `${data}:first` };
		});
		tui.addInputListener((data) => {
			observed.push(`existing:${data}`);
			return { data: `${data}:existing` };
		});
		tui.start();
		try {
			terminal.sendInput("a");
			assert.deepStrictEqual(observed, ["first:a", "existing:a:first"]);

			observed.length = 0;
			terminal.sendInput("b");
			assert.deepStrictEqual(observed, ["first:b", "existing:b:first", "late:b:first:existing"]);
		} finally {
			tui.stop();
		}
	});

	it("removes listeners from the next event without truncating the current generation", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const observed: string[] = [];
		let removeSecond: () => void = () => undefined;
		tui.addInputListener((data) => {
			observed.push(`first:${data}`);
			removeSecond();
		});
		removeSecond = tui.addInputListener((data) => {
			observed.push(`second:${data}`);
		});
		tui.start();
		try {
			terminal.sendInput("a");
			assert.deepStrictEqual(observed, ["first:a", "second:a"]);

			observed.length = 0;
			terminal.sendInput("b");
			assert.deepStrictEqual(observed, ["first:b"]);
		} finally {
			tui.stop();
		}
	});
});
