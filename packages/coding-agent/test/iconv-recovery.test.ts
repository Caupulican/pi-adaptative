import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import { createEditTool } from "../src/core/tools/edit.ts";
import { createReadTool } from "../src/core/tools/read.ts";

vi.mock("../src/core/python-runtime.ts", () => ({
	ensurePythonRuntime: vi.fn(async () => ({
		status: "ready",
		pythonPath: process.platform === "win32" ? "python" : "python3",
		uvPath: "synthetic-unused",
		pythonInstalled: false,
	})),
}));

/**
 * Bounded by the file's test budget, not an arbitrary ten seconds: loading native iconv symbols
 * through the Python fixture took over 10 s on a loaded Windows CI runner (a 192 s shard) and the
 * child was killed, while the same fixture finishes in under three seconds on an idle host.
 */
const FIXTURE_TIMEOUT_MS = 25_000;

describe("packaged iconv recovery", () => {
	it("recovers through loaded native iconv symbols when the command is missing", async (context) => {
		const fixture = fileURLToPath(new URL("./fixtures/file-codec/iconv-recovery.test.py", import.meta.url));
		const helper = fileURLToPath(new URL("../src/bundled-resources/runtimes/file-edit-codec.py", import.meta.url));
		const result = await execCommand(
			process.platform === "win32" ? "python" : "python3",
			["-I", "-S", "-B", fixture, helper, "--native-library"],
			process.cwd(),
			{ timeout: FIXTURE_TIMEOUT_MS, maxBuffer: 64 * 1024 },
		);
		expect(result, result.stderr).toMatchObject({
			code: 0,
			killed: false,
			stdoutTruncated: false,
			stderrTruncated: false,
		});
		if (JSON.parse(result.stdout).available === false)
			context.skip("Loaded native iconv with IBM1047 is unavailable; mocked conformance remains mandatory.");
		expect(JSON.parse(result.stdout)).toEqual({ available: true });
	});

	it("passes deterministic codec and process fixtures without a host iconv dependency", async () => {
		const fixture = fileURLToPath(new URL("./fixtures/file-codec/iconv-recovery.test.py", import.meta.url));
		const helper = fileURLToPath(new URL("../src/bundled-resources/runtimes/file-edit-codec.py", import.meta.url));
		const result = await execCommand(
			process.platform === "win32" ? "python" : "python3",
			["-I", "-S", "-B", fixture, helper],
			process.cwd(),
			{ timeout: FIXTURE_TIMEOUT_MS, maxBuffer: 64 * 1024 },
		);
		expect(result, result.stderr).toMatchObject({
			code: 0,
			killed: false,
			stdoutTruncated: false,
			stderrTruncated: false,
		});
		expect(JSON.parse(result.stdout)).toEqual({ passed: 34, tests: 34, skipped: 0 });
	});

	it("reads and edits IBM1047 bytes through the native installed converter", async (context) => {
		const probe = await execCommand("iconv", ["-f", "IBM1047", "-t", "UTF-8"], process.cwd(), {
			stdin: "",
			timeout: 2_000,
			maxBuffer: 1024,
		});
		if (probe.code !== 0 || probe.killed || probe.errorMessage)
			context.skip("Native iconv with IBM1047 is unavailable; mocked conformance remains mandatory.");
		const cwd = await mkdtemp(join(tmpdir(), "pi-iconv-recovery-"));
		try {
			const path = join(cwd, "source é.txt");
			await writeFile(path, Buffer.from("o4GZh4WjDSU=", "base64"));
			const read = await createReadTool(cwd).execute("read", { path, encoding: "IBM1047" });
			expect(read.content).toContainEqual(
				expect.objectContaining({ type: "text", text: expect.stringContaining("target") }),
			);
			const edit = await createEditTool(cwd).execute("edit", {
				path,
				encoding: "IBM1047",
				edits: [{ oldText: "target", newText: "changed" }],
			});
			expect(edit.details).toMatchObject({ encodingRecovery: { encoding: "IBM1047", verified: true } });
			expect(await readFile(path)).toEqual(Buffer.from([0x83, 0x88, 0x81, 0x95, 0x87, 0x85, 0x84, 0x0d, 0x25]));
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
