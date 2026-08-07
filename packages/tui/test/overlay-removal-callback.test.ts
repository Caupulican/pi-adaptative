import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class StaticOverlay implements Component {
	render(): string[] {
		return ["overlay"];
	}

	invalidate(): void {}
}

function createTui(): TUI {
	const tui = new TUI(new VirtualTerminal(80, 24));
	// Overlay lifecycle tests do not need to exercise asynchronous rendering.
	tui.requestRender = () => {};
	return tui;
}

describe("TUI overlay removal callbacks", () => {
	it("notifies exactly once when a scoped handle removes an overlay", () => {
		const tui = createTui();
		let removals = 0;
		let visibleDuringRemoval = true;
		const handle = tui.showOverlay(new StaticOverlay(), {
			onRemove: () => {
				removals += 1;
				visibleDuringRemoval = tui.hasOverlay();
			},
		});

		handle.hide();
		handle.hide();
		tui.hideOverlay();

		assert.strictEqual(removals, 1);
		assert.strictEqual(visibleDuringRemoval, false);
	});

	it("notifies exactly once when the generic stack operation removes an overlay", () => {
		const tui = createTui();
		let removals = 0;
		const handle = tui.showOverlay(new StaticOverlay(), {
			onRemove: () => {
				removals += 1;
			},
		});

		tui.hideOverlay();
		handle.hide();

		assert.strictEqual(removals, 1);
	});

	it("does not treat temporary visibility changes as removal", () => {
		const tui = createTui();
		let removals = 0;
		const handle = tui.showOverlay(new StaticOverlay(), {
			onRemove: () => {
				removals += 1;
			},
		});

		handle.setHidden(true);
		handle.setHidden(false);
		assert.strictEqual(removals, 0);

		handle.hide();
		assert.strictEqual(removals, 1);
	});
});
