import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	countFileLinesSync,
	readBoundedTextFile,
	readBoundedTextFileSync,
	readFilePrefixSync,
} from "../src/core/util/bounded-file.ts";

const roots: string[] = [];

function fixtureFile(content: string): string {
	const root = mkdtempSync(join(tmpdir(), "pi-bounded-file-"));
	roots.push(root);
	const file = join(root, "state.json");
	writeFileSync(file, content);
	return file;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readBoundedTextFileSync", () => {
	it("returns an exact file at the byte boundary", () => {
		expect(readBoundedTextFileSync(fixtureFile("four"), 4, "Test state")).toBe("four");
	});

	it("rejects an oversized durable file before exposing its content", () => {
		expect(() => readBoundedTextFileSync(fixtureFile("oversized"), 4, "Test state")).toThrow(
			"Test state exceeds its byte limit",
		);
	});

	it("rejects invalid byte limits", () => {
		expect(() => readBoundedTextFileSync(fixtureFile("state"), -1, "Test state")).toThrow(TypeError);
	});
});

describe("readFilePrefixSync", () => {
	it("returns an exact file and a bounded oversized prefix", () => {
		expect(readFilePrefixSync(fixtureFile("four"), 4, "Test state")).toEqual({
			content: Buffer.from("four"),
			truncated: false,
		});
		expect(readFilePrefixSync(fixtureFile("oversized"), 4, "Test state")).toEqual({
			content: Buffer.from("over"),
			truncated: true,
		});
	});
});

describe("countFileLinesSync", () => {
	it("matches text line semantics without loading the complete file", () => {
		expect(countFileLinesSync(fixtureFile("first\r\nsecond\n"), "Test state")).toBe(3);
		expect(countFileLinesSync(fixtureFile(""), "Test state")).toBe(1);
	});
});

describe("readBoundedTextFile", () => {
	it("returns an exact file at the byte boundary", async () => {
		await expect(readBoundedTextFile(fixtureFile("four"), 4, "Test state")).resolves.toBe("four");
	});

	it("rejects an oversized durable file before exposing its content", async () => {
		await expect(readBoundedTextFile(fixtureFile("oversized"), 4, "Test state")).rejects.toThrow(
			"Test state exceeds its byte limit",
		);
	});
});

it.skipIf(process.platform === "win32")("rejects leaf symlinks through every path-based bounded reader", async () => {
	const target = fixtureFile("first\nsecond");
	const link = join(target, "..", "linked-state");
	symlinkSync(target, link);

	expect(() => readBoundedTextFileSync(link, 64, "Test state")).toThrow("not a regular file");
	expect(() => readFilePrefixSync(link, 64, "Test state")).toThrow("not a regular file");
	expect(() => countFileLinesSync(link, "Test state")).toThrow("not a regular file");
	await expect(readBoundedTextFile(link, 64, "Test state")).rejects.toThrow("not a regular file");
});

it.skipIf(process.platform === "win32").each(["async", "text", "prefix", "lines"])(
	"rejects a FIFO before %s reader acquisition can block the host",
	(mode) => {
		const file = fixtureFile("ordinary");
		const pipe = join(file, "..", "reference.pipe");
		execFileSync("mkfifo", [pipe]);
		const probe = fileURLToPath(new URL("./fixtures/bounded-file-probe.mjs", import.meta.url));
		const control = spawnSync(process.execPath, [probe, mode, file], { timeout: 3000, encoding: "utf8" });
		expect(control.error).toBeUndefined();
		expect(control.status).toBe(0);
		expect(control.stdout).toBe("read");
		const result = spawnSync(process.execPath, [probe, mode, pipe], { timeout: 3000, encoding: "utf8" });
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/not a regular file/);
	},
);
