import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDeclaredEncoding } from "../src/core/tools/file-encoding-metadata.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tree(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-editorconfig-"));
	directories.push(root);
	return root;
}

/** Rewrite a file with a distinct modification time so a cache keyed on mtime must observe it. */
async function rewrite(path: string, content: string): Promise<void> {
	await writeFile(path, content);
	const future = new Date(Date.now() + 2000);
	await utimes(path, future, future);
}

describe("declared source encoding from project metadata", () => {
	it("takes the nearest .editorconfig declaration and reports it as the source", async () => {
		const root = await tree();
		await writeFile(join(root, ".editorconfig"), "[*]\ncharset = utf-16le\n");
		await mkdir(join(root, "src"));
		const nearest = join(root, "src", ".editorconfig");
		await writeFile(nearest, "[*.pas]\ncharset = latin1\n");
		expect(await resolveDeclaredEncoding(join(root, "src", "unit.pas"))).toEqual({
			encoding: "windows-1252",
			source: nearest,
		});
		expect(await resolveDeclaredEncoding(join(root, "unit.pas"))).toEqual({
			encoding: "utf-16le",
			source: join(root, ".editorconfig"),
		});
	});

	it("stops the walk after a file declaring root = true", async () => {
		const root = await tree();
		await writeFile(join(root, ".editorconfig"), "[*.pas]\ncharset = latin1\n");
		await mkdir(join(root, "src"));
		await writeFile(join(root, "src", ".editorconfig"), "Root = True\n\n[*.txt]\ncharset = latin1\n");
		expect(await resolveDeclaredEncoding(join(root, "src", "unit.pas"))).toBeUndefined();
		expect(await resolveDeclaredEncoding(join(root, "src", "notes.txt"))).toMatchObject({
			encoding: "windows-1252",
		});
	});

	it("stops the walk at an explicit boundary", async () => {
		const root = await tree();
		await writeFile(join(root, ".editorconfig"), "[*.pas]\ncharset = latin1\n");
		await mkdir(join(root, "src"));
		expect(
			await resolveDeclaredEncoding(join(root, "src", "unit.pas"), { stopAt: join(root, "src") }),
		).toBeUndefined();
		expect(await resolveDeclaredEncoding(join(root, "src", "unit.pas"), { stopAt: root })).toMatchObject({
			encoding: "windows-1252",
		});
	});

	it("matches EditorConfig section globs", async () => {
		const root = await tree();
		await writeFile(
			join(root, ".editorconfig"),
			[
				"[*.pas]",
				"charset = latin1",
				"",
				"[src/**.dfm]",
				"charset = latin1",
				"",
				"[{a,b}.txt]",
				"charset = latin1",
				"",
				"[report{1..3}.log]",
				"charset = latin1",
				"",
				"[page?.md]",
				"charset = latin1",
				"",
				"[[abc].ini]",
				"charset = latin1",
				"",
				"[[!x].cfg]",
				"charset = latin1",
				"",
			].join("\n"),
		);
		await mkdir(join(root, "src", "forms"), { recursive: true });
		await mkdir(join(root, "vendor"));
		const declared = async (...segments: string[]) =>
			(await resolveDeclaredEncoding(join(root, ...segments)))?.encoding;

		expect(await declared("unit.pas")).toBe("windows-1252");
		expect(await declared("src", "forms", "deep.pas")).toBe("windows-1252");
		expect(await declared("src", "forms", "main.dfm")).toBe("windows-1252");
		expect(await declared("src", "main.dfm")).toBe("windows-1252");
		expect(await declared("vendor", "main.dfm")).toBeUndefined();
		expect(await declared("a.txt")).toBe("windows-1252");
		expect(await declared("b.txt")).toBe("windows-1252");
		expect(await declared("c.txt")).toBeUndefined();
		expect(await declared("report2.log")).toBe("windows-1252");
		expect(await declared("report7.log")).toBeUndefined();
		expect(await declared("page1.md")).toBe("windows-1252");
		expect(await declared("page12.md")).toBeUndefined();
		expect(await declared("b.ini")).toBe("windows-1252");
		expect(await declared("d.ini")).toBeUndefined();
		expect(await declared("y.cfg")).toBe("windows-1252");
		expect(await declared("x.cfg")).toBeUndefined();
	});

	it("maps EditorConfig charset values onto decoder codecs", async () => {
		const root = await tree();
		const config = join(root, ".editorconfig");
		await writeFile(
			config,
			[
				"[*.pas]",
				"charset = latin1",
				"[*.md]",
				"charset = utf-8",
				"[*.txt]",
				"charset = utf-8-bom",
				"[*.rc]",
				"charset = utf-16le",
				"[*.bin]",
				"charset = cp437",
				"",
			].join("\n"),
		);
		const declared = async (name: string) => await resolveDeclaredEncoding(join(root, name));
		expect(await declared("unit.pas")).toEqual({ encoding: "windows-1252", source: config });
		expect(await declared("readme.md")).toBeUndefined();
		expect(await declared("notes.txt")).toBeUndefined();
		expect(await declared("app.rc")).toEqual({ encoding: "utf-16le", source: config });
		expect(await declared("blob.bin")).toEqual({ encoding: "cp437", source: config });
	});

	it("ignores comments and lets a later matching section override an earlier one", async () => {
		const root = await tree();
		await writeFile(
			join(root, ".editorconfig"),
			[
				"# [*.pas]",
				"# charset = cp437",
				"; charset = cp437",
				"[*.pas]",
				"charset = cp437",
				"indent_style = space",
				"[*]",
				"charset = latin1",
				"",
			].join("\n"),
		);
		expect(await resolveDeclaredEncoding(join(root, "unit.pas"))).toMatchObject({ encoding: "windows-1252" });
	});

	it("re-reads a declaration after the file changes", async () => {
		const root = await tree();
		const config = join(root, ".editorconfig");
		await rewrite(config, "[*.pas]\ncharset = latin1\n");
		expect(await resolveDeclaredEncoding(join(root, "unit.pas"))).toMatchObject({ encoding: "windows-1252" });
		await rewrite(config, "[*.pas]\ncharset = cp437\n");
		expect(await resolveDeclaredEncoding(join(root, "unit.pas"))).toMatchObject({ encoding: "cp437" });
		await rewrite(config, "[*.pas]\ncharset = utf-8\n");
		expect(await resolveDeclaredEncoding(join(root, "unit.pas"))).toBeUndefined();
	});

	it("returns nothing when no .editorconfig declares a charset", async () => {
		const root = await tree();
		await writeFile(join(root, ".editorconfig"), "[*.pas]\nindent_style = tab\n");
		expect(await resolveDeclaredEncoding(join(root, "unit.pas"))).toBeUndefined();
	});
});
