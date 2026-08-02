import { describe, expect, it } from "vitest";
import { escapePromptXml } from "../src/core/prompt-markup.ts";

describe("prompt XML escaping", () => {
	it("escapes text and attribute metacharacters through one owner", () => {
		expect(escapePromptXml(`a&<b>"c'd`)).toBe("a&amp;&lt;b&gt;&quot;c&apos;d");
	});

	it("does not treat pre-escaped untrusted input as trusted markup", () => {
		expect(escapePromptXml("&amp;")).toBe("&amp;amp;");
	});
});
