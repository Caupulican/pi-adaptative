import { describe, expect, it } from "vitest";
import { parseStreamingJson, repairJson } from "../src/utils/json-parse.ts";

describe("json parse repair", () => {
	it("preserves valid unicode escapes", () => {
		expect(JSON.parse(repairJson(String.raw`{"letter":"\u0041"}`))).toEqual({ letter: "A" });
	});

	it("repairs invalid unicode-like path escapes without dropping the object", () => {
		const parsed = parseStreamingJson<{ path: string }>(String.raw`{"path":"C:\users\bob\file.txt","keep":true}`);
		expect(parsed).toMatchObject({ keep: true });
		expect(parsed.path).toContain("C:\\users");
	});

	it("pins other malformed escape classes", () => {
		expect(JSON.parse(repairJson(String.raw`{"x":"a\x20b"}`))).toEqual({ x: String.raw`a\x20b` });
		expect(JSON.parse(repairJson('{"x":"a\nb"}'))).toEqual({ x: "a\nb" });
		expect(repairJson('{"x":"tail\\')).toBe('{"x":"tail\\\\');
	});
});
