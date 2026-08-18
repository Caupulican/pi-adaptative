import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { disposeShellExecutionSessionAndWait } from "../src/core/tools/shell-execution-session.ts";

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

	const hasRipgrep = spawnSync("where", ["rg.exe"], { encoding: "utf8", windowsHide: true }).status === 0;

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
			await disposeShellExecutionSessionAndWait(sessionKey);
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
			await disposeShellExecutionSessionAndWait(sessionKey);
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
			await disposeShellExecutionSessionAndWait(sessionKey);
		}
	});

	it("(d) word-list and arithmetic for loops execute with printf and loop control", async () => {
		const sessionKey = freshSessionKey("refusal");
		try {
			const tool = createBashToolDefinition(process.cwd(), { sessionKey });
			const result = await tool.execute(
				"call-d-loop",
				{ command: `for item in one "two words"; do printf '[%s]\\n' "$item"; done` },
				undefined,
				undefined,
				undefined as never,
			);
			const content = result.content[0];
			if (content?.type !== "text") throw new Error("expected text output");
			expect(content.text.trim()).toBe("[one]\n[two words]");

			const arithmetic = await tool.execute(
				"call-d-arithmetic",
				{
					command:
						`for ((i=0; i<5; i++)); do ` +
						`test "$i" = 1 && continue; test "$i" = 4 && break; printf '[%s]\\n' "$i"; done`,
				},
				undefined,
				undefined,
				undefined as never,
			);
			const arithmeticContent = arithmetic.content[0];
			if (arithmeticContent?.type !== "text") throw new Error("expected text output");
			expect(arithmeticContent.text.trim()).toBe("[0]\n[2]\n[3]");

			await expect(
				tool.execute("call-d", { command: "if true; then echo hi; fi" }, undefined, undefined, undefined as never),
			).rejects.toThrow(/control-flow|not supported|if\/while/i);
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
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
			await disposeShellExecutionSessionAndWait(sessionKey);
		}
	});

	it("(f) executes a .ps1 target through the selected PowerShell host when redirection requires the engine", async () => {
		const sessionKey = freshSessionKey("powershell-script-adapter");
		const root = mkdtempSync(join(tmpdir(), "pi-win-shell-ps1-"));
		const scriptPath = join(root, "probe.ps1");
		const capturePath = join(root, "capture.txt");
		writeFileSync(
			scriptPath,
			[
				"param([string]$Value)",
				'Write-Output "stdout:$Value"',
				'[Console]::Error.WriteLine("stderr:$Value")',
				"exit 7",
				"",
			].join("\r\n"),
			"utf8",
		);

		try {
			const tool = createBashToolDefinition(process.cwd(), { sessionKey });
			const script = scriptPath.replaceAll("\\", "/");
			const capture = capturePath.replaceAll("\\", "/");
			await tool.execute(
				"call-f",
				{ command: `'${script}' 'value with spaces' > '${capture}' 2>&1 || true` },
				undefined,
				undefined,
				undefined as never,
			);

			const captured = readFileSync(capturePath, "utf8");
			expect(captured.match(/stdout:value with spaces/gu)).toHaveLength(1);
			expect(captured.match(/stderr:value with spaces/gu)).toHaveLength(1);
			expect(captured).not.toContain("WinError 193");
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.skipIf(!hasRipgrep)("(g) invokes native rg.exe through both the simple and combined routes", async () => {
		const sessionKey = freshSessionKey("native-ripgrep");
		const root = mkdtempSync(join(tmpdir(), "pi-win-shell-rg-"));
		const sourcePath = join(root, "Hairware 7 (Release).txt");
		writeFileSync(sourcePath, "needle\nother\nmiss\n", "utf8");

		try {
			const tool = createBashToolDefinition(process.cwd(), { sessionKey });
			const source = sourcePath.replaceAll("\\", "/");
			const simple = await tool.execute(
				"call-g1",
				{ command: `rg -n 'needle|other' '${source}'` },
				undefined,
				undefined,
				undefined as never,
			);
			const simpleContent = simple.content[0];
			if (simpleContent?.type !== "text") throw new Error("expected text output");
			expect(simpleContent.text).toContain("1:needle");
			expect(simpleContent.text).toContain("2:other");

			const combined = await tool.execute(
				"call-g2",
				{ command: `cat '${source}' | rg 'needle|other'` },
				undefined,
				undefined,
				undefined as never,
			);
			const combinedContent = combined.content[0];
			if (combinedContent?.type !== "text") throw new Error("expected text output");
			expect(combinedContent.text).toBe("needle\nother\n");

			const noMatch = await tool.execute(
				"call-g3",
				{
					command:
						`printf '%s\\n' '--- first search ---'; rg -n 'absent' '${source}'; ` +
						`printf '%s\\n' '--- final search ---'; rg -n 'absent' '${source}';`,
				},
				undefined,
				undefined,
				undefined as never,
			);
			const noMatchContent = noMatch.content[0];
			if (noMatchContent?.type !== "text") throw new Error("expected text output");
			expect(noMatchContent.text).toContain("--- final search ---");
			expect(noMatchContent.text).toContain("Final rg search completed with no matches.");

			await expect(
				tool.execute("call-g4", { command: `rg '(' '${source}'` }, undefined, undefined, undefined as never),
			).rejects.toThrow("Command exited with code 2");
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("(h) retains one PowerShell process across 20 routed empty searches", async () => {
		const sessionKey = freshSessionKey("powershell-process-lifetime");
		const root = mkdtempSync(join(tmpdir(), "pi-win-shell-lifetime-"));
		const sourcePath = join(root, "source.txt");
		writeFileSync(sourcePath, "needle\n", "utf8");
		try {
			const tool = createBashToolDefinition(root, { sessionKey });
			const parentPid = async (toolCallId: string): Promise<string> => {
				const result = await tool.execute(
					toolCallId,
					{ command: 'node -e "console.log(process.ppid)"' },
					undefined,
					undefined,
					undefined as never,
				);
				const content = result.content[0];
				if (content?.type !== "text") throw new Error("expected text output");
				return content.text.trim();
			};

			const firstParentPid = await parentPid("call-h1");
			for (let index = 0; index < 20; index++) {
				const search = hasRipgrep && index % 2 === 0 ? "rg" : "grep";
				const empty = await tool.execute(
					`call-h-empty-${index}`,
					{ command: `${search} absent source.txt` },
					undefined,
					undefined,
					undefined as never,
				);
				const emptyContent = empty.content[0];
				if (emptyContent?.type !== "text") throw new Error("expected text output");
				expect(emptyContent.text).toContain(`Final ${search} search completed with no matches.`);
			}
			expect(await parentPid("call-h3")).toBe(firstParentPid);
			await expect(
				tool.execute(
					"call-h4",
					{ command: "pi-command-that-does-not-exist --version" },
					undefined,
					undefined,
					undefined as never,
				),
			).rejects.toThrow("Command exited with code 1");
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
