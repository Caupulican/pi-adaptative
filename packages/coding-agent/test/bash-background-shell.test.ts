import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { disposeShellExecutionSessionAndWait } from "../src/core/tools/shell-execution-session.ts";

function makeRoot(): string {
	return realpathSync.native(mkdtempSync(join(tmpdir(), "pi-bash-background-shell-")));
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("")
		.trim();
}

/** Compare directory identity without depending on symlinked temp roots (/tmp, /private/tmp). */
function sameDirectory(reported: string, expected: string): boolean {
	return realpathSync.native(reported) === realpathSync.native(expected);
}

function createSessionTool(root: string, sessionKey: string) {
	return createBashTool(root, { sessionKey, outputReduction: { enabled: false } });
}

describe.skipIf(process.platform === "win32")("background commands and the persistent shell session", () => {
	it("runs a background command outside the session so a later foreground command does not queue behind it", async () => {
		const root = makeRoot();
		const sessionKey = `test-bg-shell-${randomUUID()}`;
		const tool = createSessionTool(root, sessionKey);
		try {
			let backgroundSettled = false;
			const background = tool
				.execute("bg-1", { command: "sleep 3; echo bg-done", background: true })
				.then((result) => {
					backgroundSettled = true;
					return result;
				});

			const startedAt = Date.now();
			const foreground = await tool.execute("fg-1", { command: "echo fg-ran" });
			const elapsedMs = Date.now() - startedAt;

			expect(text(foreground)).toContain("fg-ran");
			expect(elapsedMs).toBeLessThan(1_000);
			expect(backgroundSettled).toBe(false);
			expect(text(await background)).toContain("bg-done");
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("starts a background command in the session's current directory without moving the session", async () => {
		const root = makeRoot();
		const sessionKey = `test-bg-shell-${randomUUID()}`;
		const tool = createSessionTool(root, sessionKey);
		try {
			expect(sameDirectory(text(await tool.execute("fg-2", { command: "cd /tmp && pwd" })), "/tmp")).toBe(true);

			// Seeded from the session's directory: a background command is not a fresh process at the
			// project root, it is the shell the agent is standing in, minus the shared session.
			const seeded = await tool.execute("bg-2", { command: "pwd", background: true });
			expect(sameDirectory(text(seeded), "/tmp")).toBe(true);

			// ... and its own cd is its own: the session must not follow a detached command home.
			expect(text(await tool.execute("bg-3", { command: "cd / && pwd", background: true }))).toBe("/");
			expect(sameDirectory(text(await tool.execute("fg-3", { command: "pwd" })), "/tmp")).toBe(true);
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("runs two background commands concurrently instead of serializing them", async () => {
		const root = makeRoot();
		const sessionKey = `test-bg-shell-${randomUUID()}`;
		const tool = createSessionTool(root, sessionKey);
		try {
			const startedAt = Date.now();
			const [first, second] = await Promise.all([
				tool.execute("bg-c1", { command: "sleep 2; echo one", background: true }),
				tool.execute("bg-c2", { command: "sleep 2; echo two", background: true }),
			]);
			expect(Date.now() - startedAt).toBeLessThan(3_500);
			expect(text(first)).toContain("one");
			expect(text(second)).toContain("two");
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function resolveTestPython(): string | undefined {
	return [process.env.PI_TEST_PYTHON, "python3", "python"].find(
		(candidate) => candidate && spawnSync(candidate, ["--version"], { stdio: "ignore", timeout: 5_000 }).status === 0,
	);
}

function createEngineTool(root: string, sessionKey: string) {
	return createBashTool(root, {
		sessionKey,
		outputReduction: { enabled: false },
		windowsShellEngineOptions: {
			resolveRuntime: async () => {
				const pythonPath = resolveTestPython();
				if (!pythonPath)
					throw new Error(
						"Background engine fixture requires an installed Python; no runtime download is allowed",
					);
				return { status: "ready", uvPath: "/unused/uv", pythonPath, pythonInstalled: false };
			},
			engineScriptPath: join(import.meta.dirname, "../src/bundled-resources/runtimes/pi-shell-engine/main.py"),
		},
	});
}

describe.skipIf(process.platform !== "win32")("background commands and the Windows shell engine", () => {
	it("runs a background engine command on its own coordinator so a foreground command still finishes", async () => {
		const root = makeRoot();
		const sessionKey = `test-bg-engine-${randomUUID()}`;
		const tool = createEngineTool(root, sessionKey);
		try {
			let backgroundSettled = false;
			const background = tool
				.execute("bg-win-1", { command: "sleep 3; echo bg-done", background: true })
				.then((result) => {
					backgroundSettled = true;
					return result;
				});

			const startedAt = Date.now();
			const foreground = await tool.execute("fg-win-1", { command: "echo fg-ran" });

			expect(text(foreground)).toContain("fg-ran");
			expect(Date.now() - startedAt).toBeLessThan(2_500);
			expect(backgroundSettled).toBe(false);
			expect(text(await background)).toContain("bg-done");
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
