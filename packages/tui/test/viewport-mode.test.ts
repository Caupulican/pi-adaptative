import assert from "node:assert/strict";
import { test } from "node:test";
import { TerminalViewportMode } from "../src/viewport-mode.ts";

test("viewport mode pairs enter/leave across restart and repeated stops without touching the mouse", () => {
	const writes: string[] = [];
	const mode = new TerminalViewportMode((data) => writes.push(data));
	mode.enter();
	mode.enter();
	mode.leave();
	mode.leave();
	mode.enter();
	mode.leave();
	assert.equal(writes.length, 4);
	assert.ok(writes[0]?.includes("\x1b[?1049h"));
	assert.ok(writes[1]?.endsWith("\x1b[?1049l"));
	assert.equal(
		writes.some((write) => write.includes("?1002") || write.includes("?1006")),
		false,
		"the terminal keeps the mouse unless capture is requested",
	);
	assert.equal(mode.mouseTracking, false);
});

test("mouse capture requested up front is enabled with the screen and released before it", () => {
	const writes: string[] = [];
	const mode = new TerminalViewportMode((data) => writes.push(data), { mouse: true });
	mode.enter();
	mode.leave();
	assert.deepEqual(writes, ["\x1b[?1049h\x1b[H", "\x1b[?1002h\x1b[?1006h", "\x1b[?1002l\x1b[?1006l", "\x1b[?1049l"]);
	assert.equal(mode.mouseTracking, true);
});

test("toggling capture on a live screen writes the mode change once, and a toggle before enter waits for it", () => {
	const writes: string[] = [];
	const mode = new TerminalViewportMode((data) => writes.push(data));
	mode.setMouseTracking(true);
	assert.equal(writes.length, 0, "nothing is written before the screen is entered");
	mode.enter();
	assert.deepEqual(writes, ["\x1b[?1049h\x1b[H", "\x1b[?1002h\x1b[?1006h"]);
	mode.setMouseTracking(true);
	assert.equal(writes.length, 2, "re-enabling an active capture is a no-op");
	mode.setMouseTracking(false);
	assert.equal(writes.at(-1), "\x1b[?1002l\x1b[?1006l");
	assert.equal(mode.mouseTracking, false);
	mode.leave();
	assert.equal(writes.at(-1), "\x1b[?1049l");
	assert.equal(writes.filter((write) => write.includes("?1002l")).length, 1, "leave releases only what is held");
});
