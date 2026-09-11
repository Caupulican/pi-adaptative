import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileMutationIntentController } from "../src/core/tools/file-mutation-intent.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

/** Never a literal byte in this source: the guard's own subject must not live in the fixture file. */
const NUL = String.fromCharCode(0);

const directories: string[] = [];
const controllers: FileMutationIntentController[] = [];
afterEach(async () => {
	await Promise.all(controllers.splice(0).map((controller) => controller.dispose()));
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
	const cwd = await mkdtemp(join(tmpdir(), "pi-write-nul-guard-"));
	directories.push(cwd);
	const intentController = new FileMutationIntentController();
	controllers.push(intentController);
	return { cwd, intentController, tool: createWriteTool(cwd, { intentController }) };
}

describe("write tool NUL guard", () => {
	it("refuses content carrying NUL and creates no file", async () => {
		const { tool, cwd } = await fixture();
		const path = join(cwd, "created.txt");

		await expect(tool.execute("nul-write", { path, content: `head${NUL}tail` })).rejects.toThrow(
			/^PI_NUL_IN_CONTENT: write content has U\+0000 \(NUL\) at character offset 4: "head\\0tail"\./,
		);
		expect(existsSync(path)).toBe(false);
	});

	it("refuses before the parent directory is created", async () => {
		const { tool, cwd } = await fixture();
		const parent = join(cwd, "nested", "deeper");

		await expect(
			tool.execute("nul-write-nested", { path: join(parent, "created.txt"), content: `a${NUL}b` }),
		).rejects.toThrow(/^PI_NUL_IN_CONTENT:/);
		expect(existsSync(parent)).toBe(false);
	});

	it("states the rule and the repair without offering a shell as the way out", async () => {
		const { tool, cwd } = await fixture();
		const failure = await tool
			.execute("nul-write-message", { path: join(cwd, "created.txt"), content: `a${NUL}b` })
			.then(
				() => undefined,
				(error: unknown) => String(error),
			);

		expect(failure).toContain("Text files never contain NUL");
		expect(failure).toContain("no file was created");
		expect(failure).toContain("Re-send the same content without the U+0000 character");
		expect(failure).toContain("never create the file through bash or python instead");
	});

	it("counts the offset in characters and quotes twenty of them on each side", async () => {
		const { tool, cwd } = await fixture();
		// 25 two-byte characters before the NUL: a UTF-16 index would report 50, not 25.
		const content = `${"é".repeat(25)}${NUL}${"x".repeat(25)}`;

		const failure = await tool.execute("nul-write-context", { path: join(cwd, "created.txt"), content }).then(
			() => undefined,
			(error: unknown) => String(error),
		);

		expect(failure).toContain("at character offset 25:");
		expect(failure).toContain(`"...${"é".repeat(20)}\\0${"x".repeat(20)}..."`);
	});

	it("leaves NUL-free content, including other control characters, writing normally", async () => {
		const { tool, cwd } = await fixture();
		const path = join(cwd, "clean.txt");
		const content = "tab\there\r\nand a café\n";

		await tool.execute("clean-write", { path, content });

		expect(await readFile(path, "utf-8")).toBe(content);
	});

	it("copies by reference without re-validating bytes the guard already cleared", async () => {
		// contentRef and payloadRef name bytes an earlier inline write already passed through the
		// guard, so the copy path stays free of a second scan of the whole content.
		const { tool, cwd } = await fixture();
		const first = await tool.execute("ref-source", { path: join(cwd, "first.txt"), content: "plain text\n" });
		const { contentRef } = first.details as { contentRef: string };

		await tool.execute("ref-copy", { path: join(cwd, "second.txt"), contentRef });

		expect(await readFile(join(cwd, "second.txt"), "utf-8")).toBe("plain text\n");
	});
});
