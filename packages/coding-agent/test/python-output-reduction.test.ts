import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReductionProjector, MAX_BUFFERED_REDUCTION_BYTES } from "../src/core/tools/output-reduction.ts";
import { createPythonToolDefinition } from "../src/core/tools/python.ts";
import type { PythonExecutionResult } from "../src/core/tools/schemas/python.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";

function pythonTool(
	directory: string,
	stdout: string,
	stderr: string,
	options: { outputDirectory?: string; execution?: PythonExecutionResult } = {},
) {
	return wrapToolDefinition(
		createPythonToolDefinition(directory, {
			outputDirectory: options.outputDirectory ?? directory,
			outputReduction: { agentDir: directory, level: "standard" },
			resolveRuntime: async () => ({ status: "ready", uvPath: "uv", pythonPath: "python", pythonInstalled: true }),
			operations: {
				stat: async () => ({ isDirectory: () => true, isFile: () => false }),
				getEnvironment: async () => ({ caseSensitive: true, variables: {} }),
				readOutputRules: async () => {
					throw Object.assign(new Error("No project rules"), { code: "ENOENT" });
				},
				exec: async ({ onStdout, onStderr }) => {
					for (const [text, append] of [
						[stdout, onStdout],
						[stderr, onStderr],
					] as const) {
						const bytes = Buffer.from(text);
						for (let offset = 0; offset < bytes.length; offset += 257) {
							append(bytes.subarray(offset, offset + 257));
						}
					}
					return options.execution ?? { reason: "exited", exitCode: 0, signal: null };
				},
			},
		}),
	);
}

