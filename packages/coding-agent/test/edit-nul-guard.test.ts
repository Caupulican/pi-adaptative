import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import { FileMutationIntentController } from "../src/core/tools/file-mutation-intent.ts";
import { findEditNulViolation } from "../src/core/tools/text-nul-guard.ts";

// The legitimate-NUL case needs the managed codec to decode a byte the UTF-8 edit path refuses.
// Exercise the packaged codec with a real local interpreter, never uv downloads or a provider.
vi.mock("../src/core/python-runtime.ts", () => ({
	ensurePythonRuntime: vi.fn(async () => ({
		status: "ready",
		pythonPath: process.platform === "win32" ? "python" : "python3",
		uvPath: "synthetic-unused",
		pythonInstalled: false,
	})),
}));

/** Never a literal byte in this source: the guard's own subject must not live in the fixture file. */
const NUL = String.fromCharCode(0);

const directories: string[] = [];
const controllers: FileMutationIntentController[] = [];
afterEach(async () => {
	await Promise.all(controllers.splice(0).map((controller) => controller.dispose()));
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(bytes: Buffer | string) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-nul-guard-"));
	directories.push(cwd);
	const path = join(cwd, "source.txt");
	await writeFile(path, bytes);
	const intentController = new FileMutationIntentController();
	controllers.push(intentController);
	return { cwd, path, intentController, tool: createEditTool(cwd, { intentController }) };
}

describe("edit tool NUL guard", () => {
	it("refuses a replacement carrying NUL and leaves the file's bytes untouched", async () => {
		const original = Buffer.from("alpha\r\nbeta\n");
		const { tool, path } = await fixture(original);

		await expect(
			tool.execute("nul-edit", { path, edits: [{ oldText: "beta", newText: `va${NUL}lue` }] }),
		).rejects.toThrow(
			/^PI_NUL_IN_REPLACEMENT: Edit 1 has U\+0000 \(NUL\) in newText at character offset 2: "va\\x00lue"\./,
		);
		expect(await readFile(path)).toEqual(original);
	});

	it("states the rule and the repair without offering a shell as the way out", async () => {
		const { tool, path } = await fixture("alpha\n");
		const failure = await tool
			.execute("nul-message", { path, edits: [{ oldText: "alpha", newText: `a${NUL}b` }] })
			.then(
				() => undefined,
				(error: unknown) => String(error),
			);

		expect(failure).toContain("Text files never contain NUL");
		expect(failure).toContain("no file was read and no write was attempted");
		expect(failure).toContain("Re-send edit 1 with the same replacement without the U+0000 character");
		expect(failure).toContain("never write the file through bash or python instead");
	});

	it("names the offending edit by its 1-based position in the call", async () => {
		const { tool, path } = await fixture("alpha\nbeta\ngamma\n");

		await expect(
			tool.execute("nul-second-edit", {
				path,
				edits: [
					{ oldText: "alpha", newText: "ALPHA" },
					{ oldText: "gamma", newText: `GAM${NUL}MA` },
				],
			}),
		).rejects.toThrow(/Edit 2 has U\+0000 \(NUL\) in newText at character offset 3: "GAM\\x00MA"/);
		expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
	});

	it("counts the offset in characters and quotes twenty of them on each side", async () => {
		const { tool, path } = await fixture("alpha\n");
		// 25 two-byte characters before the NUL: a UTF-16 index would report 50, not 25.
		const newText = `${"é".repeat(25)}${NUL}${"x".repeat(25)}`;

		const failure = await tool.execute("nul-context", { path, edits: [{ oldText: "alpha", newText }] }).then(
			() => undefined,
			(error: unknown) => String(error),
		);

		expect(failure).toContain("at character offset 25:");
		expect(failure).toContain(`"...${"é".repeat(20)}\\x00${"x".repeat(20)}..."`);
	});

	it("refuses before the path is prepared, so a missing target still reports the NUL", async () => {
		const { tool, cwd } = await fixture("alpha\n");

		// A missing path would otherwise fail preflight with a retained-payload retarget; the NUL
		// diagnostic instead proves nothing was prepared, leased or read.
		await expect(
			tool.execute("nul-missing", {
				path: join(cwd, "absent.txt"),
				edits: [{ oldText: "alpha", newText: `a${NUL}b` }],
			}),
		).rejects.toThrow(/^PI_NUL_IN_REPLACEMENT:/);
	});

	it("does not fire when the anchor carries the NUL too, leaving the encoding contract to decide", async () => {
		// A file holding 0x00 is refused one layer down, by the pre-existing edit encoding contract
		// (decodeUtf8ForEdit, then the managed codec, both reject NUL-bearing source). This guard must
		// not become a second, earlier refusal for the same file: an edit whose own anchor matches the
		// NUL is left to that contract, so relaxing the contract later needs no change here.
		const original = Buffer.from([...Buffer.from("head"), 0x00, ...Buffer.from("tailé", "latin1")]);
		const { tool, path } = await fixture(original);

		const failure = await tool
			.execute("nul-anchor", {
				path,
				encoding: "latin-1",
				edits: [{ oldText: `head${NUL}tail`, newText: `HEAD${NUL}TAIL` }],
			})
			.then(
				() => undefined,
				(error: unknown) => String(error),
			);

		expect(failure).not.toContain("PI_NUL_IN_REPLACEMENT");
		expect(failure).toContain("PI_FILE_ENCODING_CORRUPTION");
		expect(await readFile(path)).toEqual(original);
	});

	it("clears an edit whose anchor carries the NUL and refuses only the sibling that invents one", () => {
		expect(findEditNulViolation([{ oldText: `a${NUL}b`, newText: `A${NUL}B` }])).toBeUndefined();
		expect(
			findEditNulViolation([
				{ oldText: `a${NUL}b`, newText: `A${NUL}B` },
				{ oldText: "plain", newText: `pl${NUL}ain` },
			]),
		).toEqual({ index: 2, characterOffset: 2, context: "pl\\x00ain" });
	});
});
