import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { type BashOperations, createBashTool, createLocalBashOperations } from "../src/core/tools/bash.ts";
import {
	classifyGitCommand,
	executeFilteredGit,
	isComplexShellCommand,
	tokenizeCommand,
} from "../src/core/tools/git-filter.ts";

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.join("\n");
}

describe("Git Output Filter - Classification & Tokenizer", () => {
	it("should tokenize commands properly with quotes and escapes", () => {
		expect(tokenizeCommand('git commit -m "hello world"')).toEqual(["git", "commit", "-m", "hello world"]);
		expect(tokenizeCommand("git commit -m 'hello world'")).toEqual(["git", "commit", "-m", "hello world"]);
		expect(tokenizeCommand("git add file\\ space.txt")).toEqual(["git", "add", "file space.txt"]);
	});

	it("should recognize complex shell commands", () => {
		expect(isComplexShellCommand("git status")).toBe(false);
		expect(isComplexShellCommand("git status && git log")).toBe(true);
		expect(isComplexShellCommand("git log | cat")).toBe(true);
		expect(isComplexShellCommand("git status > output.txt")).toBe(true);
		expect(isComplexShellCommand("git status; echo done")).toBe(true);
	});

	it("should classify simple git commands as eligible", () => {
		const res = classifyGitCommand("git status");
		expect(res.eligible).toBe(true);
		expect(res.subcommand).toBe("status");
		expect(res.globalOptions).toEqual([]);
		expect(res.subcommandArgs).toEqual([]);
	});

	it("should classify git commands with global options as eligible", () => {
		const res = classifyGitCommand("git -C /tmp status -s");
		expect(res.eligible).toBe(true);
		expect(res.subcommand).toBe("status");
		expect(res.globalOptions).toEqual(["-C", "/tmp"]);
		expect(res.subcommandArgs).toEqual(["-s"]);
	});

	it("should respect global and local env opt-outs", () => {
		const resPrefix = classifyGitCommand("PI_TOOL_FILTER_DISABLED=1 git status");
		expect(resPrefix.eligible).toBe(false);

		const resGitPrefix = classifyGitCommand("PI_GIT_FILTER_DISABLED=1 git status");
		expect(resGitPrefix.eligible).toBe(false);

		process.env.PI_TOOL_FILTER_DISABLED = "1";
		expect(classifyGitCommand("git status").eligible).toBe(false);
		delete process.env.PI_TOOL_FILTER_DISABLED;

		process.env.PI_GIT_FILTER_DISABLED = "1";
		expect(classifyGitCommand("git status").eligible).toBe(false);
		delete process.env.PI_GIT_FILTER_DISABLED;
	});

	it("should refuse unrelated environment prefixes to preserve native command semantics", () => {
		expect(classifyGitCommand("GIT_PAGER=cat git status").eligible).toBe(false);
	});
});

