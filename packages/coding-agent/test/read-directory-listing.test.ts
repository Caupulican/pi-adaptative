import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

describe("read tool directory listing", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function fixture(): string {
		const root = mkdtempSync(join(tmpdir(), "read-directory-"));
		roots.push(root);
		mkdirSync(join(root, "src", "nested"), { recursive: true });
		mkdirSync(join(root, "empty"));
		writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n");
		writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
		writeFileSync(join(root, "README.md"), "# hi\n");
		symlinkSync(join(root, "README.md"), join(root, "src", "link.md"));
		return root;
	}

	it("returns a bounded listing instead of EISDIR, directories first", async () => {
		const root = fixture();
		const tool = createReadTool(root);
		const result = await tool.execute("read-dir", { path: "src" });
		const text = textOf(result);
		expect(text.split("\n")[0]).toBe("Directory src (4 entries)");
		expect(text.split("\n").slice(1)).toEqual([
			"nested/",
			expect.stringMatching(/^a\.ts {2}\S+$/),
			expect.stringMatching(/^b\.ts {2}\S+$/),
			"link.md -> (symlink)",
		]);
		expect(result.details).toEqual({ directory: { entries: 4, shown: 4 } });
	});

	it("lists the workspace root and an empty directory", async () => {
		const root = fixture();
		const tool = createReadTool(root);
		expect(textOf(await tool.execute("read-root", { path: "." }))).toContain("src/");
		expect(textOf(await tool.execute("read-empty", { path: "empty" }))).toBe("Directory empty (0 entries)\n(empty)");
	});

	it("refuses byte-oriented options on a directory", async () => {
		const root = fixture();
		const tool = createReadTool(root);
		await expect(tool.execute("read-dir-offset", { path: "src", offset: 2 })).rejects.toThrow(
			"src is a directory: read it without offset, tail, column, or mode.",
		);
	});
});
