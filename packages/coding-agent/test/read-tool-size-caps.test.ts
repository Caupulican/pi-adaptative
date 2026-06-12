import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

describe("read tool sliced reads for oversized files", () => {
	let tempDir: string;
	let bigFile: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `read-caps-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const lines: string[] = [];
		for (let index = 0; index < 5000; index++) lines.push(`line-${String(index).padStart(5, "0")}`);
		bigFile = join(tempDir, "big.log");
		writeFileSync(bigFile, `${lines.join("\n")}\n`);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("reads the first batch of an oversized file with a continuation pointer", async () => {
		const tool = createReadTool(tempDir, { maxTextReadBytes: 8 * 1024 });
		const result = await tool.execute("read-1", { path: bigFile });
		const text = textOf(result);

		expect(text).toContain("line-00000");
		expect(text).not.toContain("line-04999");
		expect(text).toMatch(/Use offset=\d+ to continue/);
	});

	it("reaches a deep slice of an oversized file via offset without loading the whole file", async () => {
		const tool = createReadTool(tempDir, { maxTextReadBytes: 8 * 1024 });
		const result = await tool.execute("read-2", { path: bigFile, offset: 4500, limit: 5 });
		const text = textOf(result);

		expect(text).toContain("line-04499");
		expect(text).toContain("line-04503");
		expect(text).not.toContain("line-00000");
		expect(text).toMatch(/Use offset=4505 to continue/);
	});

	it("serves tail reads on an oversized file", async () => {
		const tool = createReadTool(tempDir, { maxTextReadBytes: 8 * 1024 });
		const result = await tool.execute("read-3", { path: bigFile, tail: 5 });
		const text = textOf(result);

		expect(text).toContain("line-04999");
		expect(text).not.toContain("line-00000");
	});

	it("reads small files exactly as before", async () => {
		const file = join(tempDir, "small.txt");
		writeFileSync(file, "alpha\nbeta\ngamma\n");

		const tool = createReadTool(tempDir, { maxTextReadBytes: 8 * 1024 });
		const result = await tool.execute("read-4", { path: file });

		expect(textOf(result)).toContain("alpha");
		expect(textOf(result)).toContain("gamma");
	});

	it("guides instead of loading an image beyond the decode limit", async () => {
		const file = join(tempDir, "huge.png");
		const png = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			Buffer.from([0x00, 0x00, 0x00, 0x0d]),
			Buffer.from("IHDR", "ascii"),
			Buffer.alloc(13 + 4, 0),
			Buffer.alloc(4096, 0),
		]);
		writeFileSync(file, png);

		const tool = createReadTool(tempDir, { maxImageReadBytes: 1024 });
		const result = await tool.execute("read-5", { path: file });

		expect(result.content.some((part) => part.type === "image")).toBe(false);
		expect(textOf(result)).toMatch(/decode limit/i);
		expect(textOf(result)).toMatch(/resize|downscale/i);
	});
});
