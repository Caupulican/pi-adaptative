import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from "../src/bracketed-paste.ts";
import { StdinBuffer } from "../src/stdin-buffer.ts";

describe("framed paste lifecycle", () => {
	for (const gap of [499, 501, 60_000]) {
		it(`keeps a delayed Enter inside paste after ${gap} ms`, (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			const buffer = new StdinBuffer();
			t.after(() => buffer.destroy());
			const keys: string[] = [];
			const pastes: string[] = [];
			buffer.on("data", (data) => keys.push(data));
			buffer.on("paste", (data) => pastes.push(data));
			buffer.process(`${BRACKETED_PASTE_START}synthetic`);
			t.mock.timers.tick(gap);
			buffer.process(`\r${BRACKETED_PASTE_END}`);
			assert.deepEqual(keys, []);
			assert.equal(pastes.join(""), "synthetic\r");
			buffer.process("\r");
			assert.deepEqual(keys, ["\r"]);
		});
	}

	for (let split = 1; split < BRACKETED_PASTE_END.length; split++) {
		it(`retains closing-marker prefix ${split} through repeated idle drains`, (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			const buffer = new StdinBuffer();
			t.after(() => buffer.destroy());
			const keys: string[] = [];
			const pastes: string[] = [];
			buffer.on("data", (data) => keys.push(data));
			buffer.on("paste", (data) => pastes.push(data));
			buffer.process(`${BRACKETED_PASTE_START}first`);
			t.mock.timers.tick(501);
			assert.deepEqual(pastes, ["first"]);
			buffer.process(`\rsecond${BRACKETED_PASTE_END.slice(0, split)}`);
			t.mock.timers.tick(501);
			assert.deepEqual(keys, []);
			assert.equal(pastes.join(""), "first\rsecond");
			buffer.process(BRACKETED_PASTE_END.slice(split));
			buffer.process("x");
			assert.deepEqual(keys, ["x"]);
			assert.equal(pastes.join(""), "first\rsecond");
		});
	}

	it("ignores empty chunks during paste and resumes keys only after explicit clear", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const buffer = new StdinBuffer();
		t.after(() => buffer.destroy());
		const keys: string[] = [];
		const pastes: string[] = [];
		buffer.on("data", (data) => keys.push(data));
		buffer.on("paste", (data) => pastes.push(data));
		buffer.process(`${BRACKETED_PASTE_START}first`);
		t.mock.timers.tick(501);
		buffer.process("");
		buffer.process("\r");
		t.mock.timers.tick(501);
		assert.deepEqual(keys, []);
		assert.equal(pastes.join(""), "first\r");
		buffer.process("discarded");
		buffer.clear();
		t.mock.timers.tick(501);
		buffer.process("\r");
		assert.deepEqual(keys, ["\r"]);
		assert.equal(pastes.join(""), "first\r");
	});

	it("preserves a pre-paste partial key until actual closure, not an idle gap", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const buffer = new StdinBuffer();
		t.after(() => buffer.destroy());
		const keys: string[] = [];
		buffer.on("data", (data) => keys.push(data));
		buffer.process(`\x1b[${BRACKETED_PASTE_START}fixture`);
		t.mock.timers.tick(10_000);
		assert.deepEqual(keys, []);
		buffer.process(`${BRACKETED_PASTE_END}A`);
		assert.deepEqual(keys, ["\x1b[A"]);
	});

	it("preserves content across deterministic adversarial chunking and idle gaps", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const content = "fixture\r\n世界\r\x1b[201x\n\x1b[20\rfinal";
		let seed = 17;
		for (let trial = 0; trial < 64; trial++) {
			const buffer = new StdinBuffer();
			const keys: string[] = [];
			const pastes: string[] = [];
			buffer.on("data", (data) => keys.push(data));
			buffer.on("paste", (data) => pastes.push(data));
			buffer.process(BRACKETED_PASTE_START);
			const tail = content + BRACKETED_PASTE_END;
			for (let offset = 0; offset < tail.length; ) {
				seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
				const length = 1 + (seed % 7);
				buffer.process(tail.slice(offset, offset + length));
				offset += length;
				t.mock.timers.tick(seed % 2 === 0 ? 501 : 0);
			}
			assert.deepEqual(keys, []);
			assert.equal(pastes.join(""), content);
			buffer.process("k");
			assert.deepEqual(keys, ["k"]);
			buffer.destroy();
		}
	});

	it("cancels paste drainage at teardown without late text or key delivery", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const buffer = new StdinBuffer();
		const delivered: string[] = [];
		buffer.on("data", (data) => delivered.push(data));
		buffer.on("paste", (data) => delivered.push(data));
		buffer.process(`${BRACKETED_PASTE_START}fixture\x1b[201`);
		buffer.destroy();
		t.mock.timers.tick(60_000);
		assert.deepEqual(delivered, []);
	});
});
