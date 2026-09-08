import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { getTextOutput } from "../src/core/tools/render-utils.ts";
import { disposeShellExecutionSessionAndWait } from "../src/core/tools/shell-execution-session.ts";

/**
 * Drives the real Windows PowerShell floor end to end: a live PowerShell process, real cwd/env
 * persistence, and real exit codes. The Python engine tier is intentionally off (windowsShellPythonEngine:
 * false) — these cases exercise the plain floor the adversarial router suite reasons about statically.
 * This file cannot execute on this Linux dev machine; it is gated so it compiles and skips cleanly here,
 * and is written to be correct by construction for a win32 CI runner (mirrors the fixture pattern in
 * test/bash-pinned-directory.test.ts and test/windows-shell-engine-persistent.test.ts).
 */

function findPython(): string | undefined {
	for (const candidate of [process.env.PI_TEST_PYTHON, "python", "python3"]) {
		if (!candidate) continue;
		if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) return candidate;
	}
	return undefined;
}

function createFloorTool(root: string, sessionKey: string) {
	return createBashTool(root, {
		sessionKey,
		outputReduction: { enabled: false },
		// The Python engine tier is a separate coordinator (covered by
		// test/windows-shell-engine-persistent.test.ts); disabling it here keeps this file scoped to
		// the plain PowerShell-floor behavior the adversarial router suite documents statically.
		windowsShellPythonEngine: false,
	});
}

type FloorTool = ReturnType<typeof createFloorTool>;

function textOf(result: Awaited<ReturnType<FloorTool["execute"]>>): string {
	return getTextOutput(result, false);
}

describe.skipIf(process.platform !== "win32")("live Windows PowerShell floor (real process execution)", () => {
	const python = findPython();

	it("round-trips single-quote, double-quote, dollar, percent, ampersand, pipe, redirection, and Unicode through echo", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-floor-echo-"));
		const root = realpathSync(scratch);
		const sessionKey = `floor-echo-${randomUUID()}`;
		const tool = createFloorTool(root, sessionKey);
		try {
			const cases = ["it's a test", 'say "hi" now', "$HOME", "%PATH%", "a & b", "a | b", "a < b", "a > b", "日本語"];
			for (const value of cases) {
				const result = await tool.execute(randomUUID(), { command: `echo '${value.replaceAll("'", "''")}'` });
				expect(textOf(result).trim()).toBe(value);
			}
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it.skipIf(!python)("reports the real exit code of a failing external process", async () => {
		if (!python) throw new Error("unreachable: gated by skipIf");
		const scratch = mkdtempSync(join(tmpdir(), "pi-floor-exit-"));
		const root = realpathSync(scratch);
		const sessionKey = `floor-exit-${randomUUID()}`;
		const tool = createFloorTool(root, sessionKey);
		try {
			await expect(tool.execute("exit-code", { command: `${python} -c "import sys; sys.exit(3)"` })).rejects.toThrow(
				/Command exited with code 3/,
			);
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it.skipIf(!python)("merges stderr into the returned output", async () => {
		if (!python) throw new Error("unreachable: gated by skipIf");
		const scratch = mkdtempSync(join(tmpdir(), "pi-floor-stderr-"));
		const root = realpathSync(scratch);
		const sessionKey = `floor-stderr-${randomUUID()}`;
		const tool = createFloorTool(root, sessionKey);
		try {
			const result = await tool.execute("stderr", {
				command: `${python} -c "import sys; sys.stderr.write('stderr-marker\\n')"`,
			});
			expect(textOf(result)).toContain("stderr-marker");
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it.skipIf(!python)("passes through UTF-8 output from a Python one-liner", async () => {
		if (!python) throw new Error("unreachable: gated by skipIf");
		const scratch = mkdtempSync(join(tmpdir(), "pi-floor-utf8-"));
		const root = realpathSync(scratch);
		const sessionKey = `floor-utf8-${randomUUID()}`;
		const tool = createFloorTool(root, sessionKey);
		try {
			const result = await tool.execute("utf8", { command: `${python} -c "print('日本語')"` });
			expect(textOf(result).trim()).toBe("日本語");
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("persists the working directory across two calls after a bare cd", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-floor-cwd-"));
		const root = realpathSync(scratch);
		mkdirSync(join(root, "sub"));
		const sessionKey = `floor-cwd-${randomUUID()}`;
		const tool = createFloorTool(root, sessionKey);
		try {
			await tool.execute("cd", { command: "cd sub" });
			const result = await tool.execute("pwd", { command: "pwd" });
			expect(realpathSync.native(textOf(result).trim())).toBe(realpathSync.native(join(root, "sub")));
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("invokes a generated .cmd script with a quoted, space-containing argument", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-floor-cmd-"));
		const root = realpathSync(scratch);
		const scriptPath = join(root, "args-echo.cmd");
		writeFileSync(scriptPath, "@echo off\r\necho %*\r\n");
		const sessionKey = `floor-cmd-${randomUUID()}`;
		const tool = createFloorTool(root, sessionKey);
		try {
			const result = await tool.execute("cmd-script", {
				command: `'${scriptPath.replace(/\\/g, "/")}' 'has a space and "quotes"'`,
			});
			expect(textOf(result).trim()).toBe('has a space and "quotes"');
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("invokes a generated .ps1 script with a quoted, space-containing argument", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-floor-ps1-"));
		const root = realpathSync(scratch);
		const scriptPath = join(root, "args-echo.ps1");
		writeFileSync(
			scriptPath,
			"param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Values)\nWrite-Output ($Values -join '|')\n",
		);
		const sessionKey = `floor-ps1-${randomUUID()}`;
		const tool = createFloorTool(root, sessionKey);
		try {
			const result = await tool.execute("ps1-script", {
				command: `'${scriptPath.replace(/\\/g, "/")}' 'has a space and "quotes"'`,
			});
			expect(textOf(result).trim()).toBe('has a space and "quotes"');
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("produces a timeout result instead of hanging on a long-running external process", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-floor-timeout-"));
		const root = realpathSync(scratch);
		const sessionKey = `floor-timeout-${randomUUID()}`;
		const tool = createFloorTool(root, sessionKey);
		try {
			await expect(tool.execute("ping-timeout", { command: "ping -n 30 127.0.0.1", timeout: 5 })).rejects.toThrow(
				/Command timed out after 5 seconds/,
			);
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(scratch, { recursive: true, force: true });
		}
	}, 20_000);

	it("resolves and runs where.exe through drive-root translation", async () => {
		// Assumes git is on PATH, as it is on this repo's windows-latest CI runners.
		const scratch = mkdtempSync(join(tmpdir(), "pi-floor-whereexe-"));
		const root = realpathSync(scratch);
		const sessionKey = `floor-whereexe-${randomUUID()}`;
		const tool = createFloorTool(root, sessionKey);
		try {
			const result = await tool.execute("where-git", { command: "/c/Windows/System32/where.exe git" });
			expect(textOf(result).toLowerCase()).toContain("git");
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("fails clearly instead of hanging on the cmd builtin dir, which has no standalone executable", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-floor-dirbuiltin-"));
		const root = realpathSync(scratch);
		const sessionKey = `floor-dirbuiltin-${randomUUID()}`;
		const tool = createFloorTool(root, sessionKey);
		try {
			// `dir` is a cmd.exe builtin, not a file on PATH; PowerShell's `&` invocation of it must
			// report a command-not-found style failure, not hang the persistent session.
			await expect(tool.execute("dir-builtin", { command: "dir" })).rejects.toThrow();
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
