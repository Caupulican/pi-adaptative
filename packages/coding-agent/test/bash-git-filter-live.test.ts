/**
 * The git filter must run in the live agent, which always installs an environment-only spawn hook
 * on the bash tool. Measured on live sessions the filter never ran because any hook was treated as
 * an execution override; every `git diff`, `git show` and `git status` went to the model raw.
 * These tests drive the real bash tool against a real repository.
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { getTextOutput } from "../src/core/tools/render-utils.ts";

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("bash tool: git filter in the live configuration", () => {
	let repoDir: string;
	let outputDirectory: string;

	beforeEach(() => {
		repoDir = mkdtempSync(join(tmpdir(), "pi-git-filter-live-"));
		outputDirectory = mkdtempSync(join(tmpdir(), "pi-git-filter-live-out-"));
		execSync("git init -q", { cwd: repoDir });
		execSync("git config user.email test@example.com", { cwd: repoDir });
		execSync("git config user.name Test", { cwd: repoDir });
		mkdirSync(join(repoDir, "sub"));
		writeFileSync(join(repoDir, "sub", "tracked.txt"), "one\n");
		execSync("git add .", { cwd: repoDir });
		execSync("git commit -q -m first", { cwd: repoDir });
		execSync("git commit -q --allow-empty -m second", { cwd: repoDir });
		writeFileSync(join(repoDir, "sub", "tracked.txt"), "two\n");
		writeFileSync(join(repoDir, "new.txt"), "new\n");
	});

	afterEach(() => {
		rmSync(repoDir, { recursive: true, force: true });
		rmSync(outputDirectory, { recursive: true, force: true });
	});

	it("filters git status when the spawn hook only adjusts the environment", async () => {
		const tool = createBashTool(repoDir, {
			outputDirectory,
			sessionKey: `git-filter-live-env-${Date.now()}`,
			spawnHook: (context) => ({ ...context, env: { ...context.env, PI_TEST_HOOK_MARK: "1" } }),
		});
		const result = await tool.execute("git-status-env-hook", { command: "git status" });
		const text = getTextOutput(result, false);
		// The filtered status is the porcelain projection: no advice lines, both changes named.
		expect(text).not.toContain("(use ");
		expect(text).toContain("tracked.txt");
		expect(text).toContain("new.txt");
	});

	it("leaves the command to the shell when the hook rewrites the command text", async () => {
		const tool = createBashTool(repoDir, {
			outputDirectory,
			sessionKey: `git-filter-live-rewrite-${Date.now()}`,
			spawnHook: (context) => ({ ...context, command: `true\n${context.command}` }),
		});
		const result = await tool.execute("git-status-rewrite-hook", { command: "git status" });
		const text = getTextOutput(result, false);
		expect(text).toContain("On branch");
	});

	it("replays a leading cd into the session and runs the filtered git there", async () => {
		const tool = createBashTool(repoDir, {
			outputDirectory,
			sessionKey: `git-filter-live-cd-${Date.now()}`,
			spawnHook: (context) => ({ ...context, env: { ...context.env, PI_TEST_HOOK_MARK: "1" } }),
		});
		const status = await tool.execute("git-status-cd", { command: "cd sub && git status --short" });
		const statusText = getTextOutput(status, false);
		expect(statusText).toContain("tracked.txt");
		expect(statusText).not.toContain("(use ");
		// The session moved: the next plain command runs inside sub.
		const pwd = await tool.execute("pwd-after-cd", { command: "pwd" });
		expect(getTextOutput(pwd, false).trim().endsWith("/sub")).toBe(true);
		// And a later filtered run without a prefix uses the moved directory.
		const log = await tool.execute("git-log-after-cd", { command: "git log --oneline | head -1" });
		expect(getTextOutput(log, false).trim().split("\n")).toHaveLength(1);
	});

	it("reports a failing cd as the command outcome instead of running git elsewhere", async () => {
		const tool = createBashTool(repoDir, {
			outputDirectory,
			sessionKey: `git-filter-live-badcd-${Date.now()}`,
		});
		await expect(tool.execute("git-status-bad-cd", { command: "cd missing-dir && git status" })).rejects.toThrow(
			/exited with code/u,
		);
	});
});