describe("Python tool stream reduction", () => {
	let directory: string;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-python-output-"));
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	const columns = ["label", "count", "enabled", "remark"].map((key) => key + "_field".repeat(18));
	const streamJson = (label: string) =>
		JSON.stringify(
			Array.from({ length: 12 }, (_, index) =>
				Object.fromEntries(columns.map((column, cell) => [column, [label, index, true, null][cell]])),
			),
		);
	const stdout = `\uFEFF${streamJson("stdout-café")}`;
	const stderr = streamJson("stderr-日本語");

	it("reduces both complete streams before display limits and publishes their original artifacts", async () => {
		const result = await pythonTool(directory, stdout, stderr).execute("test", {
			code: "pass",
			maxOutputBytes: 1000,
		});
		const content = result.content[0];
		expect(content?.type).toBe("text");
		const text = content?.type === "text" ? content.text : "";
		const [out, err] = text.split("\n\n");
		expect(JSON.parse(out!)).toEqual({
			$format: "columnar-json",
			columns,
			rows: Array.from({ length: 12 }, (_, index) => ["stdout-café", index, true, null]),
		});
		expect(JSON.parse(err!.replace(/^\[stderr\]\n/, ""))).toEqual({
			$format: "columnar-json",
			columns,
			rows: Array.from({ length: 12 }, (_, index) => ["stderr-日本語", index, true, null]),
		});
		const details = result.details;
		expect(details.stdoutTruncation).toMatchObject({
			truncated: true,
			totalBytes: Buffer.byteLength(stdout.slice(1)),
		});
		expect(details.stderrTruncation).toMatchObject({ truncated: true, totalBytes: Buffer.byteLength(stderr) });
		expect(details.stdoutReducedDisplayTruncated).toBe(false);
		expect(details.stderrReducedDisplayTruncated).toBe(false);
		expect(details.outputReduction?.rawPath).toBe(details.stdoutOutputPath);
		expect(details.stderrReduction?.rawPath).toBe(details.stderrOutputPath);
		expect(await readFile(details.stdoutOutputPath!, "utf8")).toBe(stdout);
		expect(await readFile(details.stderrOutputPath!, "utf8")).toBe(stderr);
	});

	it("keeps the raw display when full output is requested or the recovery file fails", async () => {
		const full = await pythonTool(directory, stdout, stderr).execute("test", {
			code: "pass",
			maxOutputBytes: 1000,
			fullOutput: true,
		});
		expect(full.details.outputReduction).toBeUndefined();
		expect(full.details.stderrReduction).toBeUndefined();
		expect(full.details.stdoutReducedDisplayTruncated).toBeUndefined();
		expect(full.details.stderrReducedDisplayTruncated).toBeUndefined();
		expect(await readFile(full.details.stdoutOutputPath!, "utf8")).toBe(stdout);
		expect(await readFile(full.details.stderrOutputPath!, "utf8")).toBe(stderr);

		const failed = await pythonTool(directory, stdout, stderr, {
			outputDirectory: join(directory, "missing"),
		}).execute("test", {
			code: "pass",
			maxOutputBytes: 1000,
		});
		expect(failed.details.outputReduction).toBeUndefined();
		expect(failed.details.stderrReduction).toBeUndefined();
		expect(failed.details.stdoutOutputPath).toBeUndefined();
		expect(failed.details.stderrOutputPath).toBeUndefined();
		expect(failed.details.stdoutOutputError).toContain("ENOENT");
		expect(failed.details.stderrOutputError).toContain("ENOENT");
	});

	it("clips a reduced display that still exceeds the caller's cap", async () => {
		const distinct = Array.from({ length: 100 }, (_, index) => `item-${index} ${"x".repeat(30)}`).join("\n");
		const raw = `${"progress line\n".repeat(100)}${distinct}\n`;
		const result = await pythonTool(directory, raw, "").execute("test", { code: "pass", maxOutputBytes: 1000 });
		const content = result.content[0];
		const display = content?.type === "text" ? content.text.split("\n\n")[0]! : "";
		expect(result.details.outputReduction).toMatchObject({
			kind: "generic",
			rawPath: result.details.stdoutOutputPath,
		});
		expect(result.details.stdoutReducedDisplayTruncated).toBe(true);
		expect(display).toContain("...[middle omitted:");
		expect(Buffer.byteLength(display)).toBeLessThanOrEqual(1000);
		expect(await readFile(result.details.stdoutOutputPath!, "utf8")).toBe(raw);
	});

	it("preserves error classification and publishes both settled streams on timeout", async () => {
		const tool = pythonTool(directory, stdout, stderr, {
			execution: { reason: "timeout", exitCode: null, signal: "SIGTERM" },
		});
		const pending = tool.execute("test", { code: "pass", timeoutSeconds: 1, maxOutputBytes: 1000 });
		const names = await pending.then(
			() => {
				throw new Error("Python unexpectedly returned success");
			},
			async (error: unknown) => {
				expect(error).toMatchObject({
					failureCode: "timeout",
					errorKind: "operation_outcome",
					outputSignature: expect.stringMatching(/^[\w-]+:[\w-]+$/),
					message: expect.stringContaining("Python timed out after 1 seconds"),
				});
				const files = await readdir(directory);
				for (const name of files) {
					expect(error instanceof Error && error.message).toContain(join(directory, name));
				}
				return files.sort();
			},
		);
		expect(names).toEqual([expect.stringMatching(/^pi-python-stderr-/), expect.stringMatching(/^pi-python-stdout-/)]);
		expect(await readFile(join(directory, names[0]!), "utf8")).toBe(stderr);
		expect(await readFile(join(directory, names[1]!), "utf8")).toBe(stdout);
	});
});

describe("process output reduction projector", () => {
	it("owns appended bytes when a process backend reuses its chunk buffer", () => {
		let input: string | undefined;
		const projector = createReductionProjector("bash", "echo output", "standard", {
			extraReducers: [
				{
					name: "capture",
					applies: () => true,
					reduce: (_classification, request) => {
						input = request.text;
						return undefined;
					},
				},
			],
		})!;
		const reused = Buffer.from("fir");
		projector.append(reused);
		reused.write("st!");
		projector.append(reused);
		reused.fill(0);
		projector.finish(0);
		expect(input).toBe("first!");
	});
	it("declines an oversized or failing projection without replaying a reducer", () => {
		let attempts = 0;
		const projector = () =>
			createReductionProjector("python", "python", "standard", {
				extraReducers: [
					{
						name: "throws",
						applies: () => true,
						reduce: () => {
							attempts++;
							throw new Error("Reducer failed");
						},
					},
				],
			})!;
		const huge = projector();
		huge.append(Buffer.alloc(MAX_BUFFERED_REDUCTION_BYTES + 1));
		expect(huge.finish(0)).toBeUndefined();
		expect(attempts).toBe(0);

		const failing = projector();
		failing.append(Buffer.from("unstructured text"));
		expect(failing.finish(1)).toBeUndefined();
		expect(failing.finish(1)).toBeUndefined();
		expect(attempts).toBe(1);
	});
});
