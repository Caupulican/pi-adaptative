import { describe, expect, it } from "vitest";
import { parseModelOutputJsonObject } from "../src/core/model-output-json.ts";

describe("parseModelOutputJsonObject", () => {
	it("recovers plain, fenced, and prose-wrapped JSON objects", () => {
		expect(parseModelOutputJsonObject('  {"kind":"plain"}\n')).toEqual({ kind: "plain" });
		expect(parseModelOutputJsonObject('answer:\n```json\n{"kind":"fenced"}\n```')).toEqual({ kind: "fenced" });
		expect(parseModelOutputJsonObject('answer: {"kind":"embedded","nested":{"brace":"}"}} done')).toEqual({
			kind: "embedded",
			nested: { brace: "}" },
		});
	});

	it("rejects arrays, primitives, malformed objects, and multiple prose objects", () => {
		expect(parseModelOutputJsonObject('[{"kind":"array"}]')).toBeUndefined();
		expect(parseModelOutputJsonObject('"primitive"')).toBeUndefined();
		expect(parseModelOutputJsonObject('{"kind":')).toBeUndefined();
		expect(parseModelOutputJsonObject('before {"first":true} between {"second":true} after')).toBeUndefined();
	});

	it("handles a large wrapper without accumulated-prefix construction", () => {
		const padding = "x".repeat(2 * 1024 * 1024);
		expect(parseModelOutputJsonObject(`${padding}{"marker":"tail"}${padding}`)).toEqual({ marker: "tail" });
	}, 2_000);
});
