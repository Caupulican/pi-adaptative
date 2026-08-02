import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";
import { StdinBuffer } from "../src/stdin-buffer.ts";

interface StdinCapture {
	data: string[];
	pastes: string[];
}

function capture(buffer: StdinBuffer): StdinCapture {
	const result: StdinCapture = { data: [], pastes: [] };
	buffer.on("data", (data) => result.data.push(data));
	buffer.on("paste", (paste) => result.pastes.push(paste));
	return result;
}

describe("StdinBuffer linear framed paste", () => {
	it("keeps normal keys and a lone Enter on the data path", () => {
		const buffer = new StdinBuffer({ detectUnframedPaste: true });
		const result = capture(buffer);

		buffer.process("a");
		buffer.process("\r");
		buffer.process("bc");

		assert.deepEqual(result.data, ["a", "\r", "b", "c"]);
		assert.deepEqual(result.pastes, []);
		buffer.destroy();
	});

	it("recognizes start and end delimiters split across chunks", () => {
		const buffer = new StdinBuffer();
		const result = capture(buffer);

		buffer.process("\x1b[20");
		buffer.process("0~alpha\x1b[20");
		buffer.process("1~");

		assert.deepEqual(result.data, []);
		assert.deepEqual(result.pastes, ["alpha"]);
		buffer.destroy();
	});

	it("collects multi-megabyte fragmented paste without accumulated-prefix work", () => {
		const buffer = new StdinBuffer({ timeout: 5_000 });
		const result = capture(buffer);
		const fragment = "x".repeat(256);
		const fragmentCount = 8_192;
		const startedAt = performance.now();

		buffer.process("\x1b[200~");
		for (let index = 0; index < fragmentCount; index++) buffer.process(fragment);
		buffer.process("\x1b[201~");
		const elapsedMs = performance.now() - startedAt;

		assert.deepEqual(result.data, []);
		assert.equal(result.pastes.length, 1);
		assert.equal(result.pastes[0]?.length, fragment.length * fragmentCount);
		assert.equal(result.pastes[0], fragment.repeat(fragmentCount));
		assert.ok(elapsedMs < 1_500, `fragmented paste took ${elapsedMs.toFixed(1)}ms`);
		buffer.destroy();
	});
});
