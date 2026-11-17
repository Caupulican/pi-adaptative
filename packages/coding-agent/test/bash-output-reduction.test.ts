import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { toolOutputFidelityFromResult } from "../src/core/tools/tool-output-fidelity.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../src/kernel/utils/truncate.ts";

function shellWithOutput(directory: string, content: string, outputDirectory = directory) {
	return createBashTool(directory, {
		platform: "linux",
		outputDirectory,
		outputReduction: { agentDir: directory, level: "standard" },
		operations: {
			exec: async (_command, _cwd, { onData }) => {
				const bytes = Buffer.from(content);
				for (let offset = 0; offset < bytes.length; offset += 4093) onData(bytes.subarray(offset, offset + 4093));
				return { exitCode: 0 };
			},
		},
	});
}

describe("Bash tool output display", () => {
	let directory: string;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-bash-output-"));
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	const repeat = "progress line\n".repeat(7000);
	// Trimming alone does not request a raw file. The extra display cap must add that requirement.
	const distinct = Array.from({ length: 35 }, (_, index) => `item-${index}: ${"é".repeat(1000)}${" ".repeat(300)}`);
	const large = `${distinct.join("\n")}\n`;
	const run = (raw: string, outputDirectory?: string, fullOutput = false) =>
		shellWithOutput(directory, raw, outputDirectory).execute("bounded-output", {
			command: "emit-output",
			fullOutput,
		});

	it("bounds the reduced body and preview and preserves complete raw bytes", async () => {
		const result = await run(large);
		const body = result.content[0]?.type === "text" ? result.content[0].text : "";
		const display = body.split("\n\n[Reduced preview truncated")[0]!;
		expect(body).toContain("[Reduced preview truncated");
		expect(display).toContain("...[middle omitted:");
		expect(display).not.toContain("\uFFFD");
		expect(Buffer.byteLength(display)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(Buffer.byteLength(result.details.preview.content)).toBeLessThanOrEqual(8 * 1024);
		expect(result.details).toMatchObject({
			displayTruncated: true,
			outputProjection: { outputBytes: Buffer.byteLength(display) },
			outputReduction: { kind: "generic", persistRaw: true, rawPath: result.details.fullOutputPath },
		});
		expect(result.details.outputReduction.outputBytes).toBeGreaterThan(DEFAULT_MAX_BYTES);
		expect(toolOutputFidelityFromResult("bash", result.details)).toMatchObject({ clipped: true });
		expect(await readFile(result.details.fullOutputPath, "utf8")).toBe(large);
	});

	it("caps the final projection's line count independently of its byte size", async () => {
		const lines = Array.from({ length: DEFAULT_MAX_LINES + 100 }, (_, index) => `row-${index}`).join("\n");
		const result = await run(`${repeat}${lines}\n`);
		expect(result.details.displayTruncated).toBe(true);
		expect(result.details.outputProjection.outputLines).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
		expect(result.details.outputReduction.outputLines).toBeGreaterThan(DEFAULT_MAX_LINES);
		expect(result.details.outputReduction.outputBytes).toBeLessThan(DEFAULT_MAX_BYTES);
	});

	it("distinguishes a complete reduced display from the capped raw preview", async () => {
		const small = `${repeat}last ordinary line\n`;
		const result = await run(small);
		expect(result.details).toMatchObject({
			displayTruncated: false,
			truncation: { truncated: true },
			outputReduction: { kind: "generic", rawPath: result.details.fullOutputPath },
		});
		expect(toolOutputFidelityFromResult("bash", result.details)?.clipped).toBeUndefined();
		expect(await readFile(result.details.fullOutputPath, "utf8")).toBe(small);
	});

	it("uses the raw bounded display when the required artifact fails or fullOutput is requested", async () => {
		for (const [outputDirectory, fullOutput] of [
			[join(directory, "missing"), false],
			[directory, true],
		] as const) {
			const result = await run(large, outputDirectory, fullOutput);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(result.details.outputProjection).toBeUndefined();
			expect(result.details.outputReduction).toBeUndefined();
			expect(result.details.truncation.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
			expect(text).not.toContain("[Reduced preview truncated");
			if (fullOutput) expect(await readFile(result.details.fullOutputPath, "utf8")).toBe(large);
			else {
				expect(result.details.fullOutputPath).toBeUndefined();
				expect(result.details.fullOutputError).toContain("ENOENT");
			}
		}
	});
});
