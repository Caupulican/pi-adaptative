import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { createBashTool } from "../src/core/tools/bash.ts";
import { executeFilteredGit } from "../src/core/tools/git-filter.ts";
import { prepareFilteredGitDisplay } from "../src/core/tools/git-filter-display.ts";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../src/kernel/utils/truncate.ts";

describe("filtered Git output for Bash and recorded commands", () => {
	let directory: string;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-git-display-"));
	});
	afterEach(async () => {
		await rm(directory, { force: true, recursive: true });
	});

	it("bounds filtered output at both model entry points and reports Git failures", async () => {
		const git = (args: string[], input?: string) =>
			execFileSync("git", args, { cwd: directory, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
		git(["init", "--quiet"]);
		await writeFile(join(directory, "sample.txt"), "seed\n");
		const staged = await executeFilteredGit(directory, "add", [], ["sample.txt"]);
		expect(staged.exitCode).toBe(0);
		expect(staged.rawBytes?.toString()).toContain("sample.txt");
		// Keep the witness a full preview budget away from either end for every head/tail split.
		const omittedLine = `commit message line ${DEFAULT_MAX_LINES + 1}`;
		const message = Array.from({ length: DEFAULT_MAX_LINES * 3 }, (_, i) => `commit message line ${i}`).join("\n");
		git(
			[
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"-c",
				"commit.gpgSign=false",
				"commit",
				"--quiet",
				"-F",
				"-",
			],
			message,
		);
		const command = "git log -1 --format=%B";
		const tool = createBashTool(directory, { forceCwd: true, outputDirectory: directory });
		const rawStatus = await tool.execute("raw-git-status", { command: "git status --short", fullOutput: true });
		expect(rawStatus.details?.displayTruncated).toBeUndefined();
		expect(rawStatus.content).toEqual([{ type: "text", text: "(no output)" }]);
		const run = await tool.execute("git-log", { command });
		expect(run.details?.displayTruncated).toBe(true);
		const rendered = run.content[0];
		if (rendered?.type !== "text") throw new Error("Expected Git text");
		expect(rendered.text).toContain("middle omitted");
		expect(rendered.text).not.toContain(omittedLine);
		const chunks: string[] = [];
		const unused = {
			exec: async (): Promise<never> => {
				throw new Error("Expected filtered Git");
			},
		};
		const recorded = await executeBashWithOperations(command, directory, unused, {
			enableGitFilter: true,
			onChunk: (text) => chunks.push(text),
		});
		try {
			expect(recorded.truncated).toBe(true);
			expect(recorded.output).toBe(chunks.join(""));
			expect(recorded.output).not.toContain(omittedLine);
			expect(Buffer.byteLength(recorded.output)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
			const raw = await readFile(recorded.fullOutputPath!, "utf8");
			expect(raw).toContain(omittedLine);
			expect(raw).toBe(await readFile(run.details!.fullOutputPath!, "utf8"));
		} finally {
			if (recorded.fullOutputPath) await rm(recorded.fullOutputPath, { force: true });
		}
		await expect(tool.execute("git-fails", { command: "git show refs/heads/missing-fixture-ref" })).rejects.toThrow();
		const failed = await executeBashWithOperations("git show refs/heads/missing-fixture-ref", directory, unused, {
			enableGitFilter: true,
		});
		expect(failed.exitCode).not.toBe(0);
		expect(failed.output).toContain("missing-fixture-ref");
	});

	it("preserves the process exit and recovery path when a failing Git query overflows", async () => {
		execFileSync("git", ["init", "--quiet"], { cwd: directory });
		await writeFile(join(directory, "changed-file.txt"), "added\n");
		execFileSync("git", ["add", "changed-file.txt"], { cwd: directory });
		vi.stubEnv("PI_GIT_FILTER_MAX_RETAINED_BYTES", "8");
		try {
			const tool = createBashTool(directory, { forceCwd: true, outputDirectory: directory });
			await expect(
				tool.execute("git-exits-one", { command: "git diff --cached --name-only --exit-code" }),
			).rejects.toThrow(/Raw Git output:[^\n]+[\s\S]*Command exited with code 1/u);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("bounds the selected lines and preserves the complete raw stream across repeated publication", async () => {
		const rawBytes = Buffer.from("original Git stream\n");
		const output = Array.from({ length: DEFAULT_MAX_LINES + 25 }, (_, i) => `branch-${i}`).join("\n");
		const result = { output, rawOut: rawBytes.toString(), rawBytes, exitCode: 0 };
		const raw = new OutputAccumulator({ tempDirectory: directory });
		const capped = await prepareFilteredGitDisplay(result, undefined, raw);
		expect(capped.display.truncatedBy).toBe("lines");
		expect(capped.display.outputLines).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
		expect(capped.display.content).toContain("branch-0");
		expect(capped.display.content).toContain(`branch-${DEFAULT_MAX_LINES + 24}`);
		expect(capped.toolText).toContain(capped.fullOutputPath);
		expect((await raw.publishSnapshot(true)).fullOutputPath).toBe(capped.fullOutputPath);
		expect(await readFile(capped.fullOutputPath!)).toEqual(rawBytes);

		const selected = await prepareFilteredGitDisplay(
			result,
			{ kind: "tail", lines: 1 },
			new OutputAccumulator({ tempDirectory: directory }),
		);
		expect(selected.partial).toBe(false);
		expect(selected.toolText).toBe(`branch-${DEFAULT_MAX_LINES + 24}\n`);
		expect(selected.fullOutputPath).toBeUndefined();
	});

	it("caps an oversized multibyte line and never advertises a retained head as a full file", async () => {
		const line = "界".repeat(DEFAULT_MAX_BYTES);
		const result = { output: line, rawOut: line, exitCode: 0 };
		const clipped = await prepareFilteredGitDisplay(
			result,
			undefined,
			new OutputAccumulator({ tempDirectory: directory }),
		);
		expect(clipped.display.content).toMatch(/^界+$/u);
		expect(Buffer.byteLength(clipped.display.content)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(clipped.partial).toBe(true);
		expect(clipped.fullOutputPath).toBeUndefined();
		expect(clipped.toolText).toContain("Full output unavailable");
		const archived = await prepareFilteredGitDisplay(
			{ ...result, fullOutputPath: "/producer/full.log" },
			undefined,
			new OutputAccumulator({ tempDirectory: directory }),
		);
		expect(archived.fullOutputPath).toBe("/producer/full.log");
		expect(archived.toolText).toContain("/producer/full.log");
		expect(await readdir(directory)).toEqual([]);
	});
});
