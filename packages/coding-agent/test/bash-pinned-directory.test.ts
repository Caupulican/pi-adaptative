import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { announceToolCall, retireToolCall } from "../src/core/tools/file-mutation-queue.ts";
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
			// Compare directory identity without discarding short-name inputs on Windows.
			expect(realpathSync.native(text(moved))).toBe(realpathSync.native(join(root, "child")));
			const next = await tool.execute("next", { command: "pwd" });
			expect(realpathSync.native(text(next))).toBe(realpathSync.native(root));
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

/** Identity comparison that survives short names and symlinked temp roots on either platform. */
function sameDirectory(reported: string, expected: string): boolean {
	return realpathSync.native(reported.trim().replace(/\\/g, "/")) === realpathSync.native(expected);
}

/**
 * One assistant message's tool wave: every call is announced with its emission index before any
 * body starts, so the bodies run together on separate shell lanes instead of serializing behind the
 * exclusive mutation barrier.
 */
async function runAnnouncedBatch(
	tool: ReturnType<typeof createPinnedTool>,
	commands: Array<{ command: string; background?: boolean }>,
): Promise<string[]> {
	const batchId = randomUUID();
	const callIds = commands.map((_entry, index) => `${batchId}-${index}`);
	for (const [index, callId] of callIds.entries()) announceToolCall(callId, index, false, batchId);
	try {
		const results = await Promise.all(commands.map((entry, index) => tool.execute(callIds[index], entry)));
		return results.map((result) => getTextOutput(result, false).trim());
	} finally {
		for (const callId of callIds) retireToolCall(callId);
	}
}

/**
 * Every execution path the tool owns re-enters the pin: the lane pool, the detached background
 * spawn, and the detached probe a background filtered git call uses to resolve its landing
 * directory. The pool remembers where the shell last stood so an unpinned session keeps its
 * directory between calls; under the pin that memory must never be consulted.
 */
describe.skipIf(process.platform === "win32")("Bash tool directory pin across every execution path", () => {
	it("starts every concurrent lane in the pin after a command changed the shell directory", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-bash-pin-lanes-"));
		const root = realpathSync(scratch);
		const away = realpathSync(mkdtempSync(join(tmpdir(), "pi-bash-pin-away-")));
		const sessionKey = `pin-lanes-${randomUUID()}`;
		const tool = createPinnedTool(root, sessionKey);
		try {
			const [moved] = await runAnnouncedBatch(tool, [{ command: `cd '${away}' && pwd` }]);
			expect(sameDirectory(moved, away)).toBe(true);
			const reported = await runAnnouncedBatch(tool, [{ command: "pwd" }, { command: "pwd" }, { command: "pwd" }]);
			expect(reported.map((entry) => sameDirectory(entry, root))).toEqual([true, true, true]);
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(scratch, { recursive: true, force: true });
			rmSync(away, { recursive: true, force: true });
		}
	});

	it("never seeds a lane from the pool's remembered directory while pinned", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-bash-pin-pool-"));
		const root = realpathSync(scratch);
		const away = realpathSync(mkdtempSync(join(tmpdir(), "pi-bash-pin-pool-away-")));
		const sessionKey = `pin-pool-${randomUUID()}`;
		const tool = createPinnedTool(root, sessionKey);
		try {
			// The `cd` completes first, so the pool has a remembered directory to leak before the
			// observers ask for lanes: the lane it ran on, and the lanes the pool grows for the wave.
			const moved = await tool.execute("move", { command: `cd '${away}' && pwd` });
			expect(sameDirectory(getTextOutput(moved, false), away)).toBe(true);
			const wave = await runAnnouncedBatch(tool, [
				{ command: "pwd" },
				{ command: "pwd" },
				{ command: "pwd" },
				{ command: "pwd" },
			]);
			expect(wave.map((entry) => sameDirectory(entry, root))).toEqual([true, true, true, true]);
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(scratch, { recursive: true, force: true });
			rmSync(away, { recursive: true, force: true });
		}
	});

	it("starts a detached background command in the pin, not where the session was left standing", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-bash-pin-background-"));
		const root = realpathSync(scratch);
		const away = realpathSync(mkdtempSync(join(tmpdir(), "pi-bash-pin-background-away-")));
		const sessionKey = `pin-background-${randomUUID()}`;
		const tool = createPinnedTool(root, sessionKey);
		try {
			const moved = await tool.execute("move", { command: `cd '${away}' && pwd` });
			expect(sameDirectory(getTextOutput(moved, false), away)).toBe(true);
			const detached = await tool.execute("detached-pwd", { command: "pwd", background: true });
			expect(sameDirectory(getTextOutput(detached, false), root)).toBe(true);
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(scratch, { recursive: true, force: true });
			rmSync(away, { recursive: true, force: true });
		}
	});

	it("probes a background filtered git call inside the pin and leaves the session in the pin", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-bash-pin-bg-git-"));
		const root = realpathSync(scratch);
		const child = join(root, "sub");
		mkdirSync(child);
		// Two repositories, so the porcelain status (always repository-root relative) names the
		// directory git actually ran in instead of the same paths from either side.
		for (const cwd of [root, child]) execFileSync("git", ["init", "-q"], { cwd });
		writeFileSync(join(root, "root-marker"), "fixture");
		writeFileSync(join(child, "child-marker"), "fixture");
		const away = realpathSync(mkdtempSync(join(tmpdir(), "pi-bash-pin-bg-git-away-")));
		const sessionKey = `pin-bg-git-${randomUUID()}`;
		const tool = createPinnedTool(root, sessionKey);
		try {
			// The session is standing somewhere else when the background call arrives: the probe still
			// resolves `sub` against the pin, never against where the shell was left.
			const moved = await tool.execute("move", { command: `cd '${away}' && pwd` });
			expect(sameDirectory(getTextOutput(moved, false), away)).toBe(true);
			const status = await tool.execute("bg-git", { command: "cd sub && git status --short", background: true });
			const text = getTextOutput(status, false);
			expect(text).toContain("child-marker");
			expect(text).not.toContain("root-marker");
			const pwd = await tool.execute("pwd-after", { command: "pwd" });
			expect(sameDirectory(getTextOutput(pwd, false), root)).toBe(true);
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(scratch, { recursive: true, force: true });
			rmSync(away, { recursive: true, force: true });
		}
	});
});
