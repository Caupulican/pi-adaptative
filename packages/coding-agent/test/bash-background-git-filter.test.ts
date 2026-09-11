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
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * The same background shape on the Windows PowerShell floor (the tier that runs when
 * `windowsShell.pythonEngine` is off). The floor's contract router translates single MODEL-authored
 * commands and refuses `&&`, so the Bash probe cannot reach it; the tool authors the probe itself,
 * so it hands the floor the PowerShell program that answers the same question.
 *
 * Driven from POSIX by pinning the contract platform to win32 and pointing the tool at a stand-in
 * PowerShell 7 host, which is the only way to observe the floor's own grammar without a Windows
 * machine. The real floor's behavior on a Windows runner is covered by test/windows-floor-live.test.ts.
 */
describe.skipIf(isWindows)("bash tool: a background filtered git call on the PowerShell floor", () => {
	let repoDir: string;
	let hostDir: string;
	let pwshPath: string;
	let commandLog: string;

	beforeEach(() => {
		repoDir = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-floor-bg-git-")));
		hostDir = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-floor-pwsh-")));
		commandLog = join(hostDir, "commands.log");
		pwshPath = join(hostDir, "pwsh");
		// A stand-in for the PowerShell 7 host: it records the program it was handed and answers the
		// two floor programs this path produces, so the assertions are about the tool's composition.
		writeFileSync(
			pwshPath,
			[
				"#!/bin/sh",
				'for program in "$@"; do :; done',
				`printf '%s\\n<<<END>>>\\n' "$program" >> '${commandLog}'`,
				"target=$(printf '%s' \"$program\" | sed -n \"s/^Set-Location -LiteralPath '\\\\(.*\\\\)'; (Get-Location)\\\\.Path$/\\\\1/p\" | sed \"s/''/'/g\")",
				'if [ -n "$target" ]; then cd "$target" || exit 1; fi',
				'case "$program" in *"(Get-Location).Path"*) pwd ;; esac',
				"exit 0",
			].join("\n"),
			{ mode: 0o755 },
		);
		execSync("git init -q", { cwd: repoDir });
		execSync("git config user.email test@example.com", { cwd: repoDir });
		execSync("git config user.name Test", { cwd: repoDir });
		mkdirSync(join(repoDir, "sub"));
		// A repository of its own, so the porcelain status (always repository-root relative) names
		// the directory git ran in rather than printing the same paths from either side.
		execSync("git init -q", { cwd: join(repoDir, "sub") });
		writeFileSync(join(repoDir, "root-marker.txt"), "one\n");
		writeFileSync(join(repoDir, "sub", "child-marker.txt"), "one\n");
	});

	afterEach(() => {
		rmSync(repoDir, { recursive: true, force: true });
		rmSync(hostDir, { recursive: true, force: true });
	});

	it("probes the landing directory with a PowerShell program the floor accepts", async () => {
		const tool = createBashTool(repoDir, {
			platform: "win32",
			windowsShellPythonEngine: false,
			shellPath: pwshPath,
			sessionKey: `floor-bg-git-${Date.now()}`,
			outputReduction: { enabled: false },
		});
		const status = await tool.execute("bg-git-status", { command: "cd sub && git status --short", background: true });
		const statusText = getTextOutput(status, false);
		expect(statusText).toContain("child-marker.txt");
		expect(statusText).not.toContain("root-marker.txt");
		const programs = readFileSync(commandLog, "utf-8").split("<<<END>>>\n").filter(Boolean);
		expect(programs).toHaveLength(1);
		expect(programs[0]).toContain("Set-Location -LiteralPath 'sub'; (Get-Location).Path");
		// The Bash spelling never reaches the floor: it is exactly what its router refuses.
		expect(programs[0]).not.toContain("&&");
	});

	it("quotes a directory containing a single quote for the floor", async () => {
		const awkward = "it's sub";
		mkdirSync(join(repoDir, awkward));
		execSync("git init -q", { cwd: join(repoDir, awkward) });
		writeFileSync(join(repoDir, awkward, "quoted-marker.txt"), "one\n");
		const tool = createBashTool(repoDir, {
			platform: "win32",
			windowsShellPythonEngine: false,
			shellPath: pwshPath,
			sessionKey: `floor-bg-git-quote-${Date.now()}`,
			outputReduction: { enabled: false },
		});
		const status = await tool.execute("bg-git-quoted", {
			command: `cd "${awkward}" && git status --short`,
			background: true,
		});
		expect(getTextOutput(status, false)).toContain("quoted-marker.txt");
		expect(readFileSync(commandLog, "utf-8")).toContain("Set-Location -LiteralPath 'it''s sub'; (Get-Location).Path");
	});
});
