import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { createBashTool, createLocalBashOperations, setCommandSilenceMsForTests } from "../src/core/tools/bash.ts";
import { getTextOutput } from "../src/core/tools/render-utils.ts";
import { disposeShellExecutionSession } from "../src/core/tools/shell-execution-session.ts";

describe("bash-executor silence sentinel mapping", () => {
	it("maps the raw silence:<secs> sentinel to the friendly message instead of leaking it", async () => {
		setCommandSilenceMsForTests(300);
		try {
			let caught: unknown;
			try {
				await executeBashWithOperations("sleep 30", process.cwd(), createLocalBashOperations());
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(Error);
			const message = (caught as Error).message;
			// The raw sentinel must never reach the caller; only the friendly message should.
			expect(message).not.toMatch(/^silence:/);
			expect(message).toMatch(
				/Command killed after .*s of silence \(no output\)\. If the command is legitimately quiet/,
			);
		} finally {
			setCommandSilenceMsForTests(undefined);
		}
	}, 15_000);
});

describe.skipIf(process.platform === "win32")("bash tool cwd reporting", () => {
	it("ends a failed result with the exit line and the session-reported cwd after an in-session cd", async () => {
		const sessionKey = `bash-cwd-report-${Math.random().toString(36).slice(2)}`;
		const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-bash-cwd-")));
		const tool = createBashTool(process.cwd(), { sessionKey });
		try {
			await tool.execute("cd-call", { command: `cd '${tempDir}' && true` });
			let caught: unknown;
			try {
				// The in-session cd persists; the failure must report where the command actually ran.
				await tool.execute("fail-call", { command: "false" });
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(Error);
			expect((caught as Error).message.endsWith(`Command exited with code 1\ncwd: ${tempDir}`)).toBe(true);
		} finally {
			disposeShellExecutionSession(sessionKey);
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps success results free of cwd lines", async () => {
		const sessionKey = `bash-cwd-success-${Math.random().toString(36).slice(2)}`;
		const tool = createBashTool(process.cwd(), { sessionKey });
		try {
			const result = await tool.execute("ok-call", { command: "echo ok" });
			const text = getTextOutput(result, false);
			expect(text).toContain("ok");
			expect(text).not.toMatch(/^cwd: /m);
		} finally {
			disposeShellExecutionSession(sessionKey);
		}
	});

	it("reports the host cwd on a filtered git failure", async () => {
		const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-bash-git-cwd-")));
		const tool = createBashTool(tempDir);
		try {
			let caught: unknown;
			try {
				await tool.execute("git-call", { command: "git status" });
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(Error);
			expect((caught as Error).message).toMatch(/Command exited with code \d+\ncwd: /);
			expect((caught as Error).message.endsWith(`\ncwd: ${tempDir}`)).toBe(true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
