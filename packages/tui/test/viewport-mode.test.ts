import assert from "node:assert/strict";
import { test } from "node:test";
import { TerminalViewportMode } from "../src/viewport-mode.ts";

test("viewport mode pairs enter/leave across restart and repeated stops", () => {
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
	assert.ok(writes[0]?.includes("\x1b[?1002h\x1b[?1006h"));
	assert.ok(writes[1]?.includes("\x1b[?1002l\x1b[?1006l"));
	assert.ok(writes[1]?.endsWith("\x1b[?1049l"));
});
