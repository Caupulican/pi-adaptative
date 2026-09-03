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
		expect(text).toContain("[rg output filtered: 40 lines regrouped, none omitted. Full output: ");
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

	it("returns the raw output when the model asks for fullOutput or the operator turned reduction off", async () => {
		const outputDirectory = mkdtempSync(join(tmpdir(), "pi-bash-reduction-"));
		cleanupDirectories.push(outputDirectory);
		const tool = createBashTool(process.cwd(), { operations: operationsFor(rgOutput), outputDirectory });
		const full = await tool.execute("rg-full", { command: "rg -n needle packages/app/src", fullOutput: true });
		expect(getTextOutput(full, false)).toBe(rgOutput);
		expect(full.details?.outputReduction).toBeUndefined();
		const offTool = createBashTool(process.cwd(), {
			operations: operationsFor(rgOutput),
			outputDirectory,
			outputReduction: { enabled: false },
		});
		const off = await offTool.execute("rg-off", { command: "rg -n needle packages/app/src" });
		expect(getTextOutput(off, false)).toBe(rgOutput);
		expect(off.details?.outputReduction).toBeUndefined();
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

describe("bash tool: generic output cleaning", () => {
	it("cleans any command's output silently and collapses repeats with a persisted raw copy", async () => {
		const outputDirectory = mkdtempSync(join(tmpdir(), "pi-bash-reduction-"));
		cleanupDirectories.push(outputDirectory);
		const esc = String.fromCharCode(27);
		const colored = `${Array.from({ length: 12 }, (_, index) => `${esc}[32mok${esc}[0m step ${index}   `).join("\n")}\n`;
		const cleanTool = createBashTool(process.cwd(), { operations: operationsFor(colored), outputDirectory });
		const cleaned = await cleanTool.execute("clean", { command: "./scripts/build.sh" });
		expect(getTextOutput(cleaned, false)).toBe(
			Array.from({ length: 12 }, (_, index) => `ok step ${index}`)
				.join("\n")
				.concat("\n"),
		);
		expect(cleaned.details?.outputReduction).toMatchObject({ kind: "generic", omittedLines: 0, persistRaw: false });
		expect(cleaned.details?.outputReduction?.rawPath).toBeUndefined();

		const repeated = `${Array.from({ length: 200 }, () => "waiting for the service to come up").join("\n")}\nready\n`;
		const repeatTool = createBashTool(process.cwd(), { operations: operationsFor(repeated), outputDirectory });
		const collapsed = await repeatTool.execute("collapse", { command: "./scripts/wait.sh" });
		const text = getTextOutput(collapsed, false);
		expect(text.startsWith("waiting for the service to come up\n[line repeated 200 times]\nready\n")).toBe(true);
		expect(text).toContain("[wait.sh output filtered: retained 3 of 201 lines. Full output: ");
		const reduction = collapsed.details?.outputReduction;
		expect(reduction).toMatchObject({ kind: "generic", omittedLines: 199, persistRaw: true });
		expect(readFileSync(reduction!.rawPath!, "utf-8")).toBe(repeated);
	});

	it("applies a bundled rule and names it", async () => {
		const outputDirectory = mkdtempSync(join(tmpdir(), "pi-bash-reduction-"));
		cleanupDirectories.push(outputDirectory);
		const npm = `${Array.from({ length: 30 }, (_, index) => `npm warn deprecated pkg${index}@1.0.0: no longer supported`).join("\n")}\n\nadded 412 packages in 9s\n\nfound 0 vulnerabilities\n`;
		const tool = createBashTool(process.cwd(), { operations: operationsFor(npm), outputDirectory });
		const result = await tool.execute("npm", { command: "cd packages/app && npm install" });
		const text = getTextOutput(result, false);
		expect(text.startsWith("added 412 packages in 9s\nfound 0 vulnerabilities\n")).toBe(true);
		expect(result.details?.outputReduction).toMatchObject({ kind: "rule:npm-install", family: "npm install" });
	});
});
