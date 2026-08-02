import { describe, expect, it } from "vitest";
import { stripAnsi } from "../src/utils/ansi.ts";
import { ansi256ToHex } from "../src/utils/ansi-colors.ts";

function referenceAnsiRegex(): RegExp {
	const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
	const osc = `(?:\\u001B\\][\\s\\S]*?${ST})`;
	const csi = "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
	return new RegExp(`${osc}|${csi}`, "g");
}

const referenceRegex = referenceAnsiRegex();

function referenceStripAnsi(value: string): string {
	if (!value.includes("\u001B") && !value.includes("\u009B")) {
		return value;
	}
	return value.replace(referenceRegex, "");
}

function getCompatibilityInputs(): string[] {
	const inputs = [
		"plain",
		"a\x1b[31mred\x1b[0mz",
		"a\x1b]8;;https://example.com\x07link\x1b]8;;\x07z",
		"a\x1b]unterminated",
		"a\x1b]funterminated",
		"a\x1bPabc\x1b\\z",
		"a\x1b^abc\x07z",
		"a\x1b_abc\x9cz",
		"a\x90abc\x9cz",
		"a\x9dabc\x9cz",
		"a\x9b31mred",
		"a\x1b(0x",
		"a\x1b*0x",
		"a\x1b+c",
		"a\x1b/0x",
		"a\x1bcok",
		"a\x1b\\ok",
	];
	const chars = [
		"a",
		"f",
		"0",
		"1",
		";",
		":",
		"[",
		"]",
		"(",
		")",
		"#",
		"?",
		"m",
		"P",
		"_",
		"\\",
		"\x07",
		"\x1b",
		"\x9b",
		"\x9c",
		"\x90",
		"\x9d",
	];

	for (const char of chars) {
		inputs.push(`x\x1b${char}y`);
		inputs.push(`x\x9b${char}y`);
		for (let index = 0; index < chars.length; index += 3) {
			inputs.push(`x\x1b${char}${chars[index]}y`);
		}
	}

	return inputs;
}

describe("stripAnsi", () => {
	it("matches chalk strip-ansi for generated compatibility inputs", () => {
		for (const input of getCompatibilityInputs()) {
			expect(stripAnsi(input)).toBe(referenceStripAnsi(input));
		}
	});

	it("throws the same TypeError as chalk strip-ansi for non-string values", () => {
		const stripAnsiUnknown = stripAnsi as (value: unknown) => string;

		for (const value of [undefined, null, 123, {}, Object("x")]) {
			const message = `Expected a \`string\`, got \`${typeof value}\``;
			expect(() => stripAnsiUnknown(value)).toThrow(TypeError);
			expect(() => stripAnsiUnknown(value)).toThrow(message);
		}
	});

	it("strips RIS without leaking the final byte", () => {
		expect(stripAnsi("\x1bcdone")).toBe("done");
	});

	it("strips single-byte ESC sequences without leaking final bytes", () => {
		for (let code = "g".charCodeAt(0); code <= "m".charCodeAt(0); code++) {
			expect(stripAnsi(`\x1b${String.fromCharCode(code)}ok`)).toBe("ok");
		}
		for (let code = "r".charCodeAt(0); code <= "t".charCodeAt(0); code++) {
			expect(stripAnsi(`\x1b${String.fromCharCode(code)}ok`)).toBe("ok");
		}
	});

	it("strips common ANSI sequences used in tool output", () => {
		const input = "a\x1b[31mred\x1b[0m\x1b]8;;https://example.com\x07link\x1b]8;;\x07z";
		expect(stripAnsi(input)).toBe("aredlinkz");
	});
});

describe("ansi256ToHex", () => {
	it("preserves the basic, cube, and grayscale palette boundaries", () => {
		expect([
			ansi256ToHex(0),
			ansi256ToHex(15),
			ansi256ToHex(16),
			ansi256ToHex(17),
			ansi256ToHex(21),
			ansi256ToHex(22),
			ansi256ToHex(231),
			ansi256ToHex(232),
			ansi256ToHex(255),
		]).toEqual(["#000000", "#ffffff", "#000000", "#00005f", "#0000ff", "#005f00", "#ffffff", "#080808", "#eeeeee"]);
	});
});
