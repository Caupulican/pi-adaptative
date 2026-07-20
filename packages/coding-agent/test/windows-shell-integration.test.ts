import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { disposeWindowsShellState } from "../src/core/tools/windows-shell-state.ts";

/**
 * Cross-tier integration (WP-F §3): drives the REAL `bash` tool created by
 * `createBashToolDefinition` with the engine enabled, asserting the engine tier executes complex
 * Bash-like commands, `cd`/`export` state carries to the next call regardless of which tier runs
 * it, a named refusal surfaces for an unsupported construct, and the PS floor keeps working with a
 * named degradation error when the Python runtime is forced unavailable. win32 only — the router's
 * `python-engine` route and the PowerShell floor only exist on that platform.
 */
describe("windows shell cross-tier integration (bash tool + python engine on win32)", () => {
	if (process.platform !== "win32") {
		it.skip("windows shell integration runs on win32 only", () => {});
		return;
	}

	function freshSessionKey(label: string): string {
		return `windows-shell-integration:${label}:${Math.random().toString(36).slice(2)}`;
	}

	it("(a) a pipeline/redirection/expansion command executes through the engine tier with correct output", async () => {
		const sessionKey = freshSessionKey("pipeline");
		try {
			const tool = createBashToolDefinition(process.cwd(), { sessionKey });
			const result = await tool.execute(
				"call-a",
				{ command: 'printf "%s\\n" one two three | grep t | sort -r' },
				undefined,
				undefined,
				undefined as never,
			);
			const content = result.content[0];
			if (content?.type !== "text") throw new Error("expected text output");
			// Assert the exact tool output including its real trailing newline — the tool's
			// output is not expected to be pre-trimmed.
			expect(content.text).toBe("two\nthree\n");
		} finally {
			disposeWindowsShellState(sessionKey);
		}
	});

	it("(b) cd in the engine tier -> a subsequent simple PS-tier command observes the new cwd", async () => {
		const sessionKey = freshSessionKey("cd-state");
		const sub = mkdtempSync(join(tmpdir(), "pi-win-shell-cd-"));
		try {
			const tool = createBashToolDefinition(process.cwd(), { sessionKey });
			await tool.execute("call-b1", { command: `cd ${sub}` }, undefined, undefined, undefined as never);
			// `pwd` alone routes through the PS floor (routeBuiltIn), not the engine.
			const result = await tool.execute("call-b2", { command: "pwd" }, undefined, undefined, undefined as never);
			const content = result.content[0];
			if (content?.type !== "text") throw new Error("expected text output");
			// Canonicalize both sides through the native realpath resolver: `mkdtempSync`
			// returns a long-form path, but the PS floor's `pwd` may echo back an 8.3 short
			// name (e.g. "runner~1") for the SAME directory — same identity, different
			// spelling. `realpathSync.native` resolves both to one canonical form.
			expect(realpathSync.native(content.text.trim()).toLowerCase()).toBe(realpathSync.native(sub).toLowerCase());
		} finally {
			disposeWindowsShellState(sessionKey);
		}
	});

	it("(c) export in the engine tier -> a subsequent command observes the new env value", async () => {
		const sessionKey = freshSessionKey("export-state");
		try {
			const tool = createBashToolDefinition(process.cwd(), { sessionKey });
			await tool.execute(
				"call-c1",
				{ command: "export PI_WIN_SHELL_INTEGRATION_VAR=carried" },
				undefined,
				undefined,
				undefined as never,
			);
			const result = await tool.execute(
				"call-c2",
				{ command: "echo $PI_WIN_SHELL_INTEGRATION_VAR" },
				undefined,
				undefined,
				undefined as never,
			);
			const content = result.content[0];
			if (content?.type !== "text") throw new Error("expected text output");
			expect(content.text.trim()).toBe("carried");
		} finally {
			disposeWindowsShellState(sessionKey);
		}
	});

	it("(d) an unsupported construct returns the named refusal", async () => {
		const sessionKey = freshSessionKey("refusal");
		try {
			const tool = createBashToolDefinition(process.cwd(), { sessionKey });
			await expect(
				tool.execute("call-d", { command: "if true; then echo hi; fi" }, undefined, undefined, undefined as never),
			).rejects.toThrow(/control-flow|not supported|if\/for\/while/i);
		} finally {
			disposeWindowsShellState(sessionKey);
		}
	});

	it("(e) with the runtime forced unavailable, a simple command still works via the PS floor and the complex command fails with the NAMED degradation error", async () => {
		const sessionKey = freshSessionKey("degraded");
		try {
			const tool = createBashToolDefinition(process.cwd(), {
				sessionKey,
				windowsShellEngineOptions: {
					resolveRuntime: async () => ({
						status: "python-unavailable",
						reason: "Simulated: Python runtime is not installed for this test.",
					}),
				},
			});

			// Simple command: routes to the PS floor (`echo` is a routed builtin), never touches the engine.
			const simple = await tool.execute(
				"call-e1",
				{ command: "echo still-works" },
				undefined,
				undefined,
				undefined as never,
			);
			const simpleContent = simple.content[0];
			if (simpleContent?.type !== "text") throw new Error("expected text output");
			expect(simpleContent.text.trim()).toBe("still-works");

			// Complex command: routes to python-engine, which throws the named degradation error.
			await expect(
				tool.execute(
					"call-e2",
					{ command: "printf '%s\\n' a b | grep a" },
					undefined,
					undefined,
					undefined as never,
				),
			).rejects.toThrow(/Windows shell engine \(Python\) is unavailable/);
		} finally {
			disposeWindowsShellState(sessionKey);
		}
	});
});
