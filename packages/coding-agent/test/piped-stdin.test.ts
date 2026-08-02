import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readPipedInput } from "../src/cli/piped-stdin.ts";

describe("readPipedInput", () => {
	it("joins fragmented input once and preserves content between outer whitespace", async () => {
		const chunks = Array.from({ length: 20_000 }, (_, index) => `${index % 10}`);
		const input = Readable.from([" \n", ...chunks, "\n "]);

		await expect(readPipedInput(input)).resolves.toBe(chunks.join(""));
	});

	it("returns undefined for empty input and TTY streams", async () => {
		await expect(readPipedInput(Readable.from([" \n\t "]))).resolves.toBeUndefined();
		await expect(readPipedInput(Readable.from(["ignored"]), true)).resolves.toBeUndefined();
	});
});