describe("Git Output Filter - Subcommands", () => {
	let testRepoDir: string;

	beforeEach(() => {
		testRepoDir = join(tmpdir(), `pi-git-filter-test-${Date.now()}`);
		mkdirSync(testRepoDir, { recursive: true });

		// Initialize temp git repository
		execSync("git init -b main", { cwd: testRepoDir });
		execSync('git config user.name "Test User"', { cwd: testRepoDir });
		execSync('git config user.email "test@example.com"', { cwd: testRepoDir });
		execSync("git config commit.gpgsign false", { cwd: testRepoDir });

		// Add initial commit to ensure HEAD is valid for branch/stash operations
		writeFileSync(join(testRepoDir, "init.txt"), "init");
		execSync("git add init.txt", { cwd: testRepoDir });
		execSync('git commit -m "Initial commit"', { cwd: testRepoDir });
	});

	afterEach(() => {
		rmSync(testRepoDir, { recursive: true, force: true });
	});

	it("should handle status for empty clean repository", async () => {
		const res = await executeFilteredGit(testRepoDir, "status", [], []);
		expect(res.exitCode).toBe(0);
		expect(res.output).toContain("nothing to commit, working tree clean");
	});

	it("should handle status with changes", async () => {
		writeFileSync(join(testRepoDir, "file1.txt"), "hello");
		const res = await executeFilteredGit(testRepoDir, "status", [], []);
		expect(res.exitCode).toBe(0);
		expect(res.output).toContain("file1.txt");
		expect(res.output).not.toContain("nothing to commit");
	});

	it("should handle log compaction", async () => {
		writeFileSync(join(testRepoDir, "file1.txt"), "hello");
		execSync("git add file1.txt", { cwd: testRepoDir });
		execSync('git commit -m "First commit\n\nSome body\nSigned-off-by: Me"', { cwd: testRepoDir });

		const res = await executeFilteredGit(testRepoDir, "log", [], []);
		expect(res.exitCode).toBe(0);
		expect(res.output).toContain("First commit");
		expect(res.output).toContain("Some body");
		expect(res.output).not.toContain("Signed-off-by:");
		expect(res.output).not.toContain("Author:");
	});

	it("should handle diff compaction", async () => {
		writeFileSync(join(testRepoDir, "file1.txt"), "hello\n");
		execSync("git add file1.txt", { cwd: testRepoDir });
		execSync('git commit -m "First"', { cwd: testRepoDir });

		writeFileSync(join(testRepoDir, "file1.txt"), "hello\nworld\n");
		const res = await executeFilteredGit(testRepoDir, "diff", [], []);
		expect(res.exitCode).toBe(0);
		expect(res.output).toContain("+world");
		expect(res.output).toContain("file1.txt");
	});

	it("should handle show compaction", async () => {
		writeFileSync(join(testRepoDir, "file1.txt"), "hello\n");
		execSync("git add file1.txt", { cwd: testRepoDir });
		execSync('git commit -m "First commit"', { cwd: testRepoDir });

		const res = await executeFilteredGit(testRepoDir, "show", [], []);
		expect(res.exitCode).toBe(0);
		expect(res.output).toContain("commit");
		expect(res.output).toContain("First commit");
	});

	it("should handle push, pull, fetch, branch, stash, worktree summaries", async () => {
		// Branch show-current
		const branchRes = await executeFilteredGit(testRepoDir, "branch", [], ["--show-current"]);
		expect(branchRes.output.trim()).toBe("main");

		// Branch create
		const branchCreateRes = await executeFilteredGit(testRepoDir, "branch", [], ["test-branch"]);
		expect(branchCreateRes.exitCode).toBe(0);

		// Stash
		writeFileSync(join(testRepoDir, "file1.txt"), "stashed changes");
		execSync("git add file1.txt", { cwd: testRepoDir });
		const stashRes = await executeFilteredGit(testRepoDir, "stash", [], []);
		expect(stashRes.exitCode).toBe(0);

		// Stash list
		const stashListRes = await executeFilteredGit(testRepoDir, "stash", [], ["list"]);
		expect(stashListRes.output).toContain("WIP on main");
	});

	it("bash tool should compact git status and honor env-prefix opt-outs", async () => {
		const bash = createBashTool(testRepoDir);

		const compact = await bash.execute("git-status-compact", { command: "git status" });
		expect(getTextOutput(compact)).toContain("## main");

		const rawToolOptOut = await bash.execute("git-status-tool-optout", {
			command: "PI_TOOL_FILTER_DISABLED=1 git status",
		});
		expect(getTextOutput(rawToolOptOut)).toContain("On branch main");

		const rawGitOptOut = await bash.execute("git-status-git-optout", {
			command: "PI_GIT_FILTER_DISABLED=1 git status",
		});
		expect(getTextOutput(rawGitOptOut)).toContain("On branch main");
	});

	it("bash tool should preserve custom operations for eligible git commands", async () => {
		let execCalled = false;
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				execCalled = true;
				onData(Buffer.from("custom git status\n", "utf-8"));
				return { exitCode: 0 };
			},
		};
		const bash = createBashTool(testRepoDir, { operations });

		const result = await bash.execute("git-status-custom-ops", { command: "git status" });
		expect(execCalled).toBe(true);
		expect(getTextOutput(result).trim()).toBe("custom git status");
	});

	it("bash tool should pass through explicit git log formats", async () => {
		const bash = createBashTool(testRepoDir);
		const result = await bash.execute("git-log-format", { command: "git log --pretty=%H -n 1" });
		const output = getTextOutput(result).trim();

		expect(output).toMatch(/^[0-9a-f]{40}$/);
	});

	it("interactive bash executor should opt into git filtering only when requested", async () => {
		const raw = await executeBashWithOperations("git status", testRepoDir, createLocalBashOperations());
		expect(raw.output).toContain("On branch main");

		const filtered = await executeBashWithOperations("git status", testRepoDir, createLocalBashOperations(), {
			enableGitFilter: true,
		});
		expect(filtered.output).toContain("## main");
	});
});
