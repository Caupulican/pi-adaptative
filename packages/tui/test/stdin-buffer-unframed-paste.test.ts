import assert from "node:assert";
import { describe, it } from "node:test";
import { StdinBuffer } from "../src/stdin-buffer.ts";

describe("StdinBuffer unframed paste fallback", () => {
	it("emits one atomic paste for a multiline plain-text chunk", () => {
		const buffer = new StdinBuffer({ timeout: 10, detectUnframedPaste: true });
		const data: string[] = [];
		const pastes: string[] = [];
		buffer.on("data", (value) => data.push(value));
		buffer.on("paste", (value) => pastes.push(value));

		buffer.process("first\r\nsecond\nthird");

		assert.deepStrictEqual(data, []);
		assert.deepStrictEqual(pastes, ["first\r\nsecond\nthird"]);
	});

	it("does not reinterpret an Enter key or batched printable typing as paste", () => {
		const buffer = new StdinBuffer({ timeout: 10, detectUnframedPaste: true });
		const data: string[] = [];
		const pastes: string[] = [];
		buffer.on("data", (value) => data.push(value));
		buffer.on("paste", (value) => pastes.push(value));

		buffer.process("\r");
		buffer.process("typed");

		assert.deepStrictEqual(data, ["\r", "t", "y", "p", "e", "d"]);
		assert.deepStrictEqual(pastes, []);
	});

	it("keeps the fallback disabled unless the terminal owner opts in", () => {
		const buffer = new StdinBuffer({ timeout: 10 });
		const data: string[] = [];
		const pastes: string[] = [];
		buffer.on("data", (value) => data.push(value));
		buffer.on("paste", (value) => pastes.push(value));

		buffer.process("first\nsecond");

		assert.deepStrictEqual(data, [..."first\nsecond"]);
		assert.deepStrictEqual(pastes, []);
	});
});
