import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BashOperations, type BashToolDetails, createBashTool } from "../src/core/tools/bash.ts";
import { assessShellSearchScope, parseShellSearchInvocationScope } from "../src/core/tools/search-command-guard.ts";

describe("shared shell search invocation scope", () => {
	it("owns value-taking flags, explicit targets, positive globs, and piped stdin", () => {
		expect(parseShellSearchInvocationScope("rg", ["-A", "3", "needle|other"], true)).toEqual({
			targets: [],
			positiveGlobs: [],
			hasScopeFilter: false,
			readsStdin: true,
			metaOnly: false,
		});
		expect(parseShellSearchInvocationScope("rg", ["-g", "*.ts", "needle", "src"], false)).toEqual({
			targets: ["src"],
			positiveGlobs: ["*.ts"],
			hasScopeFilter: true,
			readsStdin: false,
			metaOnly: false,
		});
		expect(parseShellSearchInvocationScope("grep", ["-E", "needle|other"], true)).toEqual({
			targets: [],
			positiveGlobs: [],
			hasScopeFilter: false,
			readsStdin: true,
			metaOnly: false,
		});
	});
});

describe("shell search scope assessment", () => {
	it.each([
		["rg needle", "rg"],
		["rg --files", "rg"],
		["rg needle . | head -100", "rg"],
		["rg needle . 2>/dev/null", "rg"],
		["rg needle *", "rg"],
		["rg needle $PWD", "rg"],
		["rg --files /", "rg"],
		["rg needle / --glob '*.ts'", "rg"],
		["rg -e needle", "rg"],
		["cd packages && rg needle", "rg"],
		["cd packages&&rg needle", "rg"],
		["grep -R needle .", "grep"],
		["grep -R needle / --include '*.ts'", "grep"],
		["printf needle | grep -R needle /", "grep"],
		["find . -type f", "find"],
		["find / -name '*.ts'", "find"],
		["find -L / -name '*.ts'", "find"],
		["fd .", "fd"],
		["fd --type f .", "fd"],
	])("blocks broad search %s", (command, searchTool) => {
		expect(assessShellSearchScope(command, "/repo")).toMatchObject({ kind: "broad", searchTool });
	});

	it.each([
		"rg needle packages/agent/src",
		"rg needle . --glob '*.ts'",
		"rg --files packages/agent/src",
		"rg -e needle packages/agent/src",
		"grep -R needle packages/agent/src",
		"find . -name '*.ts'",
		"fd '*.ts' packages",
		"echo rg needle",
		"printf 'needle\\n' | rg needle",
		"printf 'needle\\n' |& rg needle",
		"printf 'needle\\n' | rg -A 3 'needle|other'",
		"printf 'needle\\n' | grep -E 'needle|other'",
		"rg 'needle|other' packages/agent/src",
		"rg needle packages/agent/src > matches.txt",
		"rg --type-list",
	])("allows scoped search %s", (command) => {
		expect(assessShellSearchScope(command, "/repo")).toEqual({ kind: "scoped" });
	});
});

describe("bash broad-search guard", () => {
	let outputDirectory = "";
	let executedCommands: string[];
	let operations: BashOperations;

	beforeEach(() => {
		outputDirectory = mkdtempSync(join(tmpdir(), "pi-bash-search-guard-"));
		executedCommands = [];
		operations = {
			exec: async (command, _cwd, { onData }) => {
				executedCommands.push(command);
				onData(Buffer.from("src/a.ts:needle\nsrc/b.ts:needle\n", "utf-8"));
				return { exitCode: 0 };
			},
		};
	});

	afterEach(() => {
		rmSync(outputDirectory, { recursive: true, force: true });
	});

	it("rejects a broad scan before execution and teaches the bounded alternatives", async () => {
		const tool = createBashTool("/repo", { operations, outputDirectory });

		await expect(tool.execute("search-1", { command: "rg needle" })).rejects.toThrow(
			/narrow.*path.*glob.*broadSearch="route-to-file"/is,
		);
		expect(executedCommands).toEqual([]);
	});

	it("executes an explicit broad override while routing all output to a file", async () => {
		const tool = createBashTool("/repo", { operations, outputDirectory });

		const result = await tool.execute("search-2", {
			command: "rg needle",
			broadSearch: "route-to-file",
		});
		const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("");
		const details = result.details as BashToolDetails | undefined;

		expect(executedCommands).toHaveLength(1);
		if (process.platform === "win32") {
			expect(executedCommands[0]).toContain("& 'rg' 'needle'");
		} else {
			expect(executedCommands[0]).toBe("rg needle");
		}
		expect(text).toContain("Broad search output routed to");
		expect(text).not.toContain("src/a.ts:needle");
		expect(details?.fullOutputPath).toBeDefined();
		expect(readFileSync(details?.fullOutputPath ?? "", "utf-8")).toBe("src/a.ts:needle\nsrc/b.ts:needle\n");
	});
});
