import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import { FileMutationIntentController } from "../src/core/tools/file-mutation-intent.ts";

// Exercise the packaged codec with a real local interpreter, never uv downloads or a provider.
vi.mock("../src/core/python-runtime.ts", () => ({
	ensurePythonRuntime: vi.fn(async () => ({
		status: "ready",
		pythonPath: process.platform === "win32" ? "python" : "python3",
		uvPath: "synthetic-unused",
		pythonInstalled: false,
	})),
}));

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A Delphi unit as a Windows toolchain writes it: 0xe9 is ISO-8859-1, 0x93/0x94 windows-1252 only. */
function delphiSource(word: string): Buffer {
	return Buffer.concat([
		Buffer.from("unit caf"),
		Buffer.from([0xe9]),
		Buffer.from(";\r\nbegin\r\n  "),
		Buffer.from([0x93]),
		Buffer.from(word),
		Buffer.from([0x94]),
		Buffer.from("\r\nend.\r\n"),
	]);
}

async function fixture(options: { declare: boolean }) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-edit-declared-"));
	directories.push(cwd);
	const path = join(cwd, "unit.pas");
	await writeFile(path, delphiSource("target"));
	if (options.declare) await writeFile(join(cwd, ".editorconfig"), "root = true\n\n[*.pas]\ncharset = latin1\n");
	const intentController = new FileMutationIntentController();
	return { cwd, path, tool: createEditTool(cwd, { intentController }) };
}

describe("edit with a charset declared in project metadata", () => {
	it("uses the declaration as evidence and preserves every untouched byte", async () => {
		const { tool, path } = await fixture({ declare: true });
		const result = await tool.execute("declared", { path, edits: [{ oldText: "target", newText: "changed" }] });
		expect(await readFile(path)).toEqual(delphiSource("changed"));
		expect(result.details).toMatchObject({
			encodingRecovery: { codec: "python", encoding: "cp1252", verified: true },
		});
	});

	it("keeps the undeclared edit failure unchanged", async () => {
		const { tool, path } = await fixture({ declare: false });
		const failure = await tool
			.execute("undeclared", { path, edits: [{ oldText: "target", newText: "changed" }] })
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		expect((failure as Error).message).toContain("PI_FILE_ENCODING_CORRUPTION");
		expect((failure as Error).message).not.toContain("PI_READ_ENCODING_REQUIRED");
		expect(await readFile(path)).toEqual(delphiSource("target"));
	});
});
