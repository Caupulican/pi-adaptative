import { describe, expect, it } from "vitest";
import { requiredCapabilitiesForTool } from "../src/core/autonomy/approval-gate.ts";
import { buildForegroundEnvelope } from "../src/core/autonomy/foreground-envelope.ts";
import { evaluateToolGate } from "../src/core/autonomy/gates.ts";
import { getDefaultActiveToolNames, mapToolNamesForPlatform } from "../src/core/default-tool-surface.ts";
import { classifyToolTrust } from "../src/core/security/untrusted-boundary.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { type BashToolOptions, createAllToolDefinitions, createBashToolDefinition } from "../src/core/tools/index.ts";
import {
	getPlatformShellToolName,
	getShellConfig,
	POWERSHELL_UTF8_PREFIX,
	prefixPowerShellCommand,
} from "../src/utils/shell.ts";

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

	it("uses Codex-compatible PowerShell launch flags and idempotent UTF-8 setup", () => {
		expect(getShellConfig(process.execPath, "powershell")).toEqual({
			shell: process.execPath,
			args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
		});
		expect(getShellConfig(process.execPath, "bash")).toEqual({ shell: process.execPath, args: ["-c"] });
		expect(prefixPowerShellCommand("Write-Output 'ok'")).toBe(`${POWERSHELL_UTF8_PREFIX}Write-Output 'ok'`);
		expect(prefixPowerShellCommand(`${POWERSHELL_UTF8_PREFIX}Write-Output 'ok'`)).toBe(
			`${POWERSHELL_UTF8_PREFIX}Write-Output 'ok'`,
		);
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
		expect(tool.promptSnippet).toContain("routes supported forms deterministically");
		expect((tool.promptGuidelines ?? []).join("\n")).toContain("do not write PowerShell");

		const result = await tool.execute(
			"call-1",
			{ command: "node --version" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(executedCommand).toContain(POWERSHELL_UTF8_PREFIX);
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
		expect(prompt).toContain("Use bash for file operations");
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

	it("keeps the stable contract at the existing capability and trust boundaries", () => {
		expect(requiredCapabilitiesForTool("bash")).toEqual(["run_shell"]);
		expect(classifyToolTrust("bash")).toBe("trusted");
		const envelope = buildForegroundEnvelope({ turnIndex: 1, activeToolNames: ["bash"], cwd: process.cwd() });
		expect(envelope.capabilities).toEqual(["run_shell"]);
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
