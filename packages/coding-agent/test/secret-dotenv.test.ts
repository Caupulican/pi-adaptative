import { describe, expect, it } from "vitest";
import { formatDotenvVariables, parseDotenvDocument, SecretDotenvError } from "../src/core/secrets/secret-dotenv.ts";

describe("secret dotenv document", () => {
	it("parses practical dotenv syntax without returning rejected values in errors", () => {
		const parsed = parseDotenvDocument(
			[
				"# owner comment",
				"export API_TOKEN = unquoted-value # trailing comment",
				'PRIVATE_KEY="line-one\\nline-two"',
				"QUOTED_HASH='value#kept'",
				"EMPTY=",
				"",
			].join("\n"),
		);

		expect(parsed.variables).toEqual([
			{ name: "API_TOKEN", value: "unquoted-value" },
			{ name: "PRIVATE_KEY", value: "line-one\nline-two" },
			{ name: "QUOTED_HASH", value: "value#kept" },
			{ name: "EMPTY", value: "" },
		]);
		expect(parsed.document).toContain("# owner comment");
	});

	it("supports multiline quoted credentials", () => {
		const parsed = parseDotenvDocument('PRIVATE_KEY="-----BEGIN KEY-----\nbody\n-----END KEY-----"\n');
		expect(parsed.variables[0]).toEqual({
			name: "PRIVATE_KEY",
			value: "-----BEGIN KEY-----\nbody\n-----END KEY-----",
		});
	});

	it("rejects duplicate or malformed assignments with bounded grammar-only diagnostics", () => {
		expect(() => parseDotenvDocument("TOKEN=first\nTOKEN=second-secret-marker\n")).toThrowError(
			expect.objectContaining({ message: "Dotenv line 2: variable TOKEN is duplicated" }),
		);
		try {
			parseDotenvDocument("TOKEN='sensitive-marker\n");
		} catch (error) {
			expect(error).toBeInstanceOf(SecretDotenvError);
			expect((error as Error).message).not.toContain("sensitive-marker");
		}
	});

	it("serializes variable maps deterministically", () => {
		expect(
			formatDotenvVariables([
				{ name: "Z_TOKEN", value: "z" },
				{ name: "A_TOKEN", value: "line\nvalue" },
			]),
		).toBe('A_TOKEN="line\\nvalue"\nZ_TOKEN="z"\n');
	});
});
