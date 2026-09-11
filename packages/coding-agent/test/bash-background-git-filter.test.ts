/**
 * A background (`background: true`) bash call runs detached: its own child shell, seeded with the
 * pool's current directory, leaving the agent's persistent session untouched. The git filter
 * spawns git itself instead of going through the shell, so a `cd <path> && git <subcommand>` needs
 * the directory that cd lands in. For a foreground call the cd is replayed into the session and
 * the session moves with it. For a detached call the landing directory is observed by a detached
 * probe (`cd <path> && pwd`), because moving the session would be a side effect a detached command
 * must never have.
 *
 * These drive the real bash tool against a real repository: the family filters are off for a
 * caller-supplied backend (they need the real shell), so a fake `operations` backend cannot
 * exercise this path at all.
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { getTextOutput } from "../src/core/tools/render-utils.ts";

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("bash tool: a background filtered git call with a leading cd", () => {
	let repoDir: string;
	let outputDirectory: string;
	let spawnedCommands: string[];

	beforeEach(() => {
		repoDir = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-bash-bg-git-filter-")));
		outputDirectory = mkdtempSync(join(tmpdir(), "pi-bash-bg-git-filter-out-"));
		spawnedCommands = [];
		execSync("git init -q", { cwd: repoDir });
		execSync("git config user.email test@example.com", { cwd: repoDir });
		execSync("git config user.name Test", { cwd: repoDir });
		mkdirSync(join(repoDir, "sub"));
		writeFileSync(join(repoDir, "sub", "tracked.txt"), "one\n");
		execSync("git add .", { cwd: repoDir });
		execSync("git commit -q -m first", { cwd: repoDir });
		writeFileSync(join(repoDir, "sub", "tracked.txt"), "two\n");
	});

	afterEach(() => {
		rmSync(repoDir, { recursive: true, force: true });
		rmSync(outputDirectory, { recursive: true, force: true });
	});

	function makeTool(name: string) {
		return createBashTool(repoDir, {
			outputDirectory,
			sessionKey: `bash-bg-git-filter-${name}-${Date.now()}`,
			spawnHook: (context) => {
				spawnedCommands.push(context.command);
				return context;
			},
		});
	}

	it("probes for the landing directory, filters git there, and leaves the session where it stood", async () => {
		const tool = makeTool("background");
		const status = await tool.execute("bg-git-status", { command: "cd sub && git status --short", background: true });
		const statusText = getTextOutput(status, false);
		// The filtered projection of `git status --short` inside sub: the modified file, no advice.
		expect(statusText).toContain("tracked.txt");
		expect(statusText).not.toContain("(use ");
		// The session never moved: the next command still starts at the pool's directory.
		const pwd = await tool.execute("pwd-after-background", { command: "pwd" });
		expect(getTextOutput(pwd, false).trim()).toBe(repoDir);
		// The landing directory came from a probe, not from a session cd.
		expect(spawnedCommands.some((entry) => entry.includes("pwd"))).toBe(true);
	});

	it("reports a failing background cd as the command outcome instead of filtering elsewhere", async () => {
		const tool = makeTool("bad-cd");
		await expect(
			tool.execute("bg-git-bad-cd", { command: "cd missing-dir && git status", background: true }),
		).rejects.toThrow(/exited with code/u);
		const pwd = await tool.execute("pwd-after-bad-cd", { command: "pwd" });
		expect(getTextOutput(pwd, false).trim()).toBe(repoDir);
	});

	it("keeps replaying the cd into the session for the foreground shape", async () => {
		const tool = makeTool("foreground");
		const status = await tool.execute("fg-git-status", { command: "cd sub && git status --short" });
		expect(getTextOutput(status, false)).toContain("tracked.txt");
		const pwd = await tool.execute("pwd-after-foreground", { command: "pwd" });
		expect(getTextOutput(pwd, false).trim()).toBe(join(repoDir, "sub"));
	});
});
