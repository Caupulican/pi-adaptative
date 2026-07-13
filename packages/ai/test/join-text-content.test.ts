import { describe, expect, it } from "vitest";
import { joinTextContent } from "../src/providers/transform-messages.ts";

describe("joinTextContent", () => {
	it("returns a single text block unchanged", () => {
		const text = "large immutable text";
		expect(joinTextContent([{ type: "text", text }])).toBe(text);
	});

	it("joins multiple text blocks while ignoring images", () => {
		expect(
			joinTextContent([
				{ type: "text", text: "one" },
				{ type: "image", data: "data", mimeType: "image/png" },
				{ type: "text", text: "two" },
			]),
		).toBe("one\ntwo");
	});
});
