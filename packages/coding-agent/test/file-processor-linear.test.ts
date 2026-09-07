import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { processFileArguments } from "../src/cli/file-processor.ts";
import { resolveReadPath } from "../src/core/tools/path-utils.ts";

vi.mock("../src/core/tools/path-utils.ts", async (importOriginal) => {
	const original = await importOriginal<{ resolveReadPath: typeof resolveReadPath }>();
	return { ...original, resolveReadPath: vi.fn(original.resolveReadPath) };
});

describe("file argument projection", () => {
	const directories: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		vi.mocked(resolveReadPath).mockReset();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	test.each(["EACCES", "EIO", "ELOOP"])("reports %s from path lookup without claiming file absence", async (code) => {
		const failure = Object.assign(new Error(`${code}: synthetic lookup failure`), { code });
		vi.mocked(resolveReadPath).mockImplementation(() => {
			throw failure;
		});
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const stopped = new Error("synthetic CLI exit");
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw stopped;
		});
		await expect(processFileArguments(["fixture.txt"])).rejects.toBe(stopped);
		expect(exit).toHaveBeenCalledExactlyOnceWith(1);
		expect(log).toHaveBeenCalledOnce();
		expect(log.mock.calls[0]?.[0]).toContain(code);
		expect(log.mock.calls[0]?.[0]).not.toContain("File not found");
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
