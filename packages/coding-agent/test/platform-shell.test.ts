import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requiredCapabilitiesForTool } from "../src/core/autonomy/approval-gate.ts";
import { buildForegroundEnvelope } from "../src/core/autonomy/foreground-envelope.ts";
import { evaluateToolGate } from "../src/core/autonomy/gates.ts";
import { getDefaultActiveToolNames, mapToolNamesForPlatform } from "../src/core/default-tool-surface.ts";
import { classifyToolTrust } from "../src/core/security/untrusted-boundary.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { type BashToolOptions, createAllToolDefinitions, createBashToolDefinition } from "../src/core/tools/index.ts";
import { disposeShellExecutionSession } from "../src/core/tools/shell-execution-session.ts";
import {
	createPowerShellHostEnvironment,
	POWERSHELL_7_GUARD,
	POWERSHELL_BOOTSTRAP,
} from "../src/utils/powershell-session-protocol.ts";
import { getPlatformShellToolName, getShellConfig, POWERSHELL_STARTUP_PROBE_TIMEOUT_MS } from "../src/utils/shell.ts";

describe("automatic platform shell contract", () => {
	it("keeps one Bash-like agent contract while selecting the backend by platform", () => {
		expect(getPlatformShellToolName("win32")).toBe("powershell");
		expect(getPlatformShellToolName("linux")).toBe("bash");
		expect(getDefaultActiveToolNames("win32")).toContain("bash");
		expect(getDefaultActiveToolNames("win32")).not.toContain("powershell");
		expect(getDefaultActiveToolNames("linux")).toContain("bash");
	});

	it("maps platform-specific stored names to the stable contract", () => {
		expect(mapToolNamesForPlatform(["read", "powershell", "edit"], "win32")).toEqual(["read", "bash", "edit"]);
		expect(mapToolNamesForPlatform(["bash", "powershell"], "linux")).toEqual(["bash"]);
	});

	it("uses headless PowerShell launch flags without overriding command encoding", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-pwsh-flags-"));
		const pwsh = join(directory, "pwsh.exe");
		writeFileSync(pwsh, "official");
		try {
			expect(getShellConfig(pwsh, "powershell")).toEqual({
				shell: pwsh,
				args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
		expect(getShellConfig(process.execPath, "bash")).toEqual({ shell: process.execPath, args: ["-c"] });
		expect(POWERSHELL_BOOTSTRAP).toContain(POWERSHELL_7_GUARD.trimEnd());
		expect(POWERSHELL_BOOTSTRAP).not.toContain("OutputEncoding");
		const original = {
			KEEP_ME: "yes",
			no_color: "0",
			powershell_telemetry_optout: "false",
			POWERSHELL_UPDATECHECK: "Default",
		};
		expect(createPowerShellHostEnvironment(original)).toEqual({
			KEEP_ME: "yes",
			NO_COLOR: "1",
			POWERSHELL_DIAGNOSTICS_OPTOUT: "1",
			POWERSHELL_TELEMETRY_OPTOUT: "1",
			POWERSHELL_UPDATECHECK: "Off",
		});
		expect(original).toHaveProperty("no_color", "0");
	});

	it("expands a home-relative custom shell path before validation", () => {
		const missingPath = `~/.pi-shell-does-not-exist-${process.pid}`;
		expect(() => getShellConfig(missingPath, "bash")).toThrow(
			`Custom shell path not found: ${join(homedir(), missingPath.slice(2))}`,
		);
	});

	it("rejects a legacy Windows PowerShell path and accepts only pwsh as a custom PowerShell host", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-official-pwsh-"));
		const legacyPowerShell = join(directory, "powershell.exe");
		const officialPowerShell = join(directory, "pwsh.exe");
		try {
			writeFileSync(legacyPowerShell, "legacy");
			writeFileSync(officialPowerShell, "official");
			expect(getShellConfig(officialPowerShell, "powershell").shell).toBe(officialPowerShell);
			expect(() => getShellConfig(legacyPowerShell, "powershell")).toThrow("PowerShell 7 (pwsh)");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("prefers a usable PowerShell 7 executable", () => {
		const executable = process.platform === "win32" ? "pwsh.exe" : "pwsh";
		const probe = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Write-Output ok"], {
			encoding: "utf-8",
			timeout: POWERSHELL_STARTUP_PROBE_TIMEOUT_MS,
			windowsHide: true,
		});
		if (probe.status !== 0) return;
		expect(getShellConfig(undefined, "powershell").shell.toLowerCase()).toMatch(/pwsh(?:\.exe)?$/u);
	});

	it("routes the Bash-like contract to PowerShell without exposing PowerShell syntax to the agent", async () => {
		let executedCommand = "";
		let executedTimeout: number | undefined;
		const options: BashToolOptions = {
			platform: "win32",
			operations: {
				exec: async (command, _cwd, { onData, timeout }) => {
					executedCommand = command;
					executedTimeout = timeout;
					onData(Buffer.from("ok\n"));
					return { exitCode: 0 };
				},
			},
		};
		const tool = createBashToolDefinition(process.cwd(), options);
		expect(tool.name).toBe("bash");
		expect(tool.description).toContain("stable Bash-like command contract");
		expect(tool.promptSnippet).toBe("Run Bash-like commands; Pi routes Windows.");
		expect((tool.promptGuidelines ?? []).join("\n")).toContain("never write PowerShell");

		const result = await tool.execute(
			"call-1",
			{ command: "node --version" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(executedCommand).not.toContain("OutputEncoding");
		expect(executedCommand).toContain("& 'node' '--version'");
		expect(executedTimeout).toBe(120);
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("Expected shell text output");
		expect(content.text).toBe("ok\n");

		await tool.execute(
			"call-2",
			{ command: "node --version", timeout: 10_000 },
			undefined,
			undefined,
			undefined as never,
		);
		expect(executedTimeout).toBe(3_600);
	});

	it("decodes mixed UTF-8 and Windows-1252 output without changing the command encoding", async () => {
		const tool = createBashToolDefinition(process.cwd(), {
			platform: "win32",
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("ação 日本 €\n", "utf8"));
					onData(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
					return { exitCode: 0 };
				},
			},
		});

		const result = await tool.execute(
			"encoding",
			{ command: "legacy-output.exe" },
			undefined,
			undefined,
			undefined as never,
		);
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("Expected shell text output");
		expect(content.text).toBe("ação 日本 €\ncafé\n");
	});

	it("registers only the stable contract in built-in tool definitions", () => {
		const windows = createAllToolDefinitions(process.cwd(), undefined, "win32");
		expect(Object.keys(windows)).toContain("bash");
		expect(Object.keys(windows)).not.toContain("powershell");
		const linux = createAllToolDefinitions(process.cwd(), undefined, "linux");
		expect(Object.keys(linux)).toContain("bash");
		expect(Object.keys(linux)).not.toContain("powershell");
	});

	it("generates prompt guidance for the stable contract without a shell choice", () => {
		const prompt = buildSystemPrompt({ cwd: process.cwd(), selectedTools: ["read", "bash"] });
		expect(prompt).toContain("Bash: ls, rg, find");
		expect(prompt).not.toContain("choose a shell");
	});

	it("executes the routed contract through native PowerShell on Windows", async () => {
		if (process.platform !== "win32") return;
		const tool = createBashToolDefinition(process.cwd());
		const result = await tool.execute(
			"call-windows",
			{ command: "node -e \"console.log('pi-shell-router-ok')\"", timeout: 10 },
			undefined,
			undefined,
			undefined as never,
		);
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("Expected routed shell text output");
		expect(content.text).toContain("pi-shell-router-ok");
	});

	it("preserves routed statuses through the explicit per-command PowerShell fallback", async () => {
		if (process.platform !== "win32") return;
		const cwd = mkdtempSync(join(tmpdir(), "pi-powershell-per-command-"));
		try {
			writeFileSync(join(cwd, "visible.txt"), "needle\n");
			const tool = createBashToolDefinition(cwd, { shellPath: getShellConfig(undefined, "powershell").shell });
			const execute = (command: string) =>
				tool.execute("call-windows-per-command", { command }, undefined, undefined, undefined as never);

			await expect(execute('node -e "process.exit(7)"')).rejects.toThrow("Command exited with code 7");
			await expect(execute("grep absent visible.txt")).resolves.toBeDefined();
			await expect(execute("grep needle missing.txt")).rejects.toThrow("Command exited with code 2");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("preserves routed builtin status and flag semantics through native PowerShell", async () => {
		if (process.platform !== "win32") return;
		const cwd = mkdtempSync(join(tmpdir(), "pi-powershell-contract-"));
		// An explicit sessionKey lets `finally` dispose the persistent shell session (killing its
		// process) before removing `cwd` below — the process's own cwd. Without this the live
		// process keeps the directory locked and `rmSync` races it (EPERM on Windows).
		const sessionKey = "platform-shell-contract-test";
		try {
			writeFileSync(join(cwd, "visible.txt"), "one\ntwo\n");
			writeFileSync(join(cwd, ".hidden.txt"), "hidden\n");
			mkdirSync(join(cwd, "existing"));
			mkdirSync(join(cwd, "source-dir"));
			writeFileSync(join(cwd, "source-dir", "inside.txt"), "inside\n");
			const tool = createBashToolDefinition(cwd, { sessionKey });
			const execute = (command: string) =>
				tool.execute("call-windows-semantics", { command }, undefined, undefined, undefined as never);

			const echoResult = await execute("echo -nn hi");
			const echoContent = echoResult.content[0];
			if (echoContent?.type !== "text") throw new Error("Expected routed shell text output");
			expect(echoContent.text).toBe("hi");
			const missingGrep = await execute("grep missing visible.txt");
			const missingGrepContent = missingGrep.content[0];
			if (missingGrepContent?.type !== "text") throw new Error("Expected routed shell text output");
			expect(missingGrepContent.text).toContain("completed with no matches");
			const caseSensitiveGrep = await execute("grep ONE visible.txt");
			const caseSensitiveGrepContent = caseSensitiveGrep.content[0];
			if (caseSensitiveGrepContent?.type !== "text") throw new Error("Expected routed shell text output");
			expect(caseSensitiveGrepContent.text).toContain("completed with no matches");
			await expect(execute("grep needle missing.txt")).rejects.toThrow("Command exited with code 2");
			await expect(execute("grep '[' visible.txt")).rejects.toThrow("Command exited with code 2");
			const plainList = await execute("ls");
			const plainListContent = plainList.content[0];
			if (plainListContent?.type !== "text") throw new Error("Expected routed shell text output");
			expect(plainListContent.text).not.toContain(".hidden.txt");
			const hiddenList = await execute("ls -a");
			const hiddenListContent = hiddenList.content[0];
			if (hiddenListContent?.type !== "text") throw new Error("Expected routed shell text output");
			expect(hiddenListContent.text).toContain(".hidden.txt");
			await expect(execute("rm -f missing.txt")).resolves.toBeDefined();
			await expect(execute("mkdir existing")).rejects.toThrow("Command exited with code 1");
			await expect(execute("mkdir -p existing")).resolves.toBeDefined();
			await expect(execute("cp source-dir copied-dir")).rejects.toThrow("Command exited with code 1");
			await expect(execute("cp -r source-dir copied-dir")).resolves.toBeDefined();
		} finally {
			disposeShellExecutionSession(sessionKey);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("keeps the stable contract at the existing capability and trust boundaries", () => {
		expect(requiredCapabilitiesForTool("bash")).toEqual(["process.exec"]);
		expect(classifyToolTrust("bash")).toBe("trusted");
		const envelope = buildForegroundEnvelope({ turnIndex: 1, activeToolNames: ["bash"], cwd: process.cwd() });
		expect(envelope.capabilities).toEqual(["process.exec"]);
		expect(
			evaluateToolGate({
				toolName: "bash",
				args: { command: "ls" },
				cwd: process.cwd(),
				envelope,
			}),
		).toMatchObject({ outcome: "allow" });
	});
});
