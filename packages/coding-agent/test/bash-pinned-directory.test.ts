import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { getTextOutput } from "../src/core/tools/render-utils.ts";
import { disposeShellExecutionSessionAndWait } from "../src/core/tools/shell-execution-session.ts";

function createPinnedTool(root: string, sessionKey: string) {
	return createBashTool(root, {
		sessionKey,
		forceCwd: true,
		outputReduction: { enabled: false },
		windowsShellEngineOptions: {
			resolveRuntime: async () => {
				const pythonPath = [process.env.PI_TEST_PYTHON, "python3", "python"].find(
					(candidate) =>
						candidate && spawnSync(candidate, ["--version"], { stdio: "ignore", timeout: 5000 }).status === 0,
				);
				if (!pythonPath)
					throw new Error("Pinned shell fixture requires an installed Python; no runtime download is allowed");
				return { status: "ready", uvPath: "/unused/uv", pythonPath, pythonInstalled: false };
			},
			engineScriptPath: join(import.meta.dirname, "../src/bundled-resources/runtimes/pi-shell-engine/main.py"),
		},
	});
}

describe("Bash tool directory pin", () => {
	it("applies the host pin on consecutive calls and retains command-local cd", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-bash-pin-"));
		const root = realpathSync(scratch);
		mkdirSync(join(root, "child"));
		const sessionKey = `pin-${randomUUID()}`;
		const tool = createPinnedTool(root, sessionKey);
		const text = (result: Awaited<ReturnType<typeof tool.execute>>) =>
			result.content
				.map((part) => (part.type === "text" ? part.text : ""))
				.join("")
				.trim()
				.replace(/\\/g, "/");
		try {
			const moved = await tool.execute("move", { command: "cd child; pwd" });
			expect(text(moved)).toBe(join(root, "child").replace(/\\/g, "/"));
			const next = await tool.execute("next", { command: "pwd" });
			expect(text(next)).toBe(root.replace(/\\/g, "/"));
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("keeps direct Git filtering in the pin after a previous command changed the shell directory", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-git-pin-"));
		const root = realpathSync(scratch);
		const child = join(root, "child");
		mkdirSync(child);
		for (const cwd of [root, child]) execFileSync("git", ["init", "-q"], { cwd });
		writeFileSync(join(root, "root-marker"), "fixture");
		writeFileSync(join(child, "child-marker"), "fixture");
		const sessionKey = `git-pin-${randomUUID()}`;
		const tool = createPinnedTool(root, sessionKey);
		try {
			await tool.execute("move-filtered", { command: "cd child && git status --short" });
			const result = await tool.execute("root-status", { command: "git status --short" });
			const text = getTextOutput(result, false);
			expect(text).toContain("root-marker");
			expect(text).not.toContain("child-marker");
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
