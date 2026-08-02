import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BracketedPasteBuffer } from "../src/bracketed-paste.ts";
import { Text } from "../src/components/text.ts";
import { frameTextLines, prepareTextBlock, TextRenderCache } from "../src/components/text-layout.ts";

describe("BracketedPasteBuffer", () => {
	it("completes a paste when the closing marker is split across chunks", () => {
		const buffer = new BracketedPasteBuffer();

		assert.deepEqual(buffer.consume("regular"), { kind: "unhandled", data: "regular" });
		assert.deepEqual(buffer.consume("\x1b[200~alpha\x1b[20"), { kind: "pending" });
		assert.deepEqual(buffer.consume("1~tail"), {
			kind: "complete",
			content: "alpha",
			remainder: "tail",
		});
	});

	it("preserves a closing-marker prefix that later diverges", () => {
		const buffer = new BracketedPasteBuffer();

		assert.deepEqual(buffer.consume("\x1b[200~alpha\x1b[20"), { kind: "pending" });
		assert.deepEqual(buffer.consume("xomega\x1b[201~"), {
			kind: "complete",
			content: "alpha\x1b[20xomega",
			remainder: "",
		});
	});

	it("preserves fragmented content across bounded compaction", () => {
		const buffer = new BracketedPasteBuffer();
		const fragment = "0123456789abcdef";
		const count = 16_384;

		assert.deepEqual(buffer.consume(`\x1b[200~${fragment}`), { kind: "pending" });
		for (let index = 1; index < count; index++) {
			assert.deepEqual(buffer.consume(fragment), { kind: "pending" });
		}
		const completed = buffer.consume("\x1b[201~");

		assert.equal(completed.kind, "complete");
		if (completed.kind === "complete") {
			assert.equal(completed.content.length, fragment.length * count);
			assert.equal(completed.content, fragment.repeat(count));
		}
	});
});

describe("shared text layout", () => {
	it("prepares visible text and rejects whitespace-only input", () => {
		assert.deepEqual(prepareTextBlock("a\tb", 10, 1), {
			normalizedText: "a   b",
			contentWidth: 8,
		});
		assert.equal(prepareTextBlock(" \t ", 10, 1), undefined);
	});

	it("frames text while leaving terminal-owned rows untouched", () => {
		assert.deepEqual(
			frameTextLines(["x", "IMAGE"], {
				width: 6,
				paddingX: 1,
				paddingY: 1,
				isPassthrough: (line) => line === "IMAGE",
			}),
			["      ", " x    ", "IMAGE", "      "],
		);
	});

	it("returns cache copies so consumers cannot mutate retained render state", () => {
		const cache = new TextRenderCache();
		cache.write("text", 20, ["first"]);

		const firstRead = cache.read("text", 20);
		assert.deepEqual(firstRead, ["first"]);
		firstRead![0] = "consumer-mutated";
		assert.deepEqual(cache.read("text", 20), ["first"]);
	});

	it("does not expose the cache-owned empty render result", () => {
		const component = new Text("", 0, 0);
		const first = component.render(20);
		first.push("consumer-mutated");

		assert.deepEqual(component.render(20), []);
	});
});
