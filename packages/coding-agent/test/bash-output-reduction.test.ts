/**
 * The bash tool runs a family reducer over search output the way it runs the test projector: the raw
 * output is persisted first, the model sees the shorter version plus one notice naming the raw path,
 * and the result's details carry the reduction so the census can price it.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BashOperations, createBashTool } from "../src/core/tools/bash.ts";
import { getTextOutput } from "../src/core/tools/render-utils.ts";

const cleanupDirectories: string[] = [];
afterEach(() => {
	for (const directory of cleanupDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function operationsFor(rawOutput: string, exitCode = 0): BashOperations {
	return {
		exec: async (_command, _cwd, { onData }) => {
			onData(Buffer.from(rawOutput, "utf-8"));
			return { exitCode };
		},
	};
}

const rgOutput = Array.from(
	{ length: 40 },
	(_, index) =>
		`packages/app/src/services/search-service.ts:${5 + index * 3}:  logger.debug("needle", { step: ${index} });`,
)
	.join("\n")
	.concat("\n");

describe("bash tool: search output reduction", () => {
	it("reduces rg output to the grouped layout, persists the raw output and reports the reduction", async () => {
		const outputDirectory = mkdtempSync(join(tmpdir(), "pi-bash-reduction-"));
		cleanupDirectories.push(outputDirectory);
		const tool = createBashTool(process.cwd(), { operations: operationsFor(rgOutput), outputDirectory });
		const result = await tool.execute("rg-reduced", { command: "rg -n needle packages/app/src" });
		const text = getTextOutput(result, false);
		expect(text.startsWith("packages/app/src/services/search-service.ts\n  5: ")).toBe(true);
		expect(text).toContain("[rg output filtered: retained 41 of 40 lines. Full output: ");
		const reduction = result.details?.outputReduction;
		expect(reduction).toMatchObject({ kind: "search", family: "rg", inputLines: 40, omittedLines: 0 });
		expect(reduction?.rawPath).toBeDefined();
		expect(existsSync(reduction!.rawPath!)).toBe(true);
		expect(readFileSync(reduction!.rawPath!, "utf-8")).toBe(rgOutput);
		expect(result.details?.outputProjection).toMatchObject({ kind: "reduction" });
	});

	it("passes through output modes the reducer does not understand and explicit verbosity", async () => {
		const outputDirectory = mkdtempSync(join(tmpdir(), "pi-bash-reduction-"));
		cleanupDirectories.push(outputDirectory);
		const listing = "packages/app/src/a.ts\npackages/app/src/b.ts\n";
		const tool = createBashTool(process.cwd(), { operations: operationsFor(listing), outputDirectory });
		const files = await tool.execute("rg-files", { command: "rg -l needle packages/app/src" });
		expect(getTextOutput(files, false)).toBe(listing);
		expect(files.details?.outputReduction).toBeUndefined();
		const verboseTool = createBashTool(process.cwd(), { operations: operationsFor(rgOutput), outputDirectory });
		const verbose = await verboseTool.execute("rg-verbose", { command: "rg -n --verbose needle packages/app/src" });
		expect(getTextOutput(verbose, false)).toBe(rgOutput);
	});

	it("leaves a result alone when the reduction would not be materially smaller", async () => {
		const outputDirectory = mkdtempSync(join(tmpdir(), "pi-bash-reduction-"));
		cleanupDirectories.push(outputDirectory);
		const sparse = "a.ts:1:x\nb.ts:2:y\n";
		const tool = createBashTool(process.cwd(), { operations: operationsFor(sparse), outputDirectory });
		const result = await tool.execute("rg-sparse", { command: "rg -n x src" });
		expect(getTextOutput(result, false)).toBe(sparse);
		expect(result.details?.outputReduction).toBeUndefined();
	});
});
