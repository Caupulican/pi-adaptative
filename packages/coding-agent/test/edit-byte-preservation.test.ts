import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import {
	applyEditMatchPlanToSource,
	computeEditsPlannedDiff,
	normalizeToLF,
	planEditsToNormalizedContent,
} from "../src/core/tools/edit-diff.ts";

vi.mock("../src/core/python-runtime.ts", () => ({
	ensurePythonRuntime: async () => ({
		status: "ready",
		pythonPath: process.platform === "win32" ? "python" : "python3",
		uvPath: "synthetic-unused",
		pythonInstalled: false,
	}),
}));

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(bytes: Buffer) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-edit-bytes-"));
	directories.push(cwd);
	const path = join(cwd, "fixture.txt");
	await writeFile(path, bytes);
	return { cwd, path, tool: createEditTool(cwd) };
}

describe("edit byte preservation", () => {
	it("preserves disjoint edits across deterministic mixed-ending and Unicode layouts", () => {
		const endings = ["\r\n", "\n", "\r"];
		for (let seed = 0; seed < 48; seed++) {
			const before = `${seed % 2 ? "\uFEFF" : ""}é🙂${endings[seed % 3]}target-one${endings[(seed + 1) % 3]}e\u0301${endings[(seed + 2) % 3]}target-two${seed % 4 ? endings[seed % 3] : ""}`;
			const edits = [
				{ oldText: "target-two", newText: "SECOND" },
				{ oldText: "target-one", newText: "FIRST" },
			];
			const plan = planEditsToNormalizedContent(normalizeToLF(before), edits, "synthetic.txt");
			const actual = applyEditMatchPlanToSource(before, plan, "synthetic.txt").sourceContent;
			expect(Buffer.from(actual)).toEqual(
				Buffer.from(before.replace("target-one", "FIRST").replace("target-two", "SECOND")),
			);
		}
	});
	it.each([
		{ label: "mixed endings", before: "first\r\ntarget\nlast\rfinal", after: "first\r\nchanged\nlast\rfinal" },
		{ label: "CR-only", before: "first\rtarget\rlast\r", after: "first\rchanged\rlast\r" },
		{ label: "BOM and Unicode", before: "\uFEFFcafé\r\ntarget\n世界\r", after: "\uFEFFcafé\r\nchanged\n世界\r" },
	])("preserves untouched bytes: $label", async ({ before, after }) => {
		const { tool, path } = await fixture(Buffer.from(before));
		await tool.execute("fixture-edit", { path, edits: [{ oldText: "target", newText: "changed" }] });
		expect(await readFile(path)).toEqual(Buffer.from(after));
	});

	it("keeps original newline sequences inside a multiline replacement", async () => {
		const { tool, path } = await fixture(Buffer.from("keep\r\nalpha\nbeta\rgamma\r\nend\n"));
		await tool.execute("fixture-edit", {
			path,
			edits: [{ oldText: "alpha\nbeta\ngamma", newText: "ALPHA\nBETA\nGAMMA" }],
		});
		expect(await readFile(path)).toEqual(Buffer.from("keep\r\nALPHA\nBETA\rGAMMA\r\nend\n"));
	});

	it.each([
		{
			label: "BOM-less UTF-16LE",
			bytes: Buffer.from("target", "utf16le"),
			after: Buffer.from("tXrget", "utf16le"),
		},
		{
			label: "legacy single-byte text",
			bytes: Buffer.from([0x74, 0x61, 0x72, 0x67, 0x65, 0x74, 0xe9]),
			after: Buffer.from([0x74, 0x58, 0x72, 0x67, 0x65, 0x74, 0xe9]),
		},
	])("edits an undeclared encoding the codec resolves, byte for byte: $label", async ({ bytes, after }) => {
		const { tool, path } = await fixture(bytes);
		await tool.execute("fixture-edit", { path, edits: [{ oldText: "a", newText: "X" }] });
		expect(await readFile(path)).toEqual(after);
	});

	it.each([
		{ label: "malformed UTF-16 BOM body", bytes: Buffer.from([0xff, 0xfe, 0x74]) },
		{ label: "NUL-bearing binary", bytes: Buffer.from([0x74, 0x61, 0x00, 0xfe, 0x01]) },
	])("rejects unresolvable bytes without rewriting them: $label", async ({ bytes }) => {
		const { tool, path, cwd } = await fixture(bytes);
		await expect(tool.execute("fixture-edit", { path, edits: [{ oldText: "a", newText: "X" }] })).rejects.toThrow(
			/PI_FILE_ENCODING_CORRUPTION/,
		);
		expect(await readFile(path)).toEqual(bytes);
		const preview = await computeEditsPlannedDiff(path, [{ oldText: "a", newText: "X" }], cwd);
		expect(preview).toHaveProperty("error", expect.stringContaining("PI_FILE_ENCODING_CORRUPTION"));
	});

	it("rejects malformed replacement Unicode instead of silently writing replacement characters", async () => {
		const bytes = Buffer.from("target\r\nkeep\n");
		const { tool, path } = await fixture(bytes);
		await expect(
			tool.execute("fixture-edit", { path, edits: [{ oldText: "target", newText: "\ud800" }] }),
		).rejects.toThrow(/Unicode|encoding/i);
		expect(await readFile(path)).toEqual(bytes);
	});
});
