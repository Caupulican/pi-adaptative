import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { processFileArguments } from "../src/cli/file-processor.ts";

describe("file argument projection", () => {
	const directories: string[] = [];

	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	test("joins many immutable attachment blocks once in argument order", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-file-arguments-"));
		directories.push(directory);
		const paths = Array.from({ length: 256 }, (_, index) => {
			const path = join(directory, `${index}.txt`);
			writeFileSync(path, `content-${index}`);
			return path;
		});

		const result = await processFileArguments(paths);

		expect(result.images).toEqual([]);
		expect(result.text).toContain(`<file name="${paths[0]}">\ncontent-0\n</file>`);
		expect(result.text).toContain(`<file name="${paths[255]}">\ncontent-255\n</file>`);
		expect(result.text.indexOf(paths[0])).toBeLessThan(result.text.indexOf(paths[255]));
	});
});
